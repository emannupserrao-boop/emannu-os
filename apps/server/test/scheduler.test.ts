import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Scheduler } from '../src/scheduler.ts';
import { claudeAdapter, type AgentAdapter } from '../src/runners/adapters.ts';
import { git } from '../src/worktrees.ts';
import type { Job, RunnableAgent } from '../../../packages/shared/types.ts';

const FAKE = join(import.meta.dirname, 'fake-agent.mjs');

// O modo do agente falso vem do título do job: "write", "sleep", "limit" ou "fail".
const fakeAdapter: AgentAdapter = {
  buildArgs: (job, _cwd, prompt) => ({ args: [FAKE, ...job.title.split(' ')], stdin: prompt }),
  parse: claudeAdapter.parse,
};

async function waitFor<T>(fn: () => T | null | undefined | false, ms = 15_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timeout esperando condição');
}

let dir: string;
let store: Store;
let sched: Scheduler;
let repo: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'emannu-test-'));
  repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'teste\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init');
  store = new Store(':memory:');
  store.upsertProject({ id: 'p', name: 'Projeto Teste', path: repo, isGit: true });
  sched = new Scheduler({
    store,
    logDir: join(dir, 'logs'),
    worktreesDir: join(dir, 'wt'),
    adapters: { claude: fakeAdapter, codex: fakeAdapter },
    resolveExe: () => process.execPath,
  });
});

afterEach(async () => {
  for (const [, a] of sched.active) a.proc.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const job = (title: string, agent: RunnableAgent = 'claude', extra: Partial<Parameters<Scheduler['createJob']>[0]> = {}) =>
  sched.createJob({ title, prompt: `tarefa ${title}`, agent, projectId: 'p', ...extra });

const status = (j: Job) => store.getJob(j.id)!.status;

describe('Scheduler', () => {
  it('roda 1 job por agente e Claude + Codex em paralelo', async () => {
    const a = job('sleep 800', 'claude');
    const b = job('sleep 800', 'claude');
    const c = job('sleep 800', 'codex');
    expect(status(a)).toBe('running');
    expect(status(b)).toBe('queued');
    expect(status(c)).toBe('running');
    expect(sched.agents().find((x) => x.id === 'claude')!.runningJobs).toEqual([a.id]);
    await waitFor(() => status(b) === 'running');
    expect(status(a)).toBe('done');
    await waitFor(() => status(b) === 'done' && status(c) === 'done');
  });

  it('cancela um job rodando, mata o processo e remove o worktree', async () => {
    const a = job('sleep 60000');
    const wt = await waitFor(() => store.getJob(a.id)!.worktree);
    sched.cancel(a.id);
    await waitFor(() => status(a) === 'canceled');
    expect(existsSync(wt)).toBe(false);
    expect(sched.active.size).toBe(0);
  });

  it('job que altera arquivos vai para revisão e o merge aprovado chega ao projeto', async () => {
    const a = job('write');
    await waitFor(() => status(a) === 'review');
    expect(store.getJob(a.id)!.filesChanged).toEqual(['saida.txt']);
    const d = sched.diff(a.id);
    expect(d.diff).toContain('saida.txt');
    expect(d.files).toEqual(['saida.txt']);
    // Chamar o diff de novo (com arquivos já marcados no índice) não pode cortar nomes.
    expect(sched.diff(a.id).files).toEqual(['saida.txt']);
    const finishedAt = store.getJob(a.id)!.finishedAt;
    await new Promise((r) => setTimeout(r, 20));
    sched.approve(a.id);
    expect(status(a)).toBe('done');
    expect(store.getJob(a.id)!.finishedAt).toBe(finishedAt);
    expect(readFileSync(join(repo, 'saida.txt'), 'utf8')).toContain('tarefa write');
    expect(git(repo, 'branch', '--list', 'job/*')).toBe('');
  });

  it('descartar remove o worktree sem tocar no projeto', async () => {
    const a = job('write');
    await waitFor(() => status(a) === 'review');
    const wt = store.getJob(a.id)!.worktree!;
    sched.discard(a.id);
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(join(repo, 'saida.txt'))).toBe(false);
  });

  it('job AMARELO espera aprovação antes de rodar', async () => {
    const a = job('write', 'claude', { risk: 'amarelo' });
    expect(status(a)).toBe('approval');
    // v3.1: 60 min é VERDE (o teto é 120; acima disso é recusado).
    const longo = job('write', 'codex', { timeoutMin: 60 });
    expect(store.getJob(longo.id)!.risk).toBe('verde');
    sched.approve(a.id);
    await waitFor(() => status(a) === 'review');
  });

  it('recusa job VERMELHO', () => {
    expect(() => job('write', 'claude', { risk: 'vermelho' })).toThrow(/VERMELH/);
  });

  it('limite de uso pausa o grupo inteiro e devolve o job', async () => {
    const a = job('limit');
    await waitFor(() => sched.capacity.pausedUntil('claude'));
    await waitFor(() => status(a) === 'queued' && sched.active.size === 0);
    const b = job('write');
    expect(status(b)).toBe('queued'); // fila pausada
    expect(sched.agents().find((x) => x.id === 'claude')!.paused).toBe(true);
  });

  it('falha registra erro', async () => {
    const a = job('fail');
    await waitFor(() => status(a) === 'failed');
    expect(store.getJob(a.id)!.error).toContain('falhou de propósito');
  });

  it('pasta sem git usa lock: dois agentes não rodam na mesma pasta ao mesmo tempo', async () => {
    const plain = join(dir, 'pasta');
    mkdirSync(plain);
    store.upsertProject({ id: 'n', name: 'Sem git', path: plain, isGit: false });
    const a = sched.createJob({ title: 'sleep 600', prompt: 'x', agent: 'claude', projectId: 'n' });
    const b = sched.createJob({ title: 'sleep 600', prompt: 'x', agent: 'codex', projectId: 'n' });
    expect(status(a)).toBe('running');
    expect(status(b)).toBe('queued');
    await waitFor(() => status(b) === 'running');
    await waitFor(() => status(b) === 'done');
  });

  it('servidor reiniciado marca jobs órfãos como falha', () => {
    const j = store.createJob({ title: 't', prompt: 'p', agent: 'claude', projectId: 'p', risk: 'verde', status: 'running', timeoutMin: 5 });
    sched.recoverAfterRestart();
    expect(status(j)).toBe('failed');
  });
});
