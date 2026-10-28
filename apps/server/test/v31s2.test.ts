// Testes de aceite da Sprint 2 do refino v3.1 (seções 7, 8, 10 e 12).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Scheduler } from '../src/scheduler.ts';
import { claudeAdapter, type AgentAdapter } from '../src/runners/adapters.ts';
import { Renda } from '../src/renda/index.ts';
import { Rocky, MAX_DESCENDANTS } from '../src/rocky.ts';
import { detectGame, type GameSignals } from '../src/gamemode.ts';
import { git } from '../src/worktrees.ts';
import type { Job } from '../../../packages/shared/types.ts';

const FAKE = join(import.meta.dirname, 'fake-agent.mjs');
const say = (text: string) => ['say', Buffer.from(text).toString('base64')];

async function waitFor<T>(fn: () => T | null | undefined | false, ms = 15_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('timeout esperando condição');
}

let dir: string;
let store: Store;
let sched: Scheduler;
let script: (job: Job) => string[];
let signals: GameSignals;

function makeSched(opts: { checkpointMs?: number } = {}) {
  const fake: AgentAdapter = { buildArgs: (job, _c, prompt) => ({ args: [FAKE, ...script(job)], stdin: prompt }), parse: claudeAdapter.parse };
  return new Scheduler({ store, logDir: join(dir, 'logs'), worktreesDir: join(dir, 'wt'), adapters: { claude: fake, codex: fake, hermes: fake, openclaw: fake }, resolveExe: () => process.execPath, gameProbe: async () => signals, ...opts });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'emannu-s2-'));
  store = new Store(':memory:');
  store.upsertProject({ id: 'p', name: 'P', path: dir, isGit: false });
  script = () => say('ok');
  signals = { processes: [], fullscreen: null, gpuUtil: 5 };
  sched = makeSched();
});

