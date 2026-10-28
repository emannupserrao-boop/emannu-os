// Rocky em ciclo (v3.1, seção 8): às 07h00 e 17h30 (dias úteis), depois de conclusões ou
// falhas (com intervalo e sem repetir a mesma situação) e quando algo destrava.
// Lê objetivos, funil, prazos, capacidade e bloqueios; cria jobs DENTRO dos limites
// (10 descendentes por objetivo, profundidade 2, orçamento) numa transação; pede tempo
// extra ao Emannuel pela aba Hoje. Nunca aprova AMARELO/VERMELHO.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { Job, RunnableAgent } from '../../../packages/shared/types.ts';
import { RUNNABLE_AGENTS } from '../../../packages/shared/types.ts';
import type { Scheduler } from './scheduler.ts';
import type { Outcome } from './flow.ts';
import { localDate, type Routines } from './routines.ts';
import { LONG_JOB_MIN, TIMEZONE } from './config.ts';
import { loadPrompt } from './prompts/load.ts';
import { extractJson } from './immigration/topics.ts';
import { clean } from './renda/index.ts';

export const ROCKY_PROJECT = 'rocky';
export const MAX_DESCENDANTS = 10;
export const MAX_DEPTH = 2;
const MAX_JOBS_PER_RUN = 6;
const MAX_EVENT_RUNS_PER_DAY = 6;
const EVENT_DEBOUNCE_MS = 10 * 60_000;
// Ações que só o Emannuel faz: viram pedido humano, nunca job.
const RED = /\b(envi[aeo]|mand(ar|e) (mensage|e-?mail|proposta)|public|postar|cobr[aeo]|pag(ar|ue|amento)|gast[aeo]|compr[aeo]|credenc|senha|token|chave de api|api key|candidat|apag(ar|ue) .*fora|exp(or|onha) .*internet|funnel)/i;
const YELLOW = /\b(instal(ar|e) (programa|aplicativo|o lm studio)|auth\.ts|pin\b|permiss|migra[cç][aã]o destrutiva|drop table|firewall|acl\b)/i;
const TYPES = ['venda', 'entrega', 'desbloqueio'];

export interface RockyResult {
  tipo: string;
  titulo: string;
  objetivoId: string | null;
}

export interface RockyPedido {
  id: string;
  titulo: string;
  minutos: number;
  motivo: string;
  resposta: 'sim' | 'nao' | null;
}

export interface RockyLast {
  em: string;
  jobId: string | null;
  resultados: RockyResult[];
  pedidos: RockyPedido[];
  criados: string[];
  recusados: { titulo: string; motivo: string }[];
}

const objKey = (objectiveId: string) => `rocky-obj:${objectiveId}:`;

export class Rocky {
  private s: Scheduler;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(s: Scheduler, opts: { projectPath: string }) {
    this.s = s;
    s.rocky = this;
    mkdirSync(opts.projectPath, { recursive: true });
    s.store.upsertProject({ id: ROCKY_PROJECT, name: 'Planejador (Claude)', path: opts.projectPath, isGit: false, isTest: true });
  }

