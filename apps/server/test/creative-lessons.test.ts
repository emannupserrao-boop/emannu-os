import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Store } from '../src/db.ts';
import { Scheduler } from '../src/scheduler.ts';
import { Vault } from '../src/vault.ts';
import { Renda } from '../src/renda/index.ts';
import { fixPrompt, reviewPrompt, taskPrompt } from '../src/prompts.ts';
import { CREATIVE_LESSONS_NOTE, creativeLessons } from '../src/prompts/creative-lessons.ts';
import { countWords } from '../src/context.ts';
import type { Job } from '../../../packages/shared/types.ts';

let dir: string;
let note: string;
let vault: Vault;
let store: Store;
let sched: Scheduler;
let renda: Renda;

function writeNote(text: string) {
  mkdirSync(dirname(note), { recursive: true });
  writeFileSync(note, text);
}
function job(projectId = 'criativos-motion', kind: Job['kind'] = 'task') {
  return store.createJob({ title: 'Criar motion', prompt: 'Produzir criativo', agent: 'claude', projectId, kind, risk: 'verde', status: 'queued', timeoutMin: 10 });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'emannu-creative-lessons-'));
  vault = new Vault(join(dir, 'vault'));
  note = join(vault.root, CREATIVE_LESSONS_NOTE);
  store = new Store(':memory:');
  store.upsertProject({ id: 'criativos-motion', name: 'Criativos Motion', path: dir, isGit: false });
  sched = new Scheduler({ store, vault, logDir: join(dir, 'logs'), worktreesDir: join(dir, 'wt'), resolveExe: () => null });
  vi.spyOn(sched, 'tick').mockImplementation(() => {});
  renda = new Renda(sched, { projectPath: join(dir, 'isolado') });
});
afterEach(() => {
  vi.restoreAllMocks();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('lições de criativos nos prompts de produção e QA', () => {
  it('inclui as lições via Vault em tarefa, revisão, correção e proposta; ignora o frontmatter', () => {
    const text = '---\nsegredo_de_metadados: privado\n---\nEvitar títulos cortados na área segura.';
    writeNote(text);
    const read = vi.spyOn(vault, 'read');
    const target = job();
    const review = job('criativos-motion', 'review');
    const prompts = [
      sched.flow.prompt(target),
      reviewPrompt(target, 'codex', 'diff', 'base', 'contexto', vault),
      fixPrompt(target, review, 'contexto', vault),
      sched.flow.prompt(renda.enqueueProposals()),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain('Evitar títulos cortados na área segura.');
      expect(prompt).toContain('80 - AUTOMATION/Aprendizados/Criativos.md');
      expect(prompt).not.toContain('segredo_de_metadados');
      expect(prompt).not.toContain('{{aprendizados}}');
    }
    expect(read).toHaveBeenCalledWith(note);
    expect(readFileSync(note, 'utf8')).toBe(text);
  });

  it('segue sem a nota ou sem vault, inclusive em instalações que usam renda', () => {
    const target = job();
    expect(sched.flow.prompt(target)).not.toContain('# Lições de criativos');
    expect(sched.flow.prompt(renda.enqueueProposals())).not.toContain('{{aprendizados}}');
    expect(creativeLessons(target.projectId, null)).toBe('');
    const fallback = job('renda');
    expect(taskPrompt(fallback, '', null, vault)).not.toContain('# Lições de criativos');
    expect(existsSync(note)).toBe(false);
  });

  it('não lê nem injeta as lições para outros projetos ou pesquisa de leads', () => {
    writeNote('Não usar o aprendizado fora de Criativos Motion.');
    const read = vi.spyOn(vault, 'read');
    const other = job('renda');
    expect(taskPrompt(other, '', null, vault)).not.toContain('Não usar o aprendizado');
    expect(reviewPrompt(other, 'codex', '', 'base', '', vault)).not.toContain('Não usar o aprendizado');
    expect(fixPrompt(other, other, '', vault)).not.toContain('Não usar o aprendizado');
    expect(renda.prompt(renda.enqueueLeads())).not.toContain('Não usar o aprendizado');
    expect(read).not.toHaveBeenCalled();
  });

  it('recarrega a nota a cada prompt mesmo com o contexto do projeto em cache', () => {
    const target = job();
    writeNote('Primeira lição');
    expect(sched.flow.prompt(target)).toContain('Primeira lição');
    writeNote('Lição revisada');
    const next = sched.flow.prompt(target);
    expect(next).toContain('Lição revisada');
    expect(next).not.toContain('Primeira lição');
  });

  it('limita a nota a 1.500 palavras preservando a parte inicial', () => {
    writeNote(Array.from({ length: 1600 }, (_, i) => `palavra${i + 1}`).join(' '));
    const block = creativeLessons('criativos-motion', vault);
    const body = block.split('\n\n').at(-1)!.trim();
    expect(countWords(body)).toBeLessThanOrEqual(1501); // reticências não fazem parte da nota
    expect(body).toContain('palavra1 ');
    expect(body).toContain('palavra1500');
    expect(body).not.toContain('palavra1501');
  });

  it('não esconde erro de leitura diferente de nota ausente', () => {
    vi.spyOn(vault, 'read').mockImplementation(() => { throw Object.assign(new Error('Sem acesso'), { code: 'EACCES' }); });
    expect(() => creativeLessons('criativos-motion', vault)).toThrow('Sem acesso');
  });
});
