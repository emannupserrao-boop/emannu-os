// Capacidade por grupo de cota (v3.1, seção 4.2):
// - claude (Claude, Rocky, OpenClaw via claude-cli), chatgpt (Codex, Hermes) e local;
// - 30% dos minutos do dia de cada grupo ficam reservados para jobs de cliente (sem empréstimo);
// - a reserva é feita no início (minutos do teto do job) e acertada pelo consumo real no fim,
//   uma única vez (retomadas e reinícios não liberam em dobro);
// - limite de uso detectado: o grupo inteiro pausa até a hora informada.
import type { Job, RunnableAgent } from '../../../packages/shared/types.ts';
import type { Store } from './db.ts';
import { localDate } from './routines.ts';

export type GroupId = 'claude' | 'chatgpt' | 'local';

export const GROUP_OF: Record<RunnableAgent, GroupId> = { claude: 'claude', openclaw: 'claude', codex: 'chatgpt', hermes: 'chatgpt' };
export const GROUP_AGENTS: Record<GroupId, string[]> = { claude: ['Claude', 'Planejador', 'OpenClaw'], chatgpt: ['Codex', 'Hermes'], local: ['Modelo local'] };

const DEFAULTS: Record<GroupId, { maxParallel: number; dailyMinutes: number }> = {
  claude: { maxParallel: 2, dailyMinutes: 600 },
  chatgpt: { maxParallel: 2, dailyMinutes: 600 },
  local: { maxParallel: 1, dailyMinutes: 1440 },
};

export interface GroupView {
  id: GroupId;
  agentes: string[];
  maxParallel: number;
  dailyMinutes: number;
  reservedPct: number;
  usadoHoje: number;
  reservadoAgora: number;
  rodando: number;
  pausadoAte: string | null;
}

export class Capacity {
  private store: Store;
  private now: () => Date;

  constructor(store: Store, now: () => Date = () => new Date()) {
    this.store = store;
    this.now = now;
    store.db.exec('CREATE TABLE IF NOT EXISTS capacity_usage (group_id TEXT NOT NULL, day TEXT NOT NULL, minutes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (group_id, day))');
    for (const [id, d] of Object.entries(DEFAULTS)) {
      store.db.prepare('INSERT OR IGNORE INTO capacity_groups (id, max_parallel, daily_minutes, reserved_pct) VALUES (?, ?, ?, 30)').run(id, d.maxParallel, d.dailyMinutes);
    }
  }

  private get db() {
    return this.store.db;
  }

  // Job que roda no modelo local (definido pelo Scheduler: OpenClaw + GPU + tarefa aprovada no benchmark).
  localFor: (job: Pick<Job, 'agent'> & Partial<Pick<Job, 'gpuRequired' | 'planKey'>>) => boolean = () => false;

  groupOf(job: Pick<Job, 'agent'> & Partial<Pick<Job, 'gpuRequired' | 'planKey'>> & { gpuLocal?: boolean }): GroupId {
    return job.gpuLocal || this.localFor(job) ? 'local' : GROUP_OF[job.agent];
  }

  // Job de cliente: entrega (planKey "entrega:…") ou objetivo de resultado "entrega".
  isClient(job: Job): boolean {
    if (job.planKey?.startsWith('entrega:')) return true;
    const objectiveId = job.objectiveId ?? /^rocky-obj:(obj-[^:]+):/.exec(job.planKey ?? '')?.[1] ?? null;
    if (!objectiveId) return false;
    const r = this.db.prepare('SELECT outcome_kind FROM objectives WHERE id = ?').get(objectiveId) as any;
    return r?.outcome_kind === 'entrega';
  }

  private group(id: GroupId) {
    return this.db.prepare('SELECT * FROM capacity_groups WHERE id = ?').get(id) as any;
  }

  setGroup(id: GroupId, patch: { maxParallel?: number; dailyMinutes?: number; reservedPct?: number }): void {
    const g = this.group(id);
    this.db
      .prepare('UPDATE capacity_groups SET max_parallel = ?, daily_minutes = ?, reserved_pct = ? WHERE id = ?')
      .run(patch.maxParallel ?? g.max_parallel, patch.dailyMinutes ?? g.daily_minutes, patch.reservedPct ?? g.reserved_pct, id);
  }

