// Resumo das 8h e alertas deduplicados (v3.1, seção 4.2 "notifications.ts").
// - 08h00: 3 prioridades do Rocky, ações humanas do dia (aba Hoje, 45 min), prazos e AMARELOS agrupados.
// - Alertas (uma vez cada): lead ≥85, proposta vencendo, resposta registrada, vaga ≥75,
//   mudança legal confirmada e grupo pausado.
import type { GitHubView } from '../../../packages/shared/types.ts';
import type { Job } from '../../../packages/shared/types.ts';
import type { JobsResearch, LegalResearch } from '../../../packages/shared/immigration.ts';
import { jobScore } from '../../../packages/shared/immigration-score.ts';
import { LEAD_PREVIEW_MIN } from '../../../packages/shared/renda.ts';
import type { Scheduler } from './scheduler.ts';
import type { Routines } from './routines.ts';
import type { PushPayload } from './push.ts';
import { buildHoje } from './renda/hoje.ts';
import { localDate } from './routines.ts';

const SENT_KEY = 'alertas.enviados';
const VAGA_MIN = 75;

export function buildMorning(s: Scheduler, now = new Date()): PushPayload {
  const hoje = buildHoje(s, now);
  const prio = s.rocky?.last()?.resultados ?? [];
  const amarelos = s.store.jobsByStatus('approval').length;
  const prazos = (s.renda?.store.proposals() ?? []).filter((p) => p.state === 'sent' && p.dueAt && p.dueAt.slice(0, 10) <= localDate(now)).length;
  const parts = [
    prio.length ? `Prioridades: ${prio.map((p, i) => `${i + 1}) ${p.titulo}`).join(' ')}` : 'Sem prioridades do Planejador ainda.',
    `Hoje: ${hoje.itens.length} ação(ões), ~${hoje.totalMin} de ${hoje.orcamentoMin} min.`,
    prazos ? `${prazos} follow-up(s) vencendo.` : '',
    amarelos ? `${amarelos} AMARELO(s) esperando seu OK.` : '',
  ].filter(Boolean);
  return { title: 'Bom dia — resumo das 8h', body: parts.join(' '), url: '/?aba=hoje', tag: `resumo-${localDate(now)}` };
}

export class Alerts {
  private s: Scheduler;
  private send: (p: PushPayload) => unknown;

  constructor(s: Scheduler, send: (p: PushPayload) => unknown) {
    this.s = s;
    this.send = send;
  }

  // Primeira conferência depois de instalar: só registra o que já existe (sem rajada de avisos).
  private baseline = false;

  private once(key: string, p: PushPayload): boolean {
    const sent = new Set(this.s.store.kvGet<string[]>(SENT_KEY) ?? []);
    if (sent.has(key)) return false;
    sent.add(key);
    this.s.store.kvSet(SENT_KEY, [...sent].slice(-2000));
    if (this.baseline) return false;
    this.send(p);
    return true;
  }

  registerRoutines(r: Routines): void {
    r.register({
      id: 'resumo-8h',
      nome: 'Resumo das 8h',
      descricao: '3 prioridades, ações humanas do dia (45 min), prazos e AMARELOS agrupados no celular',
      agente: 'sistema',
      schedule: '0 8 * * *',
      catchUpHours: 3,
      fire: (ctx) => {
        ctx.claim('push', ctx.window, () => null);
        this.once(`resumo:${ctx.window}`, buildMorning(this.s));
      },
    });
  }

