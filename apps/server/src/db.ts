import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Job, JobEvent, JobKind, JobStatus, Objective, ObjectiveStatus, Project, EventKind, RunnableAgent, Risk } from '../../../packages/shared/types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  is_git INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  agent TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  risk TEXT NOT NULL,
  status TEXT NOT NULL,
  step TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  session_id TEXT,
  worktree TEXT,
  branch TEXT,
  error TEXT,
  summary TEXT,
  files_changed TEXT NOT NULL DEFAULT '[]',
  timeout_min INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_events_job ON job_events(job_id, id);
CREATE TABLE IF NOT EXISTS locks (
  key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_state (
  agent TEXT PRIMARY KEY,
  paused INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT
);
CREATE TABLE IF NOT EXISTS objectives (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  status TEXT NOT NULL,
  plan TEXT,
  context_pack TEXT,
  plan_job_id TEXT,
  branch TEXT,
  worktree TEXT,
  base_commit TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  finished_at TEXT,
  vault_note TEXT,
  source TEXT NOT NULL DEFAULT 'ui',
  source_path TEXT,
  error TEXT,
  summary TEXT
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox_seen (
  path TEXT PRIMARY KEY,
  objective_id TEXT,
  seen_at TEXT NOT NULL
);
`;

// v3.1: renda, candidaturas e rotinas (seção 4.1 do documento de refino).
// Datas em ISO UTC; dinheiro em centavos por moeda.
const SCHEMA_V31 = `
CREATE TABLE IF NOT EXISTS leads(
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 source_url TEXT NOT NULL, collected_at TEXT NOT NULL, posted_at TEXT,
 company TEXT, channel TEXT, need TEXT NOT NULL, evidence TEXT NOT NULL,
 score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100), score_json TEXT,
 status TEXT NOT NULL DEFAULT 'new' CHECK(status IN('new','qualified','discarded','converted')),
 discard_reason TEXT,
 UNIQUE(project_id,source_url));
CREATE TABLE IF NOT EXISTS proposals(
 id TEXT PRIMARY KEY,
 lead_id TEXT NOT NULL REFERENCES leads(id),
 body TEXT NOT NULL, scope TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('ready','sent','replied','paid','lost')),
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 currency TEXT NOT NULL CHECK(length(currency)=3),
 sent_at TEXT, replied_at TEXT, next_action TEXT, due_at TEXT, lost_reason TEXT,
 recurring INTEGER NOT NULL DEFAULT 0 CHECK(recurring IN(0,1)),
 human_minutes INTEGER NOT NULL DEFAULT 0 CHECK(human_minutes>=0),
 created_at TEXT NOT NULL,
 UNIQUE(id,currency),
 CHECK(state NOT IN('sent','replied','paid') OR sent_at IS NOT NULL),
 CHECK(state<>'lost' OR length(trim(coalesce(lost_reason,'')))>0));
CREATE TABLE IF NOT EXISTS payments(
 id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, currency TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 kind TEXT NOT NULL CHECK(kind IN('deposit','balance','recurring')),
 received_at TEXT NOT NULL, receipt_ref TEXT NOT NULL UNIQUE,
 FOREIGN KEY(proposal_id,currency) REFERENCES proposals(id,currency));
CREATE TABLE IF NOT EXISTS deliveries(
 id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES proposals(id),
 state TEXT NOT NULL CHECK(state IN('briefing','approved_scope','in_production','preview_sent','revision','final_sent','accepted')),
 due_at TEXT, revisions INTEGER NOT NULL DEFAULT 0, late INTEGER NOT NULL DEFAULT 0 CHECK(late IN(0,1)),
 cost_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL CHECK(length(currency)=3),
 created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS capacity_groups(
 id TEXT PRIMARY KEY,
 max_parallel INTEGER NOT NULL CHECK(max_parallel>0),
 daily_minutes INTEGER NOT NULL CHECK(daily_minutes>0),
 reserved_pct INTEGER NOT NULL DEFAULT 30 CHECK(reserved_pct BETWEEN 0 AND 100),
 paused_until TEXT);
CREATE TABLE IF NOT EXISTS routines(
 id TEXT PRIMARY KEY, schedule TEXT NOT NULL, timezone TEXT NOT NULL,
 agent TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN(0,1)));
