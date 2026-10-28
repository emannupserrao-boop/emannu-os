// Testes de aceite da Sprint 3 do refino v3.1.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Scheduler } from '../src/scheduler.ts';
import { Vault } from '../src/vault.ts';
import { claudeAdapter, type AgentAdapter } from '../src/runners/adapters.ts';
import { ResearchMemory } from '../src/memory.ts';
import { Conselho } from '../src/conselho.ts';
import { Benchmark, decide, taskPct } from '../src/benchmark.ts';
import { Maintenance } from '../src/manutencao.ts';
import { Renda } from '../src/renda/index.ts';
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
let vaultDir: string;
let prompts: Record<string, string>;
let script: (job: Job) => string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'emannu-s3-'));
  vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir);
  store = new Store(':memory:');
  prompts = {};
  script = () => say('ok');
  const fake: AgentAdapter = { buildArgs: (job, _c, prompt) => ((prompts[job.planKey ?? job.id] = prompt), { args: [FAKE, ...script(job)], stdin: prompt }), parse: claudeAdapter.parse };
  sched = new Scheduler({ store, vault: new Vault(vaultDir), logDir: join(dir, 'logs'), worktreesDir: join(dir, 'wt'), adapters: { claude: fake, codex: fake, hermes: fake, openclaw: fake }, resolveExe: () => process.execPath });
});

