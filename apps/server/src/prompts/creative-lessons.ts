import { join } from 'node:path';
import { clipWords } from '../context.ts';
import { stripFrontmatter, type Vault } from '../vault.ts';

export const CREATIVE_LESSONS_NOTE = join('80 - AUTOMATION', 'Aprendizados', 'Criativos.md');

// Lido ao montar cada prompt, sem cache: correções no vault valem para o próximo job.
export function creativeLessons(projectId: string, vault?: Vault | null): string {
  if (projectId !== 'criativos-motion' || !vault) return '';
  let text: string;
  try {
    text = vault.read(join(vault.root, CREATIVE_LESSONS_NOTE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
  const body = clipWords(stripFrontmatter(text).body, 1500);
  if (!body) return '';
  return `\n# Lições de criativos\nFonte: 80 - AUTOMATION/Aprendizados/Criativos.md\nUse estas lições como referência de produção e QA, respeitando as regras do job e as confirmações humanas.\n\n${body}\n`;
}
