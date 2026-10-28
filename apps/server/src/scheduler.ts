// Agendador: fila, limites por agente, locks, processos, cancelamento e limite
// de uso. As regras de negócio (planos, revisão cruzada, objetivos, vault) ficam
// no Flow, que é chamado nos pontos de decisão.
import { EventEmitter } from 'node:events';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { AgentState, Job, JobEvent, JobUsage, NewJobInput, Objective, RunnableAgent, Risk } from '../../../packages/shared/types.ts';
import { RUNNABLE_AGENTS } from '../../../packages/shared/types.ts';
import type { JobPatch, NewJobRow, Store } from './db.ts';
import { adapters, type AgentAdapter, type Parsed } from './runners/adapters.ts';
import { startProcess, type RunningProcess } from './runners/process.ts';
import { UsageTracker, combineUsage, watchRollout, type UsageEvent } from './runners/usage.ts';
import { findAgentExe, probeAgent, type ProbeResult } from './agents/discover.ts';
import { buildHarnesses, probeExtra, type ExtraProbe } from './agents/harness.ts';
import { removeWorktree, resolveBase, worktreeDiff } from './worktrees.ts';
import { AGENT_LIMITS, CHECKPOINT_MIN, DEFAULT_TIMEOUT_MIN, LONG_JOB_MIN, USAGE_PAUSE_MIN } from './config.ts';
import { Capacity, GROUP_OF } from './capacity.ts';
import { GameMode, type GameSignals } from './gamemode.ts';
import { execFileSync } from 'node:child_process';
import { Flow, type Outcome } from './flow.ts';
import type { Vault } from './vault.ts';
import type { Immigration } from './immigration/index.ts';
import type { ProjectHistory } from './history.ts';
import type { Market } from './market.ts';
import type { Renda } from './renda/index.ts';
import type { Rocky } from './rocky.ts';
import { AutoMerge } from './automerge.ts';
import { ResearchMemory } from './memory.ts';
import type { Conselho } from './conselho.ts';
import type { Benchmark } from './benchmark.ts';
import type { BenchRunner } from './benchrun.ts';
import type { Chats } from './chat.ts';
import { Routines } from './routines.ts';

export interface SchedulerOptions {
  store: Store;
  logDir: string;
  worktreesDir: string;
  vault?: Vault | null;
  limits?: Partial<Record<RunnableAgent, number>>;
  adapters?: Partial<Record<RunnableAgent, AgentAdapter>>;
  // Permite trocar o executável nos testes.
  resolveExe?: (agent: RunnableAgent) => string | null;
  // Intervalo dos checkpoints (testes usam milissegundos).
  checkpointMs?: number;
  // Sinais do modo jogo (testes usam um falso; o padrão não detecta nada até o index.ts ligar o real).
  gameProbe?: () => Promise<GameSignals>;
}

interface Active {
  proc: RunningProcess;
  log: WriteStream;
  canceled: boolean;
  timedOut: boolean;
  final: { ok: boolean; text: string } | null;
  lastText: string | null;
  usageLimit: string | null;
  usage: UsageTracker;
  usageSavedAt: number;
  stopRollout: (() => void) | null;
  // Uso de tentativas anteriores do mesmo job (retomada depois de limite de uso).
  usageBase: JobUsage | null;
  // Checkpoints: assinatura do progresso no último e quantos seguidos sem mudança.
  lastSig: string;
  noProgress: number;
  stalled: boolean;
}

// Tamanho máximo do contexto por modelo, aprendido nos jobs concluídos.
const CONTEXT_KEY = 'agentes.contexto';

