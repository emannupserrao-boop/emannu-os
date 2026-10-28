import { spawn, execFile } from 'node:child_process';
import { cleanEnv } from '../agents/discover.ts';

export interface RunningProcess {
  pid: number | undefined;
  kill(): void;
  done: Promise<{ code: number | null }>;
}

// Mata o processo e todos os filhos (no Windows, kill() sozinho deixa netos vivos).
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
}

export function startProcess(opts: {
  exe: string;
  args: string[];
  cwd: string;
  stdin?: string;
  // Variáveis extras só para este processo (ex.: HERMES_HOME).
  env?: Record<string, string>;
  timeoutMs: number;
  onLine(line: string): void;
  onStderr(text: string): void;
  onTimeout(): void;
}): RunningProcess {
  const child = spawn(opts.exe, opts.args, {
    cwd: opts.cwd,
    env: { ...cleanEnv(), ...(opts.env ?? {}) },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  if (opts.stdin !== undefined) child.stdin.end(opts.stdin, 'utf8');
  else child.stdin.end();

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) opts.onLine(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (t: string) => opts.onStderr(t));

  const timer = setTimeout(() => {
    opts.onTimeout();
    killTree(child.pid);
  }, opts.timeoutMs);

  const done = new Promise<{ code: number | null }>((resolve) => {
    child.on('error', (err) => {
      opts.onStderr(String(err));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf.trim()) opts.onLine(buf.trim());
      resolve({ code });
    });
  });

  return { pid: child.pid, kill: () => killTree(child.pid), done };
}
