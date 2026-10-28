// Rotinas do EMANNU OS (v3.1): a ÚNICA autoridade de agendamento.
// - Cada rotina tem um horário cron ("min hora dia mês dia-da-semana") e um fuso.
// - Cada disparo reserva, numa transação BEGIN IMMEDIATE, uma execução por
//   (rotina, escopo, janela): dois relógios, dois servidores ou um reinício não duplicam.
// - Retomadas reutilizam o registro e incrementam o "fence"; a conclusão de um job
//   que não é mais o executor atual é rejeitada.
import { randomBytes } from 'node:crypto';
import type { Job } from '../../../packages/shared/types.ts';
import type { RoutineView, RunState } from '../../../packages/shared/renda.ts';
import type { Store } from './db.ts';
import { TIMEZONE } from './config.ts';

// ---------- cron e fuso ----------

interface Cron {
  min: number[];
  hour: number[];
  dom: Set<number>;
  mon: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

function field(spec: string, lo: number, hi: number): number[] {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const [range, stepS] = part.split('/');
    const step = stepS ? Number(stepS) : 1;
    let a = lo;
    let b = hi;
    if (range !== '*') {
      const [x, y] = range.split('-').map(Number);
      a = x;
      b = y ?? (stepS ? hi : x);
    }
    if (![a, b, step].every(Number.isInteger) || a < lo || b > hi || a > b || step < 1) throw new Error(`Horário inválido: "${spec}"`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return [...out].sort((x, y) => x - y);
}

export function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`Horário inválido: "${expr}" (use "min hora dia mês dia-da-semana")`);
  return {
    min: field(f[0], 0, 59),
    hour: field(f[1], 0, 23),
    dom: new Set(field(f[2], 1, 31)),
    mon: new Set(field(f[3], 1, 12)),
    dow: new Set(field(f[4], 0, 7).map((d) => d % 7)),
    domAny: f[2] === '*',
    dowAny: f[4] === '*',
  };
}

const fmts = new Map<string, Intl.DateTimeFormat>();
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function zonedParts(date: Date, tz: string) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
    fmts.set(tz, f);
  }
  const o = Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
  return { y: Number(o.year), m: Number(o.month), d: Number(o.day), h: Number(o.hour) % 24, mi: Number(o.minute), dow: WEEK.indexOf(o.weekday) };
}

const offsetMs = (t: number, tz: string) => {
  const p = zonedParts(new Date(t), tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(t / 60_000) * 60_000;
};

// Hora local (no fuso) → instante UTC. Duas passadas acertam a troca de horário de verão.
// Horário que não existe (o relógio pula, ex.: 03:30 no fim de março em Bucareste):
// dispara no primeiro minuto válido depois do salto (04:00), como o cron tradicional.
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - offsetMs(guess, tz);
  t = guess - offsetMs(t, tz);
  const p = zonedParts(new Date(t), tz);
  if (p.h !== h || p.mi !== mi) {
    // Procura, minuto a minuto numa janela de ±3 h, o primeiro instante cuja hora local
    // é igual ou posterior à pedida (a hora pedida não existe naquele dia).
    const key = (q: { y: number; m: number; d: number; h: number; mi: number }) => ((q.y * 100 + q.m) * 100 + q.d) * 1440 + q.h * 60 + q.mi;
    const target = key({ y, m, d, h, mi });
    for (let x = t - 3 * 3_600_000; x <= t + 3 * 3_600_000; x += 60_000) {
      if (key(zonedParts(new Date(x), tz)) >= target) return new Date(x);
    }
  }
  return new Date(t);
}

const pad = (n: number) => String(n).padStart(2, '0');

