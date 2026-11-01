// GitHub dos projetos (só leitura): leitura do gh e do git, cache e erros sem derrubar a aba.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubStatus, ciState, parseGitHubRemote } from '../src/github.ts';
import { Store } from '../src/db.ts';
import { Scheduler } from '../src/scheduler.ts';
import { Auth } from '../src/auth.ts';
import { buildApp } from '../src/app.ts';
import { Alerts } from '../src/resumo.ts';

const REPO = {
  html_url: 'https://github.com/emannupserrao-boop/projeto-exemplo',
  private: true,
  default_branch: 'main',
  pushed_at: '2026-11-01T12:15:13Z',
};
const RUNS = {
  workflow_runs: [
    { name: 'CI', status: 'in_progress', conclusion: null, head_branch: 'fatia-023', html_url: 'https://x/run/3', updated_at: '2026-11-01T13:00:00Z' },
    { name: 'CI', status: 'completed', conclusion: 'failure', head_branch: 'main', html_url: 'https://x/run/2', updated_at: '2026-11-01T12:58:53Z' },
    { name: 'CI', status: 'completed', conclusion: 'success', head_branch: 'main', html_url: 'https://x/run/1', updated_at: '2026-11-01T09:47:32Z' },
  ],
};
const PRS = [{ number: 3, title: 'Fatia 023: visual 3', html_url: 'https://x/pull/3', head: { ref: 'fatia-023' }, draft: true }];
const COMMITS = [{ commit: { message: 'CI do PR #2: painel\n\ncorpo', author: { date: '2026-11-01T08:53:00Z' } }, html_url: 'https://x/commit/c1' }];

// gh e git falsos: respondem pelo caminho pedido e contam as chamadas.
function fake(opts: { fail?: string; delayMs?: number } = {}) {
  const calls: string[] = [];
  const run = async (exe: string, args: string[]) => {
    calls.push(`${exe} ${args.join(' ')}`);
    if (exe === 'git') {
      if (args[0] === 'remote') return 'https://github.com/emannupserrao-boop/projeto-exemplo.git\n';
      if (args[0] === 'rev-parse') return 'fatia-023-visual-3\n';
      if (args[0] === 'status') return ' M a.json\n M b.json\n?? c.txt\n';
      if (args[0] === 'rev-list') return '2\t0\n';
    }
    if (opts.fail) throw new Error(opts.fail);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const path = args[args.length - 1];
    if (/\/pulls/.test(path)) return JSON.stringify(PRS);
    if (/\/actions\/runs/.test(path)) {
      // Com branch=main: só as da main; sem filtro: a mais recente de qualquer branch.
      const runs = RUNS.workflow_runs.map((w, i) => ({ id: i + 1, ...w }));
      return JSON.stringify({ workflow_runs: /branch=main/.test(path) ? runs.filter((w) => w.head_branch === 'main') : runs });
    }
    if (/\/commits/.test(path)) return JSON.stringify(COMMITS);
    return JSON.stringify(REPO);
  };
  return { run, calls };
}

describe('github_parse', () => {
  it('reconhece o repositório pelo origin (https e ssh) e traduz o estado do CI', () => {
    expect(parseGitHubRemote('https://github.com/emannupserrao-boop/projeto-exemplo.git')).toBe('emannupserrao-boop/projeto-exemplo');
    expect(parseGitHubRemote('git@github.com:emannupserrao-boop/ro3.hub.git\n')).toBe('emannupserrao-boop/ro3.hub');
    expect(parseGitHubRemote('https://gitlab.com/a/b.git')).toBeNull();
    expect(ciState('completed', 'success')).toBe('ok');
    expect(ciState('completed', 'failure')).toBe('falhou');
    expect(ciState('queued', null)).toBe('rodando');
    expect(ciState('completed', 'cancelled')).toBe('cancelado');
  });
});

describe('github_view', () => {
  it('lê repo, CI da main (e o mais recente de outra branch), PRs, último commit e a pasta local', async () => {
    const f = fake();
    const gh = new GitHubStatus({ gh: 'gh.exe', run: f.run });
    const v = await gh.view({ projectId: 'projeto-exemplo', repo: 'emannupserrao-boop/projeto-exemplo', papel: 'origem', path: 'D:/x' });
    expect(v).toMatchObject({
      privado: true,
      branchPadrao: 'main',
      ci: { estado: 'falhou', branch: 'main', url: 'https://x/run/2' },
      ciOutro: { estado: 'rodando', branch: 'fatia-023' },
      prsAbertos: [{ numero: 3, titulo: 'Fatia 023: visual 3', branch: 'fatia-023', rascunho: true }],
      ultimoCommit: { mensagem: 'CI do PR #2: painel' },
      local: { branch: 'fatia-023-visual-3', alteracoes: 3, aFrente: 2, atras: 0 },
      erro: null,
    });
    // Só leitura: nenhum comando que escreve.
    expect(f.calls.some((c) => /\b(push|merge|commit|pr (create|merge|comment)|-X (POST|PATCH|PUT|DELETE)|--method)\b/i.test(c))).toBe(false);
  });

  it('usa o cache por 10 min e, velho, devolve o que tem enquanto atualiza', async () => {
    const f = fake();
    const gh = new GitHubStatus({ gh: 'gh.exe', run: f.run, ttlMs: 50 });
    const t = { projectId: 'p', repo: 'emannupserrao-boop/projeto-exemplo', papel: 'origem' as const, path: null };
    await gh.view(t);
    const n = f.calls.length;
    await gh.view(t);
    expect(f.calls.length).toBe(n);
    await new Promise((r) => setTimeout(r, 70));
    const stale = await gh.view(t);
    expect(stale.repo).toBe('emannupserrao-boop/projeto-exemplo');
    await new Promise((r) => setTimeout(r, 30));
    expect(f.calls.length).toBeGreaterThan(n);
  });

  it('sem login ou sem gh: mostra o motivo e não quebra', async () => {
    const noLogin = new GitHubStatus({ gh: 'gh.exe', run: fake({ fail: 'HTTP 401: Bad credentials' }).run });
    expect((await noLogin.view({ projectId: 'p', repo: 'a/b', papel: 'origem', path: null })).erro).toMatch(/gh auth login/);
    const noGh = new GitHubStatus({ gh: null, run: fake().run });
    expect(noGh.available).toBe(false);
    expect((await noGh.view({ projectId: 'p', repo: 'a/b', papel: 'copia-publica', path: null })).erro).toMatch(/não encontrado/);
  });
});

