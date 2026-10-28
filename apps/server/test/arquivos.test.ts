// Testes da aba Arquivos: só leitura, sem sair da raiz, sem segredos, com Range para tocar áudio.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Scheduler } from '../src/scheduler.ts';
import { Auth } from '../src/auth.ts';
import { buildApp } from '../src/app.ts';
import { Library, findFfmpeg, hiddenName, splitRel, type LegacyRef, type Root } from '../src/arquivos.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
function wav(seconds = 1): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(rate * seconds);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate, 28);
  h.writeUInt16LE(1, 32);
  h.writeUInt16LE(8, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

let dir: string;
let roots: Root[];
let lib: Library;
let outside: string;
let legacy: LegacyRef[];

const put = (p: string, data: string | Buffer = 'x') => {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, data);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'emannu-arq-'));
  const music = join(dir, 'Musicas');
  put(join(music, 'Bitter End.wav'), wav());
  put(join(music, 'The Abyss', 'WAV', 'Ashes in my veins.wav'), wav());
  put(join(music, 'Visual content', 'Capa #1 ção.png'), PNG);
  put(join(music, 'Visual content', 'teaser.mp4'), 'não é vídeo de verdade');
  put(join(music, 'node_modules', 'pkg', 'som.wav'), wav());
  put(join(music, '.git', 'config'), 'x');
  put(join(music, 'api-token.txt'), 'segredo');
  put(join(music, '.env'), 'SEGREDO=1');
  put(join(music, 'notas', 'Letras da música.md'), '# Letra\n\nAshes in my veins');
  // Projeto que contém a pasta var\ do EMANNU OS (com token e banco) e um projeto dentro dela.
  const os = join(dir, 'emannu-os');
  put(join(os, 'README.md'), '# OS');
  put(join(os, 'var', 'admin-token'), 'tok');
  put(join(os, 'var', 'emannu.db'), 'db');
  put(join(os, 'var', 'integracoes', 'slack.json'), '{}');
  put(join(os, 'var', 'conselho', 'relatorio.md'), '# Conselho');
  outside = join(dir, 'fora');
  put(join(outside, 'privado.md'), 'não deveria aparecer');
  // Junção que aponta para fora da raiz: não pode ser seguida.
  execFileSync('cmd', ['/c', 'mklink', '/J', join(music, 'atalho'), outside], { stdio: 'ignore' });
  put(join(dir, 'cockpit', 'antigo.png'), PNG);
  put(join(dir, 'cockpit', 'guia.md'), '# Guia');
  legacy = [
    { id: 'm-1', project: 'WHAT LIES BTWN', title: 'Antigo', path: join(dir, 'cockpit', 'antigo.png') },
    // Título sem extensão e projeto com barra no nome (Estação Raiz / Jogos).
    { id: 'd-9', project: 'estacao-raiz', projectName: 'Estação Raiz / Jogos', title: 'Guia do projeto', path: join(dir, 'cockpit', 'guia.md') },
    { id: 'm-2', project: 'WHAT LIES BTWN', title: 'Bitter End', path: join(music, 'Bitter End.wav') }, // já está em Músicas
    { id: 'm-3', project: 'OS', title: 'token', path: join(os, 'var', 'admin-token') },
  ];
  roots = [
    { id: 'musicas', nome: 'Músicas (WHAT LIES BTWN)', grupo: 'musica', path: music },
    { id: 'emannu-os', nome: 'EMANNU OS', grupo: 'projeto', path: os },
    { id: 'conselho', nome: 'Conselho', grupo: 'projeto', path: join(os, 'var', 'conselho') },
    { id: 'var', nome: 'var', grupo: 'projeto', path: join(os, 'var') },
    { id: 'sumiu', nome: 'Sumiu', grupo: 'projeto', path: join(dir, 'nao-existe') },
  ];
  lib = new Library({ roots: () => roots, varDir: join(os, 'var'), varAllow: ['conselho'], cacheDir: join(dir, 'cache'), ffmpeg: null, legacy: () => legacy });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const blocked = (r: string, p: string) => {
  try {
    lib.resolve(r, p);
    return false;
  } catch (e: any) {
    return e.statusCode === 404;
  }
};