  usedToday(id: GroupId): number {
    const r = this.db.prepare('SELECT minutes FROM capacity_usage WHERE group_id = ? AND day = ?').get(id, localDate(this.now())) as any;
    return r?.minutes ?? 0;
  }

  private reservedNow(id: GroupId): { minutes: number; running: number } {
    // Toda reserva viva conta (inclusive a feita agora, antes de o job virar "running").
    const r = this.db.prepare('SELECT coalesce(sum(reserved_minutes), 0) m, count(*) n FROM jobs WHERE capacity_group_id = ? AND reserved_minutes > 0').get(id) as any;
    return { minutes: r.m, running: r.n };
  }

  pausedUntil(id: GroupId): string | null {
    const g = this.group(id);
    return g?.paused_until && Date.parse(g.paused_until) > this.now().getTime() ? g.paused_until : null;
  }

  pause(id: GroupId, until: Date): void {
    this.db.prepare('UPDATE capacity_groups SET paused_until = ? WHERE id = ?').run(until.toISOString(), id);
  }

  resume(id: GroupId): void {
    this.db.prepare('UPDATE capacity_groups SET paused_until = NULL WHERE id = ?').run(id);
  }

  // Reserva atômica antes de iniciar. Devolve o motivo quando não cabe.
  reserve(job: Job, gpuLocal = false): { ok: true; group: GroupId } | { ok: false; motivo: string } {
    const id = this.groupOf({ agent: job.agent, gpuLocal, gpuRequired: job.gpuRequired, planKey: job.planKey });
    return this.store.transaction(() => {
      const g = this.group(id);
      if (this.pausedUntil(id)) return { ok: false, motivo: `grupo ${id} pausado até ${g.paused_until}` };
      const now = this.reservedNow(id);
      if (now.running >= g.max_parallel) return { ok: false, motivo: `grupo ${id} no limite de ${g.max_parallel} job(s) ao mesmo tempo` };
      const limit = this.isClient(job) ? g.daily_minutes : Math.floor((g.daily_minutes * (100 - g.reserved_pct)) / 100);
      if (this.usedToday(id) + now.minutes + job.timeoutMin > limit) {
        return { ok: false, motivo: `cota do dia do grupo ${id} (${limit} min${this.isClient(job) ? '' : `, ${g.reserved_pct}% reservados a clientes`})` };
      }
      this.db.prepare('UPDATE jobs SET capacity_group_id = ?, reserved_minutes = ? WHERE id = ?').run(id, job.timeoutMin, job.id);
      return { ok: true, group: id };
    });
  }

  // Acerto pelo consumo real. Só a primeira chamada conta (reserved_minutes volta a 0).
  release(jobId: string): number {
    return this.store.transaction(() => {
      const j = this.db.prepare('SELECT capacity_group_id g, reserved_minutes r, started_at s, finished_at f, objective_id o, plan_key k FROM jobs WHERE id = ?').get(jobId) as any;
      if (!j?.g || !j.r) return 0;
      const end = j.f ? Date.parse(j.f) : this.now().getTime();
      const used = j.s ? Math.max(1, Math.ceil((end - Date.parse(j.s)) / 60_000)) : 0;
      this.db.prepare('UPDATE jobs SET reserved_minutes = 0 WHERE id = ? AND reserved_minutes > 0').run(jobId);
      this.db
        .prepare('INSERT INTO capacity_usage (group_id, day, minutes) VALUES (?, ?, ?) ON CONFLICT(group_id, day) DO UPDATE SET minutes = minutes + excluded.minutes')
        .run(j.g, localDate(this.now()), used);
      const objectiveId = j.o ?? /^rocky-obj:(obj-[^:]+):/.exec(j.k ?? '')?.[1] ?? null;
      if (objectiveId && used) this.db.prepare('UPDATE objectives SET spent_minutes = spent_minutes + ? WHERE id = ?').run(used, objectiveId);
      return used;
    });
  }

  view(): GroupView[] {
    return (['claude', 'chatgpt', 'local'] as GroupId[]).map((id) => {
      const g = this.group(id);
      const now = this.reservedNow(id);
      return {
        id,
        agentes: GROUP_AGENTS[id],
        maxParallel: g.max_parallel,
        dailyMinutes: g.daily_minutes,
        reservedPct: g.reserved_pct,
        usadoHoje: this.usedToday(id),
        reservadoAgora: now.minutes,
        rodando: now.running,
        pausadoAte: this.pausedUntil(id),
      };
    });
  }
}
