// Um git worktree por job: o agente trabalha numa cópia isolada do projeto, num
// branch job/<id>. Jobs de um objetivo partem do branch obj/<id>, que reúne o
// trabalho aprovado na revisão cruzada. O merge no branch principal é AMARELO.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const MAX_DIFF = 200_000;
const BOT = ['-c', 'user.name=EMANNU OS', '-c', 'user.email=emannu-os@localhost'];

function gitRaw(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

export function git(cwd: string, ...args: string[]): string {
  return gitRaw(cwd, ...args).trim();
}

export function isGitRepo(path: string): boolean {
  try {
    return git(path, 'rev-parse', '--is-inside-work-tree') === 'true';
  } catch {
    return false;
  }
}

export const slug = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'projeto';

export function createWorktree(
  repo: string,
  root: string,
  projectName: string,
  name: string,
  opts: { startPoint?: string; branch?: string } = {},
): { path: string; branch: string; base: string } {
  const dir = join(root, slug(projectName));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const branch = opts.branch ?? `job/${name}`;
  const startPoint = opts.startPoint ?? 'HEAD';
  if (!existsSync(path)) git(repo, 'worktree', 'add', '-b', branch, path, startPoint);
  return { path, branch, base: git(repo, 'rev-parse', startPoint) };
}

// Commit de partida para comparar o trabalho de um job. Jobs antigos (sem base
// gravada) usam o ponto em que o branch saiu do branch principal.
export function resolveBase(repo: string, wt: string, base: string | null): string {
  if (base) return base;
  try {
    return git(wt, 'merge-base', 'HEAD', git(repo, 'rev-parse', 'HEAD'));
  } catch {
    return 'HEAD';
  }
}

// Arquivos alterados no worktree em relação à base (commits do job + mudanças
// ainda não salvas + arquivos novos). Sem trim: a saída usa -z (separada por NUL).
export function changedFiles(wt: string, base: string): string[] {
  git(wt, 'add', '-A', '-N');
  const out = gitRaw(wt, 'diff', '--name-only', '-z', base);
  return [...new Set(out.split('\0').filter(Boolean))];
}

export function worktreeDiff(wt: string, base: string): { files: string[]; stat: string; diff: string; truncated: boolean } {
  const files = changedFiles(wt, base);
  const stat = git(wt, 'diff', '--stat', base);
  let diff = gitRaw(wt, 'diff', base);
  const truncated = diff.length > MAX_DIFF;
  if (truncated) diff = diff.slice(0, MAX_DIFF);
  return { files, stat, diff, truncated };
}

// Salva o trabalho do job num commit dentro do próprio worktree (nível VERDE).
export function commitAll(wt: string, message: string): boolean {
  git(wt, 'add', '-A');
  if (!git(wt, 'status', '--porcelain')) return false;
  git(wt, ...BOT, 'commit', '-q', '-m', message);
  return true;
}

// Merge de um branch dentro de outro worktree (ex.: job/<id> → obj/<id>).
export function mergeBranchInto(targetWt: string, branch: string, message: string): string {
  try {
    git(targetWt, ...BOT, 'merge', '--no-ff', '-m', message, branch);
  } catch (e: any) {
    try {
      git(targetWt, 'merge', '--abort');
    } catch {}
    throw new Error(`Conflito ao integrar ${branch}; nada foi alterado. ${String(e.stderr ?? e.message).trim()}`);
  }
  return git(targetWt, 'rev-parse', '--short', 'HEAD');
}

// Commit do que faltar no worktree e merge no branch atual do repositório (AMARELO).
export function mergeWorktree(repo: string, wt: string, branch: string, message: string): string {
  if (git(repo, 'status', '--porcelain', '--untracked-files=no')) {
    throw new Error('O repositório principal tem alterações não salvas. Faça commit ou descarte antes do merge.');
  }
  commitAll(wt, message);
  try {
    git(repo, ...BOT, 'merge', '--no-ff', '-m', `Merge ${branch}: ${message}`, branch);
  } catch (e: any) {
    try {
      git(repo, 'merge', '--abort');
    } catch {}
    throw new Error(`Conflito no merge; nada foi alterado no projeto. ${String(e.stderr ?? e.message).trim()}`);
  }
  const head = git(repo, 'rev-parse', '--short', 'HEAD');
  removeWorktree(repo, wt, branch);
  return head;
}

export function removeWorktree(repo: string, wt: string, branch: string | null): void {
  try {
    git(repo, 'worktree', 'remove', '--force', wt);
  } catch {
    if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
    try {
      git(repo, 'worktree', 'prune');
    } catch {}
  }
  if (branch) {
    try {
      git(repo, 'branch', '-D', branch);
    } catch {}
  }
}
