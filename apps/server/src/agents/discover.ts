import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { RunnableAgent } from '../../../../packages/shared/types.ts';
import { VAR_DIR } from '../config.ts';

export function which(name: string): string | null {
  try {
    return execFileSync('where.exe', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

export function findClaude(): string | null {
  if (process.env.EMANNU_CLAUDE_EXE) return process.env.EMANNU_CLAUDE_EXE;
  const fallback = join(homedir(), '.local', 'bin', 'claude.exe');
  return which('claude') ?? (existsSync(fallback) ? fallback : null);
}

// O app do Codex instala o CLI numa pasta com hash que muda a cada atualização;
// pegamos o executável mais recente.
export function findCodex(): string | null {
  if (process.env.EMANNU_CODEX_EXE) return process.env.EMANNU_CODEX_EXE;
  const found = which('codex');
  if (found) return found;
  const base = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  if (!existsSync(base)) return null;
  return (
    readdirSync(base)
      .map((d) => join(base, d, 'codex.exe'))
      .filter((p) => existsSync(p))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null
  );
}

export function findAgentExe(agent: RunnableAgent): string | null {
  if (agent === 'openclaw') return findOpenClawExe();
  if (agent === 'hermes') return findHermesExe();
  return agent === 'claude' ? findClaude() : findCodex();
}

// OpenClaw via npm: o .cmd do npm não roda bem sem shell; chama o node com o openclaw.mjs.
export function findOpenClawExe(): string | null {
  if (process.env.EMANNU_OPENCLAW_EXE) return process.env.EMANNU_OPENCLAW_EXE;
  // Instalado na pasta do projeto (var\ferramentas\openclaw): o app do Claude virtualiza o
  // AppData, então um "npm -g" feito por ele não aparece para o servidor.
  const local = join(VAR_DIR, 'ferramentas', 'openclaw', 'node_modules', 'openclaw', 'openclaw.mjs');
  const global = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', 'openclaw', 'openclaw.mjs');
  return [local, global].find((p) => existsSync(p)) ?? null;
}

export function findHermesExe(): string | null {
  if (process.env.EMANNU_HERMES_EXE) return process.env.EMANNU_HERMES_EXE;
  // Primeiro a instalação na pasta do projeto (var\ferramentas\hermes), que o servidor enxerga.
  const bins = [join(VAR_DIR, 'ferramentas', 'hermes', 'bin'), join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'hermes', 'bin')];
  return bins.flatMap((b) => ['hermes.exe', 'hermes.cmd', 'hermes.bat'].map((f) => join(b, f))).find((p) => existsSync(p)) ?? which('hermes');
}

// Ambiente limpo para os agentes filhos: sem as variáveis de uma sessão
// Claude que tenha iniciado o servidor, para cada CLI usar o próprio login.
export function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(CLAUDE|ANTHROPIC_)/i.test(k)) delete env[k];
  }
  return env;
}

export function run(exe: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile(exe, args, { env: { ...cleanEnv(), ...env }, timeout: 20_000, windowsHide: true }, (err, stdout, stderr) => {
      done({ code: err ? ((err as any).code ?? 1) : 0, out: `${stdout}${stderr}` });
    });
  });
}

export interface ProbeResult {
  installed: boolean;
  version: string | null;
  authenticated: boolean | null;
  exe: string | null;
}

export async function probeAgent(agent: RunnableAgent): Promise<ProbeResult> {
  const exe = findAgentExe(agent);
  if (!exe) return { installed: false, version: null, authenticated: null, exe: null };
  if (agent === 'openclaw' || agent === 'hermes') {
    // O Hermes precisa saber onde está a pasta dele (instalado em var\\ferramentas\\hermes).
    const env: Record<string, string> = agent === 'hermes' ? { HERMES_HOME: join(VAR_DIR, 'ferramentas', 'hermes'), PYTHONIOENCODING: 'utf-8' } : {};
    const v = await run(exe.endsWith('.mjs') ? process.execPath : exe, [...(exe.endsWith('.mjs') ? [exe] : []), '--version'], env);
    const version = /(\d{4}\.\d+\.\d+[\w.-]*|\d+\.\d+\.\d+)/.exec(v.out)?.[1] ?? null;
    // OpenClaw usa o login do Claude Code (claude-cli); Hermes, o login do ChatGPT feito nele.
    const authenticated = agent === 'openclaw' ? !!findClaude() : existsSync(join(VAR_DIR, 'ferramentas', 'hermes', 'auth.json'));
    return { installed: true, version, authenticated, exe };
  }
  const v = await run(exe, ['--version']);
  const version = v.out.trim().split(/\r?\n/)[0]?.replace(/^codex-cli\s*/, '').replace(/\s*\(Claude Code\)/, '') || null;
  let authenticated: boolean | null = null;
  if (agent === 'claude') {
    const a = await run(exe, ['auth', 'status']);
    try {
      authenticated = !!JSON.parse(a.out.slice(a.out.indexOf('{'))).loggedIn;
    } catch {
      authenticated = null;
    }
  } else {
    const a = await run(exe, ['login', 'status']);
    authenticated = /logged in/i.test(a.out) && !/not logged in/i.test(a.out);
  }
  return { installed: true, version, authenticated, exe };
}
