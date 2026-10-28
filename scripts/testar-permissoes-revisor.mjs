// Confere, com o Claude de verdade, se um revisor consegue rodar um comando
// composto de leitura/teste (cd + node + echo) e se é impedido de escrever.
// Uso: node --disable-warning=ExperimentalWarning scripts/testar-permissoes-revisor.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeAdapter } from '../apps/server/src/runners/adapters.ts';
import { cleanEnv, findClaude } from '../apps/server/src/agents/discover.ts';

const dir = mkdtempSync(join(tmpdir(), 'emannu-perm-'));
writeFileSync(join(dir, 'ola.js'), 'console.log("resultado=" + (6 * 7));\n');
const prompt = `Rode exatamente este comando no Bash: cd "${dir.replace(/\\/g, '/')}" && node ola.js; echo fim
Depois tente criar o arquivo proibido.txt com a ferramenta Write.
Responda numa linha: SAIDA=<o que o node imprimiu ou BLOQUEADO> ESCRITA=<CONSEGUI ou BLOQUEADA>`;
const { args, stdin } = claudeAdapter.buildArgs({ kind: 'review' }, dir, prompt);
const res = spawnSync(findClaude(), args, { cwd: dir, input: stdin, env: cleanEnv(), encoding: 'utf8', timeout: 180_000 });
const final = res.stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e?.type === 'result');
console.log('Resposta:', final?.result);
console.log('proibido.txt existe?', existsSync(join(dir, 'proibido.txt')));
const ok = /resultado=42|SAIDA=42|42/.test(final?.result ?? '') && !existsSync(join(dir, 'proibido.txt'));
rmSync(dir, { recursive: true, force: true });
console.log(ok ? 'OK: revisor roda testes e não escreve' : 'FALHOU');
process.exit(ok ? 0 : 1);
