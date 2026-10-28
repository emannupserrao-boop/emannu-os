// Módulo comercial (Criativos Motion): rotinas das 06h30 (Hermes: leads) e 07h15
// (Claude: propostas), leitura e validação das respostas no servidor.
// Só saídas validadas são gravadas; o texto vindo da web é dado, nunca instrução.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Job, RunnableAgent } from '../../../../packages/shared/types.ts';
import { LEAD_CRITERIA, MOTION_OFFER, type CriterionLevel, type LeadCriterion } from '../../../../packages/shared/renda.ts';
import type { Scheduler } from '../scheduler.ts';
import type { Outcome } from '../flow.ts';
import type { Routines } from '../routines.ts';
import { localDate } from '../routines.ts';
import { TIMEZONE } from '../config.ts';
import { loadPrompt } from '../prompts/load.ts';
import { extractJson } from '../immigration/topics.ts';
import { RendaStore } from './store.ts';

export const RENDA_PROJECT = 'renda';
export const CRIATIVOS_PROJECT = 'criativos-motion';
const LEADS_PER_DAY = 3;
const CHANNELS = ['reddit', 'upwork', 'linkedin', 'google', 'site', 'outro'];
const LEVELS: CriterionLevel[] = ['zero', 'metade', 'integral'];

// Controles, zero-width e marcas de direção (usadas para esconder texto).
const CONTROL_RE = new RegExp('[\x00-\x1f\x7f\u200b-\u200f\u2028-\u202e]', 'g');

