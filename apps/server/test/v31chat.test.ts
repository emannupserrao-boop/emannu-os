// Testes de aceite da aba Chat (seção 13) e da ponte do Rocky pelo Slack (13.1).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Scheduler } from '../src/scheduler.ts';
import { claudeAdapter, type AgentAdapter } from '../src/runners/adapters.ts';
import { Chats, converseArgs } from '../src/chat.ts';
import { SlackBridge, SLACK_CONFIG } from '../src/slack.ts';
import { Conselho } from '../src/conselho.ts';
import { Auth } from '../src/auth.ts';
import { buildApp } from '../src/app.ts';
import { ROOT } from '../src/config.ts';
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
let chats: Chats;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'emannu-chat-'));
  store = new Store(':memory:');
  store.upsertProject({ id: 'sandbox', name: 'Sandbox', path: dir, isGit: false, isTest: true });
  // resolveExe aponta para o .mjs falso (o agendador põe o node na frente): os argumentos não repetem o caminho.
  const fake: AgentAdapter = { buildArgs: (_j, _c, prompt) => ({ args: say('feito'), stdin: prompt }), parse: claudeAdapter.parse };
  sched = new Scheduler({ store, logDir: join(dir, 'logs'), worktreesDir: join(dir, 'wt'), adapters: { claude: fake, codex: fake, hermes: fake }, resolveExe: () => FAKE });
  chats = new Chats(sched, { dir: join(dir, 'chat') });
});

