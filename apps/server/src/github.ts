// GitHub dos projetos, só leitura: pelo gh (com o login do Emannuel, guardado no cofre do
// Windows) lê o repositório, os PRs abertos e o último CI; pelo git, a branch local e o que
// ainda não foi salvo. Nada aqui cria, comenta, faz merge ou push. O token nunca sai do gh.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { GitHubView } from '../../../packages/shared/types.ts';

type Run = (exe: string, args: string[], cwd?: string) => Promise<string>;

const run: Run = (exe, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(exe, args, { cwd, encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split(/\r?\n/)[0]));
      else resolve(stdout);
    });
  });

export function findGh(): string | null {
  const candidates = [process.env.EMANNU_GH, 'C:\\Program Files\\GitHub CLI\\gh.exe', `${process.env.LOCALAPPDATA ?? ''}\\Programs\\GitHub CLI\\gh.exe`];
  return candidates.find((c) => c && existsSync(c)) ?? null;
}

// "https://github.com/dono/nome.git" ou "git@github.com:dono/nome.git" → "dono/nome".
export function parseGitHubRemote(url: string): string | null {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

type CiState = NonNullable<GitHubView['ci']>['estado'];
export function ciState(status: string, conclusion: string | null): CiState {
  if (status !== 'completed') return 'rodando';
  if (conclusion === 'success') return 'ok';
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure') return 'falhou';
  if (conclusion === 'cancelled') return 'cancelado';
  return 'outro';
}

export interface RepoTarget {
  projectId: string;
  repo: string;
  papel: GitHubView['papel'];
  path: string | null; // pasta local (só para o "origin")
}

export class GitHubStatus {
  private gh: string | null;
  private run: Run;
  private ttlMs: number;
  private cache = new Map<string, { at: number; view: GitHubView }>();
  private pending = new Map<string, Promise<GitHubView>>();

  constructor(opts: { gh?: string | null; run?: Run; ttlMs?: number } = {}) {
    this.gh = opts.gh === undefined ? findGh() : opts.gh;
    this.run = opts.run ?? run;
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
  }

  get available(): boolean {
    return !!this.gh;
  }

  // Repositório do "origin" de uma pasta git (null se não for GitHub).
  async originOf(path: string): Promise<string | null> {
    try {
      return parseGitHubRemote(await this.run('git', ['remote', 'get-url', 'origin'], path));
    } catch {
      return null;
    }
  }

  private async api<T>(path: string): Promise<T> {
    return JSON.parse(await this.run(this.gh!, ['api', '-H', 'Accept: application/vnd.github+json', path])) as T;
  }

  private async local(path: string): Promise<GitHubView['local']> {
    try {
      const branch = (await this.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], path)).trim();
      const status = (await this.run('git', ['status', '--porcelain'], path)).split(/\r?\n/).filter(Boolean).length;
      let aFrente: number | null = null;
      let atras: number | null = null;
      try {
        const [a, b] = (await this.run('git', ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], path)).trim().split(/\s+/).map(Number);
        aFrente = a;
        atras = b;
      } catch {}
      return { branch, alteracoes: status, aFrente, atras };
    } catch {
      return null;
    }
  }

  private async fetch(t: RepoTarget): Promise<GitHubView> {
    const base: GitHubView = {
      repo: t.repo, url: `https://github.com/${t.repo}`, papel: t.papel, privado: false, branchPadrao: 'main', ultimoPush: null,
      ultimoCommit: null, prsAbertos: [], ci: null, ciOutro: null, local: t.path ? await this.local(t.path) : null, erro: null,
    };
    if (!this.gh) return { ...base, erro: 'GitHub CLI (gh) não encontrado neste PC' };
    try {
      const r = await this.api<any>(`repos/${t.repo}`);
      const branch = String(r.default_branch ?? 'main');
      const noRuns = () => ({ workflow_runs: [] });
      const [prs, mainRuns, latestRuns, commits] = await Promise.all([
        this.api<any[]>(`repos/${t.repo}/pulls?state=open&per_page=10`),
        this.api<any>(`repos/${t.repo}/actions/runs?per_page=1&branch=${encodeURIComponent(branch)}`).catch(noRuns),
        this.api<any>(`repos/${t.repo}/actions/runs?per_page=1`).catch(noRuns),
        this.api<any[]>(`repos/${t.repo}/commits?per_page=1&sha=${encodeURIComponent(branch)}`).catch(() => []),
      ]);
      const toCi = (w: any): GitHubView['ci'] =>
        w ? { estado: ciState(w.status, w.conclusion), branch: String(w.head_branch ?? ''), url: String(w.html_url), em: String(w.updated_at ?? w.created_at), nome: String(w.name ?? 'CI') } : null;
      const main = mainRuns.workflow_runs?.[0] ?? null;
      const latest = latestRuns.workflow_runs?.[0] ?? null;
      const c = commits[0];
      return {
        ...base,
        url: String(r.html_url ?? base.url),
        privado: !!r.private,
        branchPadrao: branch,
        ultimoPush: r.pushed_at ?? null,
        ultimoCommit: c ? { mensagem: String(c.commit?.message ?? '').split('\n')[0].slice(0, 160), data: String(c.commit?.author?.date ?? ''), url: String(c.html_url) } : null,
        prsAbertos: prs.map((p) => ({ numero: p.number, titulo: String(p.title).slice(0, 160), url: String(p.html_url), branch: String(p.head?.ref ?? ''), rascunho: !!p.draft })),
        ci: toCi(main),
        ciOutro: latest && latest.id !== main?.id ? toCi(latest) : null,
      };
    } catch (e: any) {
      const msg = String(e.message ?? e);
      return { ...base, erro: /auth|login|401|credentials/i.test(msg) ? 'gh sem login: rode "gh auth login" no PC' : `GitHub indisponível: ${msg.slice(0, 120)}` };
    }
  }

  // Situação de um repositório, com cache. Velho: devolve o que tem e atualiza em segundo plano.
  async view(t: RepoTarget, force = false): Promise<GitHubView> {
    const key = `${t.papel}:${t.repo}:${t.path ?? ''}`;
    const hit = this.cache.get(key);
    const fresh = hit && Date.now() - hit.at < this.ttlMs;
    if (hit && fresh && !force) return hit.view;
    let p = this.pending.get(key);
    if (!p) {
      p = this.fetch(t)
        .then((view) => {
          this.cache.set(key, { at: Date.now(), view });
          return view;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    if (hit && !force) return hit.view;
    return p;
  }

  clear(): void {
    this.cache.clear();
  }
}