const STATIC_AGENTS: Omit<AgentState, 'runningJobs' | 'paused' | 'pausedReason'>[] = [
  { id: 'claude', name: 'Claude', role: 'Jogos, interface/UX, pesquisa e escrita', runnable: true, installed: false, authenticated: null, version: null, limit: 1, note: null },
  { id: 'codex', name: 'Codex', role: 'Implementação e QA', runnable: true, installed: false, authenticated: null, version: null, limit: 1, note: null },
  { id: 'rocky', name: 'Planejador', role: 'Coordenador: quebra objetivos em planos (executado pelo Claude)', runnable: false, installed: true, authenticated: null, version: null, limit: 0, note: 'Planos executados pelo Claude' },
  { id: 'openclaw', name: 'OpenClaw', role: 'Agente aberto (motor: Claude Code, sem gateway)', runnable: true, installed: false, authenticated: null, version: null, limit: 1, note: null },
  { id: 'hermes', name: 'Hermes', role: 'Agente aberto (Nous Research)', runnable: true, installed: false, authenticated: null, version: null, limit: 1, note: null },
];

export class Scheduler extends EventEmitter {
  store: Store;
  logDir: string;
  worktreesDir: string;
  vault: Vault | null;
  limits: Record<RunnableAgent, number>;
  adapters: Record<RunnableAgent, AgentAdapter>;
  resolveExe: (agent: RunnableAgent) => string | null;
  flow: Flow;
  // Módulos que recebem jobs de pesquisa (registrado pelo próprio módulo).
  immigration: Immigration | null = null;
  history: ProjectHistory | null = null;
  market: Market | null = null;
  renda: Renda | null = null;
  rocky: Rocky | null = null;
  autoMerge: AutoMerge;
  memory: ResearchMemory;
  // Adaptador do OpenClaw com modelo local (ligado no index.ts; testes podem trocar).
  localAdapterFor: ((model: string) => AgentAdapter) | null = null;
  conselho: Conselho | null = null;
  benchmark: Benchmark | null = null;
  benchRunner: BenchRunner | null = null;
  chats: Chats | null = null;
  // Rotinas (v3.1): única autoridade de agendamento.
  routines: Routines;
  active = new Map<string, Active>();
  probes: Partial<Record<RunnableAgent, ProbeResult>> = {};
  usageNotes: Partial<Record<RunnableAgent, string>> = {};
  extras: Partial<Record<'hermes' | 'openclaw', ExtraProbe>> = {};
  private ticking = false;
  private tickAgain = false;
  capacity: Capacity;
  gameMode: GameMode;
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  readonly checkpointMs: number;
  // Motivo atual de espera de cada job na fila (para não repetir o mesmo evento).
  private waitReason = new Map<string, string>();

  constructor(opts: SchedulerOptions) {
    super();
    this.store = opts.store;
    this.logDir = opts.logDir;
    this.worktreesDir = opts.worktreesDir;
    this.vault = opts.vault ?? null;
    this.limits = { ...AGENT_LIMITS, ...(opts.limits ?? {}) };
    this.adapters = { ...adapters, ...(opts.adapters ?? {}) };
    this.resolveExe = opts.resolveExe ?? findAgentExe;
    this.flow = new Flow(this);
    this.routines = new Routines(this.store);
    this.capacity = new Capacity(this.store);
    this.autoMerge = new AutoMerge(this.store, this.worktreesDir);
    this.capacity.localFor = (j) => j.agent === 'openclaw' && !!j.gpuRequired && !!this.benchmark?.modelFor(j.planKey ?? null);
    // Rotina disparada (mesmo sem job, ex.: manutenção): a aba Rotinas recarrega.
    this.routines.onFired = () => this.emit('renda', null);
    this.autoMerge.onRecovered = (jobId, sha) => {
      const j = this.store.getJob(jobId);
      if (!j || j.status === 'done') return;
      const p = this.store.getProject(j.projectId);
      if (p && j.worktree) {
        try {
          removeWorktree(p.path, j.worktree, j.branch);
        } catch {}
      }
      this.finish(jobId, { status: 'done', step: `Auto-merge (${sha.slice(0, 10)}) — concluído na recuperação`, worktree: null }, { keepFinishedAt: true });
    };
    this.memory = new ResearchMemory(this.store);
    this.gameMode = new GameMode(this.store, opts.gameProbe ?? (async () => ({ processes: [], fullscreen: null, gpuUtil: null })));
    this.gameMode.ourGpuBusy = () => this.store.isLocked('gpu', '');
    this.gameMode.onChange = (s) => {
      this.emit('sistema', this.sistema());
      if (!s.ativo) this.tick();
    };
    this.checkpointMs = opts.checkpointMs ?? CHECKPOINT_MIN * 60_000;
    mkdirSync(this.logDir, { recursive: true });
  }

