// Context pack: um resumo curto (300–700 palavras) do projeto para cada job.
// Fontes: nota Current State do vault (ou README/GDD do repositório) + estrutura de arquivos.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from '../../../packages/shared/types.ts';
import { stripFrontmatter, type Vault } from './vault.ts';
import { git } from './worktrees.ts';

const MAX_WORDS = 650;

export function clipWords(text: string, max: number): string {
  let count = 0;
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const words = line.split(/\s+/).filter(Boolean);
    if (count + words.length > max) {
      const rest = max - count;
      if (rest > 0) out.push(words.slice(0, rest).join(' ') + ' …');
      else out.push('…');
      break;
    }
    count += words.length;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

// Resume a árvore de arquivos versionados por pasta (até 2 níveis).
function structure(project: Project): string {
  let files: string[] = [];
  try {
    files = project.isGit ? git(project.path, 'ls-files').split(/\r?\n/).filter(Boolean) : readdirSync(project.path);
  } catch {
    return '(não consegui listar os arquivos)';
  }
  const groups = new Map<string, number>();
  const rootFiles: string[] = [];
  for (const f of files) {
    const parts = f.split('/');
    if (parts.length === 1) rootFiles.push(f);
    else {
      const key = parts.slice(0, Math.min(2, parts.length - 1)).join('/') + '/';
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
  }
  const lines = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 30)
    .map(([k, n]) => `- ${k} (${n} arquivo${n > 1 ? 's' : ''})`);
  if (rootFiles.length) lines.unshift(`- raiz: ${rootFiles.slice(0, 12).join(', ')}`);
  return lines.join('\n');
}

function repoOverview(project: Project): string | null {
  for (const name of ['README.md', 'Docs/GDD.md', 'GDD.md', 'docs/README.md']) {
    const p = join(project.path, name);
    if (existsSync(p)) return `Fonte: ${name}\n${clipWords(stripFrontmatter(readFileSync(p, 'utf8')).body, 220)}`;
  }
  return null;
}

export function buildContextPack(project: Project, vault: Vault | null): string {
  const parts: string[] = [`## Projeto: ${project.name}`, `Pasta: ${project.path}${project.isGit ? ' (git)' : ''}`];

  let state: string | null = null;
  if (vault && project.vaultFolder) {
    const note = vault.findCurrentState(project.vaultFolder);
    if (note) state = `Fonte: vault/${vault.rel(note)}\n${clipWords(stripFrontmatter(vault.read(note)).body, 320)}`;
  }
  parts.push('## Estado atual', state ?? 'Não há nota Current State no vault para este projeto.');
  if (!state) {
    const overview = repoOverview(project);
    if (overview) parts.push('## Visão geral do repositório', overview);
  }
  parts.push('## Estrutura de arquivos', structure(project));
  return clipWords(parts.join('\n\n'), MAX_WORDS);
}