afterEach(async () => {
  for (const [, a] of sched.active) a.proc.kill();
  await new Promise((r) => setTimeout(r, 250));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('hermes_memory_provenance', () => {
  it('só entra com URL e sem dados pessoais; vence sozinha; vai no prompt como dado', async () => {
    let now = new Date('2026-10-28T10:00:00Z');
    const m = new ResearchMemory(store, () => now);
    const r = m.add([
      { tipo: 'fonte_boa', texto: 'r/TrafegoPago tem pedidos reais toda semana', url: 'https://www.reddit.com/r/TrafegoPago/', validade_dias: 30 },
      { tipo: 'criterio', texto: 'Sem link não conta', url: '' },
      { tipo: 'descarte', texto: 'Contato: joao@exemplo.com', url: 'https://x.test/1' },
      { tipo: 'criterio', texto: 'Telefone +55 11 91234-5678 é bom', url: 'https://x.test/2' },
      { tipo: 'descarte', texto: 'Pedidos de teste grátis completo', url: 'https://x.test/3', validade_dias: 999 },
      { tipo: 'inventado', texto: 'x', url: 'https://x.test/4' },
    ], 'job-1');
    expect(r.aceitos).toBe(2);
    expect(r.recusados.join(' ')).toMatch(/sem procedência/);
    expect(r.recusados.filter((x) => /dado pessoal/.test(x))).toHaveLength(2);
    expect(m.list().map((x) => x.validade)).toEqual(['2026-11-27', '2027-01-26']); // validade máxima de 90 dias
    expect(m.promptBlock()).toMatch(/r\/TrafegoPago tem pedidos reais .*reddit\.com.*válido até 2026-11-27/);
    now = new Date('2026-12-01T10:00:00Z');
    expect(m.list()).toHaveLength(1); // a de 30 dias venceu
    // O prompt do Hermes de leads leva a memória; a resposta dele alimenta a memória.
    const renda = new Renda(sched, { projectPath: join(dir, 'renda') });
    store.kvSet('hermes.memoria.pesquisa', []);
    script = () => say('ok\n```json\n' + JSON.stringify({ leads: [], lacunas: ['nada hoje'], memoria: [{ tipo: 'fonte_ruim', texto: 'Grupo X só tem spam', url: 'https://x.test/spam' }] }) + '\n```');
    const job = renda.enqueueLeads('2026-10-28');
    await waitFor(() => store.getJob(job.id)!.status === 'done');
    expect(sched.memory.list()).toMatchObject([{ tipo: 'fonte_ruim', url: 'https://x.test/spam', jobId: job.id }]);
    expect(prompts['comercial:leads:2026-10-28']).toMatch(/Memória do perfil "pesquisa"/);
  });
});

describe('conselho_two_independent', () => {
  it('Claude e Hermes respondem em paralelo sem ver um ao outro; a síntese vem depois dos dois', async () => {
    sched.probes.hermes = { installed: true, version: '0.22.5', authenticated: true, exe: 'x' };
    const c = new Conselho(sched, { projectPath: join(dir, 'conselho') });
    script = (j) => say(j.planKey!.endsWith(':claude') ? 'RESPOSTA-DO-CLAUDE' : j.planKey!.endsWith(':hermes') ? 'RESPOSTA-DO-CHATGPT' : 'SÍNTESE: divergem em X');
    const caso = c.ask('Qual renda priorizar em dezembro: Motion ou sites?');
    const jobs = store.listJobs().filter((j) => j.planKey?.startsWith(`conselho:${caso.id}`));
    expect(jobs.map((j) => j.agent).sort()).toEqual(['claude', 'hermes']);
    expect(jobs.every((j) => j.status === 'running')).toBe(true); // em paralelo
    const done = await waitFor(() => c.get(caso.id)!.estado === 'pronto' && c.get(caso.id)!);
    expect(prompts[`conselho:${caso.id}:claude`]).not.toMatch(/RESPOSTA-DO-CHATGPT/);
    expect(prompts[`conselho:${caso.id}:hermes`]).not.toMatch(/RESPOSTA-DO-CLAUDE/);
    expect(prompts[`conselho:${caso.id}:sintese`]).toMatch(/RESPOSTA-DO-CLAUDE[\s\S]*RESPOSTA-DO-CHATGPT/);
    expect(done.sintese).toMatch(/SÍNTESE/);
    expect(done.vaultNote).toMatch(/Conselho/);
    expect(() => c.ask('curta')).toThrow();
  });
});

describe('local_benchmark_rubric', () => {
  it('nota por rubrica; local só assume a tarefa com ≥ 80% da nota do Claude (e latência no MIRAE)', async () => {
    const claude = { modelo: 'claude', notas: { historico: [2, 2, 2, 2], 'triagem-log': [2, 2, 2], 'classificar-lead': [2, 2, 2], 'mirae-gsi': [2, 2] }, latenciaMs: 900 };
    const qwen = { modelo: 'qwen-14b', notas: { historico: [2, 2, 1, 2], 'triagem-log': [2, 1, 1], 'classificar-lead': [2, 2, 1], 'mirae-gsi': [2, 2] }, latenciaMs: 2600 };
    const llama = { modelo: 'llama-8b', notas: { historico: [1, 1, 1, 1], 'triagem-log': [2, 2, 1], 'classificar-lead': [1, 1, 0], 'mirae-gsi': [2, 2] }, latenciaMs: 700 };
    expect(taskPct('historico', [2, 2, 1, 2])).toBe(7 / 8);
    expect(taskPct('historico', [9, 9, 9, 9, 9])).toBe(1); // nota fora da escala é limitada
    const d = decide(claude, qwen);
    expect(d.find((x) => x.tarefa === 'historico')!.aprovado).toBe(true); // 87,5%
    expect(d.find((x) => x.tarefa === 'triagem-log')!.aprovado).toBe(false); // 66,7%
    expect(d.find((x) => x.tarefa === 'mirae-gsi')!.aprovado).toBe(false); // latência 2,6 s
    const b = new Benchmark(store, (async () => ({ ok: true, json: async () => ({ data: [{ id: 'qwen-14b' }] }) })) as any);
    expect(await b.lmStudioModels()).toEqual(['qwen-14b']);
    const res = b.record(claude, [qwen, llama]);
    // Melhor local por tarefa: histórico (qwen 87,5%), lead (qwen 83%), triagem (llama 83%), MIRAE (llama, latência ok).
    expect(b.approved().sort()).toEqual(['classificar-lead', 'historico', 'mirae-gsi', 'triagem-log']);
    expect(res.modelos).toEqual(['qwen-14b', 'llama-8b']);
    const off = new Benchmark(store, (async () => { throw new Error('recusado'); }) as any);
    expect(await off.lmStudioModels()).toBeNull();
  });

  it('OpenClaw com GPU só vai para o grupo "local" na tarefa aprovada no benchmark', () => {
    const job = { agent: 'openclaw' as const, gpuRequired: true, planKey: 'local:historico:1' };
    expect(sched.capacity.groupOf(job)).toBe('claude'); // sem aprovação: motor normal, cota do Claude
    sched.benchmark = new Benchmark(store);
    sched.benchmark.record({ modelo: 'claude', notas: { historico: [2, 2, 2, 2] } }, [{ modelo: 'qwen/qwen3-8b', notas: { historico: [2, 2, 2, 2] } }]);
    expect(sched.capacity.groupOf(job)).toBe('local');
    expect(sched.capacity.groupOf({ agent: 'openclaw' })).toBe('claude');
  });

  it('Rocky: frase negada ("não enviar nada") não vira VERMELHO', async () => {
    const { Rocky } = await import('../src/rocky.ts');
    store.upsertProject({ id: 'p', name: 'P', path: dir, isGit: false });
    const rocky = new Rocky(sched, { projectPath: join(dir, 'rocky') });
    const r = rocky.apply({ jobs: [{ titulo: 'Listar 10 leads', agente: 'hermes', projeto: 'p', tarefa: 'Pesquisar pedidos públicos. Não fazer nenhum contato, envio ou cadastro.', minutos: 30 }] });
    expect(r.criados).toHaveLength(1);
    expect(rocky.apply({ jobs: [{ titulo: 'Enviar a proposta', agente: 'claude', projeto: 'p', tarefa: 'mandar e-mail', minutos: 10 }] }).criados).toHaveLength(0);
  });
});

describe('maintenance_weekly_block', () => {
  it('quarta 15h: bloco no Current State (mudanças do git ou "sem mudança"), uma vez por projeto e semana', async () => {
    const mk = (id: string, nome: string, commit: boolean) => {
      const repo = join(dir, id);
      mkdirSync(repo);
      git(repo, 'init', '-b', 'main');
      writeFileSync(join(repo, 'a.txt'), 'a');
      git(repo, 'add', '.');
      git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', commit ? 'Chefe novo da Rodovia 9' : 'init', ...(commit ? [] : ['--date=2026-01-01T00:00:00']));
      if (!commit) git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--amend', '--no-edit', '--date=2026-01-01T00:00:00');
      const folder = `20 - PROJECTS\\${nome}`;
      mkdirSync(join(vaultDir, '20 - PROJECTS', nome), { recursive: true });
      writeFileSync(join(vaultDir, '20 - PROJECTS', nome, `${nome} - Current State.md`), `# ${nome}\n\nTexto do Emannuel.\n`);
      store.upsertProject({ id, name: nome, path: repo, isGit: true, vaultFolder: folder });
    };
    mk('neon-vanguard', 'Neon Vanguard', true);
    mk('mirae', 'MIRAE', false);
    const m = new Maintenance(sched);
    m.registerRoutines(sched.routines);
    // Quarta, 15h05 em Bucareste.
    const wed = new Date('2026-10-28T13:05:00Z');
    expect(await sched.routines.tick(wed)).toContain('manutencao');
    const nv = readFileSync(join(vaultDir, '20 - PROJECTS', 'Neon Vanguard', 'Neon Vanguard - Current State.md'), 'utf8');
    expect(nv).toContain('Texto do Emannuel.');
    expect(nv).toMatch(/Manutenção semanal[\s\S]*Chefe novo da Rodovia 9/);
    expect(readFileSync(join(vaultDir, '20 - PROJECTS', 'MIRAE', 'MIRAE - Current State.md'), 'utf8')).toMatch(/Sem mudança na última semana/);
    // Mesmo horário de novo: nada duplicado.
    await sched.routines.tick(new Date('2026-10-28T13:30:00Z'));
    expect(readFileSync(join(vaultDir, '20 - PROJECTS', 'MIRAE', 'MIRAE - Current State.md'), 'utf8').match(/Manutenção semanal/g)).toHaveLength(1);
    // Relatório de sexta.
    const note = m.writeReport('2026-10-30')!;
    const text = readFileSync(join(vaultDir, note), 'utf8');
    expect(text).toMatch(/# Semana até 2026-10-30/);
    expect(text).toMatch(/## Decisões para você \(20 min\)/);
  });

  it('auto-merge para todos só depois do marco (10 limpas e dia ≥ 4)', () => {
    const am = sched.autoMerge;
    store.kvSet('automerge.estado', { limpas: 9, desde: new Date().toISOString(), suspenso: null, todos: false });
    expect(am.eligible({ id: 'emannu-os', isGit: true } as any)).toBe(false);
    expect(am.eligible({ id: 'sandbox', isGit: true } as any)).toBe(true);
    store.kvSet('automerge.estado', { limpas: 12, desde: '2026-10-20T00:00:00Z', suspenso: null, todos: true });
    expect(am.eligible({ id: 'emannu-os', isGit: true } as any)).toBe(true);
    store.kvSet('automerge.estado', { limpas: 12, desde: '2026-10-20T00:00:00Z', suspenso: 'regressão', todos: true });
    expect(am.eligible({ id: 'sandbox', isGit: true } as any)).toBe(false);
  });
});

describe('revisão do Codex na Sprint 3', () => {
  it('memória recusa e-mail escondido na URL codificada', () => {
    const m = new ResearchMemory(store);
    expect(m.add([{ tipo: 'fonte_boa', texto: 'Lista de agências', url: 'https://x.test/l?email=joao%40example.test' }], null).aceitos).toBe(0);
  });

  it('motor local só com a tarefa aprovada no benchmark, com o modelo vencedor', () => {
    const b = new Benchmark(store);
    sched.benchmark = b;
    expect(b.modelFor('local:historico:1')).toBeNull();
    const claude = { modelo: 'claude', notas: { historico: [2, 2, 2, 2] } };
    b.record(claude, [{ modelo: 'qwen-14b', notas: { historico: [2, 2, 2, 1] } }, { modelo: 'llama-8b', notas: { historico: [1, 1, 1, 1] } }]);
    expect(b.modelFor('local:historico:1')).toBe('qwen-14b');
    expect(b.modelFor('local:triagem-log:1')).toBeNull();
    expect(b.modelFor(null)).toBeNull();
  });

  it('marco do auto-merge vale quando o prazo chega, sem precisar de nova integração', () => {
    store.kvSet('automerge.estado', { limpas: 10, desde: new Date(Date.now() - 4 * 86_400_000).toISOString(), suspenso: null, todos: false });
    expect(sched.autoMerge.eligible({ id: 'emannu-os', isGit: true } as any)).toBe(true);
  });

  it('manutenção não repete o bloco se a reserva foi desfeita depois de gravar', async () => {
    const folder = '20 - PROJECTS\\X';
    mkdirSync(join(vaultDir, '20 - PROJECTS', 'X'), { recursive: true });
    const cs = join(vaultDir, '20 - PROJECTS', 'X', 'X - Current State.md');
    writeFileSync(cs, '# X\n\n<!-- emannu-os:manutencao:2026-10-28 -->\nbloco já gravado\n');
    store.upsertProject({ id: 'neon-vanguard', name: 'X', path: join(dir, 'nao-existe'), isGit: false, vaultFolder: folder });
    const m = new Maintenance(sched);
    m.registerRoutines(sched.routines);
    await sched.routines.tick(new Date('2026-10-28T13:05:00Z'));
    expect(readFileSync(cs, 'utf8').match(/manutencao:2026-10-28/g)).toHaveLength(1);
  });
});


describe('executor do benchmark local', () => {
  it('roda as 4 tarefas nos modelos locais (GPU exclusiva), o Claude dá as notas e a latência vem do servidor', async () => {
    const { BenchRunner } = await import('../src/benchrun.ts');
    const sse = (t: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\ndata: [DONE]\n\n`);
    const fakeFetch = (async (url: string) => (String(url).endsWith('/models') ? new Response(JSON.stringify({ data: [{ id: 'qwen3-8b' }, { id: 'text-embedding-x' }] })) : sse('<think>hmm</think>Resposta local'))) as any;
    const runner = new BenchRunner(sched, new Benchmark(store, fakeFetch), { projectPath: join(dir, 'bench') });
    const notas = { claude: { historico: [2, 2, 2, 2], 'triagem-log': [2, 2, 2], 'classificar-lead': [2, 2, 2], 'mirae-gsi': [2, 2] }, A: { historico: [2, 2, 2, 1], 'triagem-log': [1, 1, 1], 'classificar-lead': [2, 2, 2], 'mirae-gsi': [2, 2] } };
    script = () => say('Notas.\n```json\n' + JSON.stringify({ notas }) + '\n```');
    const job = await runner.run(fakeFetch);
    expect(store.isLocked('gpu', 'outro')).toBe(false); // GPU devolvida
    const p: any = store.kvGet(`benchmark.pendente.${job.planKey!.slice(6)}`);
    expect(p.modelos).toEqual(['qwen3-8b']); // embedding fica de fora
    expect(p.saidas['qwen3-8b'].historico).toBe('Resposta local'); // raciocínio removido
    expect(prompts[job.planKey!]).toMatch(/<resposta_A>\nResposta local/);
    await waitFor(() => store.getJob(job.id)!.status === 'done');
    expect(runner.bench.approved().sort()).toEqual(['classificar-lead', 'historico', 'mirae-gsi']);
    expect(readFileSync(join(vaultDir, '80 - AUTOMATION', 'Benchmark local (LM Studio).md'), 'utf8')).toMatch(/✅ local/);
    // Modo jogo ligado: não começa.
    sched.gameMode.setPauseAll(false);
    store.kvSet('modojogo', { ativo: true, desde: new Date().toISOString(), motivo: 'jogo', pausarTudo: false, historico: [] });
    await expect(runner.run(fakeFetch)).rejects.toThrow(/Modo jogo/);
  });
});