CREATE TABLE IF NOT EXISTS routine_runs(
 id TEXT PRIMARY KEY, routine_id TEXT NOT NULL REFERENCES routines(id),
 scope TEXT NOT NULL, input_key TEXT NOT NULL, job_id TEXT UNIQUE REFERENCES jobs(id),
 state TEXT NOT NULL CHECK(state IN('pending','running','done','failed')),
 lease_until TEXT, fence INTEGER NOT NULL DEFAULT 0 CHECK(fence>=0),
 checkpoint_json TEXT CHECK(checkpoint_json IS NULL OR json_valid(checkpoint_json)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(routine_id,scope,input_key));
CREATE TABLE IF NOT EXISTS job_applications(
 id TEXT PRIMARY KEY, source_url TEXT NOT NULL UNIQUE, collected_at TEXT NOT NULL,
 employer TEXT, title TEXT NOT NULL, location TEXT, score INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN('found','package_ready','applied','interview','offer','rejected','discarded')),
 applied_at TEXT, next_action TEXT, due_at TEXT, notes TEXT);
CREATE INDEX IF NOT EXISTS ix_prop_state_due ON proposals(state,due_at);
CREATE INDEX IF NOT EXISTS ix_runs_lease ON routine_runs(state,lease_until);
CREATE TABLE IF NOT EXISTS hoje_tarefas(
 id TEXT PRIMARY KEY, data TEXT NOT NULL,
 bloco TEXT NOT NULL CHECK(bloco IN('propostas','respostas','candidaturas','decisoes')),
 titulo TEXT NOT NULL CHECK(length(trim(titulo)) BETWEEN 3 AND 140),
 detalhe TEXT NOT NULL DEFAULT '', minutos INTEGER NOT NULL CHECK(minutos BETWEEN 1 AND 45),
 ordem INTEGER NOT NULL DEFAULT 0, texto_copiar TEXT, url TEXT, arquivo TEXT,
 estado TEXT NOT NULL DEFAULT 'aberta' CHECK(estado IN('aberta','feita','pulada')),
 criada_em TEXT NOT NULL, feita_em TEXT,
 origem TEXT NOT NULL CHECK(origem IN('claude','codex','rocky','emannuel')));
CREATE INDEX IF NOT EXISTS ix_hoje_tarefas_estado_data ON hoje_tarefas(estado,data);
`;

// Colunas acrescentadas depois da Fase 1: migradas sem perder dados.
const ADDED_COLUMNS: Record<string, [string, string][]> = {
  projects: [
    ['vault_folder', 'TEXT'],
    ['is_test', 'INTEGER NOT NULL DEFAULT 0'],
    ['is_legacy', 'INTEGER NOT NULL DEFAULT 0'],
  ],
  jobs: [
    ['kind', "TEXT NOT NULL DEFAULT 'task'"],
    ['objective_id', 'TEXT'],
    ['plan_key', 'TEXT'],
    ['depends_on', "TEXT NOT NULL DEFAULT '[]'"],
    ['acceptance', 'TEXT'],
    ['target_job_id', 'TEXT'],
    ['attempt', 'INTEGER NOT NULL DEFAULT 0'],
    ['usage', 'TEXT'],
    ['verdict', 'TEXT'],
    ['base_commit', 'TEXT'],
    ['vault_note', 'TEXT'],
    // v3.1
    ['routine_run_id', 'TEXT'],
    ['parent_job_id', 'TEXT'],
    ['depth', 'INTEGER NOT NULL DEFAULT 0'],
    ['capacity_group_id', 'TEXT'],
    ['reserved_minutes', 'INTEGER NOT NULL DEFAULT 0'],
    ['gpu_required', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_checkpoint_at', 'TEXT'],
  ],
  objectives: [
    ['budget_minutes', 'INTEGER'],
    ['spent_minutes', 'INTEGER NOT NULL DEFAULT 0'],
    ['outcome_kind', 'TEXT'],
  ],
};

type Row = Record<string, any>;

const now = () => new Date().toISOString();

export function newId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${randomBytes(2).toString('hex')}`;
}