  // Jobs que estavam "rodando" quando o servidor caiu não têm mais processo.
  recoverAfterRestart(): void {
    for (const job of this.store.jobsByStatus('running')) {
      // Fencing de efeitos: confirma que o executor anterior terminou antes de reutilizar
      // capacidade ou GPU (mata a árvore de processos que tiver sobrado).
      const ex = this.store.kvGet<{ pid: number }>(`executor.${job.id}`);
      if (ex?.pid && pidAlive(ex.pid)) {
        try {
          execFileSync('taskkill', ['/PID', String(ex.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } catch {}
      }
      if (ex?.pid && pidAlive(ex.pid)) {
        // Não morreu: capacidade, GPU e o registro do executor ficam presos até ele terminar
        // (a varredura do tick libera). O job sai de "rodando", mas nada novo usa os recursos dele.
        this.addEvent(job.id, 'error', `O executor antigo (PID ${ex.pid}) não encerrou: recursos presos até ele terminar`);
      } else {
        this.store.db.prepare('DELETE FROM kv WHERE key = ?').run(`executor.${job.id}`);
        this.capacity.release(job.id);
        this.store.releaseLocks(job.id);
      }
      this.flow.afterJob(job, { ok: false, code: null, canceled: false, timedOut: false, text: null, error: 'O servidor foi reiniciado durante a execução.' });
    }
    // Integrações interrompidas: reconcilia a tentativa e solta as travas de merge.
    this.autoMerge.recover(this.store.listProjects());
  }

  // Executores antigos que sobreviveram ao reinício: quando terminarem, libera os recursos.
  private reapStale(): void {
    for (const r of this.store.db.prepare("SELECT key, value FROM kv WHERE key LIKE 'executor.%'").all() as any[]) {
      const id = r.key.slice('executor.'.length);
      if (this.active.has(id)) continue;
      const pid = JSON.parse(r.value)?.pid;
      if (pid && pidAlive(pid)) continue;
      this.store.db.prepare('DELETE FROM kv WHERE key = ?').run(r.key);
      this.capacity.release(id);
      this.store.releaseLocks(id);
    }
  }

  // ---------- agentes ----------

  async refreshAgents(): Promise<AgentState[]> {
    for (const a of RUNNABLE_AGENTS) this.probes[a] = await probeAgent(a);
    for (const x of ['hermes', 'openclaw'] as const) this.extras[x] = await probeExtra(x);
    this.emitAgents();
    return this.agents();
  }

  private runningOf(pred: (j: Job) => boolean): string[] {
    return [...this.active.keys()].filter((id) => {
      const j = this.store.getJob(id);
      return !!j && pred(j);
    });
  }

  agents(): AgentState[] {
    return STATIC_AGENTS.map((base) => {
      if (base.id === 'rocky') {
        return { ...base, installed: !!this.resolveExe('claude'), runningJobs: this.runningOf((j) => j.kind === 'plan'), paused: false, pausedReason: null };
      }
      if (base.id !== 'claude' && base.id !== 'codex' && base.id !== 'openclaw' && base.id !== 'hermes') return { ...base, runningJobs: [], paused: false, pausedReason: null };
      const id = base.id;
      const probe = this.probes[id];
      const pause = this.store.getAgentPause(id);
      return {
        ...base,
        installed: probe?.installed ?? !!this.resolveExe(id),
        authenticated: probe?.authenticated ?? null,
        version: probe?.version ?? null,
        limit: this.limits[id],
        runningJobs: this.runningOf((j) => j.agent === id),
        paused: pause.paused || !!this.capacity.pausedUntil(GROUP_OF[id]),
        pausedReason: pause.reason ?? (this.capacity.pausedUntil(GROUP_OF[id]) ? `Grupo ${GROUP_OF[id]} pausado (limite de uso) até ${new Date(this.capacity.pausedUntil(GROUP_OF[id])!).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : null),
        note: this.usageNotes[id] ?? (id === 'openclaw' && probe?.installed ? 'motor: Claude Code (sem chave paga)' : id === 'hermes' && probe?.installed ? 'motor: ChatGPT (sua assinatura)' : id === 'hermes' && !(probe?.installed ?? !!this.resolveExe(id)) ? 'Não instalado — veja a aba Agentes' : null),
      };
    });
  }

  // Aba Agentes: harnesses, agentes de cada um e estado de instalação.
  harnesses() {
    const lastModel: Partial<Record<string, string | null>> = {};
    for (const j of this.store.listJobs(100)) if (j.usage?.model && !lastModel[j.agent]) lastModel[j.agent] = j.usage.model;
    return buildHarnesses({ agents: this.agents(), projects: this.store.listProjects(), extras: this.extras, lastModel, routines: this.routines?.views() ?? [] });
  }

  emitAgents() {
    this.emit('agents', this.agents());
  }

  // Estado do sistema para a interface: capacidade por grupo, GPU e modo jogo.
  sistema() {
    const gpu = this.store.db.prepare("SELECT job_id FROM locks WHERE key = 'gpu'").get() as any;
    return { capacidade: this.capacity.view(), gpu: gpu ? { jobId: gpu.job_id, titulo: this.store.getJob(gpu.job_id)?.title ?? null } : null, modoJogo: this.gameMode.state(), autoMerge: this.autoMerge?.state() };
  }

  resumeAgent(agent: RunnableAgent): void {
    this.store.setAgentPause(agent, false);
    this.capacity.resume(GROUP_OF[agent]);
    this.emitAgents();
    this.tick();
  }

  // ---------- criação e ações ----------

  // Job avulso criado pela interface.
  createJob(input: NewJobInput): Job {
    const project = this.store.getProject(input.projectId);
    if (!project) throw new Error('Projeto não encontrado');
    if (!RUNNABLE_AGENTS.includes(input.agent)) throw new Error('Agente inválido');
    if (!input.title?.trim() || !input.prompt?.trim()) throw new Error('Título e tarefa são obrigatórios');
    return this.enqueue({
      title: input.title.trim(),
      prompt: input.prompt.trim(),
      agent: input.agent,
      projectId: project.id,
      risk: input.risk ?? 'verde',
      timeoutMin: input.timeoutMin ?? DEFAULT_TIMEOUT_MIN,
      gpuRequired: !!input.gpuRequired,
    });
  }

  // Cria um job aplicando as regras de risco e o coloca na fila.
  enqueue(row: Omit<NewJobRow, 'status'> & { status?: NewJobRow['status'] }): Job {
    // v3.1: teto de 120 min (com checkpoint a cada 15). Acima disso, recusado.
    if (!(row.timeoutMin <= LONG_JOB_MIN)) throw new Error(`Jobs acima de ${LONG_JOB_MIN} min não são aceitos: divida em partes menores.`);
    const timeoutMin = Math.max(1, Math.round(row.timeoutMin));
    const risk: Risk = row.risk;
    if (risk === 'vermelho') throw new Error('Ações VERMELHAS não são executadas por agentes: o sistema só prepara e você faz manualmente.');
    const job = this.store.createJob({ ...row, risk, timeoutMin, status: row.status ?? (risk === 'amarelo' ? 'approval' : 'queued') });
    this.addEvent(job.id, 'status', job.status === 'approval' ? 'Criado — aguardando sua aprovação (AMARELO)' : 'Criado — na fila');
    this.emitJob(job);
    this.tick();
    return job;
  }

  retry(id: string): Job {
    return this.flow.retry(this.mustGet(id));
  }

  cancel(id: string): Job {
    const job = this.mustGet(id);
    const act = this.active.get(id);
    if (act) {
      act.canceled = true;
      this.addEvent(id, 'status', 'Cancelamento pedido — encerrando processos');
      act.proc.kill();
      return job;
    }
    if (job.status === 'queued' || job.status === 'approval') {
      return this.flow.afterJob(job, { ok: false, code: null, canceled: true, timedOut: false, text: null, error: null });
    }
    throw new Error(`Não dá para cancelar um job com status "${job.status}"`);
  }

  // AMARELO: aprova o início de um job, ou o merge de um job em revisão.
  approve(id: string): Job {
    const job = this.mustGet(id);
    if (job.status === 'approval') {
      this.addEvent(id, 'status', 'Aprovado por você — na fila');
      const j = this.setJob(id, { status: 'queued', step: 'Na fila' });
      this.tick();
      return j;
    }
    if (job.status === 'review') return this.flow.approveReview(job);
    throw new Error(`Nada para aprovar num job com status "${job.status}"`);
  }

  discard(id: string): Job {
    return this.flow.discard(this.mustGet(id));
  }

  requestReview(id: string): Job {
    return this.flow.requestReview(this.mustGet(id));
  }

  diff(id: string) {
    const job = this.mustGet(id);
    if (!job.worktree) return { files: job.filesChanged, stat: '', diff: '', truncated: false };
    const project = this.store.getProject(job.projectId)!;
    return worktreeDiff(job.worktree, resolveBase(project.path, job.worktree, job.baseCommit));
  }

  // ---------- fila ----------

  tick(): void {
    // Dentro de uma transação (ex.: reserva de rotina), começa depois do COMMIT.
    if (this.store.db.isTransaction) {
      setImmediate(() => this.tick());
      return;
    }
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    this.ticking = true;
    try {
      this.reapStale();
      do {
        this.tickAgain = false;
        // Entrega de cliente esperando a GPU: nenhum job interno pega a placa antes dela.
        const clientGpu = this.store.jobsByStatus('queued').some((j) => j.gpuRequired && this.capacity.isClient(j));
        for (const agent of RUNNABLE_AGENTS) {
          if (this.store.getAgentPause(agent).paused) continue;
          let running = this.runningOf((j) => j.agent === agent).length;
          const queued = this.store.jobsByStatus('queued', agent);
          // Entregas de cliente passam na frente (inclusive na fila de GPU).
          queued.sort((a, b) => Number(this.capacity.isClient(b)) - Number(this.capacity.isClient(a)));
          for (const job of queued) {
            if (running >= this.limits[agent]) break;
            if (!this.flow.depsSatisfied(job)) continue;
            const key = this.flow.lockKey(job);
            if (key && this.store.isLocked(key, job.id)) continue;
            const game = this.gameMode.blocks(job);
            if (game) {
              this.waiting(job, game);
              continue;
            }
            if (job.gpuRequired && clientGpu && !this.capacity.isClient(job)) {
              this.waiting(job, 'Aguardando a GPU: entrega de cliente tem prioridade');
              continue;
            }
            if (job.gpuRequired && this.store.isLocked('gpu', job.id)) {
              this.waiting(job, 'Aguardando a GPU (outro job está usando)');
              continue;
            }
            const cap = this.capacity.reserve(job);
            if (!cap.ok) {
              this.waiting(job, `Aguardando capacidade: ${cap.motivo}`);
              continue;
            }
            this.waitReason.delete(job.id);
            if (this.start(job, key)) running++;
            else this.capacity.release(job.id);
          }
        }
      } while (this.tickAgain);
    } finally {
      this.ticking = false;
    }
  }

  private waiting(job: Job, reason: string) {
    if (this.waitReason.get(job.id) === reason) return;
    this.waitReason.set(job.id, reason);
    this.addEvent(job.id, 'status', reason);
    this.setJob(job.id, { step: reason });
    // Entrega de cliente parada pelo jogo: pergunta em vez de interromper.
    if (reason.startsWith('Modo jogo') && job.gpuRequired && this.capacity.isClient(job)) {
      this.emit('notify', { kind: 'gpu-cliente', job, text: `Entrega de cliente esperando a GPU: posso usar a placa por ~${job.timeoutMin} min?` });
    }
  }

  private start(job: Job, lockKey: string | null): boolean {
    if (job.gpuRequired && !this.store.acquireLock('gpu', job.id)) return false;
    const exe = this.resolveExe(job.agent);
    if (!exe) {
      this.store.releaseLocks(job.id);
      this.flow.afterJob(job, { ok: false, code: null, canceled: false, timedOut: false, text: null, error: `${job.agent} não encontrado neste PC` });
      return false;
    }
    let place: { cwd: string; worktree: string | null; branch: string | null; base: string | null };
    let prompt: string;
    try {
      place = this.flow.prepare(job);
      job = this.store.updateJob(job.id, { worktree: place.worktree, branch: place.branch, baseCommit: place.base });
      prompt = this.flow.prompt(job);
    } catch (e: any) {
      this.store.releaseLocks(job.id);
      this.flow.afterJob(job, { ok: false, code: null, canceled: false, timedOut: false, text: null, error: `Não consegui preparar o job: ${String(e.stderr ?? e.message).trim()}` });
      return false;
    }
    if (lockKey) this.store.acquireLock(lockKey, job.id);

    // OpenClaw com GPU numa tarefa aprovada no benchmark (≥ 80% do Claude) = motor local,
    // com o modelo vencedor daquela tarefa. Sem aprovação, segue no motor normal.
    const localModel = job.agent === 'openclaw' && job.gpuRequired ? (this.benchmark?.modelFor(job.planKey) ?? null) : null;
    const adapter = localModel && this.localAdapterFor ? this.localAdapterFor(localModel) : this.adapters[job.agent];
    const { args, stdin, env } = adapter.buildArgs(job, place.cwd, prompt);
    const parse = adapter.createParser?.() ?? adapter.parse;
    const log = createWriteStream(join(this.logDir, `${job.id}.jsonl`), { flags: 'a' });
    const known = this.store.kvGet<Record<string, number>>(CONTEXT_KEY) ?? {};
    const act: Active = {
      proc: null as any, log, canceled: false, timedOut: false, final: null, lastText: null, usageLimit: null,
      usage: new UsageTracker((m) => known[m] ?? null), usageSavedAt: 0, stopRollout: null, usageBase: job.usage,
      lastSig: '', noProgress: 0, stalled: false,
    };
    this.active.set(job.id, act);

    this.setJob(job.id, { status: 'running', startedAt: new Date().toISOString(), step: 'Iniciando', error: null });
    this.routines?.store.markRunning(job);
    this.addEvent(job.id, 'status', `Rodando com ${job.agent} em ${place.cwd}`);
    this.emitAgents();

    act.proc = startProcess({
      exe: exe.endsWith('.mjs') ? process.execPath : exe,
      args: exe.endsWith('.mjs') ? [exe, ...args] : args,
      cwd: place.cwd,
      stdin,
      env,
      timeoutMs: job.timeoutMin * 60_000,
      onLine: (line) => {
        log.write(line + '\n');
        for (const p of parse(line)) this.onParsed(job.id, job.agent, act, p);
      },
      onStderr: (t) => {
        log.write(JSON.stringify({ type: 'emannu.stderr', text: t }) + '\n');
        if (/usage limit|rate limit|429/i.test(t)) act.usageLimit ??= t.trim().slice(0, 200);
      },
      onTimeout: () => {
        act.timedOut = true;
        this.addEvent(job.id, 'error', `Tempo esgotado (${job.timeoutMin} min) — encerrando processos`);
      },
    });
    act.proc.done.then(({ code }) => this.onExit(job.id, code));
    if (act.proc.pid) this.store.kvSet(`executor.${job.id}`, { pid: act.proc.pid, at: new Date().toISOString() });
    this.ensureCheckpoints();
    return true;
  }

  private onParsed(jobId: string, agent: RunnableAgent, act: Active, p: Parsed) {
    if (p.usageNote) {
      this.usageNotes[agent] = p.usageNote;
      this.emitAgents();
    }
    if (p.sessionId) {
      this.setJob(jobId, { sessionId: p.sessionId });
      // Codex: uso ao vivo vem do arquivo de sessão dele.
      if (agent === 'codex' && !act.stopRollout) act.stopRollout = watchRollout(p.sessionId, (e) => this.onUsage(jobId, act, e));
    }
    if (p.usage) this.onUsage(jobId, act, p.usage, p.usage.type === 'total');
    if (p.usageLimit) act.usageLimit ??= p.text;
    if (p.final) act.final = p.final;
    if (p.kind === 'text') act.lastText = p.text;
    if (p.silent) return;
    this.addEvent(jobId, p.kind, p.text);
    if (p.kind === 'tool' || p.kind === 'text' || p.kind === 'system') {
      this.setJob(jobId, { step: p.kind === 'text' ? 'Escrevendo' : p.text.slice(0, 120) });
    }
  }

  private onUsage(jobId: string, act: Active, e: UsageEvent, force = false) {
    act.usage.apply(e);
    // Grava no máximo a cada 1,5 s (o stream do Claude manda vários eventos por segundo).
    if (!force && Date.now() - act.usageSavedAt < 1500) return;
    act.usageSavedAt = Date.now();
    this.setJob(jobId, { usage: combineUsage(act.usageBase, act.usage.usage) });
  }

  // ---------- checkpoints (a cada 15 min) ----------
  // Progresso verificável = eventos novos no log ou tokens novos. Dois checkpoints
  // seguidos sem progresso encerram a tentativa, preservando log e worktree.
  private ensureCheckpoints() {
    if (this.checkpointTimer) return;
    this.checkpointTimer = setInterval(() => this.checkpoint(), this.checkpointMs);
    this.checkpointTimer.unref?.();
  }

  checkpoint(): void {
    if (!this.active.size && this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
      return;
    }
    for (const [id, act] of this.active) {
      const ev = (this.store.db.prepare('SELECT count(*) n FROM job_events WHERE job_id = ?').get(id) as any).n;
      const u = act.usage.usage;
      const sig = `${ev}|${u.output}|${u.calls}|${u.input}`;
      act.noProgress = sig === act.lastSig ? act.noProgress + 1 : 0;
      act.lastSig = sig;
      const at = new Date().toISOString();
      const job = this.setJob(id, { lastCheckpointAt: at });
      if (job.routineRunId) {
        const run = this.routines.store.runById(job.routineRunId);
        if (run?.jobId === id) this.routines.store.checkpoint(run.id, run.fence, { em: at, eventos: ev, saida: u.output });
      }
      if (act.noProgress >= 2 && !act.stalled) {
        act.stalled = true;
        this.addEvent(id, 'error', 'Sem progresso verificável em 2 checkpoints seguidos — encerrando a tentativa (log e arquivos preservados)');
        act.proc.kill();
      }
    }
  }

  private onExit(jobId: string, code: number | null) {
    const act = this.active.get(jobId)!;
    act.stopRollout?.();
    this.capacity.release(jobId);
    this.store.db.prepare('DELETE FROM kv WHERE key = ?').run(`executor.${jobId}`);
    const u = act.usage.usage;
    if (act.usage.seen) {
      this.store.updateJob(jobId, { usage: combineUsage(act.usageBase, u) });
      if (u.model && u.contextMax) {
        const known = this.store.kvGet<Record<string, number>>(CONTEXT_KEY) ?? {};
        if (known[u.model] !== u.contextMax) this.store.kvSet(CONTEXT_KEY, { ...known, [u.model]: u.contextMax });
      }
    }
    act.log.end();
    this.active.delete(jobId);
    this.store.releaseLocks(jobId);
    const job = this.store.getJob(jobId)!;
    const text = act.final?.text || act.lastText || null;

    if (act.usageLimit && !act.canceled) {
      // Limite de uso: pausa o GRUPO inteiro (ex.: Codex e Hermes dividem a cota do ChatGPT),
      // mostra quando volta e devolve o job para a fila.
      const until = new Date(Date.now() + USAGE_PAUSE_MIN * 60_000);
      this.capacity.pause(GROUP_OF[job.agent], until);
      this.emit('sistema', this.sistema());
      if (job.kind === 'task' && job.worktree) {
        const project = this.store.getProject(job.projectId)!;
        try {
          removeWorktree(project.path, job.worktree, job.branch);
        } catch {}
      }
      this.addEvent(jobId, 'error', 'Limite de uso atingido — fila do agente pausada; o job voltou para a fila');
      const keep = job.kind === 'review' || job.kind === 'fix';
      this.setJob(jobId, { status: 'queued', step: 'Aguardando o limite de uso liberar', startedAt: null, ...(keep ? {} : { worktree: null, branch: null, baseCommit: null }) });
      this.emit('notify', { kind: 'paused', agent: job.agent, text: act.usageLimit });
    } else {
      const ok = !act.canceled && !act.timedOut && !act.stalled && code === 0 && act.final?.ok !== false;
      const error = act.stalled
        ? 'Sem progresso verificável em 2 checkpoints seguidos (tentativa encerrada; log e arquivos preservados)'
        : act.timedOut ? `Tempo esgotado (${job.timeoutMin} min)` : ok ? null : act.final?.text || `Processo terminou com código ${code}`;
      try {
        this.flow.afterJob(job, { ok, code, canceled: act.canceled, timedOut: act.timedOut, text, error });
      } catch (e: any) {
        this.setJob(jobId, { status: 'failed', error: `Erro interno ao concluir o job: ${e.message}`, finishedAt: new Date().toISOString() });
      }
    }
    this.emitAgents();
    this.tick();
  }

  // ---------- utilitários usados pelo Flow ----------

  setJob(id: string, patch: JobPatch): Job {
    const j = this.store.updateJob(id, patch);
    this.emit('job', j);
    return j;
  }

  // Encerra um job: grava a hora de término e anuncia o status final.
  finish(id: string, patch: JobPatch, opts: { keepFinishedAt?: boolean } = {}): Job {
    const j = this.setJob(id, { ...patch, ...(opts.keepFinishedAt ? {} : { finishedAt: new Date().toISOString() }) });
    if (patch.status && !['review', 'reviewing'].includes(patch.status)) this.addEvent(id, 'status', `Status final: ${patch.status}${patch.error ? ` — ${patch.error}` : ''}`);
    if (['review', 'failed', 'done'].includes(j.status) && j.kind === 'task') this.emit('notify', { kind: j.status, job: j });
    this.rocky?.onJobFinished(j);
    return j;
  }

  setObjective(id: string, patch: Parameters<Store['updateObjective']>[1]): Objective {
    const o = this.store.updateObjective(id, patch);
    this.emit('objective', o);
    return o;
  }

  addEvent(jobId: string, kind: JobEvent['kind'], text: string) {
    this.emit('event', this.store.addEvent(jobId, kind, text));
  }

  emitJob(job: Job) {
    this.emit('job', job);
  }

  mustGet(id: string): Job {
    const j = this.store.getJob(id);
    if (!j) throw new Error('Job não encontrado');
    return j;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
