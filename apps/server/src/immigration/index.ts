// Módulo Imigração Portugal: pesquisas (jobs do Claude, só leitura + web) — vagas e
// apartamentos 1x ao dia, o resto 1x por semana —,
// dados que você edita (status de documentos, prazos, orçamento, vagas) e as
// notas em 40 - PERSONAL/Imigração Portugal.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Job, RunnableAgent } from '../../../../packages/shared/types.ts';
import {
  DAILY_TOPICS, DEFAULT_USER, TOPIC_LABEL,
  type Apartment, type ApartmentsResearch, type DocFile, type DocsResearch, type ImmigrationState, type ImmigrationUser, type JobOffer, type JobsResearch, type ResearchRun, type ResearchTopic, type Verification,
} from '../../../../packages/shared/immigration.ts';
import { AI_VAULT_FOLDER } from '../config.ts';
import type { Scheduler } from '../scheduler.ts';
import type { Outcome } from '../flow.ts';
import type { FireContext, Routines } from '../routines.ts';
import type { ApplicationState } from '../../../../packages/shared/renda.ts';
import { jobScore } from '../../../../packages/shared/immigration-score.ts';
import { PARSERS, extractJson, importLegacyOffers, isAiOffer, matchDoc, normalizeSource, researchPrompt } from './topics.ts';
import { NOTE_NAMES, buildAiJobsNote, buildNotes } from './notes.ts';

export const IMMIGRATION_PROJECT = 'imigracao';
const TOPICS: ResearchTopic[] = ['legal', 'docs', 'living', 'jobs', 'aiJobs', 'apartamentos'];
const WEEKLY_TOPICS = TOPICS.filter((t) => !DAILY_TOPICS.includes(t));
const KEY = (k: string) => `imigracao.${k}`;
const today = () => new Date().toISOString().slice(0, 10);

export interface ImmigrationOptions {
  projectPath: string;
  docsDir: string;
  vaultFolder: string;
  legacyOffersPath?: string | null;
  researchEveryDays: number;
}

export class Immigration {
  private s: Scheduler;
  private opts: ImmigrationOptions;
  private notesTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(s: Scheduler, opts: ImmigrationOptions) {
    this.s = s;
    this.opts = opts;
    s.immigration = this;
  }

  private get store() {
    return this.s.store;
  }

  init(): void {
    mkdirSync(this.opts.projectPath, { recursive: true });
    this.store.upsertProject({ id: IMMIGRATION_PROJECT, name: 'Imigração Portugal', path: this.opts.projectPath, isGit: false, vaultFolder: this.opts.vaultFolder });
    this.ensureDocsFolder();
    // As vagas do cockpit antigo são todas trabalhos remotos de IA: vão para "Vagas de IA".
    if (!this.store.kvGet(KEY('aiJobs')) && !this.store.kvGet(KEY('jobs')) && this.opts.legacyOffersPath && existsSync(this.opts.legacyOffersPath)) {
      try {
        const vagas = importLegacyOffers(JSON.parse(readFileSync(this.opts.legacyOffersPath, 'utf8')));
        this.store.kvSet(KEY('aiJobs'), { geradoEm: today(), vagas } satisfies JobsResearch);
      } catch (e: any) {
        console.warn('Não consegui importar as vagas do legado:', e.message);
      }
    }
    this.splitOffers();
    // Reescreve as notas ao iniciar (o formato pode ter mudado numa atualização do sistema).
    if (this.store.kvGet(KEY('runs'))) setTimeout(() => this.writeNotes(), 1000);
    // Candidatura pronta: quando o rascunho termina, a vaga passa para "pronta (você envia)".
    this.s.on('job', (job: Job) => {
      if (job.projectId !== IMMIGRATION_PROJECT || job.kind !== 'task' || !job.planKey?.startsWith('vaga:') || job.status !== 'done') return;
      const id = job.planKey.slice(5);
      const user = this.user();
      if (user.vagas[id]?.status === 'preparar') this.updateUser({ vagas: { [id]: { status: 'pronta', nota: `Rascunho em ${join(this.opts.projectPath, 'candidaturas', `${id}.md`)}` } } });
    });
  }

  // A pasta de referência é sua: o sistema só garante que ela existe e lê o que está nela.
  private ensureDocsFolder(): void {
    try {
      mkdirSync(this.opts.docsDir, { recursive: true });
    } catch (e: any) {
      console.warn(`Não consegui acessar a pasta de documentos ${this.opts.docsDir}:`, e.message);
    }
  }