  // Confere tudo o que pode virar alerta. Chamado quando renda, imigração ou sistema mudam.
  check(): string[] {
    const fired: string[] = [];
    this.baseline = this.s.store.kvGet(SENT_KEY) === null;
    if (this.baseline) this.s.store.kvSet(SENT_KEY, []);
    const renda = this.s.renda?.store;
    for (const l of renda?.leads(50) ?? []) {
      if (l.score >= LEAD_PREVIEW_MIN && l.status === 'qualified' && this.once(`lead:${l.id}`, { title: `Lead forte (${l.score})`, body: `${l.company ?? l.channel}: ${l.need}`, url: '/?aba=renda', tag: `lead-${l.id}` })) fired.push(`lead:${l.id}`);
    }
    const today = localDate(new Date());
    for (const p of renda?.proposals() ?? []) {
      if (p.state === 'sent' && p.dueAt && p.dueAt.slice(0, 10) <= today && this.once(`vence:${p.id}:${p.dueAt.slice(0, 10)}`, { title: 'Follow-up vencendo', body: `${p.lead?.company ?? 'Proposta'} sem resposta: texto pronto na aba Hoje.`, url: '/?aba=hoje', tag: `vence-${p.id}` })) fired.push(`vence:${p.id}`);
      if (p.state === 'replied' && this.once(`resposta:${p.id}`, { title: 'Cliente respondeu', body: `${p.lead?.company ?? 'Proposta'}: briefing e entrada (50%) na aba Hoje.`, url: '/?aba=hoje', tag: `resp-${p.id}` })) fired.push(`resposta:${p.id}`);
    }
    const imm = this.s.immigration;
    if (imm) {
      const user = imm.user();
      for (const v of this.s.store.kvGet<JobsResearch>('imigracao.jobs')?.vagas ?? []) {
        const sc = jobScore(v, user, today).score;
        if (sc >= VAGA_MIN && this.once(`vaga:${v.url || v.id}`, { title: `Vaga forte (${sc})`, body: `${v.titulo} — ${v.empresa}, ${v.local}`, url: '/?aba=imigracao', tag: `vaga-${v.id}` })) fired.push(`vaga:${v.id}`);
      }
      const legal = this.s.store.kvGet<LegalResearch>('imigracao.legal');
      for (const m of legal?.lei?.mudancas ?? []) {
        const k = `legal:${(m as any).titulo ?? JSON.stringify(m).slice(0, 80)}`;
        if (this.once(k, { title: 'Mudança legal confirmada', body: String((m as any).titulo ?? 'Veja a aba Imigração'), url: '/?aba=imigracao', tag: 'legal' })) fired.push(k);
      }
    }
    for (const g of this.s.capacity.view()) {
      if (g.pausadoAte && this.once(`pausa:${g.id}:${g.pausadoAte}`, { title: `Grupo ${g.id} pausado`, body: `Limite de uso atingido. Volta às ${new Date(g.pausadoAte).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.`, url: '/?aba=agentes', tag: `pausa-${g.id}` })) fired.push(`pausa:${g.id}`);
    }
    this.baseline = false;
    return fired;
  }

  // CI que falhou na branch principal de um projeto (GitHub, só leitura): um aviso por execução.
  githubCi(cards: { nome: string; github?: GitHubView[] }[]): string[] {
    const fired: string[] = [];
    for (const c of cards) {
      for (const g of c.github ?? []) {
        const ci = g.ci;
        if (g.papel !== 'origem' || !ci || ci.estado !== 'falhou') continue;
        const k = `ci:${ci.url}`;
        if (this.once(k, { title: `CI falhou: ${c.nome}`, body: `${ci.nome} na ${ci.branch} (${g.repo}). Abra para ver o motivo.`, url: ci.url, tag: `ci-${g.repo}` })) fired.push(k);
      }
    }
    return fired;
  }

  // Rotina que confere o GitHub dos projetos a cada 30 min.
  registerGitHub(r: Routines, cards: () => Promise<{ nome: string; github?: GitHubView[] }[]>): void {
    r.register({
      id: 'github-ci',
      nome: 'CI dos projetos no GitHub',
      descricao: 'Lê (só leitura) o último CI da branch principal de cada projeto e avisa no celular quando falha',
      agente: 'sistema',
      schedule: '*/30 * * * *',
      fire: async () => {
        this.githubCi(await cards());
      },
    });
  }

  wire(): void {
    // Linha de base agora: o que já existe não vira aviso; o que chegar depois, sim.
    this.check();
    let t: ReturnType<typeof setTimeout> | null = null;
    const later = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => this.check(), 3000);
      t.unref?.();
    };
    for (const ev of ['renda', 'immigration', 'sistema']) this.s.on(ev, later);
    this.s.on('job', (j: Job) => j.kind === 'research' && j.status === 'done' && later());
  }
}