function toJob(r: Row): Job {
  return {
    id: r.id,
    title: r.title,
    prompt: r.prompt,
    agent: r.agent,
    projectId: r.project_id,
    risk: r.risk,
    status: r.status,
    step: r.step,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    exitCode: r.exit_code,
    sessionId: r.session_id,
    worktree: r.worktree,
    branch: r.branch,
    baseCommit: r.base_commit,
    error: r.error,
    summary: r.summary,
    filesChanged: JSON.parse(r.files_changed),
    timeoutMin: r.timeout_min,
    kind: r.kind,
    objectiveId: r.objective_id,
    planKey: r.plan_key,
    dependsOn: JSON.parse(r.depends_on),
    acceptance: r.acceptance,
    targetJobId: r.target_job_id,
    attempt: r.attempt,
    verdict: r.verdict,
    vaultNote: r.vault_note,
    usage: r.usage ? JSON.parse(r.usage) : null,
    routineRunId: r.routine_run_id ?? null,
    gpuRequired: !!r.gpu_required,
    lastCheckpointAt: r.last_checkpoint_at ?? null,
    parentJobId: r.parent_job_id ?? null,
    depth: r.depth ?? 0,
  };
}

const toProject = (r: Row): Project => ({
  id: r.id,
  name: r.name,
  path: r.path,
  isGit: !!r.is_git,
  vaultFolder: r.vault_folder ?? null,
  isTest: !!r.is_test,
  isLegacy: !!r.is_legacy,
  createdAt: r.created_at,
});

function toObjective(r: Row): Objective {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    projectId: r.project_id,
    status: r.status,
    plan: r.plan ? JSON.parse(r.plan) : null,
    contextPack: r.context_pack,
    planJobId: r.plan_job_id,
    branch: r.branch,
    worktree: r.worktree,
    baseCommit: r.base_commit,
    createdAt: r.created_at,
    approvedAt: r.approved_at,
    finishedAt: r.finished_at,
    vaultNote: r.vault_note,
    source: r.source,
    sourcePath: r.source_path,
    error: r.error,
    summary: r.summary,
  };
}

// Campo do objeto → coluna. Campos JSON são serializados.
const JOB_COLUMNS: Record<string, string> = {
  status: 'status', step: 'step', startedAt: 'started_at', finishedAt: 'finished_at', exitCode: 'exit_code',
  sessionId: 'session_id', worktree: 'worktree', branch: 'branch', baseCommit: 'base_commit', error: 'error',
  summary: 'summary', filesChanged: 'files_changed', attempt: 'attempt', verdict: 'verdict', vaultNote: 'vault_note', usage: 'usage',
  lastCheckpointAt: 'last_checkpoint_at',
};
const OBJECTIVE_COLUMNS: Record<string, string> = {
  title: 'title', description: 'description', projectId: 'project_id', status: 'status', plan: 'plan',
  contextPack: 'context_pack', planJobId: 'plan_job_id', branch: 'branch', worktree: 'worktree',
  baseCommit: 'base_commit', approvedAt: 'approved_at', finishedAt: 'finished_at', vaultNote: 'vault_note',
  error: 'error', summary: 'summary',
};
const JSON_FIELDS = new Set(['filesChanged', 'plan', 'usage']);

export type JobPatch = Partial<Pick<Job, 'status' | 'step' | 'startedAt' | 'finishedAt' | 'exitCode' | 'sessionId' | 'worktree' | 'branch' | 'baseCommit' | 'error' | 'summary' | 'filesChanged' | 'attempt' | 'verdict' | 'vaultNote' | 'usage' | 'lastCheckpointAt'>>;
export type ObjectivePatch = Partial<Omit<Objective, 'id' | 'createdAt' | 'source' | 'sourcePath'>>;

