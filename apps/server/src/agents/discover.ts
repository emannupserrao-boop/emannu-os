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

// Agentes instalados pelo npm são scripts do Node (.mjs/.js): rodam com o próprio node do servidor.
export const isNodeScript = (exe: string): boolean => /\.(mjs|cjs|js)$/i.test(exe);
export function launch(exe: string, args: string[]): { exe: string; args: string[] } {
  return isNodeScript(exe) ? { exe: process.execPath, args: [exe, ...args] } : { exe, args };
}

export function findClaude(): string | null {
  if (process.env.EMANNU_CLAUDE_EXE) return process.env.EMANNU_CLAUDE_EXE;
  const fallback = join(homedir(), '.local', 'bin', 'claude.exe');
  return which('claude') ?? (existsSync(fallback) ? fallback : null);
}

// Onde o Codex pode estar: um codex.exe no PATH; o app do Codex (pasta com hash que muda a
// cada atualização, pegamos o mais recente); ou o CLI do npm (codex.js), que o app deixou de
// trazer na atualização de 28/10/2026. O codex.cmd do npm não roda sem shell: usamos o .js.
export function findCodex(): string | null {
  if (process.env.EMANNU_CODEX_EXE) return process.env.EMANNU_CODEX_EXE;
  const found = which('codex.exe');
  if (found) return found;
  const base = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  const app = existsSync(base)
    ? readdirSync(base)
        .map((d) => join(base, d, 'codex.exe'))
        .filter((p) => existsSync(p))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
    : undefined;
  if (app) return app;
  const npm = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  return existsSync(npm) ? npm : null;
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
    const l = launch(exe, ['--version']);
    const v = await run(l.exe, l.args, env);
    const version = /(\d{4}\.\d+\.\d+[\w.-]*|\d+\.\d+\.\d+)/.exec(v.out)?.[1] ?? null;
    // OpenClaw usa o login do Claude Code (claude-cli); Hermes, o login do ChatGPT feito nele.
    const authenticated = agent === 'openclaw' ? !!findClaude() : existsSync(join(VAR_DIR, 'ferramentas', 'hermes', 'auth.json'));
    return { installed: true, version, authenticated, exe };
  }
  const call = (args: string[]) => {
    const l = launch(exe, args);
    return run(l.exe, l.args);
  };
  const v = await call(['--version']);
  const version = v.out.trim().split(/\r?\n/)[0]?.replace(/^codex-cli\s*/, '').replace(/\s*\(Claude Code\)/, '') || null;
  let authenticated: boolean | null = null;
  if (agent === 'claude') {
    const a = await call(['auth', 'status']);
    try {
      authenticated = !!JSON.parse(a.out.slice(a.out.indexOf('{'))).loggedIn;
    } catch {
      authenticated = null;
    }
  } else {
    const a = await call(['login', 'status']);
    authenticated = /logged in/i.test(a.out) && !/not logged in/i.test(a.out);
  }
  return { installed: true, version, authenticated, exe };
}
