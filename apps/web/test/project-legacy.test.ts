import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Project } from '../../../packages/shared/types.ts';
import { NewJob } from '../src/components/NewJob.tsx';
import { NewObjective } from '../src/components/Objectives.tsx';

const projects: Project[] = [
  { id: 'operacao-receita', name: 'Operação Receita', path: 'C:/antigo', isGit: true, isLegacy: true, isTest: false, vaultFolder: null, createdAt: '2026-01-01' },
  { id: 'criativos-motion', name: 'Criativos Motion', path: 'D:/novo', isGit: true, isLegacy: false, isTest: false, vaultFolder: null, createdAt: '2026-10-28' },
];

describe('projetos sugeridos nos formulários', () => {
  it('novo job exclui legado e ignora uma preferência antiga pelo projeto legado', () => {
    const html = renderToStaticMarkup(createElement(NewJob, { projects, agents: [], defaultProject: 'operacao-receita', onClose() {}, onCreated() {} }));
    expect(html).not.toContain('operacao-receita');
    expect(html).not.toContain('Operação Receita');
    expect(html).toMatch(/<option[^>]*value="criativos-motion"[^>]*selected=""/);
  });

  it('novo objetivo exclui legado e seleciona o projeto ativo mesmo com preferência antiga', () => {
    const html = renderToStaticMarkup(createElement(NewObjective, { projects, defaultProject: 'operacao-receita', onClose() {}, onCreated() {} }));
    expect(html).not.toContain('operacao-receita');
    expect(html).not.toContain('Operação Receita');
    expect(html).toMatch(/<option[^>]*value="criativos-motion"[^>]*selected=""/);
  });
});