describe('arquivos_read_only_confined', () => {
  it('não sai da raiz: "..", caminho absoluto, unidade e junção para fora são recusados', () => {
    for (const p of ['../fora/privado.md', '..\\fora\\privado.md', 'notas/../../fora/privado.md', join(outside, 'privado.md'), 'C:/Windows/win.ini', 'atalho/privado.md', 'x\0y']) {
      expect(blocked('musicas', p), p).toBe(true);
    }
    expect(() => splitRel('a/../b')).toThrow();
    expect(lib.resolve('musicas', 'notas/Letras da música.md').st.isFile()).toBe(true);
  });

  it('esconde pastas técnicas e arquivos de segredo, na lista e no acesso direto', async () => {
    const top = await lib.list('musicas', '');
    const names = top.itens.map((i) => i.nome);
    expect(names).toContain('Bitter End.wav');
    expect(names).toContain('The Abyss');
    for (const n of ['node_modules', '.git', 'api-token.txt', '.env', 'atalho']) expect(names).not.toContain(n);
    for (const p of ['node_modules/pkg/som.wav', '.git/config', 'api-token.txt', '.env']) expect(blocked('musicas', p), p).toBe(true);
    expect(hiddenName('Design.md', false)).toBe(false);
    expect(hiddenName('id_ed25519', false)).toBe(true);
    expect(hiddenName('chave.pem', false)).toBe(true);
  });

  it('a pasta var\\ do EMANNU OS fica fora, salvo as pastas de projeto dentro dela', async () => {
    expect(lib.roots().map((r) => r.id)).not.toContain('var');
    expect(lib.roots().map((r) => r.id)).not.toContain('sumiu');
    expect((await lib.list('emannu-os', '')).itens.map((i) => i.nome)).not.toContain('var');
    for (const p of ['var/admin-token', 'var/emannu.db', 'var/integracoes/slack.json', 'var/conselho/relatorio.md']) expect(blocked('emannu-os', p), p).toBe(true);
    expect(lib.resolve('conselho', 'relatorio.md').st.isFile()).toBe(true);
    expect(blocked('conselho', '../admin-token')).toBe(true);
  });

  it('o cockpit antigo entra só com o que não está em outra raiz, e nunca com segredo', async () => {
    const leg = lib.legacyList(null);
    expect(leg.itens.map((i) => [i.nome, i.p])).toEqual([['Estação Raiz / Jogos', 'estacao-raiz'], ['WHAT LIES BTWN', 'WHAT LIES BTWN']]);
    const guia = lib.legacyList('estacao-raiz').itens[0];
    expect(guia).toMatchObject({ nome: 'Guia do projeto', p: 'estacao-raiz/d-9', ext: 'md', tipo: 'doc' });
    expect(lib.resolve('legado', guia.p).abs.toLowerCase()).toContain('guia.md');
    const files = lib.legacyList('WHAT LIES BTWN').itens;
    expect(files.map((f) => f.nome)).toEqual(['Antigo']);
    expect(lib.resolve('legado', 'WHAT LIES BTWN/m-1').abs.toLowerCase()).toContain('antigo.png');
    expect(blocked('legado', 'OS/m-3')).toBe(true);
    expect(blocked('legado', 'WHAT LIES BTWN/m-2')).toBe(true);
    // Arquivo antigo apagado depois de listado: some da lista sem derrubar nada.
    rmSync(join(dir, 'cockpit', 'antigo.png'));
    expect(lib.legacyList('WHAT LIES BTWN').itens).toEqual([]);
    expect(blocked('legado', 'WHAT LIES BTWN/m-1')).toBe(true);
    await lib.index(true);
    expect(lib.status().pronto).toBe(true);
  });
});