export interface NewJobRow {
  title: string;
  prompt: string;
  agent: RunnableAgent;
  projectId: string;
  risk: Risk;
  status: JobStatus;
  timeoutMin: number;
  kind?: JobKind;
  objectiveId?: string | null;
  planKey?: string | null;
  dependsOn?: string[];
  acceptance?: string | null;
  targetJobId?: string | null;
  worktree?: string | null;
  branch?: string | null;
  baseCommit?: string | null;
  routineRunId?: string | null;
  gpuRequired?: boolean;
  parentJobId?: string | null;
  depth?: number;
}

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // busy_timeout: duas conexões (ex.: reinício) esperam a vez em vez de falhar.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.migrate();
    this.db.exec(SCHEMA_V31);
  }

  // Transação com trava de escrita desde o início (BEGIN IMMEDIATE): quem chega
  // depois espera e já enxerga o que a primeira gravou.
  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private migrate() {
    for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
      const existing = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((r: Row) => r.name));
      for (const [name, type] of cols) {
        if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS jobs_objective ON jobs(objective_id)');
    this.db.prepare("UPDATE projects SET is_legacy = 1 WHERE id = 'operacao-receita' AND is_legacy = 0").run();
  }

  private update(table: string, columns: Record<string, string>, id: string, patch: Record<string, any>) {
    const sets: string[] = [];
    const values: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!columns[k]) continue;
      sets.push(`${columns[k]} = ?`);
      values.push(JSON_FIELDS.has(k) ? (v == null ? null : JSON.stringify(v)) : (v ?? null));
    }
    if (sets.length) this.db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  // ---------- projetos ----------
  listProjects(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY is_test, name').all().map(toProject);
  }

  getProject(id: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    return r ? toProject(r) : null;
  }

  upsertProject(p: Omit<Project, 'createdAt' | 'vaultFolder' | 'isTest' | 'isLegacy'> & { vaultFolder?: string | null; isTest?: boolean; isLegacy?: boolean }): Project {
    const isLegacy = p.id === 'operacao-receita' || (p.isLegacy ?? this.getProject(p.id)?.isLegacy ?? false);
    this.db
      .prepare(`INSERT INTO projects (id, name, path, is_git, vault_folder, is_test, is_legacy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, path = excluded.path, is_git = excluded.is_git,
          vault_folder = excluded.vault_folder, is_test = excluded.is_test, is_legacy = excluded.is_legacy`)
      .run(p.id, p.name, p.path, p.isGit ? 1 : 0, p.vaultFolder ?? null, p.isTest ? 1 : 0, isLegacy ? 1 : 0, now());
    return this.getProject(p.id)!;
  }

  // ---------- jobs ----------
  createJob(input: NewJobRow): Job {
    const id = newId();
    this.db
      .prepare(`INSERT INTO jobs (id, title, prompt, agent, project_id, risk, status, created_at, timeout_min,
          kind, objective_id, plan_key, depends_on, acceptance, target_job_id, worktree, branch, base_commit, routine_run_id, gpu_required, parent_job_id, depth)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id, input.title, input.prompt, input.agent, input.projectId, input.risk, input.status, now(), input.timeoutMin,
        input.kind ?? 'task', input.objectiveId ?? null, input.planKey ?? null, JSON.stringify(input.dependsOn ?? []),
        input.acceptance ?? null, input.targetJobId ?? null, input.worktree ?? null, input.branch ?? null, input.baseCommit ?? null, input.routineRunId ?? null,
        input.gpuRequired ? 1 : 0, input.parentJobId ?? null, input.depth ?? 0,
      );
    return this.getJob(id)!;
  }

  getJob(id: string): Job | null {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    return r ? toJob(r) : null;
  }

  listJobs(limit = 300): Job[] {
    return this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit).map(toJob);
  }

  jobsByStatus(status: JobStatus, agent?: RunnableAgent): Job[] {
    const rows = agent
      ? this.db.prepare('SELECT * FROM jobs WHERE status = ? AND agent = ? ORDER BY created_at, rowid').all(status, agent)
      : this.db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at, rowid').all(status);
    return rows.map(toJob);
  }

  jobsOfObjective(objectiveId: string): Job[] {
    return this.db.prepare('SELECT * FROM jobs WHERE objective_id = ? ORDER BY created_at, rowid').all(objectiveId).map(toJob);
  }

  jobsTargeting(jobId: string): Job[] {
    return this.db.prepare('SELECT * FROM jobs WHERE target_job_id = ? ORDER BY created_at, rowid').all(jobId).map(toJob);
  }

  updateJob(id: string, patch: JobPatch): Job {
    this.update('jobs', JOB_COLUMNS, id, patch);
    return this.getJob(id)!;
  }

  // ---------- objetivos ----------
  createObjective(input: { title: string; description: string; projectId: string | null; status: ObjectiveStatus; source?: 'ui' | 'inbox'; sourcePath?: string | null }): Objective {
    const id = 'obj-' + newId();
    this.db
      .prepare(`INSERT INTO objectives (id, title, description, project_id, status, created_at, source, source_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.title, input.description, input.projectId, input.status, now(), input.source ?? 'ui', input.sourcePath ?? null);
    return this.getObjective(id)!;
  }

  getObjective(id: string): Objective | null {
    const r = this.db.prepare('SELECT * FROM objectives WHERE id = ?').get(id);
    return r ? toObjective(r) : null;
  }

  listObjectives(limit = 100): Objective[] {
    return this.db.prepare('SELECT * FROM objectives ORDER BY created_at DESC LIMIT ?').all(limit).map(toObjective);
  }

  updateObjective(id: string, patch: ObjectivePatch): Objective {
    this.update('objectives', OBJECTIVE_COLUMNS, id, patch);
    return this.getObjective(id)!;
  }

  // ---------- valores JSON de módulos (ex.: Imigração) ----------
  kvGet<T>(key: string): T | null {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return r ? (JSON.parse(r.value as string) as T) : null;
  }

  kvSet(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(value), now());
  }

  // ---------- inbox do vault ----------
  inboxSeen(path: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM inbox_seen WHERE path = ?').get(path);
  }

  markInboxSeen(path: string, objectiveId: string | null): void {
    this.db.prepare('INSERT OR REPLACE INTO inbox_seen (path, objective_id, seen_at) VALUES (?, ?, ?)').run(path, objectiveId, now());
  }

  // ---------- eventos ----------
  addEvent(jobId: string, kind: EventKind, text: string): JobEvent {
    const ts = now();
    const res = this.db.prepare('INSERT INTO job_events (job_id, ts, kind, text) VALUES (?, ?, ?, ?)').run(jobId, ts, kind, text);
    return { id: Number(res.lastInsertRowid), jobId, ts, kind, text };
  }

  listEvents(jobId: string, afterId = 0): JobEvent[] {
    return this.db
      .prepare('SELECT id, job_id, ts, kind, text FROM job_events WHERE job_id = ? AND id > ? ORDER BY id')
      .all(jobId, afterId)
      .map((r: Row) => ({ id: r.id, jobId: r.job_id, ts: r.ts, kind: r.kind, text: r.text }));
  }

  // ---------- locks ----------
  // Uma chave por projeto/caminho. Retorna false se outro job já tem.
  acquireLock(key: string, jobId: string): boolean {
    const r = this.db.prepare('SELECT job_id FROM locks WHERE key = ?').get(key);
    if (r && r.job_id !== jobId) return false;
    this.db.prepare('INSERT OR REPLACE INTO locks (key, job_id, acquired_at) VALUES (?, ?, ?)').run(key, jobId, now());
    return true;
  }

  isLocked(key: string, jobId: string): boolean {
    const r = this.db.prepare('SELECT job_id FROM locks WHERE key = ?').get(key);
    return !!r && r.job_id !== jobId;
  }

  releaseLocks(jobId: string): void {
    this.db.prepare('DELETE FROM locks WHERE job_id = ?').run(jobId);
  }

  // ---------- pausa por limite de uso ----------
  getAgentPause(agent: RunnableAgent): { paused: boolean; reason: string | null } {
    const r = this.db.prepare('SELECT paused, paused_reason FROM agent_state WHERE agent = ?').get(agent);
    return { paused: !!r?.paused, reason: (r?.paused_reason as string | null) ?? null };
  }

  setAgentPause(agent: RunnableAgent, paused: boolean, reason: string | null = null): void {
    this.db
      .prepare(`INSERT INTO agent_state (agent, paused, paused_reason) VALUES (?, ?, ?)
        ON CONFLICT(agent) DO UPDATE SET paused = excluded.paused, paused_reason = excluded.paused_reason`)
      .run(agent, paused ? 1 : 0, reason);
  }
}
