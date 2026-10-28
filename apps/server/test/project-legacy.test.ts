import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { buildProjectCards } from '../src/projects.ts';
import { projectsForNewJobs } from '../../../packages/shared/projects.ts';

let dir: string;
let store: Store | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'emannu-project-legacy-'));
});
afterEach(() => {
  store?.db.close();
  store = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('projeto legado', () => {
  it('migra o esquema antigo sem apagar ou trocar nome, pasta e data; reabrir é idempotente', () => {
    const file = join(dir, 'antigo.sqlite');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, is_git INTEGER NOT NULL, created_at TEXT NOT NULL)`);
    old.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run('operacao-receita', 'Operação Receita', 'C:\\antiga', 1, '2026-01-01');
    old.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run('criativos-motion', 'Criativos Motion', 'D:\\nova', 1, '2026-10-28');
    old.close();
    store = new Store(file);
    expect(store.getProject('operacao-receita')).toMatchObject({ name: 'Operação Receita', path: 'C:\\antiga', createdAt: '2026-01-01', isLegacy: true });
    expect(store.getProject('criativos-motion')).toMatchObject({ path: 'D:\\nova', isLegacy: false });
    store.db.close();
    store = new Store(file);
    expect(store.listProjects()).toHaveLength(2);
    expect(store.getProject('operacao-receita')!.isLegacy).toBe(true);
  });

  it('marca cadastros posteriores e preserva a marca nas atualizações', () => {
    store = new Store(':memory:');
    const project = { id: 'operacao-receita', name: 'Operação Receita', path: dir, isGit: true };
    expect(store.upsertProject(project).isLegacy).toBe(true);
    expect(store.upsertProject({ ...project, isLegacy: false }).isLegacy).toBe(true);
    store.upsertProject({ id: 'outro', name: 'Outro legado', path: dir, isGit: false, isLegacy: true });
    expect(store.upsertProject({ id: 'outro', name: 'Outro legado', path: dir, isGit: false }).isLegacy).toBe(true);
  });

  it('mantém o card e o histórico visíveis; as sugestões de jobs e objetivos excluem legados', () => {
    store = new Store(':memory:');
    store.upsertProject({ id: 'operacao-receita', name: 'Operação Receita', path: join(dir, 'antigo'), isGit: true });
    store.upsertProject({ id: 'criativos-motion', name: 'Criativos Motion', path: join(dir, 'novo'), isGit: true });
    const job = store.createJob({ title: 'Histórico antigo', prompt: 'x', agent: 'claude', projectId: 'operacao-receita', risk: 'verde', status: 'queued', timeoutMin: 10 });
    const cards = buildProjectCards(store, null, null);
    expect(cards.find((c) => c.id === 'operacao-receita')).toMatchObject({ isLegacy: true, jobsAbertos: 1, pasta: { projectId: 'operacao-receita', path: join(dir, 'antigo') } });
    expect(cards.find((c) => c.id === 'criativos-motion')!.isLegacy).toBe(false);
    expect(store.getJob(job.id)!.projectId).toBe('operacao-receita');
    expect(projectsForNewJobs(store.listProjects()).map((p) => p.id)).toEqual(['criativos-motion']);
    expect(store.listProjects()).toHaveLength(2);
  });
});