describe('arquivos_roots_policy (revisão do Codex)', () => {
  it('pasta cadastrada como projeto não abre segredo: var/integracoes, .codex, pasta do usuário e unidade inteira ficam fora', async () => {
    const codex = join(dir, 'home-falso', '.codex');
    put(join(codex, 'auth.json'), '{"token":"x"}');
    put(join(dir, 'emannu-os', 'var', 'chat', 'anexo.md'), 'x');
    roots.push(
      { id: 'integracoes', nome: 'x', grupo: 'projeto', path: join(dir, 'emannu-os', 'var', 'integracoes') },
      { id: 'chat', nome: 'x', grupo: 'projeto', path: join(dir, 'emannu-os', 'var', 'chat') },
      { id: 'codex', nome: 'x', grupo: 'projeto', path: codex },
      { id: 'home', nome: 'x', grupo: 'projeto', path: (await import('node:os')).homedir() },
      { id: 'drive', nome: 'x', grupo: 'projeto', path: 'C:/' },
    );
    const chrome = join(dir, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default');
    put(join(chrome, 'History'), 'x');
    roots.push({ id: 'chrome', nome: 'x', grupo: 'projeto', path: chrome });
    const fresh = new Library({ roots: () => roots, varDir: join(dir, 'emannu-os', 'var'), varAllow: ['conselho'], cacheDir: join(dir, 'cache') });
    const ids = fresh.roots().map((r) => r.id);
    for (const id of ['integracoes', 'chat', 'codex', 'home', 'drive', 'chrome']) expect(ids, id).not.toContain(id);
    expect(ids).toContain('conselho');
    expect(hiddenName('auth.json', false)).toBe(true);
    expect(hiddenName('hosts.yml', false)).toBe(true);
    expect(hiddenName('AppData', true)).toBe(true);
  });

  it('o índice respeita o teto de arquivos e o tempo mesmo dentro de uma pasta grande, e avisa que ficou incompleto', async () => {
    const big = join(dir, 'grande');
    mkdirSync(big);
    for (let i = 0; i < 300; i++) writeFileSync(join(big, `f${i}.png`), 'x');
    const small = new Library({ roots: () => [{ id: 'g', nome: 'g', grupo: 'projeto', path: big }], varDir: join(dir, 'emannu-os', 'var'), cacheDir: join(dir, 'cache'), maxFiles: 5 });
    await small.index();
    expect(small.status()).toMatchObject({ arquivos: 5, incompleto: true });
    const fast = new Library({ roots: () => [{ id: 'g', nome: 'g', grupo: 'projeto', path: big }], varDir: join(dir, 'emannu-os', 'var'), cacheDir: join(dir, 'cache'), walkBudgetMs: 0 });
    await fast.index();
    expect(fast.status().incompleto).toBe(true);
    expect(fast.status().arquivos).toBeLessThan(300);
    // O tempo também vale para a lista do cockpit antigo.
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `x${i}`, project: 'p', title: 't', path: join(dir, 'cockpit', 'antigo.png') }));
    const leg = new Library({ roots: () => [], varDir: join(dir, 'emannu-os', 'var'), cacheDir: join(dir, 'cache'), legacy: () => many, walkBudgetMs: -1 });
    leg.roots();
    await leg.index();
    expect(leg.status()).toMatchObject({ arquivos: 0, incompleto: true });
  });
});

describe('arquivos_index', () => {
  it('agrupa músicas e fotos por pasta, busca sem acento e não indexa o que é escondido', async () => {
    const files = await lib.index();
    expect(files.some((f) => f.p.includes('node_modules') || f.p.includes('atalho') || f.p.startsWith('var/'))).toBe(false);
    const audio = await lib.groups('audio');
    expect(audio.map((g) => g.caminho)).toEqual(['Músicas (WHAT LIES BTWN)', 'Músicas (WHAT LIES BTWN) / The Abyss / WAV']);
    const fotos = await lib.groups('image');
    expect(fotos.find((g) => g.r === 'musicas')!.capa).toBe('Visual content/Capa #1 ção.png');
    expect(fotos.some((g) => g.r === 'legado')).toBe(true);
    const r = await lib.items({ tipo: 'doc', busca: 'letras musica' });
    expect(r.itens.map((f) => f.nome)).toEqual(['Letras da música.md']);
    const disco = await lib.items({ tipo: 'audio', r: 'musicas', dir: 'The Abyss/WAV' });
    expect(disco.itens.map((f) => f.nome)).toEqual(['Ashes in my veins.wav']);
    expect(lib.status()).toMatchObject({ pronto: true, porTipo: { audio: 2 } });
  });

  it('localiza um caminho do PC dentro de uma raiz (e recusa o que está fora)', () => {
    expect(lib.locate(join(dir, 'Musicas', 'The Abyss', 'WAV', 'Ashes in my veins.wav'))).toEqual({ r: 'musicas', p: 'The Abyss/WAV/Ashes in my veins.wav', bytes: wav().length });
    expect(lib.locate(join(outside, 'privado.md'))).toBeNull();
    expect(lib.locate(join(dir, 'emannu-os', 'var', 'admin-token'))).toBeNull();
  });
});

