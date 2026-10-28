import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Scheduler } from '../src/scheduler.ts';
import { Vault } from '../src/vault.ts';
import { Auth } from '../src/auth.ts';
import { buildApp } from '../src/app.ts';
import { importLegacy, readLegacy } from '../src/legacy.ts';
import { buildProjectCards } from '../src/projects.ts';

let dir: string;
let cockpit: string;
let vaultDir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'emannu-legacy-'));
  cockpit = join(dir, 'cockpit');
  mkdirSync(cockpit);
  const media = join(dir, 'midia');
  mkdirSync(media);
  writeFileSync(join(media, 'capa.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  writeFileSync(join(media, 'faixa.wav'), Buffer.alloc(1000, 7));
  writeFileSync(join(media, 'pagina.html'), '<script>alert(1)</script>');
  writeFileSync(join(cockpit, 'project-summaries.json'), '﻿' + JSON.stringify({
    projects: {
      mirae: { purpose: 'Coach de Dota', state: 'Overlay existe', badge: '5 RAÍZES', done: 'x', planned: 'y', next: ['P1 a'], blockers: ['b'] },
      wlb: { purpose: 'Música', state: 'LTX em hold', badge: 'HOLD', next: [], blockers: [] },
    },
  }));
  writeFileSync(join(cockpit, 'media-manifest.json'), JSON.stringify({
    items: [
      { id: 'm-1', project: 'wlb', title: 'capa.png', kind: 'image', mime: 'image/png', path: join(media, 'capa.png'), realPath: join(media, 'capa.png'), bytes: 8, modifiedAt: '2026-10-01' },
      { id: 'm-2', project: 'wlb', title: 'faixa.wav', kind: 'audio', mime: 'audio/wav', path: join(media, 'faixa.wav'), bytes: 1000, modifiedAt: '2026-09-01' },
    ],
  }));
  writeFileSync(join(cockpit, 'documents-manifest.json'), JSON.stringify({
    items: [
      { id: 'd-1', project: 'mirae', title: 'App MIRAE', kind: 'html', path: join(media, 'pagina.html') },
      { id: 'd-2', project: 'os', title: 'Fila histórica v3.0.2', kind: 'text', path: join(media, 'pagina.html') },
      { id: 'd-3', project: 'os', title: 'Handoff operacional · preview', kind: 'text', path: join(media, 'pagina.html') },
      { id: 'd-4', project: 'mirae', title: 'App MIRAE · folder', kind: 'folder', path: media },
    ],
  }));
  writeFileSync(join(cockpit, 'project-flow.json'), JSON.stringify({ proofs: ['PROVA-DE-GATE-ANTIGA'] }));

  vaultDir = join(dir, 'vault');
  mkdirSync(join(vaultDir, '20 - PROJECTS', 'MIRAE', '00 - HQ'), { recursive: true });
  mkdirSync(join(vaultDir, '20 - PROJECTS', 'SerrON'), { recursive: true });
  writeFileSync(join(vaultDir, '20 - PROJECTS', 'MIRAE', '00 - HQ', 'MIRAE - Current State.md'), '---\ntype: x\n---\n# MIRAE — Current State\n\nEstado escrito no vault.\n');
  store = new Store(':memory:');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('importador do legado', () => {
  it('lê resumos, mídias e documentos e ignora gates', () => {
    const l = readLegacy(cockpit);
    expect(l.projects.map((p) => p.nome)).toEqual(['MIRAE', 'WHAT LIES BTWN']);
    expect(l.media.map((m) => m.project)).toEqual(['what-lies-btwn', 'what-lies-btwn']);
    expect(l.documents.map((d) => d.id)).toEqual(['d-1']); // sem fila, handoff nem pasta
    expect(l.documents[0].project).toBe('mirae');
    expect(JSON.stringify(l)).not.toContain('PROVA-DE-GATE-ANTIGA');
    expect(l.skipped.join(' ')).toMatch(/project-flow/);
  });

  it('é idempotente: só reimporta se o cockpit mudou', () => {
    const a = importLegacy(store, cockpit)!;
    const b = importLegacy(store, cockpit)!;
    expect(b.importedAt).toBe(a.importedAt);
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(cockpit, 'project-summaries.json'), later, later);
    const c = importLegacy(store, cockpit)!;
    expect(c.importedAt >= a.importedAt).toBe(true);
    expect(c.sourceModifiedAt).not.toBe(a.sourceModifiedAt);
    expect(c.projects).toEqual(a.projects);
  });

  it('catálogo junta legado, vault e projeto cadastrado', () => {
    store.upsertProject({ id: 'mirae', name: 'MIRAE', path: dir, isGit: false });
    const cards = buildProjectCards(store, new Vault(vaultDir), importLegacy(store, cockpit));
    const ids = cards.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['mirae', 'what-lies-btwn', 'serron']));
    const mirae = cards.find((c) => c.id === 'mirae')!;
    expect(mirae).toMatchObject({ logo: '/projetos/mirae.png', badge: '5 RAÍZES', pasta: { projectId: 'mirae' } });
    expect(mirae.estadoAtual!.texto).toContain('Estado escrito no vault');
    expect(mirae.legado!.proximos).toEqual(['P1 a']);
    const wlb = cards.find((c) => c.id === 'what-lies-btwn')!;
    expect(wlb.midias).toMatchObject({ total: 2, porTipo: { image: 1, audio: 1 } });
    expect(wlb.midias.amostra.map((m) => m.id)).toEqual(['m-1']);
    // SerrON: sem pasta, com o aviso de código não localizado (não liga ao perfil do OBS).
    const serron = cards.find((c) => c.id === 'serron')!;
    expect(serron.pasta).toBeNull();
    expect(serron.nota).toMatch(/Código não localizado/);
  });
});

describe('arquivos do legado pela API', () => {
  it('serve só o que está no manifesto, em sandbox e com Range', async () => {
    const sched = new Scheduler({ store, logDir: join(dir, 'logs'), worktreesDir: join(dir, 'wt'), vault: new Vault(vaultDir), resolveExe: () => null });
    const auth = new Auth(store, join(dir, 'admin-token'));
    const app = await buildApp({ sched, auth, push: null, legacyDir: cockpit });
    const h = { 'x-emannu-token': auth.adminToken };
    try {
      expect((await app.inject({ url: '/api/legado/arquivo/m-1' })).statusCode).toBe(401);
      const img = await app.inject({ url: '/api/legado/arquivo/m-1', headers: h });
      expect(img.statusCode).toBe(200);
      expect(img.headers['content-type']).toBe('image/png');
      expect(img.headers['content-security-policy']).toBe('sandbox');
      const part = await app.inject({ url: '/api/legado/arquivo/m-2', headers: { ...h, range: 'bytes=100-199' } });
      expect(part.statusCode).toBe(206);
      expect(part.headers['content-range']).toBe('bytes 100-199/1000');
      expect(part.rawPayload.length).toBe(100);
      const html = await app.inject({ url: '/api/legado/arquivo/d-1', headers: h });
      expect(html.headers['content-security-policy']).toBe('sandbox');
      expect((await app.inject({ url: '/api/legado/arquivo/..%2F..%2Fwindows', headers: h })).statusCode).toBe(404);
      const cards = (await app.inject({ url: '/api/projetos', headers: h })).json();
      expect(cards.length).toBeGreaterThanOrEqual(3);
      const re = (await app.inject({ method: 'POST', url: '/api/legado/importar', headers: h })).json();
      expect(re).toMatchObject({ projetos: 2, midias: 2, documentos: 1 });
    } finally {
      await app.close();
    }
  });
});
