import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Scheduler } from '../src/scheduler.ts';
import { Vault } from '../src/vault.ts';
import { claudeAdapter, type AgentAdapter } from '../src/runners/adapters.ts';
import { CodeSessionIndex, sessionDirName } from '../src/codeSessions.ts';
import { ProjectHistory } from '../src/history.ts';

const FAKE = join(import.meta.dirname, 'fake-agent.mjs');
let dir: string;
let claudeDir: string;
let store: Store;

const line = (o: object) => JSON.stringify(o);
function writeSession(projectPath: string, id: string, rows: object[]) {
  const d = join(claudeDir, sessionDirName(projectPath));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${id}.jsonl`), rows.map(line).join('\n') + '\n');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'emannu-hist-'));
  claudeDir = join(dir, 'claude-projects');
  store = new Store(':memory:');
  writeSession('D:\\Musicas', 's1', [
    { type: 'user', timestamp: '2026-10-20T10:00:00Z', cwd: 'D:\\Musicas', message: { role: 'user', content: 'Quero um clipe para Bitter End' } },
    { type: 'assistant', timestamp: '2026-10-20T10:01:00Z', message: { content: [{ type: 'thinking', thinking: 'segredo' }, { type: 'text', text: 'Proposta: 3 atos em LTX.' }, { type: 'tool_use', name: 'Bash' }] } },
    { type: 'user', timestamp: '2026-10-20T10:02:00Z', message: { content: [{ type: 'tool_result', content: 'saída enorme de ferramenta' }] } },
    { type: 'custom-title', customTitle: 'Clipe Bitter End' },
    { type: 'user', timestamp: '2026-10-21T09:00:00Z', message: { content: [{ type: 'text', text: 'Aprovo o ato 1' }] } },
  ]);
  writeSession('D:\\Musicas', 'vazia', [{ type: 'user', isMeta: true, message: { content: '<command>x</command>' } }]);
  // Execução automática (job do EMANNU OS): não conta como sessão sua.
  writeSession('D:\\Musicas', 'job', [{ type: 'user', entrypoint: 'sdk-cli', timestamp: '2026-10-22T10:00:00Z', message: { content: 'Você é o Rocky, coordenador…' } }]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

describe('sessões do Claude Code', () => {
  it('lê título, datas e pedidos reais (sem ferramentas nem mensagens internas)', async () => {
    const idx = new CodeSessionIndex(store, claudeDir);
    const list = await idx.sessionsFor(['D:\\Musicas', 'd:\\musicas']); // a mesma pasta não duplica
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 's1', title: 'Clipe Bitter End', prompts: 2, firstAt: '2026-10-20T10:00:00Z', lastAt: '2026-10-21T09:00:00Z' });
    const text = await idx.digest(list);
    expect(text).toContain('**Você:** Quero um clipe para Bitter End');
    expect(text).toContain('**Claude:** Proposta: 3 atos em LTX.');
    expect(text).not.toContain('segredo');
    expect(text).not.toContain('saída enorme');
    // Cache: a segunda leitura vem do banco.
    expect(store.kvGet<any[]>('codigo.sessoes')!.length).toBe(3);
  });

  it('resumo do projeto por um job do Claude → guardado e escrito no vault', async () => {
    const vaultDir = join(dir, 'vault');
    mkdirSync(join(vaultDir, '20 - PROJECTS', 'WHAT LIES BTWN'), { recursive: true });
    const answer = 'Resumo.\n```json\n' + JSON.stringify({ resumo: 'Clipe em produção.', feito: ['Proposta em 3 atos'], decisoes: ['LTX'], entregas: [{ titulo: 'roteiro.md', caminho: 'D:\\Musicas\\roteiro.md' }], pendencias: ['Ato 2'], proximos: ['Render'] }) + '\n```';
    const fake: AgentAdapter = { buildArgs: (_j, _c, prompt) => ({ args: [FAKE, 'say', Buffer.from(answer).toString('base64')], stdin: prompt }), parse: claudeAdapter.parse };
    const sched = new Scheduler({ store, vault: new Vault(vaultDir), logDir: join(dir, 'logs'), worktreesDir: join(dir, 'wt'), adapters: { claude: fake, codex: fake }, resolveExe: () => process.execPath });
    const h = new ProjectHistory(sched, new CodeSessionIndex(store, claudeDir), { workDir: join(dir, 'historico'), extraDirs: { 'what-lies-btwn': ['D:\\Musicas'] } });
    h.init();
    const dirs = h.dirsFor('what-lies-btwn', null);
    const started = await h.autoRefresh([{ id: 'what-lies-btwn', nome: 'WHAT LIES BTWN', dirs, vaultFolder: join('20 - PROJECTS', 'WHAT LIES BTWN') }]);
    expect(started).toEqual(['what-lies-btwn']);
    // A entrada fica presa ao job (sem arquivo compartilhado por projeto).
    const job = sched.store.listJobs().find((j) => j.planKey === 'historico:what-lies-btwn')!;
    expect(readFileSync(join(dir, 'historico', `${job.id}.md`), 'utf8')).toContain('Clipe Bitter End');
    const t = Date.now();
    while (!h.get('what-lies-btwn') && Date.now() - t < 15_000) await new Promise((r) => setTimeout(r, 50));
    const got = h.get('what-lies-btwn')!;
    expect(got).toMatchObject({ resumo: 'Clipe em produção.', sessoes: 1, feito: ['Proposta em 3 atos'] });
    expect(existsSync(join(vaultDir, '20 - PROJECTS', 'WHAT LIES BTWN', 'WHAT LIES BTWN - Histórico do Claude Code.md'))).toBe(true);
    // Sem sessão nova, não refaz.
    expect(await h.autoRefresh([{ id: 'what-lies-btwn', nome: 'WHAT LIES BTWN', dirs, vaultFolder: null }])).toEqual([]);
    await new Promise((r) => setTimeout(r, 300));
  });
});
