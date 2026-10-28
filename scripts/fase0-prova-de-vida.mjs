// FASE 0 — prova de vida: um job real do Claude e um do Codex, cada um no seu
// worktree de um repositório de teste, com o stream JSON gravado em log.
// Uso: node scripts/fase0-prova-de-vida.mjs
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, createWriteStream, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'var', 'fase0');
const REPO = join(OUT, 'repo-teste');
const TIMEOUT_MS = 5 * 60 * 1000;
const today = new Date().toISOString().slice(0, 10);

function which(name) {
  try {
    return execFileSync('where.exe', [name], { encoding: 'utf8' }).split(/\r?\n/).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

function findClaude() {
  const fallback = join(homedir(), '.local', 'bin', 'claude.exe');
  return which('claude') ?? (existsSync(fallback) ? fallback : null);
}

function findCodex() {
  const found = which('codex');
  if (found) return found;
  const base = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
  if (!existsSync(base)) return null;
  const candidates = readdirSync(base)
    .map((d) => join(base, d, 'codex.exe'))
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

// Remove as variáveis da sessão que chamou o script, para o agente filho usar o
// próprio login (como se fosse aberto num terminal comum).
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(CLAUDE|ANTHROPIC_)/i.test(k)) delete env[k];
  }
  return env;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function prepareRepo() {
  if (existsSync(OUT)) {
    for (const wt of ['wt-claude', 'wt-codex']) {
      if (existsSync(join(OUT, wt))) git(REPO, 'worktree', 'remove', '--force', join(OUT, wt));
    }
    rmSync(OUT, { recursive: true, force: true });
  }
  mkdirSync(REPO, { recursive: true });
  git(REPO, 'init', '-b', 'main');
  git(REPO, 'config', 'user.name', 'EMANNU OS');
  git(REPO, 'config', 'user.email', 'emannu-os@localhost');
  writeFileSync(join(REPO, 'README.md'), '# Repositório de teste da Fase 0\n');
  git(REPO, 'add', '.');
  git(REPO, 'commit', '-m', 'init');
  for (const agent of ['claude', 'codex']) {
    git(REPO, 'worktree', 'add', '-b', `job/${agent}-hello`, join(OUT, `wt-${agent}`));
  }
}

function killTree(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F']);
  } catch {}
}

function runJob({ name, exe, args, cwd, onEvent }) {
  return new Promise((done) => {
    const started = Date.now();
    const log = createWriteStream(join(OUT, `${name}.jsonl`));
    const errLog = createWriteStream(join(OUT, `${name}.stderr.log`));
    const child = spawn(exe, args, { cwd, env: cleanEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let events = 0;
    child.stdout.on('data', (chunk) => {
      log.write(chunk);
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        events++;
        try {
          onEvent(JSON.parse(line));
        } catch {}
      }
    });
    child.stderr.on('data', (chunk) => errLog.write(chunk));
    const timer = setTimeout(() => {
      console.log(`[${name}] timeout, matando árvore de processos`);
      killTree(child.pid);
    }, TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      log.end();
      errLog.end();
      done({ code, events, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

function evidence(wt, file) {
  const path = join(wt, file);
  return {
    file,
    exists: existsSync(path),
    content: existsSync(path) ? readFileSync(path, 'utf8') : null,
    gitStatus: git(wt, 'status', '--porcelain'),
  };
}

async function main() {
  const claude = findClaude();
  const codex = findCodex();
  console.log('claude:', claude, '\ncodex:', codex);
  if (!claude || !codex) throw new Error('Executável não encontrado');
  prepareRepo();

  const claudeInfo = { sessionId: null, result: null, isError: null, costNote: null };
  const codexInfo = { threadId: null, lastMessage: null, usage: null };

  const claudeJob = runJob({
    name: 'claude',
    exe: claude,
    cwd: join(OUT, 'wt-claude'),
    args: [
      '-p',
      `Crie o arquivo hello.md neste diretório com exatamente duas linhas: "# Olá do Claude" e "Data: ${today}". Não faça commit. Ao terminar, responda apenas "feito".`,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'dontAsk',
      '--permission-prompts', 'none',
      '--allowedTools', 'Read,Write,Edit,Glob,Grep',
    ],
    onEvent(ev) {
      if (ev.type === 'system' && ev.subtype === 'init') {
        claudeInfo.sessionId = ev.session_id;
        console.log(`[claude] sessão ${ev.session_id}, modelo ${ev.model}`);
      } else if (ev.type === 'assistant') {
        for (const c of ev.message?.content ?? []) {
          if (c.type === 'tool_use') console.log(`[claude] ferramenta: ${c.name}`);
          if (c.type === 'text') console.log(`[claude] texto: ${c.text.slice(0, 120)}`);
        }
      } else if (ev.type === 'result') {
        claudeInfo.result = ev.result;
        claudeInfo.isError = ev.is_error;
        console.log(`[claude] resultado: ${ev.subtype} — ${String(ev.result).slice(0, 120)}`);
      }
    },
  });

  const codexJob = runJob({
    name: 'codex',
    exe: codex,
    cwd: join(OUT, 'wt-codex'),
    args: [
      'exec',
      '--json',
      '-C', join(OUT, 'wt-codex'),
      '-s', 'workspace-write',
      `Crie o arquivo hello-codex.md neste diretório com exatamente duas linhas: "# Olá do Codex" e "Data: ${today}". Não faça commit. Ao terminar, responda apenas "feito".`,
    ],
    onEvent(ev) {
      if (ev.type === 'thread.started') {
        codexInfo.threadId = ev.thread_id;
        console.log(`[codex] thread ${ev.thread_id}`);
      } else if (ev.type === 'item.completed') {
        const it = ev.item ?? {};
        if (it.type === 'agent_message') codexInfo.lastMessage = it.text;
        console.log(`[codex] item: ${it.type}${it.command ? ' — ' + it.command : ''}${it.text ? ' — ' + String(it.text).slice(0, 120) : ''}`);
      } else if (ev.type === 'turn.completed') {
        codexInfo.usage = ev.usage;
        console.log('[codex] turno concluído');
      } else if (ev.type === 'turn.failed' || ev.type === 'error') {
        console.log(`[codex] ERRO: ${JSON.stringify(ev).slice(0, 300)}`);
      }
    },
  });

  const [c1, c2] = await Promise.all([claudeJob, codexJob]);
  const report = {
    date: new Date().toISOString(),
    claude: { exe: claude, ...c1, ...claudeInfo, evidence: evidence(join(OUT, 'wt-claude'), 'hello.md') },
    codex: { exe: codex, ...c2, ...codexInfo, evidence: evidence(join(OUT, 'wt-codex'), 'hello-codex.md') },
  };
  writeFileSync(join(OUT, 'resultado.json'), JSON.stringify(report, null, 2));
  console.log('\n' + JSON.stringify(report, null, 2));
  const ok = report.claude.code === 0 && report.claude.evidence.exists && report.codex.code === 0 && report.codex.evidence.exists;
  console.log(ok ? '\nFASE 0: OK — dois jobs reais concluídos' : '\nFASE 0: FALHOU — ver logs em var/fase0');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
