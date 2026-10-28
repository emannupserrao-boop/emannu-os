// Prompts dos agentes por papel (v3.1, seção 9): um arquivo .md por papel nesta pasta,
// com marcadores {{nome}} preenchidos pelo servidor.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Vault } from '../vault.ts';
import { creativeLessons } from './creative-lessons.ts';

export function loadPrompt(name: string, vars: Record<string, string | number>, context?: { projectId: string; vault: Vault | null }): string {
  const text = readFileSync(join(import.meta.dirname, `${name}.md`), 'utf8');
  const values: Record<string, string | number> = { ...vars, aprendizados: context ? creativeLessons(context.projectId, context.vault) : '' };
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in values ? String(values[k]) : m));
}