// Texto vindo de fora: sem caracteres de controle, espaços normalizados e tamanho limitado.
export function clean(v: unknown, max: number): string {
  return String(v ?? '')
    .replace(CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function validUrl(v: unknown): string | null {
  const s = clean(v, 500);
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export interface ParsedLead {
  sourceUrl: string;
  postedAt: string | null;
  company: string | null;
  channel: string;
  need: string;
  evidence: string;
  scoreDetail: Partial<Record<LeadCriterion, CriterionLevel>>;
  discardReason: string | null;
}

// Lê os leads do Hermes. Campos que o agente não pode definir (status, pontuação total,
// preço, "pago", etc.) são simplesmente ignorados.
export function parseLeads(raw: any): { leads: ParsedLead[]; lacunas: string[]; rejeitados: number } {
  const items: any[] = Array.isArray(raw?.leads) ? raw.leads.slice(0, 20) : [];
  const leads: ParsedLead[] = [];
  let rejeitados = 0;
  for (const it of items) {
    const sourceUrl = validUrl(it?.source_url);
    const need = clean(it?.need, 400);
    const evidence = clean(it?.evidence, 600);
    if (!sourceUrl || need.length < 5 || evidence.length < 10) {
      rejeitados++;
      continue;
    }
    const posted = clean(it?.posted_at, 10);
    const detail: Partial<Record<LeadCriterion, CriterionLevel>> = {};
    for (const k of Object.keys(LEAD_CRITERIA) as LeadCriterion[]) {
      const lv = String(it?.score_json?.[k] ?? 'zero').toLowerCase() as CriterionLevel;
      detail[k] = LEVELS.includes(lv) ? lv : 'zero';
    }
    const channel = clean(it?.channel, 20).toLowerCase();
    const discard = it?.descartar ? clean(it.descartar, 200) : '';
    leads.push({
      sourceUrl,
      postedAt: /^\d{4}-\d{2}-\d{2}$/.test(posted) ? posted : null,
      company: clean(it?.company, 120) || null,
      channel: CHANNELS.includes(channel) ? channel : 'outro',
      need,
      evidence,
      scoreDetail: detail,
      discardReason: discard || null,
    });
  }
  const lacunas = (Array.isArray(raw?.lacunas) ? raw.lacunas : []).map((x: unknown) => clean(x, 300)).filter(Boolean).slice(0, 10);
  return { leads, lacunas, rejeitados };
}

export interface ParsedProposal {
  leadId: string;
  currency: string;
  body: string;
  scope: string;
}

export function parseProposals(raw: any): ParsedProposal[] {
  const items: any[] = Array.isArray(raw?.propostas) ? raw.propostas.slice(0, 20) : [];
  const out: ParsedProposal[] = [];
  for (const it of items) {
    const leadId = clean(it?.lead_id, 40);
    const currency = clean(it?.moeda, 3).toUpperCase();
    // O texto da proposta pode ter quebras de linha (é uma mensagem).
    const body = String(it?.texto ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, 2000);
    const scope = clean(it?.escopo, 400) || MOTION_OFFER.nome;
    if (!/^lead-[0-9a-f]{12}$/.test(leadId) || !MOTION_OFFER.precos[currency] || body.length < 40) continue;
    out.push({ leadId, currency, body, scope });
  }
  return out;
}

export interface ParsedReferencia {
  marca: string;
  nicho: string;
  url: string;
  vistoEm: string | null;
  linha: string;
}

// Referências semanais: só anúncios com link http(s); números desconhecidos ficam como "?".
export function parseReferencias(raw: any): { referencias: ParsedReferencia[]; avaliacao: { criativo: string; nota: number | null; diferencas: string[] } | null; lacunas: string[] } {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '?');
  const referencias: ParsedReferencia[] = [];
  for (const r of Array.isArray(raw?.referencias) ? raw.referencias : []) {
    let url = '';
    try {
      const u = new URL(String(r?.url ?? ''));
      if (u.protocol === 'https:' || u.protocol === 'http:') url = u.toString();
    } catch {}
    if (!url) continue;
    const marca = clean(r?.marca, 80) || '?';
    const nicho = clean(r?.nicho, 60) || '?';
    const vistoEm = /^\d{4}-\d{2}-\d{2}$/.test(String(r?.visto_em ?? '')) ? String(r.visto_em) : null;
    const linha = `| ${marca} | ${nicho} | ${num(r?.duracao_s)} | ${num(r?.primeiro_corte_s)} | ${num(r?.cortes_por_s)} | ${r?.produto_no_quadro_0 === true ? 'sim' : r?.produto_no_quadro_0 === false ? 'não' : '?'} | ${clean(r?.gancho, 120)} | ${clean(r?.texto, 120)} | ${clean(r?.som, 80)} | ${clean(r?.final, 80)} | [link](${url}) |`;
    referencias.push({ marca, nicho, url, vistoEm, linha: linha.replace(/\n/g, ' ') });
  }
  const a = raw?.avaliacao;
  const avaliacao = a && typeof a === 'object'
    ? { criativo: clean(a.criativo, 160) || '?', nota: typeof a.nota === 'number' && a.nota >= 0 && a.nota <= 10 ? a.nota : null, diferencas: (Array.isArray(a.diferencas) ? a.diferencas : []).map((d: unknown) => clean(d, 300)).filter(Boolean).slice(0, 5) }
    : null;
  const lacunas = (Array.isArray(raw?.lacunas) ? raw.lacunas : []).map((l: unknown) => clean(l, 300)).filter(Boolean).slice(0, 10);
  return { referencias, avaliacao, lacunas };
}

export class Renda {
  readonly store: RendaStore;
  // A atribuição comercial não muda a pasta isolada usada pelos pesquisadores.
  readonly jobPath: string;
  private s: Scheduler;

  constructor(s: Scheduler, opts: { projectPath: string }) {
    this.s = s;
    this.jobPath = opts.projectPath;
    this.store = new RendaStore(s.store);
    s.renda = this;
    mkdirSync(opts.projectPath, { recursive: true });
    s.store.upsertProject({ id: RENDA_PROJECT, name: 'Renda — Criativos Motion', path: opts.projectPath, isGit: false, isTest: true });
  }

  get projectId(): string {
    return this.s.store.getProject(CRIATIVOS_PROJECT) ? CRIATIVOS_PROJECT : RENDA_PROJECT;
  }

  // Operações registradas deste módulo: leads e propostas de um dia.
  handles(planKey: string): boolean {
    return /^comercial:(leads|propostas|referencias):\d{4}-\d{2}-\d{2}$/.test(planKey);
  }

  // Pesquisa com o Hermes (só web) quando ele está instalado e com login; senão, o Claude.
  researchAgent(): RunnableAgent {
    const p = this.s.probes.hermes;
    return p?.installed && p.authenticated !== false && this.s.resolveExe('hermes') ? 'hermes' : 'claude';
  }

  registerRoutines(r: Routines): void {
    r.register({
      id: 'hermes-leads',
      nome: 'Leads Motion',
      descricao: `Pedidos públicos de criativos em vídeo (Reddit, Upwork, LinkedIn, agências): ${LEADS_PER_DAY} leads qualificados por dia útil`,
      agente: 'hermes',
      schedule: '30 6 * * 1-5',
      fire: (ctx) => {
        ctx.claim('leads', ctx.window, (runId) => this.enqueueLeads(ctx.window, runId));
      },
    });
    r.register({
      id: 'claude-propostas',
      nome: 'Propostas do dia',
      descricao: 'Adapta a proposta-base para cada lead qualificado sem proposta (você revisa e envia na aba Hoje)',
      agente: 'claude',
      schedule: '15 7 * * 1-5',
      fire: (ctx) => {
        if (!this.store.leadsAwaitingProposal(this.projectId).length) return;
        ctx.claim('propostas', ctx.window, (runId) => this.enqueueProposals(ctx.window, runId));
      },
    });
    // Comparação contínua (sessão de 28/10, seção 7.5): segunda, depois do alerta legal do Hermes (06h30).
    r.register({
      id: 'hermes-referencias',
      nome: 'Referências de anúncios líderes',
      descricao: 'Atualiza 10 anúncios líderes de referência e compara 1 criativo nosso com eles (semanal)',
      agente: 'hermes',
      schedule: '35 6 * * 1',
      fire: (ctx) => {
        ctx.claim('referencias', ctx.window, (runId) => this.enqueueReferencias(ctx.window, runId));
      },
    });
  }

  enqueueReferencias(window = localDate(new Date()), routineRunId: string | null = null): Job {
    return this.s.enqueue({
      title: `Referências de anúncios líderes (${window})`,
      prompt: 'Atualizar 10 anúncios líderes de referência (só link, data e anotações) e comparar 1 criativo nosso. O servidor grava a nota.',
      agent: this.researchAgent(),
      projectId: this.projectId,
      risk: 'verde',
      timeoutMin: 40,
      kind: 'research',
      planKey: `comercial:referencias:${window}`,
      routineRunId,
    });
  }

  // O criativo da semana fica num arquivo do projeto (o Hermes não vê arquivos locais, só esta descrição).
  private criativoDaSemana(): string {
    const project = this.s.store.getProject(CRIATIVOS_PROJECT);
    const file = project ? join(project.path, 'handoff', 'criativos-motion', 'criativo-da-semana.md') : '';
    if (file && existsSync(file)) return readFileSync(file, 'utf8').slice(0, 4000);
    return 'Nenhum criativo descrito esta semana: devolva "avaliacao": null.';
  }

  enqueueLeads(window = localDate(new Date()), routineRunId: string | null = null): Job {
    return this.s.enqueue({
      title: `Leads Motion (${window})`,
      prompt: 'Pesquisa de leads para Criativos Motion: só páginas públicas, sem contato. O servidor valida e grava.',
      agent: this.researchAgent(),
      projectId: this.projectId,
      risk: 'verde',
      timeoutMin: 30,
      kind: 'research',
      planKey: `comercial:leads:${window}`,
      routineRunId,
    });
  }

  enqueueProposals(window = localDate(new Date()), routineRunId: string | null = null): Job {
    return this.s.enqueue({
      title: `Propostas Motion (${window})`,
      prompt: 'Adaptar a proposta-base para os leads qualificados sem proposta. Sem envio: o Emannuel revisa e envia.',
      agent: 'claude',
      projectId: this.projectId,
      risk: 'verde',
      timeoutMin: 15,
      kind: 'research',
      planKey: `comercial:propostas:${window}`,
      routineRunId,
    });
  }

  prompt(job: Job): string {
    const hoje = localDate(new Date());
    if (job.planKey!.startsWith('comercial:leads:')) {
      const known = this.store.leads(60).map((l) => `${l.company ?? '?'} — ${l.need}`.slice(0, 120));
      return loadPrompt('hermes-pesquisa', {
        hoje,
        fuso: TIMEZONE,
        oferta: MOTION_OFFER.nome,
        meta: LEADS_PER_DAY,
        ja_registrados: known.length ? known.join('; ') : 'nenhum ainda',
        memoria: this.s.memory.promptBlock(),
      });
    }
    if (job.planKey!.startsWith('comercial:referencias:')) {
      return loadPrompt('hermes-referencias', {
        hoje,
        fuso: TIMEZONE,
        oferta: MOTION_OFFER.nome,
        criativo: this.criativoDaSemana(),
        memoria: this.s.memory.promptBlock(),
      });
    }
    const leads = this.store.leadsAwaitingProposal(job.projectId).slice(0, 5);
    return loadPrompt('claude-producao', {
      hoje,
      oferta: MOTION_OFFER.nome,
      leads: JSON.stringify(
        leads.map((l) => ({ lead_id: l.id, canal: l.channel, empresa: l.company, demanda: l.need, evidencia: l.evidence, link: l.sourceUrl, publicado: l.postedAt })),
        null,
        2,
      ),
    }, { projectId: job.projectId, vault: this.s.vault });
  }

  afterResearch(job: Job, o: Outcome): Job {
    if (!o.ok) return this.s.finish(job.id, { status: o.canceled ? 'canceled' : 'failed', error: o.error, summary: o.text, step: o.canceled ? 'Cancelada' : 'Falhou' });
    try {
      const raw = extractJson(o.text ?? '');
      if (job.planKey!.startsWith('comercial:leads:')) {
        const { leads, lacunas, rejeitados } = parseLeads(raw);
        let novos = 0;
        let qualificados = 0;
        for (const l of leads) {
          if (this.store.isDuplicate(l.company, l.need)) continue;
          const r = this.store.addLead({ projectId: job.projectId, ...l });
          if (r.created) {
            novos++;
            if (r.lead.status === 'qualified') qualificados++;
          }
        }
        // Memória do perfil "pesquisa": só itens com procedência e sem dados pessoais.
        this.s.memory.add(raw?.memoria, job.id);
        if (lacunas.length) this.s.store.kvSet(`renda.lacunas.${job.planKey!.slice('comercial:leads:'.length)}`, lacunas);
        if (!leads.length && !lacunas.length) throw new Error('Nenhum lead válido nem lacuna registrada.');
        this.s.emit('renda', null);
        return this.s.finish(job.id, { status: 'done', exitCode: o.code, step: `${novos} lead(s) novo(s), ${qualificados} qualificado(s)${rejeitados ? `, ${rejeitados} recusado(s) na validação` : ''}`, summary: o.text });
      }
      if (job.planKey!.startsWith('comercial:referencias:')) {
        const window = job.planKey!.slice('comercial:referencias:'.length);
        const { referencias, avaliacao, lacunas } = parseReferencias(raw);
        if (referencias.length < 5) throw new Error(`Só ${referencias.length} referência(s) com link; o mínimo é 5.`);
        this.s.memory.add(raw?.memoria, job.id);
        const body = [
          `# Referências de anúncios líderes — ${window}`,
          '',
          `Gerado pela rotina semanal do Hermes (job ${job.id}). Só link e anotações; nenhum vídeo foi baixado.`,
          '',
          '| Marca | Nicho | Duração (s) | 1º corte (s) | Cortes/s | Produto no quadro 0 | Gancho | Texto | Som | Final | Link |',
          '|---|---|---|---|---|---|---|---|---|---|---|',
          ...referencias.map((r) => r.linha),
          '',
          '## Nosso criativo × líderes',
          ...(avaliacao ? [`- Criativo: ${avaliacao.criativo}`, `- Nota (0–10): ${avaliacao.nota ?? '?'}`, ...avaliacao.diferencas.map((d) => `- ${d}`)] : ['- Sem avaliação nesta semana.']),
          ...(lacunas.length ? ['', '## Lacunas', ...lacunas.map((l) => `- ${l}`)] : []),
        ].join('\n');
        const folder = this.s.store.getProject(job.projectId)?.vaultFolder;
        const note = folder && this.s.vault ? this.s.vault.createNote(join(folder, 'Referências semanais'), `Referências ${window}`, { type: 'referencias', data: window, job: job.id }, body) : null;
        return this.s.finish(job.id, { status: 'done', exitCode: o.code, step: `${referencias.length} referência(s)${note ? `; nota ${note}` : ''}`, summary: o.text, vaultNote: note });
      }
      let criadas = 0;
      for (const p of parseProposals(raw)) {
        try {
          if (this.store.lead(p.leadId)?.projectId !== job.projectId) continue;
          this.store.createProposal(p);
          criadas++;
        } catch {
          // Lead inexistente, não qualificado ou já com proposta: ignorado.
        }
      }
      this.s.emit('renda', null);
      return this.s.finish(job.id, { status: 'done', exitCode: o.code, step: `${criadas} proposta(s) pronta(s) para você revisar`, summary: o.text });
    } catch (e: any) {
      return this.s.finish(job.id, { status: 'failed', error: e.message, summary: o.text, step: 'Resposta inválida' });
    }
  }
}