  // Arquivos da pasta de referência (nome, tamanho, data) e o item do checklist que
  // parece corresponder. Só aparece no app; nomes de arquivos não vão para o vault.
  files(): DocFile[] {
    const root = this.opts.docsDir;
    if (!existsSync(root)) return [];
    const items = this.store.kvGet<DocsResearch>(KEY('docs'))?.itens ?? [];
    const out: DocFile[] = [];
    const walk = (dir: string, depth: number) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') || out.length >= 300) continue;
        const abs = join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 3) walk(abs, depth + 1);
          continue;
        }
        const st = statSync(abs);
        out.push({ nome: e.name, pasta: relative(root, dir), kb: Math.round(st.size / 1024), modificado: st.mtime.toISOString(), sugestao: matchDoc(e.name, items) });
      }
    };
    walk(root, 0);
    return out.sort((a, b) => a.pasta.localeCompare(b.pasta) || a.nome.localeCompare(b.nome));
  }

  user(): ImmigrationUser {
    const u = this.store.kvGet<Partial<ImmigrationUser>>(KEY('user')) ?? {};
    return { ...DEFAULT_USER, ...u, apartamentos: u.apartamentos ?? {}, orcamento: { ...DEFAULT_USER.orcamento, ...(u.orcamento ?? {}) } };
  }

  private runs(): ResearchRun[] {
    const saved = this.store.kvGet<ResearchRun[]>(KEY('runs')) ?? [];
    return TOPICS.map((topic) => {
      const r = saved.find((x) => x.topic === topic) ?? { topic, jobId: null, status: 'nunca' as const, lastOkAt: null, error: null };
      // O status vivo vem do job.
      const job = r.jobId ? this.store.getJob(r.jobId) : null;
      if (job?.status === 'queued') return { ...r, status: 'na_fila' };
      if (job?.status === 'running') return { ...r, status: 'rodando' };
      return r;
    });
  }

  private saveRun(topic: ResearchTopic, patch: Partial<ResearchRun>): void {
    const runs = this.runs().map((r) => (r.topic === topic ? { ...r, ...patch } : r));
    this.store.kvSet(KEY('runs'), runs);
  }

  // Vagas de Portugal ficam na Imigração; trabalhos remotos de IA vão para a seção IA.
  // Move o que estiver no lugar errado (ex.: dados anteriores à separação).
  private splitOffers(): void {
    const pt = this.store.kvGet<JobsResearch>(KEY('jobs'));
    const ai = this.store.kvGet<JobsResearch>(KEY('aiJobs'));
    const all = [...(pt?.vagas ?? []), ...(ai?.vagas ?? [])];
    if (!all.length) return;
    const isAi = all.filter(isAiOffer);
    const isPt = all.filter((v) => !isAiOffer(v));
    const sameAsBefore = isPt.length === (pt?.vagas.length ?? 0) && isAi.length === (ai?.vagas.length ?? 0) && isPt.every((v) => pt?.vagas.some((x) => x.id === v.id));
    if (sameAsBefore) return;
    this.store.kvSet(KEY('jobs'), { geradoEm: pt?.geradoEm ?? today(), vagas: isPt } satisfies JobsResearch);
    this.store.kvSet(KEY('aiJobs'), { geradoEm: ai?.geradoEm ?? pt?.geradoEm ?? today(), vagas: isAi } satisfies JobsResearch);
  }

  state(): ImmigrationState {
    return {
      verificacao: this.store.kvGet(KEY('verificacao')),
      legal: this.store.kvGet(KEY('legal')),
      docs: this.store.kvGet(KEY('docs')),
      living: this.store.kvGet(KEY('living')),
      jobs: this.store.kvGet(KEY('jobs')),
      aiJobs: this.store.kvGet(KEY('aiJobs')),
      apartamentos: this.store.kvGet(KEY('apartamentos')),
      arquivos: this.files(),
      user: this.user(),
      research: this.runs(),
      docsFolder: this.opts.docsDir,
      vaultFolder: this.opts.vaultFolder,
    };
  }

  private changed(): void {
    this.syncApplications();
    this.s.emit('immigration', this.state());
    this.s.emit('renda', null);
    if (this.notesTimer) clearTimeout(this.notesTimer);
    this.notesTimer = setTimeout(() => this.writeNotes(), 2000);
  }

  writeNotes(): string[] {
    const vault = this.s.vault;
    if (!vault?.exists()) return [];
    const notes = buildNotes(this.state(), today());
    const written: string[] = [];
    for (const name of NOTE_NAMES) {
      try {
        written.push(vault.upsertGeneratedNote(this.opts.vaultFolder, name, { type: 'imigracao', gerado_por: 'emannu-os', atualizado: today() }, notes[name]));
      } catch (e: any) {
        console.warn(`Nota ${name}:`, e.message);
      }
    }
    // Vagas de IA: nota própria na área de carreira do vault.
    try {
      written.push(vault.upsertGeneratedNote(AI_VAULT_FOLDER, 'Vagas de IA', { type: 'vagas-ia', gerado_por: 'emannu-os', atualizado: today() }, buildAiJobsNote(this.state(), today())));
    } catch (e: any) {
      console.warn('Nota Vagas de IA:', e.message);
    }
    return written;
  }

  // ---------- pesquisas ----------

  handles(planKey: string): boolean {
    return TOPICS.includes(planKey as ResearchTopic);
  }

  // Pesquisas com o Hermes (só web) quando ele está instalado e com login; senão, o Claude.
  researchAgent(): RunnableAgent {
    const p = this.s.probes.hermes;
    return p?.installed && p.authenticated !== false && this.s.resolveExe('hermes') ? 'hermes' : 'claude';
  }

  private enqueueTopic(topic: ResearchTopic, routineRunId: string | null = null): Job {
    const job = this.s.enqueue({
      title: `Pesquisa: ${TOPIC_LABEL[topic]}`,
      prompt: `Pesquisa ${DAILY_TOPICS.includes(topic) ? 'diária' : 'semanal'} do módulo Imigração Portugal — ${TOPIC_LABEL[topic]}. Fontes oficiais para requisitos legais, cada afirmação com link e data de verificação.`,
      agent: this.researchAgent(),
      projectId: IMMIGRATION_PROJECT,
      risk: 'verde',
      timeoutMin: 40,
      kind: 'research',
      planKey: topic,
      routineRunId,
    });
    this.saveRun(topic, { jobId: job.id, status: 'na_fila', error: null });
    return job;
  }

  // Pedido manual (botão "Pesquisar"): não mexe nas rotinas.
  runResearch(topics: ResearchTopic[] = TOPICS): ResearchRun[] {
    for (const topic of topics) {
      if (!TOPICS.includes(topic)) throw new Error(`Pesquisa desconhecida: ${topic}`);
      const run = this.runs().find((r) => r.topic === topic)!;
      if (run.status === 'na_fila' || run.status === 'rodando') continue;
      this.enqueueTopic(topic);
    }
    this.changed();
    return this.runs();
  }

  // Agenda (v3.1): vagas e apartamentos todo dia às 06h30; alerta legal, documentos e custo
  // de vida às segundas, 06h30. Uma execução por tema e por dia, mesmo com reinícios.
  registerRoutines(r: Routines): void {
    const fire = (topics: ResearchTopic[]) => (ctx: FireContext) => {
      for (const topic of topics) {
        const run = this.runs().find((x) => x.topic === topic)!;
        // Pesquisa manual já na fila ou rodando: a rotina não cria outra.
        if (run.status === 'na_fila' || run.status === 'rodando') continue;
        ctx.claim(topic, ctx.window, (runId) => this.enqueueTopic(topic, runId));
      }
      this.changed();
    };
    r.register({ id: 'hermes-vagas', nome: 'Vagas e apartamentos', descricao: 'Vagas (Portugal, perto de Leiria, e IA) e apartamentos', agente: 'hermes', schedule: '30 6 * * *', fire: fire(DAILY_TOPICS) });
    r.register({ id: 'hermes-legal', nome: 'Alerta legal e documentos', descricao: 'Lei e AIMA, lista de documentos e custo de vida (semanal)', agente: 'hermes', schedule: '30 6 * * 1', fire: fire(WEEKLY_TOPICS) });
  }

  // Candidaturas (tabela job_applications) a partir das vagas e do status que você marca.
  syncApplications(): void {
    const renda = this.s.renda;
    if (!renda) return;
    const user = this.user();
    // "Enviada" e "entrevista" são estados humanos: só mudam pela API com confirmação
    // (POST /api/applications/:id/transition), nunca por esta sincronização.
    const map: Record<string, ApplicationState | null> = { nova: 'found', interessante: 'found', preparar: 'found', pronta: 'package_ready', enviada: null, entrevista: null, descartada: 'discarded' };
    for (const key of ['jobs', 'aiJobs'] as const) {
      for (const v of this.store.kvGet<JobsResearch>(KEY(key))?.vagas ?? []) {
        if (!v.url) continue;
        try {
          renda.store.upsertApplication({
            id: v.id,
            sourceUrl: v.url,
            collectedAt: v.encontradaEm ? `${v.encontradaEm.slice(0, 10)}T00:00:00.000Z` : undefined,
            employer: v.empresa || null,
            title: v.titulo,
            location: v.local || null,
            score: jobScore(v, user, today()).score,
            state: map[user.vagas[v.id]?.status ?? 'nova'] ?? renda.store.application(v.url, 'url')?.state ?? 'found',
            notes: user.vagas[v.id]?.nota || null,
          });
        } catch (e: any) {
          console.warn('Candidatura:', e.message);
        }
      }
    }
  }

  prompt(job: Job): string {
    return researchPrompt(job.planKey as ResearchTopic, today());
  }

  afterResearch(job: Job, o: Outcome): Job {
    const topic = job.planKey as ResearchTopic;
    if (!o.ok) {
      this.saveRun(topic, { status: 'falhou', error: o.canceled ? 'cancelada' : (o.error ?? 'falhou') });
      const j = this.s.finish(job.id, { status: o.canceled ? 'canceled' : 'failed', error: o.error, summary: o.text, step: o.canceled ? 'Cancelada' : 'Falhou' });
      this.changed();
      return j;
    }
    try {
      let data = PARSERS[topic](extractJson(o.text), today());
      if (topic === 'jobs' || topic === 'aiJobs') data = this.mergeOffers(topic, data as JobsResearch);
      if (topic === 'apartamentos') data = this.mergeApartments(data as ApartmentsResearch);
      this.store.kvSet(KEY(topic), data);
      this.saveRun(topic, { status: 'ok', lastOkAt: new Date().toISOString(), error: null });
      const j = this.s.finish(job.id, { status: 'done', exitCode: o.code, step: 'Pesquisa salva no módulo Imigração', summary: o.text });
      this.changed();
      return j;
    } catch (e: any) {
      this.saveRun(topic, { status: 'falhou', error: e.message });
      const j = this.s.finish(job.id, { status: 'failed', error: e.message, summary: o.text, step: 'Resposta inválida' });
      this.changed();
      return j;
    }
  }

  // Vagas novas da pesquisa + vagas do legado + vagas que você já está acompanhando.
  private mergeOffers(topic: 'jobs' | 'aiJobs', fresh: JobsResearch): JobsResearch {
    const prev = this.store.kvGet<JobsResearch>(KEY(topic))?.vagas ?? [];
    const user = this.user();
    // "encontradaEm": a primeira vez que o EMANNU OS viu a vaga (para "mais novas" e "Nova").
    const seen = (v: JobOffer) => prev.find((x) => x.id === v.id || x.url === v.url);
    // Mesma vaga (mesmo link) com outro id: mantém o id antigo (candidaturas e status usam ele).
    // Também recupera pela tabela de candidaturas (vaga que saiu da lista e voltou depois).
    const known = (v: JobOffer) => seen(v)?.id ?? (v.url ? this.s.renda?.store.application(v.url, 'url')?.id : undefined);
    const out: JobOffer[] = fresh.vagas.map((v) => ({ ...v, id: known(v) ?? v.id, encontradaEm: seen(v)?.encontradaEm ?? seen(v)?.verificadoEm ?? today() }));
    const has = (v: JobOffer) => out.some((x) => x.id === v.id || x.url === v.url);
    // Vagas verificadas nos últimos 30 dias também ficam (uma rodada focada numa região não apaga as outras).
    const recent = (v: JobOffer) => !!v.verificadoEm && Date.now() - Date.parse(v.verificadoEm) <= 30 * 86_400_000;
    for (const v of prev) if ((v.origem === 'legado' || recent(v) || (user.vagas[v.id] && user.vagas[v.id].status !== 'nova')) && !has(v)) out.push({ ...v, encontradaEm: v.encontradaEm ?? v.verificadoEm });
    return { geradoEm: fresh.geradoEm, vagas: out };
  }

  // Apartamentos saem rápido: ficam os vistos nos últimos 14 dias e os que você marcou.
  private mergeApartments(fresh: ApartmentsResearch): ApartmentsResearch {
    const prev = this.store.kvGet<ApartmentsResearch>(KEY('apartamentos'))?.apartamentos ?? [];
    const user = this.user();
    const seen = (a: Apartment) => prev.find((x) => x.id === a.id || x.url === a.url);
    const out: Apartment[] = fresh.apartamentos.map((a) => ({ ...a, encontradaEm: seen(a)?.encontradaEm ?? today() }));
    const has = (a: Apartment) => out.some((x) => x.id === a.id || x.url === a.url);
    const recent = (a: Apartment) => Date.now() - Date.parse(a.verificadoEm) <= 14 * 86_400_000;
    const marked = (a: Apartment) => ['interessante', 'visitar'].includes(user.apartamentos[a.id]?.status ?? '');
    for (const a of prev) if ((recent(a) || marked(a)) && !has(a)) out.push(a);
    return { geradoEm: fresh.geradoEm, apartamentos: out };
  }

  // Registra uma conferência independente (substitui a anterior).
  setVerification(v: Verification): ImmigrationState {
    const items = (v.itens ?? []).map((it) => ({
      afirmacao: String(it.afirmacao ?? ''),
      resultado: (['confirmado', 'diverge', 'nao_confirmado'] as const).includes(it.resultado) ? it.resultado : 'nao_confirmado',
      detalhe: String(it.detalhe ?? ''),
      fontes: (it.fontes ?? []).map((f) => normalizeSource(f, today())).filter((f): f is NonNullable<typeof f> => !!f),
    }));
    if (!items.length) throw new Error('Conferência sem itens');
    this.store.kvSet(KEY('verificacao'), { feitaEm: String(v.feitaEm || today()), por: String(v.por || '—'), itens: items });
    this.changed();
    return this.state();
  }

  // ---------- edições suas ----------

  updateUser(patch: Partial<ImmigrationUser>): ImmigrationState {
    const u = this.user();
    const next: ImmigrationUser = {
      ...u,
      ...(patch.fimEmprego !== undefined ? { fimEmprego: String(patch.fimEmprego) } : {}),
      ...(patch.autorizacaoRomeniaAte !== undefined ? { autorizacaoRomeniaAte: String(patch.autorizacaoRomeniaAte) } : {}),
      ...(patch.diasParaNovoEmpregador !== undefined ? { diasParaNovoEmpregador: Math.max(0, Math.min(365, Number(patch.diasParaNovoEmpregador) || 0)) } : {}),
      orcamento: { ...u.orcamento, ...Object.fromEntries(Object.entries(patch.orcamento ?? {}).map(([k, v]) => [k, Math.max(0, Number(v) || 0)])) },
      docs: { ...u.docs, ...(patch.docs ?? {}) },
      vagas: { ...u.vagas, ...(patch.vagas ?? {}) },
      apartamentos: { ...u.apartamentos, ...(patch.apartamentos ?? {}) },
      eventos: patch.eventos ?? u.eventos,
    };
    for (const [id, d] of Object.entries(next.docs)) {
      if (d.validoAte && !/^\d{4}-\d{2}-\d{2}$/.test(d.validoAte)) throw new Error(`Data inválida em ${id}`);
    }
    this.store.kvSet(KEY('user'), next);
    this.changed();
    return this.state();
  }

  // Prepara o rascunho de candidatura (VERDE). Enviar é VERMELHO: sempre você.
  prepareApplication(vagaId: string): Job {
    const s = this.state();
    const ai = s.aiJobs?.vagas.find((v) => v.id === vagaId);
    const vaga = ai ?? s.jobs?.vagas.find((v) => v.id === vagaId);
    if (!vaga) throw new Error('Vaga não encontrada');
    const file = `candidaturas/${vaga.id}.md`;
    const cv = ai ? 'o currículo de IA' : 'o currículo no idioma do anúncio';
    const job = this.s.enqueue({
      title: `Rascunho de candidatura: ${vaga.empresa} — ${vaga.titulo}`,
      prompt: `Escreva o arquivo ${file} com um RASCUNHO de candidatura para a vaga abaixo. O Emannuel revisa e envia ele mesmo: NÃO envie nada, não abra formulários, não crie contas.

Vaga: ${vaga.empresa} — ${vaga.titulo} (${vaga.local}, ${vaga.modalidade})
Anúncio: ${vaga.url}
Por que combina: ${vaga.porque}
Condições: ${vaga.condicoes.join('; ')}

Candidato: o usuário do EMANNU OS. Use como base ${cv}, na pasta ${this.opts.docsDir} (só leitura): o perfil sai do currículo, não deste prompt.

O arquivo deve ter: (1) carta de apresentação no idioma do anúncio, com no máximo 250 palavras; (2) respostas curtas para 3 perguntas prováveis; (3) checklist do que ele precisa conferir antes de enviar${ai ? ', incluindo se a plataforma aceita residentes na Romênia/Portugal e como paga' : ', incluindo se a vaga aceita candidatos de fora de Portugal e se patrocina visto'}. Não invente experiência, certificações nem números: use só o que está no currículo. Se puder, abra o anúncio para ajustar o texto.`,
      agent: 'claude',
      projectId: 'imigracao',
      risk: 'verde',
      timeoutMin: 20,
      kind: 'task',
      planKey: `vaga:${vaga.id}`,
    });
    this.updateUser({ vagas: { [vaga.id]: { status: 'preparar', nota: '' } } });
    return job;
  }
}
