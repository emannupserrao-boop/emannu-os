// Importador do cockpit antigo (LEGADO, só leitura). Idempotente: rodar de novo
// substitui o resultado anterior pelo mesmo conteúdo.
// Importa: resumos dos projetos, referências de mídias e documentos (os arquivos
// originais ficam onde estão). NÃO importa gates, recibos, provas nem filas históricas
// (project-flow.json, agent-roles-manifest.json e afins).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './db.ts';

export interface LegacyProject {
  legacyId: string;
  nome: string;
  badge: string;
  proposito: string;
  estado: string;
  feito: string;
  planejado: string;
  proximos: string[];
  bloqueios: string[];
}

export interface LegacyFile {
  id: string;
  project: string; // id do catálogo
  title: string;
  kind: string;
  mime: string;
  path: string;
  bytes: number;
  modifiedAt: string;
  group: string;
}

export interface LegacyImport {
  importedAt: string;
  source: string;
  sourceModifiedAt: string;
  projects: LegacyProject[];
  media: LegacyFile[];
  documents: LegacyFile[];
  skipped: string[];
}

// Ids do cockpit antigo → ids do catálogo de projetos do v3.
export const LEGACY_PROJECT_IDS: Record<string, { id: string; nome: string }> = {
  receita: { id: 'operacao-receita', nome: 'Operação Receita' },
  mirae: { id: 'mirae', nome: 'MIRAE' },
  jogos: { id: 'estacao-raiz', nome: 'Estação Raiz / Jogos' },
  os: { id: 'emannu-os', nome: 'EMANNU OS' },
  wlb: { id: 'what-lies-btwn', nome: 'WHAT LIES BTWN' },
  pulse: { id: 'pulse-events', nome: 'Pulse Events' },
  neon: { id: 'neon-vanguard', nome: 'Neon Vanguard' },
};

// Documentos de processo antigo que não vêm para o v3 (filas, handoffs, recibos, selos, gates).
const OLD_PROCESS_RE = /\b(fila|filas|handoff|recibo|selo|selad|gate|gates|hash|autoriza[çc][ãa]o)\b/i;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const strs = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const mapProject = (legacyId: string) => LEGACY_PROJECT_IDS[legacyId]?.id ?? legacyId;

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
}

function files(items: unknown, fallbackKind: string): LegacyFile[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((it) => str(it?.id) && str(it?.realPath || it?.path))
    .map((it) => ({
      id: str(it.id),
      project: mapProject(str(it.project)),
      title: str(it.title) || str(it.relativePath) || str(it.id),
      kind: str(it.kind) || fallbackKind,
      mime: str(it.mime),
      path: str(it.realPath) || str(it.path),
      bytes: Number(it.bytes) || 0,
      modifiedAt: str(it.modifiedAt),
      group: str(it.collection) || str(it.group),
    }));
}

export function readLegacy(cockpitDir: string): LegacyImport {
  const summaries = readJson(join(cockpitDir, 'project-summaries.json'));
  const media = readJson(join(cockpitDir, 'media-manifest.json'));
  const docs = readJson(join(cockpitDir, 'documents-manifest.json'));
  const projects: LegacyProject[] = Object.entries<any>(summaries?.projects ?? {}).map(([legacyId, p]) => ({
    legacyId,
    nome: LEGACY_PROJECT_IDS[legacyId]?.nome ?? legacyId,
    badge: str(p.badge),
    proposito: str(p.purpose),
    estado: str(p.state),
    feito: str(p.done),
    planejado: str(p.planned),
    proximos: strs(p.next),
    bloqueios: strs(p.blockers),
  }));
  const stamp = ['project-summaries.json', 'media-manifest.json', 'documents-manifest.json']
    .map((f) => join(cockpitDir, f))
    .filter((f) => existsSync(f))
    .map((f) => statSync(f).mtime.toISOString())
    .sort()
    .at(-1);
  return {
    importedAt: new Date().toISOString(),
    source: cockpitDir,
    sourceModifiedAt: stamp ?? '',
    projects,
    media: files(media?.items, 'image').filter((f) => f.kind !== 'folder'),
    // Pastas não são arquivos que dê para abrir; documentos de processo antigo ficam de fora.
    documents: files(docs?.items, 'document').filter((f) => f.kind !== 'folder' && !OLD_PROCESS_RE.test(f.title)),
    skipped: [
      'project-flow.json (provas e política de conclusão: gates)',
      'agent-roles-manifest.json (matriz planejada, não configuração real)',
      'documentos de filas, handoffs, recibos, selos e gates',
      'itens do tipo pasta',
    ],
  };
}

// Importa se o cockpit existir e tiver mudado desde a última importação.
// Sobe quando as regras de importação mudam, para reimportar mesmo sem o cockpit mudar.
const IMPORTER_VERSION = 2;

export function importLegacy(store: Store, cockpitDir: string, force = false): LegacyImport | null {
  if (!existsSync(cockpitDir)) return store.kvGet<LegacyImport>('legado');
  const prev = store.kvGet<LegacyImport & { version?: number }>('legado');
  const next = { ...readLegacy(cockpitDir), version: IMPORTER_VERSION };
  if (!force && prev && prev.version === IMPORTER_VERSION && prev.sourceModifiedAt === next.sourceModifiedAt) return prev;
  store.kvSet('legado', next);
  return next;
}
