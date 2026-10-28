import type { Project } from './types.ts';

// O histórico continua no catálogo; sugestões de trabalho novo usam projetos ativos.
export function projectsForNewJobs(projects: Project[]): Project[] {
  return projects.filter((p) => !p.isLegacy);
}