afterEach(async () => {
  for (const [, a] of sched.active) a.proc.kill();
  await new Promise((r) => setTimeout(r, 200));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('chat_converse_mode_is_read_only + chat_resume_each_agent', () => {
  it('Conversar não tem ferramentas de escrita, e cada agente retoma a própria sessão', () => {
    const cwd = 'C:\\c';
    const claude = converseArgs('claude', null, cwd).args;
    const tools = claude[claude.indexOf('--tools') + 1];
    expect(tools).not.toMatch(/Write|Edit|Bash/);
    expect(claude).not.toContain('--resume');
    expect(converseArgs('claude', 'sess-1', cwd).args.slice(-2)).toEqual(['--resume', 'sess-1']);
    const codex = converseArgs('codex', 'thread-9', cwd).args;
    expect(codex[codex.indexOf('-s') + 1]).toBe('read-only');
    expect(codex.slice(-3)).toEqual(['resume', 'thread-9', '-']);
    const gpt = converseArgs('gpt', 'local-abc', cwd);
    expect(gpt.args[gpt.args.indexOf('-t') + 1]).toBe('web');
    expect(gpt.args.slice(-2)).toEqual(['--resume', 'local-abc']);
    expect(gpt.env?.HERMES_HOME).toBeTruthy();
  });

  it('a conversa com o Claude guarda a sessão e a próxima mensagem continua nela', async () => {
    const c = chats.create({ agent: 'claude' });
    const deltas: string[] = [];
    const m1 = await chats.send(c.id, 'oi', [], (e) => e.type === 'delta' && deltas.push(e.text));
    expect(m1).toMatchObject({ role: 'assistant', text: 'eco: oi' });
    const sess = chats.get(c.id)!.chat.sessionRef!;
    expect(sess).toMatch(/^sess-/);
    const m2 = await chats.send(c.id, 'e agora?');
    expect(m2.text).toBe(`eco: e agora? (retomou ${sess})`);
    expect(chats.get(c.id)!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});

describe('chat_execute_creates_job_with_governance', () => {
  it('Executar vira job na fila (worktree, revisão, limites) e a conversa guarda o job', async () => {
    const c = chats.create({ agent: 'claude-code', mode: 'executar', projectId: 'sandbox' });
    expect(c.mode).toBe('executar');
    const got: string[] = [];
    const m = await chats.send(c.id, 'Criar um README melhor', [{ nome: 'notas.txt', base64: Buffer.from('ideia: seções curtas').toString('base64') }], (e) => got.push(e.type));
    expect(got).toEqual(['job', 'done']);
    const job = store.getJob(m.jobId!)!;
    expect(job).toMatchObject({ agent: 'claude', projectId: 'sandbox', kind: 'task', risk: 'verde' });
    expect(job.prompt).toContain('<anexo nome="notas.txt">');
    // Nome único por anexo (não sobrescreve o de uma mensagem anterior).
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(dir, 'chat', c.id, 'anexos'))).toEqual([expect.stringMatching(/-notas\.txt$/)]);
    // Combinações que não existem são recusadas.
    expect(() => chats.create({ agent: 'claude', mode: 'executar' })).toThrow(/não tem o modo/);
    expect(() => chats.create({ agent: 'claude-code', mode: 'conversar' })).toThrow(/não tem o modo/);
    // Transformar em objetivo: o Planejador recebe a conversa.
    store.upsertProject({ id: 'git', name: 'G', path: dir, isGit: true });
    const obj: any = chats.toObjective(c.id, 'git');
    expect(obj.description).toContain('Criar um README melhor');
    // Espera a fila esvaziar antes de apagar a pasta temporária.
    await waitFor(() => store.listJobs().every((j) => !['queued', 'running'].includes(j.status)));
  });

  it('Conselho no chat: a síntese chega como resposta da conversa', async () => {
    const cons = new Conselho(sched, { projectPath: join(dir, 'cons') });
    const c = chats.create({ agent: 'conselho' });
    const m = await chats.send(c.id, 'Qual renda priorizar em dezembro?');
    expect(m.meta).toMatchObject({ conselho: expect.stringMatching(/^cons-/) });
    await waitFor(() => cons.get(String(m.meta!.conselho))?.estado === 'pronto', 20_000);
    await waitFor(() => chats.get(c.id)!.messages.some((x) => x.meta?.sintese));
  });
});

describe('ponte do Rocky (Slack)', () => {
  const slackFake = (opts: { reply: boolean }) => {
    const calls: { method: string; body: any }[] = [];
    const fn = (async (url: string, init: any) => {
      const method = String(url).split('/api/')[1].split('?')[0];
      calls.push({ method, body: init?.body ? JSON.parse(init.body) : null });
      if (method === 'auth.test') return new Response(JSON.stringify({ ok: true, user_id: 'UEMANNUEL' }));
      if (method === 'chat.postMessage') return new Response(JSON.stringify({ ok: true, ts: '100.0001' }));
      // Uma pessoa (sem bot_id) responde antes: não pode contar como o Rocky. A resposta do Rocky vem na 2ª página.
      const page1 = [{ ts: '100.0001', user: 'UEMANNUEL', text: 'pergunta' }, { ts: '100.0005', user: 'UOUTRO', text: 'eu não sou o Rocky' }];
      // Outro bot responde antes sem "ok": não pode virar o Rocky. O Rocky responde "ok" no teste.
      const page2 = opts.reply ? [{ ts: '100.0007', user: 'UBOT', bot_id: 'BOUTRO', text: 'lembrete automático' }, { ts: '100.0009', user: 'UROCKY', bot_id: 'BROCKY', text: 'ok — Resposta do Rocky' }] : [];
      const second = String(url).includes('cursor=c2');
      return new Response(JSON.stringify(second ? { ok: true, messages: page2, has_more: false } : { ok: true, messages: page1, has_more: true, response_metadata: { next_cursor: 'c2' } }));
    }) as any;
    return { fn, calls };
  };

  it('rocky_bridge_roundtrip: posta no #rocky, lê a resposta na thread e o chat mostra "via Slack"', async () => {
    const { fn, calls } = slackFake({ reply: true });
    const bridge = new SlackBridge({ path: join(dir, 'slack.json'), fetchFn: fn, pollMs: 10 });
    bridge.configure('xoxp-1234567890-abcdef', 'C0ROCKY01');
    expect((await bridge.test(2000)).estado).toBe('ativa');
    chats.bridge = bridge;
    expect(chats.agents().find((a) => a.id === 'rocky')!.disponivel).toBe(true);
    const c = chats.create({ agent: 'rocky' });
    const m = await chats.send(c.id, 'Como está meu dia?');
    expect(m).toMatchObject({ role: 'assistant', text: 'ok — Resposta do Rocky', meta: { via: 'slack' } });
    expect(JSON.parse(readFileSync(join(dir, 'slack.json'), 'utf8')).rocky).toBe('BROCKY');
    expect(calls.filter((x) => x.method === 'chat.postMessage').at(-1)!.body).toMatchObject({ channel: 'C0ROCKY01', text: 'Como está meu dia?' });
    // Segunda mensagem vai na mesma thread.
    await chats.send(c.id, 'E amanhã?');
    expect(calls.filter((x) => x.method === 'chat.postMessage').at(-1)!.body).toMatchObject({ thread_ts: '100.0001' });
  });

  it('rocky_bridge_disabled_fallback: sem resposta à integração, a ponte é abandonada e o Rocky sai do seletor', async () => {
    const { fn } = slackFake({ reply: false });
    const bridge = new SlackBridge({ path: join(dir, 'slack.json'), fetchFn: fn, pollMs: 10 });
    chats.bridge = bridge;
    expect(chats.agents().find((a) => a.id === 'rocky')!.disponivel).toBe(false);
    expect(() => chats.create({ agent: 'rocky' })).toThrow(/não está ativa/);
    bridge.configure('xoxp-1234567890-abcdef', 'C0ROCKY01');
    expect((await bridge.test(100)).estado).toBe('abandonada');
    expect(chats.agents().find((a) => a.id === 'rocky')!.disponivel).toBe(false);
    expect(() => bridge.configure('senha123', 'C0ROCKY01')).toThrow(/inválido/);
  });

  it('remover a integração durante o teste não deixa o resultado reativar a ponte', async () => {
    const { fn } = slackFake({ reply: true });
    const bridge = new SlackBridge({ path: join(dir, 'slack.json'), fetchFn: fn, pollMs: 30 });
    bridge.configure('xoxp-1234567890-abcdef', 'C0ROCKY01');
    const t = bridge.test(2000);
    bridge.remove();
    expect((await t).estado).toBe('nao_configurada');
    expect(bridge.active()).toBe(false);
  });

  it('rocky_bridge_token_not_in_vault_or_git: token só em var\\integracoes (ignorado pelo git); a API nunca devolve', async () => {
    expect(SLACK_CONFIG.startsWith(join(ROOT, 'var'))).toBe(true);
    const ignored = execFileSync('git', ['check-ignore', '-q', '--no-index', 'var/integracoes/slack.json'], { cwd: ROOT, stdio: 'pipe' });
    expect(ignored).toBeDefined(); // exit 0 = ignorado
    const bridge = new SlackBridge({ path: join(dir, 'slack.json') });
    bridge.configure('xoxp-1234567890-segredo', 'C0ROCKY01');
    expect(JSON.stringify(bridge.status())).not.toContain('segredo');
    // Gravar o token exige aparelho + confirmação (o token local de admin não serve).
    chats.bridge = bridge;
    const auth = new Auth(store, join(dir, 'admin-token'));
    const app = await buildApp({ sched, auth, push: null });
    const r = await app.inject({ method: 'PUT', url: '/api/integracoes/slack', headers: { 'x-emannu-token': auth.adminToken }, payload: { token: 'xoxp-1234567890-outro', canal: 'C0ROCKY01' } });
    expect(r.statusCode).toBe(403);
    const st = (await app.inject({ url: '/api/integracoes/slack', headers: { 'x-emannu-token': auth.adminToken } })).json();
    expect(JSON.stringify(st)).not.toMatch(/xoxp/);
    await app.close();
    expect(readFileSync(join(dir, 'slack.json'), 'utf8')).toContain('segredo'); // só no arquivo local
  });
});
