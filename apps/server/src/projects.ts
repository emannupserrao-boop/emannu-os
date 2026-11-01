// Catálogo da aba Projetos: um card por projeto, juntando o cockpit antigo
// (resumos, mídias, documentos), o vault (Current State) e o v3 (jobs e entregas).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectCard } from '../../../packages/shared/types.ts';
import type { Store } from './db.ts';
import type { Vault } from './vault.ts';
import { PROJECTS_FOLDER, stripFrontmatter } from './vault.ts';
import { clipWords } from './context.ts';
import { LEGACY_PROJECT_IDS, type LegacyImport } from './legacy.ts';
import { slug } from './worktrees.ts';
import { PROJECT_NOTES } from './config.ts';

const LOGOS: Record<string, string> = {
  mirae: '/projetos/mirae.png',
  'what-lies-btwn': '/projetos/what-lies-btwn.png',
  'pulse-events': '/projetos/pulse-events.webp',
  'emannu-os': '/icon-192.png',
};

// Propósito dos projetos que não vieram do cockpit antigo.
const PROPOSITOS: Record<string, string> = {
};

// Pastas de projeto no vault que não estão em 20 - PROJECTS.
const EXTRA_VAULT: Record<string, { nome: string; folder: string }> = {
  'emannu-os': { nome: 'EMANNU OS', folder: '10 - EMANNU OS' },
};

const OPEN = new Set(['queued', 'approval', 'running', 'reviewing', 'review']);
const SKIP_PROJECTS = new Set(['sandbox', 'imigracao']);

function currentState(vault: Vault | null, folder: string | null): ProjectCard['estadoAtual'] {
  if (!vault?.exists() || !folder) return null;
  const note = vault.findCurrentState(folder);
  if (!note) return null;
  const body = stripFrontmatter(vault.read(note)).body.replace(/^#\s+.*$/m, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  return { texto: clipWords(body, 70), fonte: vault.rel(note) };
}

export function buildProjectCards(store: Store, vault: Vault | null, legacy: LegacyImport | null): ProjectCard[] {
  const cards = new Map<string, ProjectCard>();
  const card = (id: string, nome: string): ProjectCard => {
    let c = cards.get(id);
    if (!c) {
      c = {
        id, nome, isLegacy: false, logo: LOGOS[id] ?? null, badge: null, proposito: PROPOSITOS[id] ?? null, estadoAtual: null, legado: null, pasta: null,
        vaultFolder: null, jobsAbertos: 0, aguardandoVoce: 0, entregas: [], midias: { total: 0, porTipo: {}, amostra: [] }, documentos: [],
      };
      cards.set(id, c);
    }
    return c;
  };

  // 1. Cockpit antigo
  for (const p of legacy?.projects ?? []) {
    const c = card(LEGACY_PROJECT_IDS[p.legacyId]?.id ?? slug(p.nome), p.nome);
    c.badge = p.badge || null;
    c.proposito = p.proposito || null;
    c.legado = { estado: p.estado, feito: p.feito, planejado: p.planejado, proximos: p.proximos, bloqueios: p.bloqueios, importadoEm: legacy!.importedAt };
  }

  // 2. Vault
  if (vault?.exists()) {
    const dir = join(vault.root, PROJECTS_FOLDER);
    if (existsSync(dir)) {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory()) card(slug(d.name), d.name).vaultFolder = join(PROJECTS_FOLDER, d.name);
      }
    }
    for (const [id, x] of Object.entries(EXTRA_VAULT)) if (existsSync(join(vault.root, x.folder))) card(id, x.nome).vaultFolder = x.folder;
  }

  // 3. Projetos cadastrados no v3 (pasta no PC)
  for (const p of store.listProjects()) {
    if (p.isTest || SKIP_PROJECTS.has(p.id)) continue;
    const c = cards.get(p.id) ?? [...cards.values()].find((x) => x.nome.toLowerCase() === p.name.toLowerCase()) ?? card(p.id, p.name);
    c.pasta = { projectId: p.id, path: p.path, isGit: p.isGit };
    c.isLegacy = p.isLegacy;
    if (!c.vaultFolder && p.vaultFolder) c.vaultFolder = p.vaultFolder;
  }

  // Mídias e documentos (só referências)
  for (const m of legacy?.media ?? []) {
    const c = cards.get(m.project);
    if (!c) continue;
    c.midias.total++;
    c.midias.porTipo[m.kind] = (c.midias.porTipo[m.kind] ?? 0) + 1;
  }
  for (const c of cards.values()) {
    c.midias.amostra = (legacy?.media ?? [])
      .filter((m) => m.project === c.id && m.kind === 'image')
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
      .slice(0, 6)
      .map((m) => ({ id: m.id, title: m.title, kind: m.kind }));
    c.documentos = (legacy?.documents ?? []).filter((d) => d.project === c.id).slice(0, 10).map((d) => ({ id: d.id, title: d.title, kind: d.kind, path: d.path }));
  }

  // Jobs, decisões pendentes e entregas do v3
  const jobs = store.listJobs(1000);
  const objectives = store.listObjectives(500);
  for (const c of cards.values()) {
    c.estadoAtual = currentState(vault, c.vaultFolder);
    if (!c.pasta) continue;
    const pid = c.pasta.projectId;
    const mine = jobs.filter((j) => j.projectId === pid);
    c.jobsAbertos = mine.filter((j) => OPEN.has(j.status)).length;
    c.aguardandoVoce = mine.filter((j) => j.status === 'review' || j.status === 'approval').length + objectives.filter((o) => o.projectId === pid && ['plan_ready', 'attention', 'ready', 'proposed'].includes(o.status)).length;
    c.entregas = [
      ...objectives.filter((o) => o.projectId === pid && o.status === 'done').map((o) => ({ id: o.id, titulo: o.title, data: o.finishedAt ?? o.createdAt, tipo: 'objetivo' as const })),
      ...mine.filter((j) => j.kind === 'task' && !j.objectiveId && j.status === 'done' && j.step?.startsWith('Merge feito')).map((j) => ({ id: j.id, titulo: j.title, data: j.finishedAt ?? j.createdAt, tipo: 'job' as const })),
    ]
      .sort((a, b) => b.data.localeCompare(a.data))
      .slice(0, 5);
  }

  for (const [id, nota] of Object.entries(PROJECT_NOTES)) {
    const c = cards.get(id);
    if (c && !c.pasta) c.nota = nota;
  }

  // Com algo pendente primeiro; depois os que têm pasta; depois por nome.
  return [...cards.values()].sort((a, b) => b.aguardandoVoce - a.aguardandoVoce || Number(!!b.pasta) - Number(!!a.pasta) || a.nome.localeCompare(b.nome, 'pt'));
}