  handles(planKey: string): boolean {
    return /^rocky:\d{4}-\d{2}-\d{2}:[\w#-]+$/.test(planKey);
  }

  last(): RockyLast | null {
    return this.s.store.kvGet<RockyLast>('rocky.ultimo');
  }

  registerRoutines(r: Routines): void {
    const fire = (momento: string) => (ctx: { window: string; claim: (s: string, k: string, c: (runId: string) => Job | null) => unknown }) => {
      ctx.claim('loop', `${ctx.window}@${momento}`, (runId) => this.enqueue(ctx.window, momento, runId));
    };
    r.register({ id: 'rocky-manha', nome: 'Planejador: plano do dia', descricao: 'Lê funil, prazos, capacidade e bloqueios; define os 3 resultados do dia e cria os jobs', agente: 'claude', schedule: '0 7 * * 1-5', catchUpHours: 3, fire: fire('manha') });
    r.register({ id: 'rocky-tarde', nome: 'Planejador: fechamento', descricao: 'Reconcilia o realizado, o caixa confirmado e os bloqueios; prepara o dia seguinte', agente: 'claude', schedule: '30 17 * * 1-5', catchUpHours: 3, fire: fire('tarde') });
    r.register({ id: 'rocky-eventos', nome: 'Planejador: após conclusões', descricao: 'Replaneja depois de conclusões, falhas ou desbloqueios (no máximo 6 por dia, sem repetir a mesma situação)', agente: 'claude', schedule: '0 0 1 1 *', enabled: true, fire: () => {} });
  }

  // Conclusão ou falha de outro job: agenda um replanejamento (coalescendo eventos).
  onJobFinished(job: Job): void {
    if (job.projectId === ROCKY_PROJECT || !['done', 'failed', 'review'].includes(job.status)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.eventTick();
    }, EVENT_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  // Idempotente: a mesma situação (hash) não gera outro Rocky; limite diário.
  eventTick(now = new Date()): Job | null {
    if (!this.s.routines.store.enabled('rocky-eventos')) return null;
    const pending = this.s.store.db.prepare("SELECT 1 FROM jobs WHERE project_id = ? AND status IN ('queued','running') LIMIT 1").get(ROCKY_PROJECT);
    if (pending) return null;
    const day = localDate(now);
    const today = (this.s.store.db.prepare("SELECT count(*) n FROM routine_runs WHERE routine_id = 'rocky-eventos' AND input_key LIKE ?").get(`${day}#%`) as any).n;
    if (today >= MAX_EVENT_RUNS_PER_DAY) return null;
    const hash = createHash('sha256').update(this.situacao(false)).digest('hex').slice(0, 16);
    const r = this.s.routines.store.claim('rocky-eventos', 'evento', `${day}#${hash}`, (runId) => this.enqueue(day, 'evento', runId));
    return r.created ? r.job : null;
  }

  enqueue(window: string, momento: string, routineRunId: string | null = null): Job {
    return this.s.enqueue({
      title: `Planejador: ${momento === 'manha' ? 'plano do dia' : momento === 'tarde' ? 'fechamento do dia' : 'replanejamento'} (${window})`,
      prompt: 'Ler a situação e definir até 3 resultados, os jobs (dentro dos limites) e os pedidos ao Emannuel.',
      agent: 'claude',
      projectId: ROCKY_PROJECT,
      risk: 'verde',
      timeoutMin: 15,
      kind: 'research',
      planKey: `rocky:${window}:${momento}`,
      routineRunId,
    });
  }

  // Retrato da situação (JSON compacto). "full" inclui horários (o hash usa sem eles).
  situacao(full = true): string {
    const st = this.s.store;
    const objectives = st.listObjectives(50).filter((o) => !['done', 'canceled', 'failed'].includes(o.status));
    const income = this.s.renda?.store.income();
    const jobs = st.listJobs(150);
    const last = this.last();
    const data = {
      objetivos: objectives.map((o) => ({ id: o.id, titulo: o.title, status: o.status, projeto: o.projectId, descendentes: this.descendants(o.id) })),
      funil: income ? { ...income.funil, recebido: income.recebido, previsto: income.previsto } : null,
      propostas_vencendo: (income?.propostas ?? []).filter((p) => p.dueAt && p.state === 'sent').map((p) => ({ id: p.id, quem: p.lead?.company ?? p.lead?.channel, vence: full ? p.dueAt : null })),
      candidaturas_prontas: (this.s.renda?.store.applications() ?? []).filter((a) => a.state === 'package_ready').length,
      fila: jobs.filter((j) => ['queued', 'running', 'approval'].includes(j.status) && j.projectId !== ROCKY_PROJECT).map((j) => ({ titulo: j.title, agente: j.agent, status: j.status })),
      bloqueados: jobs.filter((j) => ['review', 'failed'].includes(j.status) && j.kind === 'task').slice(0, 10).map((j) => ({ id: j.id, titulo: j.title, status: j.status, passo: j.step })),
      capacidade: this.s.capacity.view().map((g) => ({ grupo: g.id, usado: g.usadoHoje, limite: g.dailyMinutes, pausadoAte: g.pausadoAte })),
      modo_jogo: this.s.gameMode.state().ativo,
      ...(full ? { respostas_do_emannuel: (last?.pedidos ?? []).filter((p) => p.resposta).map((p) => ({ pedido: p.titulo, resposta: p.resposta })), ultimos_resultados: last?.resultados ?? [] } : {}),
    };
    return JSON.stringify(data, null, full ? 2 : 0);
  }

  prompt(job: Job): string {
    const momento = job.planKey!.split(':')[2];
    return loadPrompt('rocky', {
      agora: new Date().toLocaleString('pt-BR', { timeZone: TIMEZONE }),
      fuso: TIMEZONE,
      momento: momento === 'manha' ? 'início do dia (07h00)' : momento === 'tarde' ? 'fechamento (17h30)' : 'depois de uma conclusão ou falha',
      situacao: this.situacao(true),
    });
  }

  descendants(objectiveId: string): number {
    // Revisões e correções herdam a ligação (plan_key), então já entram nesta conta.
    return (this.s.store.db.prepare('SELECT count(*) n FROM jobs WHERE objective_id = ? OR plan_key LIKE ?').get(objectiveId, `${objKey(objectiveId)}%`) as any).n;
  }

  overLimit(planKey: string): boolean {
    const id = /^rocky-obj:(obj-[^:]+):/.exec(planKey)?.[1];
    return !!id && this.descendants(id) >= MAX_DESCENDANTS;
  }

  // Valida e cria os jobs numa transação (duas rodadas ao mesmo tempo não passam do limite).
  apply(raw: any, rockyJob: Pick<Job, 'id' | 'depth'> | null = null): RockyLast {
    const resultados: RockyResult[] = (Array.isArray(raw?.resultados) ? raw.resultados : [])
      .map((r: any) => ({ tipo: clean(r?.tipo, 20).toLowerCase(), titulo: clean(r?.titulo, 160), objetivoId: clean(r?.objetivo_id, 60) || null }))
      .filter((r: RockyResult) => TYPES.includes(r.tipo) && r.titulo)
      .slice(0, 3);
    const pedidos: RockyPedido[] = (Array.isArray(raw?.pedidos_humanos) ? raw.pedidos_humanos : []).slice(0, 5).map((p: any, i: number) => ({
      id: `ped-${Date.now().toString(36)}-${i}`,
      titulo: clean(p?.titulo, 160),
      minutos: Math.max(1, Math.min(240, Math.round(Number(p?.minutos) || 10))),
      motivo: clean(p?.motivo, 300),
      resposta: null,
    })).filter((p: RockyPedido) => p.titulo);
    const criados: string[] = [];
    const recusados: { titulo: string; motivo: string }[] = [];
    const items: any[] = Array.isArray(raw?.jobs) ? raw.jobs : [];
    this.s.store.transaction(() => {
      for (const [i, it] of items.entries()) {
        const titulo = clean(it?.titulo, 160);
        const tarefa = String(it?.tarefa ?? '').trim().slice(0, 4000);
        const recusa = (motivo: string) => recusados.push({ titulo: titulo || `job ${i + 1}`, motivo });
        if (i >= MAX_JOBS_PER_RUN) { recusa(`mais de ${MAX_JOBS_PER_RUN} jobs numa rodada`); continue; }
        if (!titulo || !tarefa) { recusa('sem título ou tarefa'); continue; }
        const agent = String(it?.agente ?? '') as RunnableAgent;
        if (!RUNNABLE_AGENTS.includes(agent)) { recusa('agente inválido'); continue; }
        const project = this.s.store.getProject(clean(it?.projeto, 60));
        if (!project) { recusa('projeto inexistente'); continue; }
        const minutos = Math.round(Number(it?.minutos) || 30);
        if (minutos < 5 || minutos > LONG_JOB_MIN) { recusa(`duração fora de 5–${LONG_JOB_MIN} min`); continue; }
        // Frases negadas ("não enviar nada", "nenhum contato") não tornam o job VERMELHO.
        const affirmative = `${titulo}. ${tarefa}`.replace(/\b(n[aã]o|nenhum[a]?|sem|nunca)\b[^.;:\n]*/gi, ' ');
        if (String(it?.risco ?? '').toLowerCase() === 'vermelho' || RED.test(affirmative)) { recusa('ação do Emannuel (VERMELHO): vira pedido humano'); pedidos.push({ id: `ped-${Date.now().toString(36)}-r${i}`, titulo, minutos: 10, motivo: 'Ação que só você faz.', resposta: null }); continue; }
        const parent = it?.pai ? this.s.store.getJob(clean(it.pai, 40)) : null;
        if (it?.pai && !parent) { recusa('job pai inexistente'); continue; }
        const depth = (parent?.depth ?? rockyJob?.depth ?? 0) + 1;
        if (depth > MAX_DEPTH) { recusa(`profundidade acima de ${MAX_DEPTH}`); continue; }
        const inherited = /^rocky-obj:(obj-[^:]+):/.exec(parent?.planKey ?? '')?.[1] ?? parent?.objectiveId ?? null;
        const objectiveId = clean(it?.objetivo_id, 60) || inherited;
        let planKey: string | null = null;
        if (objectiveId) {
          const obj = this.s.store.getObjective(objectiveId);
          if (!obj || ['done', 'canceled', 'failed'].includes(obj.status)) { recusa('objetivo inexistente ou encerrado'); continue; }
          const n = this.descendants(objectiveId);
          if (n >= MAX_DESCENDANTS) { recusa(`objetivo já tem ${MAX_DESCENDANTS} jobs`); continue; }
          const b = this.s.store.db.prepare('SELECT budget_minutes b, spent_minutes s FROM objectives WHERE id = ?').get(objectiveId) as any;
          const open = (this.s.store.db.prepare("SELECT coalesce(sum(timeout_min),0) m FROM jobs WHERE (objective_id = ? OR plan_key LIKE ?) AND status IN ('queued','running','approval')").get(objectiveId, `${objKey(objectiveId)}%`) as any).m;
          if (b?.b != null && b.s + open + minutos > b.b) { recusa('orçamento de minutos do objetivo'); continue; }
          planKey = `${objKey(objectiveId)}${n + 1}`;
        }
        const dup = this.s.store.db.prepare("SELECT 1 FROM jobs WHERE title = ? AND status IN ('queued','running','approval') LIMIT 1").get(titulo);
        if (dup) { recusa('já está na fila'); continue; }
        const amarelo = String(it?.risco ?? '').toLowerCase() === 'amarelo' || YELLOW.test(`${titulo} ${tarefa}`);
        const job = this.s.enqueue({
          title: titulo,
          prompt: tarefa,
          acceptance: clean(it?.criterio_aceite, 600) || null,
          agent,
          projectId: project.id,
          risk: amarelo ? 'amarelo' : 'verde',
          gpuRequired: it?.gpu === true,
          timeoutMin: minutos,
          kind: 'task',
          planKey,
          parentJobId: parent?.id ?? rockyJob?.id ?? null,
          depth,
        });
        criados.push(job.id);
      }
    });
    // Pedidos ainda sem resposta (e respostas da última semana) continuam valendo.
    const week = Date.now() - 7 * 86_400_000;
    const keep = (this.last()?.pedidos ?? []).filter((p) => !p.resposta || Number.parseInt(p.id.split('-')[1] ?? '0', 36) > week);
    const result: RockyLast = { em: new Date().toISOString(), jobId: rockyJob?.id ?? null, resultados, pedidos: [...keep, ...pedidos.filter((p) => !keep.some((k) => k.titulo === p.titulo))], criados, recusados };
    this.s.store.kvSet('rocky.ultimo', result);
    this.s.emit('renda', null);
    return result;
  }

  answer(pedidoId: string, resposta: 'sim' | 'nao'): RockyLast {
    const last = this.last();
    if (!last?.pedidos.some((p) => p.id === pedidoId)) throw new Error('Pedido não encontrado');
    const next = { ...last, pedidos: last.pedidos.map((p) => (p.id === pedidoId ? { ...p, resposta } : p)) };
    this.s.store.kvSet('rocky.ultimo', next);
    this.s.emit('renda', null);
    return next;
  }

  afterResearch(job: Job, o: Outcome): Job {
    if (!o.ok) return this.s.finish(job.id, { status: o.canceled ? 'canceled' : 'failed', error: o.error, summary: o.text, step: 'Falhou' });
    try {
      const r = this.apply(extractJson(o.text ?? ''), job);
      return this.s.finish(job.id, { status: 'done', exitCode: o.code, step: `${r.resultados.length} resultado(s), ${r.criados.length} job(s) criado(s)${r.recusados.length ? `, ${r.recusados.length} recusado(s)` : ''}`, summary: o.text });
    } catch (e: any) {
      return this.s.finish(job.id, { status: 'failed', error: e.message, summary: o.text, step: 'Resposta inválida' });
    }
  }
}