afterEach(async () => {
  for (const [, a] of sched.active) a.proc.kill();
  await new Promise((r) => setTimeout(r, 250));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const task = (over: Record<string, unknown> = {}) => sched.enqueue({ title: 'x', prompt: 'x', agent: 'claude', projectId: 'p', risk: 'verde', timeoutMin: 10, ...over } as any);
const settled = (id: string) => ['done', 'failed', 'review', 'canceled'].includes(store.getJob(id)!.status);

// ---------------------------------------------------------------------------
describe('routine_restart_fencing + stale_executor_effects_rejected', () => {
  it('reinício: árvore antiga encerrada, capacidade liberada uma vez, retomada com fence novo e resultado antigo descartado', async () => {
    const renda = new Renda(sched, { projectPath: join(dir, 'renda') });
    sched.routines.store.ensure({ id: 'hermes-leads', schedule: '30 6 * * 1-5', timezone: 'Europe/Bucharest', agent: 'hermes', enabled: true });
    // Simula um job de rotina "rodando" quando o servidor caiu (sem processo de verdade).
    const first = sched.routines.store.claim('hermes-leads', 'leads', '2026-10-28', (runId) => store.createJob({ title: 'Leads', prompt: 'x', agent: 'claude', projectId: 'renda', risk: 'verde', status: 'queued', timeoutMin: 30, kind: 'research', planKey: 'comercial:leads:2026-10-28', routineRunId: runId }));
    const old = first.job!;
    store.db.prepare("UPDATE jobs SET status = 'running', started_at = ?, capacity_group_id = 'claude', reserved_minutes = 30 WHERE id = ?").run(new Date(Date.now() - 5 * 60_000).toISOString(), old.id);
    store.kvSet(`executor.${old.id}`, { pid: 999999 });
    sched.recoverAfterRestart();
    expect(store.getJob(old.id)!.status).toBe('failed');
    expect(store.kvGet(`executor.${old.id}`)).toBeNull();
    const used = sched.capacity.usedToday('claude');
    expect(used).toBeGreaterThanOrEqual(5);
    expect(sched.capacity.release(old.id)).toBe(0); // segunda liberação não conta
    expect(sched.capacity.usedToday('claude')).toBe(used);
    // Retomada: mesmo registro, fence 1, outro job.
    const again = sched.routines.store.claim('hermes-leads', 'leads', '2026-10-28', (runId) => renda.enqueueLeads('2026-10-28', runId), { afterMs: 0, maxFence: 2 });
    expect(again.run).toMatchObject({ id: first.run.id, fence: 1 });
    await waitFor(() => settled(again.job!.id));
    // O executor antigo "termina depois": nada do que ele trouxer é gravado.
    const evil = 'ok\n```json\n' + JSON.stringify({ leads: [{ source_url: 'https://x.test/stale', need: 'precisa de criativos', evidence: 'precisa de criativos curtos agora', score_json: { demanda: 'integral' } }] }) + '\n```';
    store.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(old.id);
    const res = sched.flow.afterJob(store.getJob(old.id)!, { ok: true, code: 0, canceled: false, timedOut: false, text: evil, error: null });
    expect(res.step).toBe('Resultado descartado');
    expect(renda.store.leads().some((l) => l.sourceUrl === 'https://x.test/stale')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('capacity_shared_reserve', () => {
  it('30% do grupo ficam para clientes; o acerto é pelo tempo real', () => {
    sched.capacity.setGroup('chatgpt', { dailyMinutes: 100, maxParallel: 5 });
    const mk = (min: number, planKey: string | null = null) => store.createJob({ title: 't', prompt: 'x', agent: 'codex', projectId: 'p', risk: 'verde', status: 'queued', timeoutMin: min, planKey });
    const a = mk(40);
    expect(sched.capacity.reserve(a)).toMatchObject({ ok: true, group: 'chatgpt' });
    store.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(a.id);
    // 40 reservados + 40 = 80 > 70 (100 − 30%): recusado para trabalho interno…
    const b = mk(40);
    expect(sched.capacity.reserve(b)).toMatchObject({ ok: false });
    // …mas uma entrega de cliente pode usar a reserva.
    const c = mk(40, 'entrega:prop-1');
    expect(sched.capacity.reserve(c)).toMatchObject({ ok: true });
    // Codex e Hermes dividem o mesmo grupo.
    expect(sched.capacity.groupOf({ agent: 'hermes' })).toBe('chatgpt');
    // Consumo real: o job "a" usou ~2 min, não 40.
    store.db.prepare('UPDATE jobs SET started_at = ?, finished_at = ? WHERE id = ?').run('2026-10-28T10:00:00.000Z', '2026-10-28T10:01:30.000Z', a.id);
    expect(sched.capacity.release(a.id)).toBe(2);
    store.db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(a.id);
    // A reserva do cliente (ainda na fila) também conta: 2 + 40 + 40 > 70 → interno espera.
    expect(sched.capacity.reserve(b)).toMatchObject({ ok: false });
    store.db.prepare("UPDATE jobs SET started_at = ?, finished_at = ? WHERE id = ?").run('2026-10-28T10:00:00.000Z', '2026-10-28T10:03:00.000Z', c.id);
    sched.capacity.release(c.id);
    expect(sched.capacity.reserve(b)).toMatchObject({ ok: true }); // 2 + 3 usados + 40 ≤ 70
  });

  it('limite de uso pausa o grupo inteiro e mostra até quando', () => {
    sched.capacity.pause('chatgpt', new Date(Date.now() + 60 * 60_000));
    expect(sched.agents().find((a) => a.id === 'hermes')).toMatchObject({ paused: true });
    expect(sched.agents().find((a) => a.id === 'codex')!.pausedReason).toMatch(/Grupo chatgpt pausado/);
    expect(sched.agents().find((a) => a.id === 'claude')!.paused).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('gpu_exclusive_priority + modo jogo', () => {
  it('um job de GPU por vez; entrega de cliente passa na frente', async () => {
    script = (j) => (j.title === 'render interno' ? ['sleep', '400'] : say('ok'));
    store.upsertProject({ id: 'q', name: 'Q', path: join(dir, 'q'), isGit: false });
    mkdirSync(join(dir, 'q'));
    const a = task({ title: 'render interno', gpuRequired: true });
    const b = task({ title: 'render interno 2', gpuRequired: true, agent: 'codex', projectId: 'q' });
    const c = task({ title: 'render cliente', gpuRequired: true, agent: 'codex', projectId: 'q', planKey: 'entrega:prop-9' });
    expect(store.getJob(a.id)!.status).toBe('running');
    expect(store.getJob(b.id)!.step).toMatch(/Aguardando a GPU/);
    await waitFor(() => settled(a.id));
    await waitFor(() => store.getJob(c.id)!.startedAt);
    // O cliente começou antes do interno que estava na fila há mais tempo.
    await waitFor(() => settled(b.id) && settled(c.id));
    expect(Date.parse(store.getJob(c.id)!.startedAt!)).toBeLessThan(Date.parse(store.getJob(b.id)!.startedAt!));
  });

  it('game_mode_pauses_gpu_queue + game_mode_light_jobs_continue + install_deferred_while_gaming', async () => {
    signals = { processes: [{ name: 'dota2.exe', path: 'D:\\Steam\\steamapps\\common\\dota 2 beta\\game\\bin\\win64\\dota2.exe' }], fullscreen: null, gpuUtil: 90 };
    await sched.gameMode.check();
    expect(sched.gameMode.state()).toMatchObject({ ativo: true, motivo: 'jogo aberto: dota2.exe' });
    const gpu = task({ title: 'benchmark local', gpuRequired: true });
    const install = task({ title: 'Instalar LM Studio e baixar modelos', gpuRequired: true, agent: 'codex' });
    const light = task({ title: 'pesquisa leve', agent: 'hermes' });
    await waitFor(() => settled(light.id));
    expect(store.getJob(gpu.id)!.status).toBe('queued');
    expect(store.getJob(install.id)!.status).toBe('queued');
    expect(store.getJob(gpu.id)!.step).toMatch(/Modo jogo: GPU pausada/);
    // "Pausar tudo durante o jogo": nem os leves começam.
    sched.gameMode.setPauseAll(true);
    const light2 = task({ title: 'pesquisa leve 2', agent: 'hermes' });
    expect(store.getJob(light2.id)!.status).toBe('queued');
    sched.gameMode.setPauseAll(false);
  });

  it('game_mode_resumes_after_idle: 10 min sem jogo → a fila de GPU volta', async () => {
    signals = { processes: [], fullscreen: 'eldenring.exe', gpuUtil: 30 };
    const t0 = Date.parse('2026-10-28T20:00:00Z');
    await sched.gameMode.check(t0);
    const gpu = task({ title: 'render', gpuRequired: true });
    signals = { processes: [], fullscreen: 'chrome.exe', gpuUtil: 3 };
    await sched.gameMode.check(t0 + 5 * 60_000);
    expect(sched.gameMode.state().ativo).toBe(true); // ainda dentro dos 10 min
    expect(store.getJob(gpu.id)!.status).toBe('queued');
    await sched.gameMode.check(t0 + 11 * 60_000);
    expect(sched.gameMode.state()).toMatchObject({ ativo: false });
    expect(sched.gameMode.state().historico[0].fim).toBeTruthy();
    await waitFor(() => settled(gpu.id));
  });

  it('detecção: Steam, tela cheia (menos navegador) e GPU de outro programa', () => {
    const none = { processes: [], fullscreen: null, gpuUtil: 10 };
    expect(detectGame(none)).toBeNull();
    expect(detectGame({ ...none, processes: [{ name: 'x.exe', path: 'E:\\SteamLibrary\\steamapps\\common\\Game\\x.exe' }] })).toMatch(/Steam/);
    expect(detectGame({ ...none, fullscreen: 'chrome.exe' })).toBeNull();
    expect(detectGame({ ...none, fullscreen: 'LockApp.exe' })).toBeNull();
    expect(detectGame({ ...none, fullscreen: 'LogonUI.exe' })).toBeNull();
    expect(detectGame({ ...none, gpuUtil: 75 })).toMatch(/GPU em 75%/);
    expect(detectGame({ ...none, gpuUtil: 75 }, { ourGpuBusy: true })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('job_timeout_120_121', () => {
  it('120 min é VERDE; 121 é recusado', () => {
    expect(task({ timeoutMin: 120 })).toMatchObject({ risk: 'verde', timeoutMin: 120 });
    expect(() => task({ timeoutMin: 121 })).toThrow(/acima de 120 min/);
  });
});

// ---------------------------------------------------------------------------
describe('checkpoint_no_progress', () => {
  it('2 checkpoints seguidos sem progresso encerram a tentativa, com evidência preservada', async () => {
    sched = makeSched({ checkpointMs: 250 });
    script = () => ['sleep', '60000'];
    const j = task({ title: 'travado' });
    const done = await waitFor(() => settled(j.id) && store.getJob(j.id), 10_000);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/Sem progresso verificável em 2 checkpoints/);
    expect(done.lastCheckpointAt).toBeTruthy();
    expect(existsSync(join(dir, 'logs', `${j.id}.jsonl`))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('rocky_bounds', () => {
  it('limite de 10 por objetivo, profundidade 2, VERMELHO vira pedido, sem duplicar', () => {
    const rocky = new Rocky(sched, { projectPath: join(dir, 'rocky') });
    rocky.registerRoutines(sched.routines);
    const obj = store.createObjective({ title: 'Vender piloto', description: 'x', projectId: 'p', status: 'running' });
    const jobs = Array.from({ length: 6 }, (_, i) => ({ titulo: `Peça ${i}`, agente: 'claude', projeto: 'p', tarefa: 'fazer', minutos: 20, objetivo_id: obj.id }));
    // Duas rodadas (como se fossem concorrentes): o total nunca passa de 10.
    rocky.apply({ jobs });
    rocky.apply({ jobs: jobs.map((j) => ({ ...j, titulo: `${j.titulo}b` })) });
    expect(rocky.descendants(obj.id)).toBe(MAX_DESCENDANTS);
    const third = rocky.apply({ jobs: [{ ...jobs[0], titulo: 'Mais uma' }] });
    expect(third.recusados[0].motivo).toMatch(/10 jobs/);
    // Profundidade: filho de um job de profundidade 2 é recusado.
    const deep = store.createJob({ title: 'neto', prompt: 'x', agent: 'claude', projectId: 'p', risk: 'verde', status: 'done', timeoutMin: 5, depth: 2 });
    const r = rocky.apply({
      resultados: [{ tipo: 'venda', titulo: 'A' }, { tipo: 'entrega', titulo: 'B' }, { tipo: 'desbloqueio', titulo: 'C' }, { tipo: 'venda', titulo: 'D' }, { tipo: 'outro', titulo: 'E' }],
      jobs: [
        { titulo: 'bisneto', agente: 'claude', projeto: 'p', tarefa: 't', minutos: 10, pai: deep.id },
        { titulo: 'Enviar a proposta ao cliente', agente: 'claude', projeto: 'p', tarefa: 'enviar e-mail', minutos: 10 },
        { titulo: 'longo demais', agente: 'claude', projeto: 'p', tarefa: 't', minutos: 121 },
        { titulo: 'Peça 0', agente: 'claude', projeto: 'p', tarefa: 't', minutos: 10 },
      ],
    });
    expect(r.resultados).toHaveLength(3);
    expect(r.recusados.map((x) => x.motivo)).toEqual([expect.stringMatching(/profundidade/), expect.stringMatching(/VERMELHO/), expect.stringMatching(/duração/), expect.stringMatching(/já está na fila/)]);
    expect(r.pedidos.map((p) => p.titulo)).toContain('Enviar a proposta ao cliente');
    // Mesma situação → o replanejamento por evento não roda de novo.
    for (const [, a] of sched.active) a.proc.kill();
    store.db.prepare("UPDATE jobs SET status = 'done'").run();
    const e1 = rocky.eventTick();
    expect(e1).toBeTruthy();
    store.db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(e1!.id);
    expect(rocky.eventTick()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('merge_identity_serial_recovery', () => {
  let repo: string;
  beforeEach(() => {
    repo = join(dir, 'sandbox');
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# Sandbox\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init');
    store.upsertProject({ id: 'sandbox', name: 'Sandbox', path: repo, isGit: true, isTest: true });
  });

  const pass = 'Conferi.\n```json\n{"veredito":"PASS","problemas":[]}\n```';

  it('Sandbox: PASS no mesmo diff → integra sozinho, em série, contando integrações limpas', async () => {
    script = (j) => (j.kind === 'review' ? say(pass) : ['write', j.title.replace(/\s/g, '-') + '.txt']);
    const a = task({ title: 'arquivo a', projectId: 'sandbox' });
    const b = task({ title: 'arquivo b', projectId: 'sandbox', agent: 'codex' });
    await waitFor(() => store.getJob(a.id)!.status === 'done' && store.getJob(b.id)!.status === 'done', 20_000);
    expect(store.getJob(a.id)!.step).toMatch(/Auto-merge/);
    expect(existsSync(join(repo, 'arquivo-a.txt')) && existsSync(join(repo, 'arquivo-b.txt'))).toBe(true);
    expect(sched.autoMerge.state().limpas).toBe(2);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('diff alterado depois da revisão invalida a aprovação; teste falhando deixa o destino intacto; regressão suspende e reverte', async () => {
    const project = store.getProject('sandbox')!;
    const head0 = git(repo, 'rev-parse', 'HEAD');
    // Branch de trabalho.
    git(repo, 'switch', '-c', 'job/x');
    writeFileSync(join(repo, 'x.txt'), 'x\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'x');
    git(repo, 'switch', 'main');
    const job = { id: 'job-x', branch: 'job/x' } as Job;
    const binding = sched.autoMerge.bind(repo, head0, git(repo, 'rev-parse', 'job/x'));
    // 1) Diff mudou depois da revisão.
    git(repo, 'switch', 'job/x');
    writeFileSync(join(repo, 'x.txt'), 'x2\n');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-am', 'x2');
    git(repo, 'switch', 'main');
    expect(sched.autoMerge.integrate(project, job, binding, 'm')).toMatchObject({ ok: false, newReview: true });
    const fresh = sched.autoMerge.bind(repo, head0, git(repo, 'rev-parse', 'job/x'));
    // 2) Testes falham no candidato: destino intacto.
    sched.autoMerge.testCommand = () => ['node', '-e', 'process.exit(1)'];
    expect(sched.autoMerge.integrate(project, job, fresh, 'm')).toMatchObject({ ok: false, amarelo: true });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head0);
    // 3) Tentativa interrompida na promoção é reconciliada.
    store.kvSet('automerge.tentativa.sandbox', { jobId: 'job-y', project: 'sandbox', state: 'promoting', base: head0, head: head0, diffHash: 'x', expectedTarget: head0, candidate: 'nao-existe', at: '' });
    expect(sched.autoMerge.reconcile(project)).toMatchObject({ state: 'failed' });
    // 4) Passa no candidato mas quebra no destino (smoke): suspende e reverte.
    sched.autoMerge.testCommand = (_p, cwd) => (cwd.includes('_integracao') ? null : ['node', '-e', 'process.exit(1)']);
    const r = sched.autoMerge.integrate(project, job, fresh, 'Integra x');
    expect(r).toMatchObject({ ok: false, amarelo: true });
    expect(sched.autoMerge.state().suspenso).toMatch(/Regressão/);
    expect(existsSync(join(repo, 'x.txt'))).toBe(false); // revertido
    expect(sched.autoMerge.eligible(project)).toBe(false);
    // Arquivo sensível: sempre AMARELO.
    expect(sched.autoMerge.sensitive(['apps/server/src/auth.ts'], '')).toMatch(/sensível/);
    expect(sched.autoMerge.sensitive(['db.ts'], 'ALTER TABLE jobs DROP COLUMN x')).toMatch(/destrutiva/);
  });
});

// ---------------------------------------------------------------------------
// Problemas apontados pela revisão do Codex na Sprint 2 (job 20261028-0237-b32e).
describe('revisão do Codex na Sprint 2', () => {
  it('reserva viva na fila conta (duas reservas seguidas não estouram o limite nem o paralelismo)', () => {
    sched.capacity.setGroup('chatgpt', { dailyMinutes: 100, maxParallel: 1 });
    const mk = (min: number) => store.createJob({ title: 't', prompt: 'x', agent: 'codex', projectId: 'p', risk: 'verde', status: 'queued', timeoutMin: min });
    expect(sched.capacity.reserve(mk(40))).toMatchObject({ ok: true });
    expect(sched.capacity.reserve(mk(40))).toMatchObject({ ok: false });
  });

  it('Rocky: "credenciais" vira pedido; filho herda o objetivo; revisões contam; orçamento abate o consumo real', () => {
    const rocky = new Rocky(sched, { projectPath: join(dir, 'rocky') });
    rocky.registerRoutines(sched.routines);
    const r = rocky.apply({ jobs: [{ titulo: 'Atualizar credenciais do serviço', agente: 'codex', projeto: 'p', tarefa: 'Alterar credenciais', minutos: 10 }] });
    expect(r.criados).toHaveLength(0);
    expect(r.pedidos.map((p) => p.titulo)).toContain('Atualizar credenciais do serviço');
    const obj = store.createObjective({ title: 'O', description: 'x', projectId: 'p', status: 'running' });
    store.db.prepare('UPDATE objectives SET budget_minutes = 30 WHERE id = ?').run(obj.id);
    const a = rocky.apply({ jobs: [{ titulo: 'Pai', agente: 'claude', projeto: 'p', tarefa: 't', minutos: 20, objetivo_id: obj.id }] });
    const pai = store.getJob(a.criados[0])!;
    expect(pai.planKey).toMatch(new RegExp(`^rocky-obj:${obj.id}:`));
    // Consumo real de 20 min abate o orçamento: outro de 20 não cabe (20 + 20 > 30).
    for (const [, x] of sched.active) x.proc.kill();
    store.db.prepare("UPDATE jobs SET status = 'running', capacity_group_id = 'claude', reserved_minutes = 20, started_at = ?, finished_at = ? WHERE id = ?").run('2026-10-28T10:00:00.000Z', '2026-10-28T10:20:00.000Z', pai.id);
    sched.capacity.release(pai.id);
    store.db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(pai.id);
    expect((store.db.prepare('SELECT spent_minutes s FROM objectives WHERE id = ?').get(obj.id) as any).s).toBe(20);
    const filho = rocky.apply({ jobs: [{ titulo: 'Filho', agente: 'claude', projeto: 'p', tarefa: 't', minutos: 20, pai: pai.id }] });
    expect(filho.recusados[0].motivo).toMatch(/orçamento/);
    // Revisão de um job ligado conta como descendente.
    // (o Flow dá à revisão a mesma ligação do job revisado)
    store.createJob({ title: 'rev', prompt: 'x', agent: 'codex', projectId: 'p', risk: 'verde', status: 'done', timeoutMin: 5, kind: 'review', targetJobId: pai.id, planKey: pai.planKey });
    expect(rocky.descendants(obj.id)).toBe(2);
    // Pedido pendente não some numa rodada nova.
    expect(rocky.apply({}).pedidos.map((p) => p.titulo)).toContain('Atualizar credenciais do serviço');
  });

  it('auto-merge: acesso/confirmação humana e app.ts são sensíveis; base diferente invalida; queda depois da promoção roda o smoke', () => {
    const am = sched.autoMerge;
    expect(am.sensitive(['apps/server/src/app.ts'], '')).toBeTruthy();
    expect(am.sensitive(['apps/server/src/renda/human.ts'], '')).toBeTruthy();
    expect(am.sensitive(['x.ts'], '+ if (!req.device) return')).toMatch(/acesso/);
    const repo = join(dir, 'r');
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'a');
    store.upsertProject({ id: 'sandbox', name: 'S', path: repo, isGit: true, isTest: true });
    const head = git(repo, 'rev-parse', 'HEAD');
    // "Promovido" (HEAD = candidato) mas sem smoke: a reconciliação roda o smoke, que quebra → suspende.
    store.kvSet('automerge.tentativa.sandbox', { jobId: 'j', project: 'sandbox', state: 'promoting', base: head, head, diffHash: 'x', expectedTarget: head, candidate: head, at: '' });
    am.testCommand = () => ['node', '-e', 'process.exit(1)'];
    const fixed = am.reconcile(store.getProject('sandbox')!)!;
    expect(fixed.state).not.toBe('done');
    expect(am.state().suspenso).toMatch(/Regressão/);
    // Travas de merge de uma tentativa interrompida são soltas no reinício.
    store.acquireLock('merge:sandbox', 'j');
    sched.recoverAfterRestart();
    expect(store.isLocked('merge:sandbox', 'outro')).toBe(false);
  });

  it('alertas: linha de base na inicialização; o primeiro lead forte depois disso avisa', async () => {
    const { Alerts } = await import('../src/resumo.ts');
    const renda = new Renda(sched, { projectPath: join(dir, 'renda') });
    const sent: string[] = [];
    const alerts = new Alerts(sched, (p) => sent.push(p.title));
    alerts.wire();
    renda.store.addLead({ projectId: 'renda', sourceUrl: 'https://x.test/forte', postedAt: null, company: 'Forte', channel: 'site', need: 'criativos', evidence: 'precisa de criativos já', scoreDetail: { demanda: 'integral', aderencia: 'integral', orcamento: 'integral', contato: 'integral' } });
    alerts.check();
    expect(sent).toEqual(['Lead forte (90)']);
    alerts.check();
    expect(sent).toHaveLength(1); // deduplicado
  });
});
