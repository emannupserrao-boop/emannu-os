import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Scheduler } from '../src/scheduler.ts';
import { Auth } from '../src/auth.ts';
import { buildApp } from '../src/app.ts';
import { TIMEZONE } from '../src/config.ts';
import { localDate } from '../src/routines.ts';
import { buildHoje } from '../src/renda/hoje.ts';
import { HojeTarefas } from '../src/renda/hoje-tarefas.ts';
import type { HojeTarefaEstado, NovaHojeTarefa } from '../../../packages/shared/renda.ts';

const DIA = '2026-10-28';
const NOW = new Date('2026-10-28T12:00:00Z');
const NOVA: NovaHojeTarefa = { data: DIA, bloco: 'decisoes', titulo: 'Escolher modelo A ou B', minutos: 5, origem: 'codex' };
let store: Store;
let tarefas: HojeTarefas;

beforeEach(() => {
  store = new Store(':memory:');
  tarefas = new HojeTarefas(store);
});
afterEach(() => store.db.close());

describe('persistência e validação de tarefas manuais', () => {
  it('cria aberta com os padrões e usa a data do TIMEZONE na virada do dia', () => {
    const now = new Date('2026-10-27T22:30:00Z');
    const tarefa = tarefas.criar({ ...NOVA, data: undefined, titulo: '  Escolher modelo A ou B  ' }, now);
    expect(tarefa).toMatchObject({
      data: localDate(now, TIMEZONE), titulo: NOVA.titulo, estado: 'aberta', detalhe: '', ordem: 0,
      textoCopiar: null, url: null, arquivo: null, criadaEm: now.toISOString(), feitaEm: null, origem: 'codex',
    });
    expect(tarefas.obter(tarefa.id)).toEqual(tarefa);
  });

  it('aceita os limites de título/minutos, URL http(s) e caminhos Windows', () => {
    for (const arquivo of ['D:\\Escolhas\\escolha-v5.html', 'C:/Escolhas/modelo.html', '\\\\servidor\\compartilhamento\\modelo.html']) {
      const tarefa = tarefas.criar({ ...NOVA, titulo: 'abc', minutos: 1, arquivo, url: 'http://localhost:3000/escolha', ordem: -1 });
      expect(tarefa).toMatchObject({ titulo: 'abc', minutos: 1, arquivo, ordem: -1 });
    }
    expect(tarefas.criar({ ...NOVA, titulo: 'x'.repeat(140), minutos: 45, url: 'https://example.test/' }).minutos).toBe(45);
  });

  it.each([
    { titulo: 'ab' }, { titulo: '  ' }, { titulo: 'x'.repeat(141) }, { titulo: 123 },
    { minutos: 0 }, { minutos: 46 }, { minutos: 1.5 }, { minutos: '5' },
    { bloco: 'outro' }, { bloco: 'toString' }, { origem: 'outro' },
    { data: '28/10/2026' }, { data: '2026-02-30' }, { data: '' }, { data: null },
    { ordem: 0.5 }, { ordem: '1' }, { detalhe: {} }, { textoCopiar: [] },
    { url: 'javascript:alert(1)' }, { url: 'file:///D:/escolha.html' }, { url: 'ftp://example.test' },
    { url: 'https://[' }, { url: '/escolha' }, { url: 'https:example.test' }, { url: null },
    { arquivo: 'escolha-v5.html' }, { arquivo: 'D:escolha.html' }, { arquivo: '\\escolha.html' },
    { arquivo: '/tmp/escolha.html' }, { arquivo: 'file:///D:/escolha.html' },
    { arquivo: '\\\\servidor' }, { arquivo: 'D:\\a\n.html' }, { arquivo: null },
  ])('recusa entrada inválida %j sem gravar', (patch) => {
    expect(() => tarefas.criar({ ...NOVA, ...patch } as NovaHojeTarefa)).toThrow();
    expect(tarefas.listar(DIA)).toEqual([]);
  });

  it('lista somente a data pedida, inclusive estados encerrados', () => {
    tarefas.criar({ ...NOVA, data: '2026-10-27' });
    const segunda = tarefas.criar({ ...NOVA, ordem: 2 });
    const primeira = tarefas.criar({ ...NOVA, ordem: 1 });
    tarefas.mudarEstado(primeira.id, 'feita', NOW);
    expect(tarefas.listar(DIA).map((t) => [t.id, t.estado])).toEqual([[primeira.id, 'feita'], [segunda.id, 'aberta']]);
    expect(tarefas.listar('2026-10-29')).toEqual([]);
    expect(() => tarefas.listar('2026-02-30')).toThrow();
  });

  it('conclui, pula e reabre; preserva a conclusão repetida e limpa feitaEm ao reabrir', () => {
    const t = tarefas.criar(NOVA);
    expect(tarefas.mudarEstado(t.id, 'feita', NOW)).toMatchObject({ estado: 'feita', feitaEm: NOW.toISOString() });
    expect(tarefas.mudarEstado(t.id, 'feita', new Date('2026-10-29T12:00:00Z')).feitaEm).toBe(NOW.toISOString());
    expect(tarefas.mudarEstado(t.id, 'aberta')).toMatchObject({ estado: 'aberta', feitaEm: null });
    expect(tarefas.mudarEstado(t.id, 'pulada')).toMatchObject({ estado: 'pulada', feitaEm: null });
    expect(tarefas.mudarEstado(t.id, 'aberta').estado).toBe('aberta');
    expect(() => tarefas.mudarEstado(t.id, 'errado' as HojeTarefaEstado)).toThrow();
    expect(() => tarefas.mudarEstado('inexistente', 'feita')).toThrow();
  });

  it('remove só tarefas abertas', () => {
    const t = tarefas.criar(NOVA);
    for (const estado of ['feita', 'pulada'] as const) {
      tarefas.mudarEstado(t.id, estado);
      expect(() => tarefas.remover(t.id)).toThrow(/aberta/);
      expect(tarefas.obter(t.id)?.estado).toBe(estado);
    }
    tarefas.mudarEstado(t.id, 'aberta');
    tarefas.remover(t.id);
    expect(tarefas.obter(t.id)).toBeNull();
    expect(() => tarefas.remover(t.id)).toThrow();
  });

  it('acrescenta a tabela a um banco anterior e preserva os dados ao reabrir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'emannu-hoje-migration-'));
    const path = join(dir, 'store.db');
    const old = new Store(path);
    try {
      old.kvSet('preservar', { valor: 1 });
      old.db.exec('DROP TABLE hoje_tarefas'); // Banco antes desta migração.
    } finally { old.db.close(); }
    try {
      const migrated = new Store(path);
      let id: string;
      try {
        expect(migrated.kvGet('preservar')).toEqual({ valor: 1 });
        id = new HojeTarefas(migrated).criar(NOVA).id;
      } finally { migrated.db.close(); }
      const reopened = new Store(path);
      try { expect(new HojeTarefas(reopened).obter(id!)).toMatchObject({ titulo: NOVA.titulo, estado: 'aberta' }); }
      finally { reopened.db.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('painel Hoje e API autenticada', () => {
  let dir: string;
  let sched: Scheduler;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookie: string;
  let admin: Record<string, string>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'emannu-hoje-'));
    sched = new Scheduler({ store, logDir: join(dir, 'logs'), worktreesDir: join(dir, 'wt'), resolveExe: () => null });
    const auth = new Auth(store, join(dir, 'admin-token'));
    admin = { 'x-emannu-token': auth.adminToken };
    app = await buildApp({ sched, auth, push: null });
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { pin: '246810', deviceName: 'PC' } });
    cookie = String(setup.headers['set-cookie']).split(';')[0];
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const confirm = async (estado: HojeTarefaEstado, id: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/confirmacoes', headers: { cookie }, payload: { acao: `tarefa:${estado}`, alvo: id } });
    expect(res.statusCode).toBe(200);
    return res.json().id as string;
  };
  const transition = async (id: string, estado: HojeTarefaEstado) => app.inject({
    method: 'POST', url: `/api/hoje/tarefas/${id}`, headers: { cookie, 'x-emannu-confirm': await confirm(estado, id) }, payload: { estado },
  });

  it('cria pela API de agente e lista por data; os quatro endpoints exigem autenticação', async () => {
    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      const url = method === 'DELETE' ? '/api/hoje/tarefas/id' : '/api/hoje/tarefas';
      expect((await app.inject({ method, url, ...(method === 'POST' ? { payload: NOVA } : {}) })).statusCode).toBe(401);
    }
    expect((await app.inject({ method: 'POST', url: '/api/hoje/tarefas/id', payload: { estado: 'feita' } })).statusCode).toBe(401);
    const res = await app.inject({ method: 'POST', url: '/api/hoje/tarefas', headers: admin, payload: { ...NOVA, textoCopiar: 'Texto pronto' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ estado: 'aberta', origem: 'codex', textoCopiar: 'Texto pronto' });
    tarefas.criar({ ...NOVA, data: '2026-10-27' });
    const list = await app.inject({ url: `/api/hoje/tarefas?data=${DIA}`, headers: admin });
    expect(list.json().map((t: any) => t.id)).toEqual([res.json().id]);
    expect((await app.inject({ url: '/api/hoje/tarefas?data=2026-02-30', headers: admin })).statusCode).toBe(400);
    const today = localDate(new Date());
    const defaultDate = await app.inject({ method: 'POST', url: '/api/hoje/tarefas', headers: admin, payload: { ...NOVA, data: undefined } });
    expect([today, localDate(new Date())]).toContain(defaultDate.json().data);
    expect((await app.inject({ url: '/api/hoje/tarefas', headers: admin })).json().map((t: any) => t.id)).toContain(defaultDate.json().id);
  });

  it('valida a criação e o estado pela API sem mudanças parciais', async () => {
    for (const patch of [{ titulo: 'ab' }, { minutos: 46 }, { bloco: 'x' }, { arquivo: 'a.html' }, { url: 'javascript:alert(1)' }, { origem: 'x' }]) {
      expect((await app.inject({ method: 'POST', url: '/api/hoje/tarefas', headers: admin, payload: { ...NOVA, ...patch } })).statusCode).toBe(400);
    }
    expect(tarefas.listar(DIA)).toEqual([]);
    const t = tarefas.criar(NOVA);
    expect((await app.inject({ method: 'POST', url: `/api/hoje/tarefas/${t.id}`, headers: admin, payload: { estado: 'inválido' } })).statusCode).toBe(400);
    expect(tarefas.obter(t.id)?.estado).toBe('aberta');
  });

  it('exige confirmação do aparelho para cada estado, vinculada ao item e sem reuso', async () => {
    const t = tarefas.criar(NOVA);
    const url = `/api/hoje/tarefas/${t.id}`;
    for (const estado of ['feita', 'pulada', 'aberta'] as const) {
      expect((await app.inject({ method: 'POST', url: '/api/confirmacoes', headers: admin, payload: { acao: `tarefa:${estado}`, alvo: t.id } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url, headers: { cookie }, payload: { estado, autorizado: true } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url, headers: { ...admin, 'x-emannu-confirm': await confirm(estado, t.id) }, payload: { estado } })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'POST', url, headers: { cookie, 'x-emannu-confirm': await confirm('pulada', t.id) }, payload: { estado: 'feita' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers: { cookie, 'x-emannu-confirm': await confirm('feita', 'outro') }, payload: { estado: 'feita' } })).statusCode).toBe(403);
    const token = await confirm('feita', t.id);
    const request = { method: 'POST' as const, url, headers: { cookie, 'x-emannu-confirm': token }, payload: { estado: 'feita' } };
    expect((await app.inject(request)).json()).toMatchObject({ estado: 'feita', feitaEm: expect.any(String) });
    expect((await app.inject(request)).statusCode).toBe(403);
    expect((await transition(t.id, 'pulada')).json()).toMatchObject({ estado: 'pulada', feitaEm: null });
    expect((await transition(t.id, 'aberta')).json()).toMatchObject({ estado: 'aberta', feitaEm: null });
    expect((await transition('inexistente', 'feita')).statusCode).toBe(400);
  });

  it('só remove tarefas abertas e avisa as telas das mudanças', async () => {
    let changes = 0;
    sched.on('renda', () => changes++);
    const res = await app.inject({ method: 'POST', url: '/api/hoje/tarefas', headers: admin, payload: NOVA });
    const id = res.json().id as string;
    expect(changes).toBe(1);
    const remove = () => app.inject({ method: 'DELETE', url: `/api/hoje/tarefas/${id}`, headers: admin });
    for (const estado of ['feita', 'pulada'] as const) {
      expect((await transition(id, estado)).statusCode).toBe(200);
      expect((await remove()).statusCode).toBe(400);
    }
    expect(changes).toBe(3);
    await transition(id, 'aberta');
    expect((await remove()).json()).toEqual({ ok: true });
    expect(changes).toBe(5);
    expect(tarefas.obter(id)).toBeNull();
  });

  it('inclui as ações certas; feita e pulada somem do buildHoje e da API Hoje', async () => {
    const t = tarefas.criar({ ...NOVA, data: localDate(new Date()), detalhe: 'Revisar antes de escolher.', textoCopiar: 'Texto pronto', url: 'https://example.test/escolha', arquivo: 'D:\\Escolhas\\escolha-v5.html' });
    const view = buildHoje(sched);
    expect(view.itens).toEqual([expect.objectContaining({ id: t.id, bloco: 'decisoes', minutos: 5, deOntem: false, acoes: [
      { tipo: 'copiar', rotulo: 'Copiar texto', texto: t.textoCopiar },
      { tipo: 'abrir', rotulo: 'Abrir link', url: t.url },
      { tipo: 'arquivo', rotulo: 'Abrir arquivo', arquivo: t.arquivo },
      { tipo: 'tarefa', rotulo: 'Feito', tarefaId: t.id, estado: 'feita' },
      { tipo: 'tarefa', rotulo: 'Pular', tarefaId: t.id, estado: 'pulada' },
    ] })]);
    expect(view.totalMin).toBe(5);
    for (const estado of ['feita', 'pulada'] as const) {
      expect((await transition(t.id, estado)).statusCode).toBe(200);
      expect(buildHoje(sched).itens).toEqual([]);
      expect((await app.inject({ url: '/api/hoje', headers: { cookie } })).json()).toMatchObject({ itens: [], totalMin: 0 });
    }
    await transition(t.id, 'aberta');
    expect(buildHoje(sched).itens.map((i) => i.id)).toEqual([t.id]);
  });

  it('marca pendências de dias anteriores, exclui futuras e ordena por bloco e ordem', () => {
    const ontem = tarefas.criar({ ...NOVA, data: '2026-10-27', ordem: 3 });
    const anterior = tarefas.criar({ ...NOVA, data: '2026-10-20', ordem: 2 });
    const hoje = tarefas.criar({ ...NOVA, ordem: 1 });
    const proposta = tarefas.criar({ ...NOVA, bloco: 'propostas', ordem: 99 });
    tarefas.criar({ ...NOVA, data: '2026-10-29', ordem: -1 });
    const encerrada = tarefas.criar({ ...NOVA, data: '2026-10-26' });
    tarefas.mudarEstado(encerrada.id, 'feita');
    const view = buildHoje(sched, NOW);
    expect(view.itens.map((i) => i.id)).toEqual([proposta.id, hoje.id, anterior.id, ontem.id]);
    expect(view.itens.filter((i) => i.deOntem).map((i) => i.id)).toEqual([anterior.id, ontem.id]);
    expect(view.itens[1].acoes.map((a) => a.tipo)).toEqual(['tarefa', 'tarefa']);
    expect(view.totalMin).toBe(20);
    expect(view.data).toBe(localDate(NOW));
    expect(view.timezone).toBe(TIMEZONE);
  });

  it('intercala tarefas pela ordem sem mudar o item derivado existente', () => {
    store.upsertProject({ id: 'p', name: 'Teste', path: dir, isGit: false });
    store.createJob({ title: 'Aprovar revisão', prompt: 'Revisar', agent: 'claude', projectId: 'p', risk: 'amarelo', status: 'approval', timeoutMin: 5 });
    const [derivado] = buildHoje(sched, NOW).itens;
    const depois = tarefas.criar({ ...NOVA, ordem: 1 });
    const antes = tarefas.criar({ ...NOVA, ordem: -1 });
    const view = buildHoje(sched, NOW);
    expect(view.itens.map((i) => i.id)).toEqual([antes.id, derivado.id, depois.id]);
    expect(view.itens[1]).toEqual(derivado);
    expect(view.totalMin).toBe(12);
  });
});
