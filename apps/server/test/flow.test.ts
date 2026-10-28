import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Scheduler } from '../src/scheduler.ts';
import { claudeAdapter, type AgentAdapter } from '../src/runners/adapters.ts';
import { git } from '../src/worktrees.ts';
import { Vault } from '../src/vault.ts';
import { parsePlan, parseReview, parseVerdict } from '../src/prompts.ts';
import type { Job } from '../../../packages/shared/types.ts';

const FAKE = join(import.meta.dirname, 'fake-agent.mjs');
const say = (text: string) => ['say', Buffer.from(text).toString('base64')];
const planText = (jobs: any[], manual: string[] = []) => 'Plano pronto.\n```json\n' + JSON.stringify({ resumo: 'estratégia de teste', jobs, acoes_manuais: manual }) + '\n```';

async function waitFor<T>(fn: () => T | null | undefined | false, ms = 20_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timeout esperando condição');
}

let dir: string;
let repo: string;
let vaultDir: string;
let store: Store;
let sched: Scheduler;
// Roteiro do agente falso: decide o que cada job "faz".
let script: (job: Job) => string[];

const CURRENT_STATE = '---\ntype: current-state\n---\n# Projeto Teste — Current State\n\nTexto escrito à mão pelo Emannuel.\n';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'emannu-flow-'));
  repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# Projeto Teste\n\nUm jogo de teste.\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init');

  vaultDir = join(dir, 'vault');
  mkdirSync(join(vaultDir, '20 - PROJECTS', 'Projeto Teste'), { recursive: true });
  mkdirSync(join(vaultDir, '90 - INBOX'), { recursive: true });
  writeFileSync(join(vaultDir, '20 - PROJECTS', 'Projeto Teste', 'Projeto Teste - Current State.md'), CURRENT_STATE);
  const vault = new Vault(vaultDir);

  store = new Store(':memory:');
  store.upsertProject({ id: 'p', name: 'Projeto Teste', path: repo, isGit: true, vaultFolder: vault.findProjectFolder('Projeto Teste') });
  const fake: AgentAdapter = { buildArgs: (job, _cwd, prompt) => ({ args: [FAKE, ...script(job)], stdin: prompt }), parse: claudeAdapter.parse };
  sched = new Scheduler({ store, vault, logDir: join(dir, 'logs'), worktreesDir: join(dir, 'wt'), adapters: { claude: fake, codex: fake }, resolveExe: () => process.execPath });
});