describe('github_project_cards', () => {
  it('o card do projeto ganha o origin da pasta; a cópia pública aparece depois', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'emannu-gh-'));
    try {
      const store = new Store(':memory:');
      store.upsertProject({ id: 'projeto-exemplo', name: 'Projeto Exemplo', path: dir, isGit: true });
      store.upsertProject({ id: 'emannu-os', name: 'EMANNU OS', path: dir, isGit: false });
      const sched = new Scheduler({ store, logDir: join(dir, 'logs'), worktreesDir: join(dir, 'wt') });
      const auth = new Auth(store, join(dir, 'admin-token'));
      const app = await buildApp({ sched, auth, push: null, github: new GitHubStatus({ gh: 'gh.exe', run: fake().run }) });
      const cards = (await app.inject({ url: '/api/projetos', headers: { 'x-emannu-token': auth.adminToken } })).json() as any[];
      const rh = cards.find((c) => c.id === 'projeto-exemplo');
      expect(rh.github.map((g: any) => [g.repo, g.papel])).toEqual([['emannupserrao-boop/projeto-exemplo', 'origem']]);
      const os = cards.find((c) => c.id === 'emannu-os');
      expect(os.github.map((g: any) => [g.repo, g.papel])).toEqual([['emannupserrao-boop/emannu-os', 'copia-publica']]);
      expect((await app.inject({ method: 'POST', url: '/api/projetos/github/atualizar', headers: { 'x-emannu-token': auth.adminToken } })).json()).toEqual({ ok: true });
      await app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('github_ci_alert', () => {
  it('avisa uma vez quando o CI da branch principal falha; cópia pública e CI verde não avisam', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'emannu-ghci-'));
    try {
      const store = new Store(':memory:');
      const sched = new Scheduler({ store, logDir: join(dir, 'logs'), worktreesDir: join(dir, 'wt') });
      const sent: any[] = [];
      const alerts = new Alerts(sched, (p) => sent.push(p));
      const gh = new GitHubStatus({ gh: 'gh.exe', run: fake().run });
      const v = await gh.view({ projectId: 'projeto-exemplo', repo: 'emannupserrao-boop/projeto-exemplo', papel: 'origem', path: null });
      const ok = { ...v, ci: { ...v.ci!, estado: 'ok' as const, url: 'https://x/run/9' } };
      const copy = { ...v, papel: 'copia-publica' as const, ci: { ...v.ci!, url: 'https://x/run/8' } };
      const cards = [{ nome: 'Projeto Exemplo', github: [v] }, { nome: 'Outro', github: [ok, copy] }];
      expect(alerts.githubCi(cards)).toEqual(['ci:https://x/run/2']);
      expect(sent[0]).toMatchObject({ title: 'CI falhou: Projeto Exemplo', url: 'https://x/run/2' });
      expect(alerts.githubCi(cards)).toEqual([]);
      expect(sent).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('github_review_fixes', () => {
  it('o CI da main vem de uma consulta própria (não some atrás de execuções de outras branches)', async () => {
    const f = fake();
    const gh = new GitHubStatus({ gh: 'gh.exe', run: f.run });
    await gh.view({ projectId: 'p', repo: 'emannupserrao-boop/projeto-exemplo', papel: 'origem', path: null });
    expect(f.calls.some((c) => /actions\/runs\?per_page=1&branch=main/.test(c))).toBe(true);
  });

  it('GitHub lento: o card sai marcado como pendente; a rotina pede dados frescos e espera', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'emannu-ghslow-'));
    try {
      const store = new Store(':memory:');
      store.upsertProject({ id: 'projeto-exemplo', name: 'Projeto Exemplo', path: dir, isGit: true });
      const sched = new Scheduler({ store, logDir: join(dir, 'logs'), worktreesDir: join(dir, 'wt') });
      const auth = new Auth(store, join(dir, 'admin-token'));
      const f = fake({ delayMs: 6500 });
      const app = await buildApp({ sched, auth, push: null, github: new GitHubStatus({ gh: 'gh.exe', run: f.run }) });
      const h = { 'x-emannu-token': auth.adminToken };
      const first = ((await app.inject({ url: '/api/projetos', headers: h })).json() as any[]).find((c) => c.id === 'projeto-exemplo');
      expect(first.githubPendente).toBe(true);
      expect(first.github).toBeUndefined();
      const fresh = ((await app.inject({ url: '/api/projetos?github=fresco', headers: h })).json() as any[]).find((c) => c.id === 'projeto-exemplo');
      expect(fresh.githubPendente).toBeUndefined();
      expect(fresh.github[0].ci.estado).toBe('falhou');
      await app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