// Data local AAAA-MM-DD no fuso (a "janela" de uma rotina diária).
export function localDate(date: Date, tz: string = TIMEZONE): string {
  const p = zonedParts(date, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

function matchesDay(c: Cron, y: number, m: number, d: number): boolean {
  if (!c.mon.has(m)) return false;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return c.dow.has(dow);
  if (c.dowAny) return c.dom.has(d);
  return c.dom.has(d) || c.dow.has(dow);
}

// Disparos (em UTC) num intervalo de dias locais, do mais antigo ao mais novo.
function firesAround(expr: string, tz: string, now: Date, daysBack: number, daysFwd: number): Date[] {
  const c = parseCron(expr);
  const p = zonedParts(now, tz);
  const out: Date[] = [];
  for (let i = -daysBack; i <= daysFwd; i++) {
    const day = new Date(Date.UTC(p.y, p.m - 1, p.d + i));
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    if (!matchesDay(c, y, m, d)) continue;
    for (const h of c.hour) for (const mi of c.min) out.push(zonedToUtc(y, m, d, h, mi, tz));
  }
  return out;
}

export function lastFire(expr: string, tz: string, now: Date = new Date()): Date | null {
  return firesAround(expr, tz, now, 8, 0).filter((t) => t <= now).at(-1) ?? null;
}

export function nextFire(expr: string, tz: string, now: Date = new Date()): Date | null {
  return firesAround(expr, tz, now, 0, 8).find((t) => t > now) ?? null;
}

// ---------- execuções (routine_runs) ----------

export interface RunRow {
  id: string;
  routineId: string;
  scope: string;
  inputKey: string;
  jobId: string | null;
  state: RunState;
  leaseUntil: string | null;
  fence: number;
  checkpoint: unknown;
  createdAt: string;
  updatedAt: string;
}

const toRun = (r: any): RunRow => ({
  id: r.id,
  routineId: r.routine_id,
  scope: r.scope,
  inputKey: r.input_key,
  jobId: r.job_id,
  state: r.state,
  leaseUntil: r.lease_until,
  fence: r.fence,
  checkpoint: r.checkpoint_json ? JSON.parse(r.checkpoint_json) : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const iso = () => new Date().toISOString();

export interface ClaimResult {
  run: RunRow;
  job: Job | null;
  // true = esta chamada reservou (ou retomou) a execução e criou o job.
  created: boolean;
}

export interface RetryPolicy {
  afterMs: number;
  maxFence: number;
}

export class RoutineStore {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  private get db() {
    return this.store.db;
  }

  ensure(def: { id: string; schedule: string; timezone: string; agent: string; enabled: boolean }): void {
    parseCron(def.schedule);
    // O liga/desliga escolhido por você é preservado; horário e agente vêm do código.
    this.db
      .prepare(`INSERT INTO routines (id, schedule, timezone, agent, enabled) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET schedule = excluded.schedule, timezone = excluded.timezone, agent = excluded.agent`)
      .run(def.id, def.schedule, def.timezone, def.agent, def.enabled ? 1 : 0);
  }

  enabled(id: string): boolean {
    return !!(this.db.prepare('SELECT enabled FROM routines WHERE id = ?').get(id) as any)?.enabled;
  }

  setEnabled(id: string, enabled: boolean): void {
    const r = this.db.prepare('UPDATE routines SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    if (!r.changes) throw new Error('Rotina não encontrada');
  }

  getRun(routineId: string, scope: string, inputKey: string): RunRow | null {
    const r = this.db.prepare('SELECT * FROM routine_runs WHERE routine_id = ? AND scope = ? AND input_key = ?').get(routineId, scope, inputKey);
    return r ? toRun(r) : null;
  }

  runById(id: string): RunRow | null {
    const r = this.db.prepare('SELECT * FROM routine_runs WHERE id = ?').get(id);
    return r ? toRun(r) : null;
  }

  // Reserva a execução de (rotina, escopo, janela). "create" cria o job dentro da mesma
  // transação; devolver null registra a execução sem job (ex.: marcador de disparo).
  claim(routineId: string, scope: string, inputKey: string, create: (runId: string, fence: number) => Job | null, retry?: RetryPolicy, emptyState: RunState = 'done'): ClaimResult {
    return this.store.transaction(() => {
      const existing = this.getRun(routineId, scope, inputKey);
      if (!existing) {
        const id = `run-${randomBytes(6).toString('hex')}`;
        const at = iso();
        this.db
          .prepare('INSERT INTO routine_runs (id, routine_id, scope, input_key, state, fence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
          .run(id, routineId, scope, inputKey, 'pending', at, at);
        const job = create(id, 0);
        this.db.prepare('UPDATE routine_runs SET job_id = ?, state = ? WHERE id = ?').run(job?.id ?? null, job ? 'pending' : emptyState, id);
        return { run: this.runById(id)!, job, created: true };
      }
      const retryable = existing.state === 'failed' && retry && existing.fence < retry.maxFence && Date.now() - Date.parse(existing.updatedAt) >= retry.afterMs;
      if (!retryable) return { run: existing, job: null, created: false };
      // Retomada: mesmo registro, fence + 1. O job antigo deixa de ser o executor.
      const fence = existing.fence + 1;
      this.db.prepare('UPDATE routine_runs SET fence = ?, job_id = NULL, state = ?, lease_until = NULL, updated_at = ? WHERE id = ?').run(fence, 'pending', iso(), existing.id);
      const job = create(existing.id, fence);
      this.db.prepare('UPDATE routine_runs SET job_id = ?, state = ? WHERE id = ?').run(job?.id ?? null, job ? 'pending' : emptyState, existing.id);
      return { run: this.runById(existing.id)!, job, created: true };
    });
  }

  // O job ainda é o executor atual da execução?
  isCurrent(job: Pick<Job, 'id' | 'routineRunId'>): boolean {
    if (!job.routineRunId) return true;
    return this.runById(job.routineRunId)?.jobId === job.id;
  }

  markRunning(job: Job): void {
    if (!job.routineRunId) return;
    const lease = new Date(Date.now() + (job.timeoutMin + 5) * 60_000).toISOString();
    this.db.prepare("UPDATE routine_runs SET state = 'running', lease_until = ?, updated_at = ? WHERE id = ? AND job_id = ?").run(lease, iso(), job.routineRunId, job.id);
  }

  // Conclui a execução. Devolve false se o job não é mais o executor (resultado rejeitado).
  complete(job: Pick<Job, 'id' | 'routineRunId'>, ok: boolean): boolean {
    if (!job.routineRunId) return true;
    const r = this.db
      .prepare('UPDATE routine_runs SET state = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND job_id = ?')
      .run(ok ? 'done' : 'failed', iso(), job.routineRunId, job.id);
    return r.changes > 0;
  }

  fail(runId: string): void {
    this.setState(runId, 'failed');
  }

  setState(runId: string, state: RunState): void {
    this.db.prepare('UPDATE routine_runs SET state = ?, updated_at = ? WHERE id = ?').run(state, iso(), runId);
  }

  // Checkpoint só é aceito do executor atual (mesmo fence).
  checkpoint(runId: string, fence: number, data: unknown): boolean {
    const r = this.db.prepare('UPDATE routine_runs SET checkpoint_json = ?, updated_at = ? WHERE id = ? AND fence = ?').run(JSON.stringify(data), iso(), runId, fence);
    return r.changes > 0;
  }

  failedIn(routineId: string, inputKeys: string[]): RunRow[] {
    if (!inputKeys.length) return [];
    return this.db
      .prepare(`SELECT * FROM routine_runs WHERE routine_id = ? AND state = 'failed' AND scope <> '' AND input_key IN (${inputKeys.map(() => '?').join(',')})`)
      .all(routineId, ...inputKeys)
      .map(toRun);
  }

  lastRun(routineId: string): RunRow | null {
    const r = this.db.prepare("SELECT * FROM routine_runs WHERE routine_id = ? AND scope <> '' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(routineId);
    return r ? toRun(r) : null;
  }

  runs(routineId: string, limit = 20): RunRow[] {
    return this.db.prepare('SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(routineId, limit).map(toRun);
  }
}

// ---------- motor ----------

export interface FireContext {
  // Data local do disparo (AAAA-MM-DD, no fuso da rotina).
  window: string;
  firedAt: Date;
  // Reserva uma execução desta rotina. Idempotente.
  claim(scope: string, inputKey: string, create: (runId: string, fence: number) => Job | null): ClaimResult;
}

export interface RoutineDef {
  id: string;
  nome: string;
  descricao: string;
  agente: string;
  schedule: string;
  timezone?: string;
  enabled?: boolean;
  // Se o PC estava desligado no horário, ainda dispara até este tempo depois.
  catchUpHours?: number;
  fire(ctx: FireContext): void | Promise<void>;
}

export const RETRY: RetryPolicy = { afterMs: 30 * 60_000, maxFence: 2 };
// Disparo que ficou "rodando" por mais que isso: o processo caiu no meio.
const STALE_FIRE_MS = 10 * 60_000;

export class Routines {
  readonly store: RoutineStore;
  private defs = new Map<string, RoutineDef>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  onFired: (ids: string[]) => void = () => {};

  constructor(store: Store) {
    this.store = new RoutineStore(store);
  }

  register(def: RoutineDef): void {
    this.defs.set(def.id, def);
    this.store.ensure({ id: def.id, schedule: def.schedule, timezone: def.timezone ?? TIMEZONE, agent: def.agente, enabled: def.enabled ?? true });
  }

  get(id: string): RoutineDef | undefined {
    return this.defs.get(id);
  }

  private ctx(def: RoutineDef, window: string, firedAt: Date): FireContext {
    return { window, firedAt, claim: (scope, key, create) => this.store.claim(def.id, scope, key, create, RETRY) };
  }

  // Confere todas as rotinas. Cada disparo acontece uma vez por horário (marcador de
  // escopo vazio); execuções que falharam são retomadas até 2 vezes.
  async tick(now: Date = new Date()): Promise<string[]> {
    if (this.busy) return [];
    this.busy = true;
    const fired: string[] = [];
    try {
      for (const def of this.defs.values()) {
        if (!this.store.enabled(def.id)) continue;
        const tz = def.timezone ?? TIMEZONE;
        const t = lastFire(def.schedule, tz, now);
        if (!t || now.getTime() - t.getTime() > (def.catchUpHours ?? 12) * 3_600_000) continue;
        const window = localDate(t, tz);
        const slot = `${window}T${zonedParts(t, tz).h}:${pad(zonedParts(t, tz).mi)}`;
        // O marcador de disparo também é retomado se o disparo em si falhou.
        const marker = this.store.claim(def.id, '', slot, () => null, RETRY, 'running');
        // Marcador "running" antigo = o processo caiu no meio do disparo: refaz.
        const interrupted = !marker.created && marker.run.state === 'running' && now.getTime() - Date.parse(marker.run.updatedAt) >= STALE_FIRE_MS;
        const retry = !marker.created && this.store.failedIn(def.id, [window]).some((r) => r.fence < RETRY.maxFence && now.getTime() - Date.parse(r.updatedAt) >= RETRY.afterMs);
        if (!marker.created && !interrupted && !retry) continue;
        if (!marker.created) this.store.setState(marker.run.id, 'running');
        try {
          await def.fire(this.ctx(def, window, t));
          this.store.setState(marker.run.id, 'done');
          fired.push(def.id);
        } catch (e: any) {
          this.store.fail(marker.run.id);
          console.warn(`Rotina ${def.id}:`, e.message);
        }
      }
    } finally {
      this.busy = false;
    }
    if (fired.length) this.onFired(fired);
    return fired;
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  views(now: Date = new Date()): RoutineView[] {
    return [...this.defs.values()].map((d) => {
      const tz = d.timezone ?? TIMEZONE;
      const last = this.store.lastRun(d.id);
      const enabled = this.store.enabled(d.id);
      return {
        id: d.id,
        nome: d.nome,
        descricao: d.descricao,
        agente: d.agente,
        schedule: d.schedule,
        timezone: tz,
        enabled,
        proxima: enabled ? (nextFire(d.schedule, tz, now)?.toISOString() ?? null) : null,
        ultima: last ? { em: last.updatedAt, estado: last.state, jobId: last.jobId, escopo: last.scope } : null,
      };
    });
  }
}
