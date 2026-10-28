import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Scheduler } from '../src/scheduler.ts';
import { CRIATIVOS_PROJECT, Renda, parseReferencias } from '../src/renda/index.ts';

let dir: string;
let store: Store;
let sched: Scheduler;
let renda: Renda;
const response = (data: unknown) => ({ ok: true, code: 0, canceled: false, timedOut: false, text: 'Resumo.\n```json\n' + JSON.stringify(data) + '\n```', error: null });
const ref = (i: number, url = `https://www.facebook.com/ads/library/?id=${i}`) => ({ marca: `Marca ${i}`, nicho: 'beleza', url, visto_em: '2026-11-02', duracao_s: 15, primeiro_corte_s: 0.8, cortes_por_s: 0.6, produto_no_quadro_0: true, gancho: 'problema', texto: '3 palavras no topo', som: 'música + efeito', final: 'logo 1,5 s' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'emannu-referencias-'));
  store = new Store(':memory:');
  sched = new Scheduler({ store, logDir: join(dir, 'logs'), worktreesDir: join(dir, 'wt'), resolveExe: () => null });
  vi.spyOn(sched, 'tick').mockImplementation(() => {});
  renda = new Renda(sched, { projectPath: join(dir, 'isolado') });
  store.upsertProject({ id: CRIATIVOS_PROJECT, name: 'Criativos Motion', path: join(dir, 'projeto-real'), isGit: true, vaultFolder: '20 - PROJECTS\\Criativos Motion' });
});

afterEach(() => {
  vi.restoreAllMocks();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('rotina semanal de referências (hermes-referencias)', () => {
  it('dispara na segunda às 06h35, roda na pasta isolada e usa o criativo da semana do projeto', async () => {
    mkdirSync(join(dir, 'projeto-real', 'handoff', 'criativos-motion'), { recursive: true });
    writeFileSync(join(dir, 'projeto-real', 'handoff', 'criativos-motion', 'criativo-da-semana.md'), 'Bask v5 B, V1: vapor no quadro 0');
    renda.registerRoutines(sched.routines);
    await sched.routines.tick(new Date('2026-11-02T04:35:00Z')); // segunda, 06h35 em Bucareste
    const job = store.listJobs().find((j) => j.planKey === 'comercial:referencias:2026-11-02')!;
    expect(job).toMatchObject({ kind: 'research', projectId: CRIATIVOS_PROJECT });
    expect(sched.flow.prepare(job).cwd).toBe(renda.jobPath);
    expect(renda.prompt(job)).toContain('Bask v5 B, V1: vapor no quadro 0');
  });

  it('grava as referências válidas e os critérios na memória; menos de 5 com link falha', () => {
    const job = renda.enqueueReferencias('2026-11-02');
    const refs = [...Array.from({ length: 5 }, (_, i) => ref(i)), ref(9, 'javascript:alert(1)')];
    const done = renda.afterResearch(job, response({ referencias: refs, avaliacao: { criativo: 'bask-pt-v1', nota: 6, diferencas: ['gancho lento'] }, memoria: [{ tipo: 'criterio', texto: 'Perfume: névoa no quadro 0', url: 'https://www.facebook.com/ads/library/?id=1', validade_dias: 60 }] }));
    expect(done.status).toBe('done');
    expect(done.step).toMatch(/^5 referência/);
    expect(sched.memory.list().some((m) => m.texto === 'Perfume: névoa no quadro 0')).toBe(true);
    const few = renda.afterResearch(renda.enqueueReferencias('2026-11-09'), response({ referencias: [ref(1), ref(2)] }));
    expect(few.status).toBe('failed');
  });

  it('parseReferencias descarta link inválido e não inventa números', () => {
    const { referencias, avaliacao } = parseReferencias({ referencias: [{ marca: 'X', url: 'ftp://x' }, { marca: 'Y', url: 'https://y.test/ad', duracao_s: 'quinze' }], avaliacao: { criativo: 'c', nota: 42 } });
    expect(referencias).toHaveLength(1);
    expect(referencias[0].linha).toContain('| ? |');
    expect(avaliacao!.nota).toBeNull();
  });
});