afterEach(async () => {
  for (const [, a] of sched.active) a.proc.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const obj = (id: string) => store.getObjective(id)!;
const jobsOf = (id: string) => store.jobsOfObjective(id);

describe('Objetivo de ponta a ponta', () => {
  it('plano → aprovação → dependência → revisão cruzada → correção → entrega → merge final', async () => {
    const reviews = new Map<string, number>();
    script = (job) => {
      if (job.kind === 'plan') {
        return say(planText([
          { chave: 'j1', titulo: 'Ferramenta', agente: 'codex', tipo: 'implementacao', tarefa: 'criar a.txt', criterio_aceite: 'a.txt existe', risco: 'verde', depende_de: [], minutos: 10 },
          { chave: 'j2', titulo: 'Documento', agente: 'claude', tipo: 'texto', tarefa: 'criar b.txt', criterio_aceite: 'b.txt existe', risco: 'verde', depende_de: ['j1'], minutos: 10 },
        ], ['Publicar no itch.io']));
      }
      if (job.kind === 'task') return job.planKey === 'j1' ? ['write', 'a.txt'] : ['write', 'b.txt', 'need:a.txt'];
      if (job.kind === 'fix') return ['write', 'b-corrigido.txt'];
      // Revisão: o trabalho do Claude (j2) é reprovado na primeira vez.
      const n = (reviews.get(job.targetJobId!) ?? 0) + 1;
      reviews.set(job.targetJobId!, n);
      const target = store.getJob(job.targetJobId!)!;
      return say(target.planKey === 'j2' && n === 1 ? 'Falta o arquivo corrigido.\n```json\n{"veredito":"FAIL","problemas":[{"arquivo":"x","motivo":"falta"}]}\n```' : 'Conferi tudo.\n```json\n{"veredito":"PASS","problemas":[]}\n```');
    };

    const o = sched.flow.createObjective({ title: 'Mapa do código', description: 'Documentar e criar ferramenta', projectId: 'p' });
    expect(o.contextPack).toContain('Texto escrito à mão');
    await waitFor(() => obj(o.id).status === 'plan_ready');
    const plan = obj(o.id).plan!;
    expect(plan.items.map((i) => i.key)).toEqual(['j1', 'j2']);
    expect(plan.manual).toEqual(['Publicar no itch.io']);

    sched.flow.approvePlan(o.id);
    expect(obj(o.id).status).toBe('running');
    expect(git(repo, 'branch', '--list', 'obj/*')).toContain('obj/');

    await waitFor(() => obj(o.id).status === 'ready', 30_000);
    const all = jobsOf(o.id);
    const tasks = all.filter((j) => j.kind === 'task');
    const revs = all.filter((j) => j.kind === 'review');
    const fixes = all.filter((j) => j.kind === 'fix');
    // Revisão cruzada: cada trabalho é revisado pelo OUTRO agente.
    for (const r of revs) expect(r.agent).not.toBe(store.getJob(r.targetJobId!)!.agent);
    expect(revs.map((r) => r.verdict)).toEqual(['aprovado', 'reprovado', 'aprovado']);
    expect(fixes).toHaveLength(1);
    expect(fixes[0].agent).toBe('claude');
    expect(tasks.every((t) => t.status === 'done')).toBe(true);
    // j2 só começou depois de j1 integrado (o agente falso falharia sem a.txt).
    const [j1, j2] = tasks;
    expect(Date.parse(j2.startedAt!)).toBeGreaterThan(Date.parse(j1.finishedAt!));

    // Nota de entrega no vault, sem tocar no branch principal ainda.
    const o2 = obj(o.id);
    expect(o2.vaultNote).toMatch(/^80 - AUTOMATION\/Jobs\/\d{4}-\d{2}-\d{2} - Projeto Teste - Mapa do código\.md$/);
    const note = readFileSync(join(vaultDir, o2.vaultNote!), 'utf8');
    expect(note).toContain('REPROVADO');
    expect(note).toContain('Publicar no itch.io');
    expect(existsSync(join(repo, 'a.txt'))).toBe(false);

    // Merge final (AMARELO) + bloco datado no Current State.
    sched.flow.approveDelivery(o.id);
    expect(obj(o.id).status).toBe('done');
    for (const f of ['a.txt', 'b.txt', 'b-corrigido.txt']) expect(existsSync(join(repo, f))).toBe(true);
    const cs = readFileSync(join(vaultDir, '20 - PROJECTS', 'Projeto Teste', 'Projeto Teste - Current State.md'), 'utf8');
    expect(cs.startsWith(CURRENT_STATE)).toBe(true); // nada do que você escreveu foi alterado
    expect(cs).toContain('Entrega: Mapa do código');
    expect(readFileSync(join(vaultDir, o2.vaultNote!), 'utf8')).toContain('Merge aprovado');
    expect(git(repo, 'branch', '--list', 'job/*')).toBe('');
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('reprovado 3 vezes: 2 correções e depois sobe para você', async () => {
    script = (job) =>
      job.kind === 'plan'
        ? say(planText([{ chave: 'j1', titulo: 'Coisa', agente: 'codex', tarefa: 'x', criterio_aceite: 'y' }]))
        : job.kind === 'review'
          ? say('Ainda errado.\n```json\n{"veredito":"FAIL","problemas":["errado"]}\n```')
          : ['write', `v${Date.now()}.txt`];
    const o = sched.flow.createObjective({ title: 'Teimoso', description: 'd', projectId: 'p' });
    await waitFor(() => obj(o.id).status === 'plan_ready');
    sched.flow.approvePlan(o.id);
    await waitFor(() => obj(o.id).status === 'attention', 30_000);
    const all = jobsOf(o.id);
    expect(all.filter((j) => j.kind === 'fix')).toHaveLength(2);
    expect(all.filter((j) => j.kind === 'review')).toHaveLength(3);
    const task = all.find((j) => j.kind === 'task')!;
    expect(task.status).toBe('review');
    expect(task.step).toMatch(/Reprovado 3x/);
    // Você decide: aprovar mesmo assim integra no objetivo e entrega.
    sched.approve(task.id);
    await waitFor(() => obj(o.id).status === 'ready');
  });

  it('você pode trocar o agente de um job ao aprovar o plano', async () => {
    script = (job) => (job.kind === 'plan' ? say(planText([{ chave: 'a', titulo: 'A', agente: 'codex', tarefa: 't' }])) : ['sleep', '60000']);
    const o = sched.flow.createObjective({ title: 'Troca', description: 'd', projectId: 'p' });
    await waitFor(() => obj(o.id).status === 'plan_ready');
    sched.flow.approvePlan(o.id, { a: 'claude' });
    expect(jobsOf(o.id).find((j) => j.kind === 'task')!.agent).toBe('claude');
    sched.flow.cancelObjective(o.id);
    await waitFor(() => sched.active.size === 0);
    expect(obj(o.id).status).toBe('canceled');
    expect(readdirSync(join(dir, 'wt', 'projeto-teste'))).toEqual([]);
  });

  it('plano inválido marca o objetivo como falho e dá para refazer', async () => {
    script = () => say('não sei planejar');
    const o = sched.flow.createObjective({ title: 'Ruim', description: 'd', projectId: 'p' });
    await waitFor(() => obj(o.id).status === 'failed');
    expect(obj(o.id).error).toMatch(/JSON/);
    script = (job) => (job.kind === 'plan' ? say(planText([{ chave: 'a', titulo: 'A', tarefa: 't' }])) : ['write']);
    sched.flow.startPlanning(o.id, { feedback: 'tente de novo' });
    await waitFor(() => obj(o.id).status === 'plan_ready');
    expect(store.getJob(obj(o.id).planJobId!)!.acceptance).toBe('tente de novo');
  });
});

describe('Revisão cruzada de job avulso', () => {
  it('"Pedir revisão cruzada" chama o outro agente e devolve para você', async () => {
    script = (job) => (job.kind === 'review' ? say('Bom.\n```json\n{"veredito":"PASS"}\n```') : ['write']);
    const j = sched.createJob({ title: 'avulso', prompt: 'p', agent: 'claude', projectId: 'p' });
    await waitFor(() => store.getJob(j.id)!.status === 'review');
    const review = sched.requestReview(j.id);
    expect(review.agent).toBe('codex');
    await waitFor(() => store.getJob(j.id)!.step?.includes('Aprovado na revisão cruzada (Codex)'));
    expect(store.getJob(j.id)!.status).toBe('review');
    // Job avulso concluído gera nota própria no vault.
    expect(store.getJob(j.id)!.vaultNote).toMatch(/^80 - AUTOMATION\/Jobs\//);
  });
});

describe('INBOX do vault', () => {
  it('nota com #objetivo vira objetivo proposto uma única vez', () => {
    writeFileSync(join(vaultDir, '90 - INBOX', 'ideia.md'), '---\nprojeto: Projeto Teste\n---\n# Melhorar o menu\n\nQuero um menu mais claro. #objetivo\n');
    writeFileSync(join(vaultDir, '90 - INBOX', 'outra.md'), '# Só uma nota\n\nsem tag\n');
    const created = sched.flow.scanInbox();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ title: 'Melhorar o menu', projectId: 'p', status: 'proposed', source: 'inbox' });
    expect(created[0].description).not.toContain('#objetivo');
    expect(sched.flow.scanInbox()).toHaveLength(0);
    // A nota original não é alterada.
    expect(readFileSync(join(vaultDir, '90 - INBOX', 'ideia.md'), 'utf8')).toContain('#objetivo');
  });
});

describe('parsePlan / parseVerdict', () => {
  it('itens vermelhos viram ação manual e agente padrão segue o tipo', () => {
    const p = parsePlan(planText([
      { chave: 'a', titulo: 'Código', tipo: 'implementacao', tarefa: 't' },
      { chave: 'b', titulo: 'Texto', tipo: 'texto', tarefa: 't', depende_de: ['a', 'x'] },
      { chave: 'c', titulo: 'Enviar e-mail', tarefa: 'mandar', risco: 'vermelho' },
      { chave: 'd', titulo: 'Longo', tarefa: 't', minutos: 90 },
    ]));
    expect(p.items.map((i) => [i.key, i.agent])).toEqual([['a', 'codex'], ['b', 'claude'], ['d', 'codex']]);
    expect(p.items[1].dependsOn).toEqual(['a']);
    // v3.1: até 120 min é VERDE.
    expect(p.items[2].risk).toBe('verde');
    expect(p.manual[0]).toContain('Enviar e-mail');
  });

  it('recusa ciclos', () => {
    expect(() => parsePlan(planText([{ chave: 'a', tarefa: 't', depende_de: ['b'] }, { chave: 'b', tarefa: 't', depende_de: ['a'] }]))).toThrow(/ciclo/);
  });

  // verdict_json_mapping (v3.1): PASS/FAIL em JSON; qualquer outra coisa não integra.
  it('veredito em JSON: PASS → aprovado, FAIL → reprovado, inválido → indefinido', () => {
    const j = (o: unknown) => 'Parecer.\n```json\n' + JSON.stringify(o) + '\n```';
    expect(parseReview(j({ veredito: 'PASS', problemas: [] }))).toEqual({ verdict: 'aprovado', problemas: [] });
    expect(parseReview(j({ veredito: 'fail', problemas: [{ arquivo: 'a.ts', motivo: 'quebra o build' }] }))).toEqual({ verdict: 'reprovado', problemas: [{ arquivo: 'a.ts', motivo: 'quebra o build' }] });
    // O último bloco com veredito vale.
    expect(parseVerdict(j({ veredito: 'FAIL', problemas: ['x'] }) + '\n' + j({ veredito: 'PASS' }))).toBe('aprovado');
    expect(parseVerdict(j({ veredito: 'TALVEZ' }))).toBe('indefinido');
    expect(parseVerdict(j({ veredito: 'PASS', problemas: 'nenhum' }))).toBe('indefinido');
    expect(parseVerdict('```json\n{ quebrado\n```')).toBe('indefinido');
    // A linha antiga do v3 não é mais aceita.
    expect(parseVerdict('VEREDITO: APROVADO')).toBe('indefinido');
    expect(parseVerdict('sem nada')).toBe('indefinido');
  });
});