describe('arquivos_http', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;
  beforeEach(async () => {
    const store = new Store(':memory:');
    const sched = new Scheduler({ store, logDir: join(dir, 'logs'), worktreesDir: join(dir, 'wt') });
    const auth = new Auth(store, join(dir, 'admin-token'));
    token = auth.adminToken;
    app = await buildApp({ sched, auth, push: null, library: lib });
  });
  afterEach(() => app.close());
  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ url, headers: { 'x-emannu-token': token, ...headers } });
  const f = (r: string, p: string) => `/api/arquivos/f/${r}/${p.split('/').map(encodeURIComponent).join('/')}`;

  it('exige aparelho registrado', async () => {
    expect((await app.inject({ url: f('musicas', 'Bitter End.wav') })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/arquivos' })).statusCode).toBe(401);
  });

  it('toca áudio por pedaços (Range) e baixa com o nome certo', async () => {
    const full = await get(f('musicas', 'Bitter End.wav'));
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('audio/wav');
    expect(full.headers['content-security-policy']).toBe('sandbox');
    const part = await get(f('musicas', 'Bitter End.wav'), { range: 'bytes=0-99' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-99/${wav().length}`);
    expect(part.rawPayload.length).toBe(100);
    const dl = await get(`${f('musicas', 'Visual content/Capa #1 ção.png')}?baixar=1`);
    expect(dl.statusCode).toBe(200);
    expect(String(dl.headers['content-disposition'])).toMatch(/^attachment; .*filename\*=UTF-8''Capa%20%231%20%C3%A7%C3%A3o\.png/);
  });

  it('recusa caminhos para fora e segredos também pela URL', async () => {
    for (const url of [
      '/api/arquivos/f/musicas/..%2Ffora%2Fprivado.md',
      '/api/arquivos/f/musicas/%2E%2E/fora/privado.md',
      '/api/arquivos/f/musicas/atalho/privado.md',
      '/api/arquivos/f/musicas/api-token.txt',
      '/api/arquivos/f/emannu-os/var/admin-token',
      '/api/arquivos/f/nada/x.md',
      '/api/arquivos/f/musicas/The%20Abyss',
    ]) {
      expect((await get(url)).statusCode, url).toBe(404);
    }
    const md = await get(f('conselho', 'relatorio.md'));
    expect(md.statusCode).toBe(200);
    expect(md.body).toBe('# Conselho');
  });

  it('lista pastas, grupos e itens pela API', async () => {
    const info = (await get('/api/arquivos')).json();
    expect(info.raizes.map((r: any) => r.id)).toEqual(['musicas', 'emannu-os', 'conselho', 'legado']);
    expect((await get(f('legado', 'estacao-raiz/d-9'))).body).toBe('# Guia');
    const pasta = (await get('/api/arquivos/pasta?r=musicas&p=The%20Abyss')).json();
    expect(pasta.itens).toEqual([{ nome: 'WAV', p: 'The Abyss/WAV', tipo: 'pasta' }]);
    expect((await get('/api/arquivos/pasta?r=musicas&p=..')).statusCode).toBe(404);
    expect((await get('/api/arquivos/grupos?tipo=audio')).json()).toHaveLength(2);
    expect((await get('/api/arquivos/grupos?tipo=exe')).statusCode).toBe(400);
    const itens = (await get('/api/arquivos/itens?tipo=audio&q=ashes')).json();
    expect(itens.itens.map((i: any) => i.p)).toEqual(['The Abyss/WAV/Ashes in my veins.wav']);
    const leg = (await get('/api/arquivos/pasta?r=legado&p=WHAT%20LIES%20BTWN')).json();
    expect(leg.itens[0].p).toBe('WHAT LIES BTWN/m-1');
    expect((await get(f('legado', 'WHAT LIES BTWN/m-1'))).headers['content-type']).toBe('image/png');
  });

  it('miniatura: sem ffmpeg devolve a própria foto; vídeo sem ffmpeg não tem miniatura', async () => {
    const mini = await get(`/api/arquivos/mini/musicas/${encodeURIComponent('Visual content')}/${encodeURIComponent('Capa #1 ção.png')}?w=360`);
    expect(mini.statusCode).toBe(200);
    expect(mini.headers['content-type']).toBe('image/png');
    expect((await get('/api/arquivos/mini/musicas/Visual%20content/teaser.mp4')).statusCode).toBe(404);
  });
});

describe.skipIf(!findFfmpeg())('arquivos_thumbnails (ffmpeg)', () => {
  it('gera a miniatura em JPEG no cache e reaproveita', async () => {
    const withFf = new Library({ roots: () => roots, varDir: join(dir, 'emannu-os', 'var'), varAllow: ['conselho'], cacheDir: join(dir, 'cache'), ffmpeg: findFfmpeg() });
    const t = await withFf.thumb('musicas', 'Visual content/Capa #1 ção.png', 360);
    expect(t?.type).toBe('image/jpeg');
    expect(existsSync(t!.path)).toBe(true);
    expect(t!.path.startsWith(join(dir, 'cache'))).toBe(true);
    expect((await withFf.thumb('musicas', 'Visual content/Capa #1 ção.png', 360))?.path).toBe(t!.path);
    // Vídeo inválido: sem miniatura (e não tenta de novo).
    expect(await withFf.thumb('musicas', 'Visual content/teaser.mp4', 360)).toBeNull();
  });
});
