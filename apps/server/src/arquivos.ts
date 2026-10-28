// Aba Arquivos: músicas, fotos, vídeos e documentos direto das pastas do PC.
// Só leitura: nada é copiado, movido ou apagado; as miniaturas ficam em var/cache.
// Cada arquivo é pedido por "raiz + caminho relativo". O servidor confere que o caminho real
// (depois de resolver atalhos e junções) continua dentro da raiz, e esconde pastas técnicas,
// arquivos de segredo (tokens, senhas, chaves) e os dados internos do EMANNU OS em var\.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync, type Stats } from 'node:fs';
import { opendir, stat } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { basename, extname, isAbsolute, join, parse, relative, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { TEXT_EXT, kindOf, type DirEntry, type FileGroup, type FileKind, type IndexStatus, type LibFile, type RootView } from '../../../packages/shared/arquivos.ts';

export { kindOf };

export interface Root extends RootView {
  path: string;
}

// Arquivos do cockpit antigo (lista fechada dos manifestos).
export interface LegacyRef {
  id: string;
  project: string; // id estável do projeto (vai no caminho)
  projectName?: string; // nome mostrado
  title: string;
  path: string;
}

export const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.avif': 'image/avif', '.heic': 'image/heic', '.svg': 'image/svg+xml',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.pdf': 'application/pdf', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel',
};
export const mimeOf = (name: string): string => {
  const ext = extname(name).toLowerCase();
  return MIME[ext] ?? (TEXT_EXT.has(ext.slice(1)) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
};

// Pastas técnicas (pesadas e sem interesse) e de perfis de navegador.
const DENY_DIRS = new Set(['appdata', 'node_modules', '__pycache__', 'browser-profile', '$recycle.bin', 'system volume information', 'venv', 'site-packages', 'cache', 'code cache', 'gpucache', 'cache_data']);
// Nomes que costumam guardar segredo: nunca aparecem nem são servidos.
const SECRET = /(^\.env)|(\.(pem|key|p12|pfx|kdbx|keystore|jks|ppk)$)|(^id_(rsa|dsa|ecdsa|ed25519))|((^|[-_. ])(tokens?|secrets?|credentials?|passwords?|senhas?|cookies|login data|vapid|auth)([-_. ]|$))|(^hosts\.ya?ml$)/i;

export function hiddenName(name: string, isDir: boolean): boolean {
  if (!name || name.startsWith('.') || name.startsWith('~$')) return true;
  if (isDir && DENY_DIRS.has(name.toLowerCase())) return true;
  return SECRET.test(name);
}

// "filho" está dentro de "pai" (no Windows, sem diferenciar maiúsculas).
export function inside(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r));
}

// stat que não derruba a lista quando um arquivo sumiu no meio do caminho.
const statOrNull = (p: string): Stats | null => {
  try {
    return statSync(p);
  } catch {
    return null;
  }
};

const real = (p: string): string | null => {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
};

export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}
const notFound = () => new HttpError(404, 'Arquivo não encontrado');

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// Corta um caminho relativo vindo do aparelho em partes seguras (sem "..", unidade ou caminho absoluto).
export function splitRel(rel: string): string[] {
  const s = String(rel ?? '');
  if (s.includes('\0')) throw notFound();
  const parts = s.split(/[\\/]+/).filter(Boolean);
  for (const part of parts) if (part === '.' || part === '..' || part.includes(':')) throw notFound();
  return parts;
}

function limiter(max: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (running >= max) await new Promise<void>((r) => waiting.push(r));
    running++;
    try {
      return await fn();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

// ffmpeg (para miniaturas): variável EMANNU_FFMPEG, PATH ou a instalação do winget.
export function findFfmpeg(): string | null {
  if (process.env.EMANNU_FFMPEG) return existsSync(process.env.EMANNU_FFMPEG) ? process.env.EMANNU_FFMPEG : null;
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8', windowsHide: true });
  const first = which.status === 0 ? which.stdout.split(/\r?\n/).find(Boolean) : null;
  if (first && existsSync(first)) return first;
  const pk = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const d of readdirSync(pk).filter((n) => /ffmpeg/i.test(n))) {
      for (const v of readdirSync(join(pk, d))) {
        const exe = join(pk, d, v, 'bin', 'ffmpeg.exe');
        if (existsSync(exe)) return exe;
      }
    }
  } catch {}
  return null;
}

const MAX_FILES = 200_000;
const MAX_DEPTH = 14;

export interface LibraryOptions {
  roots: () => Root[];
  varDir: string;
  cacheDir: string;
  ffmpeg?: string | null;
  legacy?: () => LegacyRef[];
  // Subpastas de var\ que podem virar raiz (pastas de trabalho dos projetos internos). O resto de var\ nunca.
  varAllow?: string[];
  ttlMs?: number;
  maxFiles?: number;
  walkBudgetMs?: number;
}

interface Resolved {
  root: Root;
  abs: string;
  st: Stats;
  rel: string;
}

export class Library {
  private opts: LibraryOptions;
  private files: LibFile[] = [];
  private builtAt = 0;
  private incompleto = false;
  private building: Promise<void> | null = null;
  private thumbs = limiter(3);
  private failed = new Set<string>();
  private varReal: string;
  private varAllowed: string[];
  private home: string | null;
  private tmp: string | null;

  constructor(opts: LibraryOptions) {
    this.opts = opts;
    this.varReal = real(opts.varDir) ?? opts.varDir;
    this.varAllowed = (opts.varAllow ?? []).map((n) => join(this.varReal, n));
    this.home = real(homedir());
    this.tmp = real(tmpdir());
  }

  // Raízes que existem no disco (sem repetir a mesma pasta) + o cockpit antigo, se sobrou algo dele.
  roots(): Root[] {
    return this.snapshot().roots;
  }

  // As raízes e a lista do cockpit antigo mudam pouco: refeitas no máximo a cada 30 s.
  private snap: { at: number; roots: Root[]; legacy: (LegacyRef & { real: string })[] } | null = null;
  private snapshot() {
    if (this.snap && Date.now() - this.snap.at < 30_000) return this.snap;
    const roots = this.computeRoots();
    const legacy = this.legacyFiles(roots);
    if (legacy.length) roots.push({ id: 'legado', nome: 'Cockpit antigo', grupo: 'legado', path: '' });
    return (this.snap = { at: Date.now(), roots, legacy });
  }

  private computeRoots(): Root[] {
    const seen: string[] = [];
    const out: Root[] = [];
    for (const r of this.opts.roots()) {
      const rp = real(r.path);
      if (!rp || !statSync(rp).isDirectory() || seen.some((s) => s.toLowerCase() === rp.toLowerCase())) continue;
      if (!this.safeRoot(rp)) continue;
      seen.push(rp);
      out.push({ ...r, path: rp });
    }
    return out;
  }

  // Arquivos do cockpit antigo que não estão dentro de nenhuma outra raiz (para não aparecer duas vezes).
  private legacyFiles(roots: Root[]): (LegacyRef & { real: string })[] {
    const list = this.opts.legacy?.() ?? [];
    const out: (LegacyRef & { real: string })[] = [];
    for (const f of list) {
      const rp = real(f.path);
      if (!rp || hiddenName(basename(rp), false) || this.denied(rp, null)) continue;
      if (roots.some((r) => r.grupo !== 'legado' && inside(rp, r.path))) continue;
      try {
        if (!statSync(rp).isFile()) continue;
      } catch {
        continue;
      }
      // O id do projeto vira uma parte do caminho: sem barras.
      out.push({ ...f, project: f.project.replace(/[\\/]+/g, '-'), real: rp });
    }
    return out;
  }

  private root(id: string): Root {
    const r = this.roots().find((x) => x.id === id);
    if (!r) throw new HttpError(404, 'Pasta não encontrada');
    return r;
  }

  // Qualquer aparelho pode cadastrar um projeto com qualquer pasta: por isso a raiz também é conferida.
  // Não vale: unidade inteira, a pasta do usuário (ou acima dela), caminho que passa por pasta
  // escondida ou de segredo (.codex, .ssh, secrets…) e, dentro de var\, o que não estiver liberado.
  private safeRoot(rp: string): boolean {
    if (parse(rp).root.toLowerCase() === (rp.endsWith(sep) ? rp : rp + sep).toLowerCase()) return false;
    if (this.home && inside(this.home, rp)) return false;
    // Todas as pastas do caminho passam pela mesma regra de dentro da raiz (AppData, .codex, secrets…).
    // Exceção: a pasta temporária do Windows (fica em AppData), usada pelos testes; só o que está abaixo dela conta.
    const base = this.tmp && rp.toLowerCase() !== this.tmp.toLowerCase() && inside(rp, this.tmp) ? this.tmp : parse(rp).root;
    if (relative(base, rp).split(sep).filter(Boolean).some((s) => hiddenName(s, true))) return false;
    if (inside(rp, this.varReal)) return this.varAllowed.some((a) => inside(rp, a));
    return true;
  }

  // Dados internos do EMANNU OS (banco, tokens, integrações) ficam fora, salvo as pastas liberadas em var\.
  private denied(realPath: string, root: Root | null): boolean {
    if (!inside(realPath, this.varReal)) return false;
    if (!root || root.grupo === 'legado' || !inside(root.path, this.varReal)) return true;
    return !this.varAllowed.some((a) => inside(realPath, a));
  }

  resolve(rootId: string, rel: string): Resolved {
    const root = this.root(rootId);
    const parts = splitRel(rel);
    if (root.grupo === 'legado') {
      const f = parts.length === 2 ? this.snapshot().legacy.find((x) => x.project === parts[0] && x.id === parts[1]) : null;
      if (!f) throw notFound();
      const st = statOrNull(f.real);
      if (!st) throw notFound();
      return { root, abs: f.real, st, rel: parts.join('/') };
    }
    parts.forEach((part, i) => {
      if (hiddenName(part, i < parts.length - 1)) throw notFound();
    });
    const abs = real(join(root.path, ...parts));
    if (!abs || !inside(abs, root.path) || this.denied(abs, root)) throw notFound();
    // O caminho real também não pode passar por pasta escondida (atalho para dentro de .git etc.).
    const realParts = relative(root.path, abs).split(sep).filter(Boolean);
    const st = statSync(abs);
    realParts.forEach((part, i) => {
      if (hiddenName(part, i < realParts.length - 1 || st.isDirectory())) throw notFound();
    });
    if (!parts.length || st.isDirectory() || st.isFile()) return { root, abs, st, rel: parts.join('/') };
    throw notFound();
  }

  // Conteúdo de uma pasta: subpastas primeiro, depois arquivos, por nome.
  async list(rootId: string, rel: string): Promise<{ raiz: RootView; p: string; itens: DirEntry[] }> {
    const { root, abs, st, rel: p } = this.resolve(rootId, rel);
    const raiz = { id: root.id, nome: root.nome, grupo: root.grupo };
    if (root.grupo === 'legado') throw notFound();
    if (!st.isDirectory()) throw new HttpError(400, 'Não é uma pasta');
    const itens: DirEntry[] = [];
    const dir = await opendir(abs);
    for await (const d of dir) {
      if (d.isSymbolicLink() || hiddenName(d.name, d.isDirectory())) continue;
      const child = p ? `${p}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!this.denied(join(abs, d.name), root)) itens.push({ nome: d.name, p: child, tipo: 'pasta' });
      } else if (d.isFile()) {
        try {
          const s = await stat(join(abs, d.name));
          itens.push({ nome: d.name, p: child, tipo: kindOf(d.name), ext: extname(d.name).slice(1).toLowerCase(), bytes: s.size, mtime: s.mtime.toISOString() });
        } catch {}
      }
      if (itens.length >= 5000) break;
    }
    const coll = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
    itens.sort((a, b) => (a.tipo === 'pasta') !== (b.tipo === 'pasta') ? (a.tipo === 'pasta' ? -1 : 1) : coll.compare(a.nome, b.nome));
    return { raiz, p, itens };
  }

  // Lista do cockpit antigo, agrupada por projeto.
  legacyList(project: string | null): { raiz: RootView; p: string; itens: DirEntry[] } {
    const raiz = { id: 'legado', nome: 'Cockpit antigo', grupo: 'legado' as const };
    const files = this.snapshot().legacy;
    if (!project) {
      const names = new Map(files.map((f) => [f.project, f.projectName ?? f.project]));
      return { raiz, p: '', itens: [...names].sort((a, b) => a[1].localeCompare(b[1])).map(([id, nome]) => ({ nome, p: id, tipo: 'pasta' })) };
    }
    const itens: DirEntry[] = [];
    for (const f of files.filter((x) => x.project === project)) {
      const s = statOrNull(f.real);
      if (s) itens.push({ nome: f.title || basename(f.real), p: `${f.project}/${f.id}`, tipo: kindOf(f.real), ext: extname(f.real).slice(1).toLowerCase(), bytes: s.size, mtime: s.mtime.toISOString() });
    }
    return { raiz, p: project, itens };
  }

  // ---------- índice (para Músicas, Fotos, Vídeos e Documentos) ----------
  status(): IndexStatus {
    const porTipo: IndexStatus['porTipo'] = {};
    for (const f of this.files) porTipo[f.tipo] = (porTipo[f.tipo] ?? 0) + 1;
    return { pronto: this.builtAt > 0, atualizando: !!this.building, arquivos: this.files.length, porTipo, atualizadoEm: this.builtAt ? new Date(this.builtAt).toISOString() : null, incompleto: this.incompleto };
  }

  // Devolve o índice; se estiver velho, atualiza em segundo plano (a primeira vez espera).
  async index(force = false): Promise<LibFile[]> {
    const stale = Date.now() - this.builtAt > (this.opts.ttlMs ?? 10 * 60_000);
    if ((force || stale) && !this.building) {
      this.building = this.build().finally(() => (this.building = null));
    }
    if (!this.builtAt && this.building) await this.building;
    else if (force && this.building) await this.building;
    return this.files;
  }

  private async build(): Promise<void> {
    const max = this.opts.maxFiles ?? MAX_FILES;
    const deadline = Date.now() + (this.opts.walkBudgetMs ?? 120_000);
    const out: LibFile[] = [];
    let cut = false;
    const roots = this.roots();
    walk: for (const root of roots) {
      if (root.grupo === 'legado') {
        for (const f of this.snapshot().legacy) {
          const tipo = kindOf(f.real);
          if (tipo === 'outro') continue;
          if (out.length >= max || Date.now() > deadline) {
            cut = true;
            break walk;
          }
          const s = statOrNull(f.real);
          if (!s) continue;
          out.push({ r: 'legado', p: `${f.project}/${f.id}`, nome: f.title || basename(f.real), tipo, ext: extname(f.real).slice(1).toLowerCase(), bytes: s.size, mtime: s.mtime.toISOString() });
        }
        continue;
      }
      const stack: { abs: string; rel: string; depth: number }[] = [{ abs: root.path, rel: '', depth: 0 }];
      while (stack.length) {
        if (out.length >= max || Date.now() > deadline) {
          cut = true;
          break walk;
        }
        const cur = stack.pop()!;
        let dir;
        try {
          dir = await opendir(cur.abs);
        } catch {
          continue;
        }
        const batch: Promise<void>[] = [];
        let stop = false;
        for await (const d of dir) {
          // Os limites valem dentro da pasta também (uma pasta com milhares de arquivos não passa do teto).
          if (out.length + batch.length >= max || Date.now() > deadline) {
            stop = true;
            break;
          }
          if (d.isSymbolicLink() || hiddenName(d.name, d.isDirectory())) continue;
          const abs = join(cur.abs, d.name);
          const rel = cur.rel ? `${cur.rel}/${d.name}` : d.name;
          if (d.isDirectory()) {
            if (cur.depth < MAX_DEPTH && !this.denied(abs, root)) stack.push({ abs, rel, depth: cur.depth + 1 });
            continue;
          }
          const tipo = kindOf(d.name);
          if (!d.isFile() || tipo === 'outro') continue;
          batch.push(
            stat(abs).then(
              (s) => {
                out.push({ r: root.id, p: rel, nome: d.name, tipo, ext: extname(d.name).slice(1).toLowerCase(), bytes: s.size, mtime: s.mtime.toISOString() });
              },
              () => {},
            ),
          );
          if (batch.length >= 64) await Promise.all(batch.splice(0));
        }
        await Promise.all(batch);
        if (stop) {
          cut = true;
          break walk;
        }
      }
    }
    this.files = out.slice(0, max);
    this.incompleto = cut;
    this.builtAt = Date.now();
  }

  private dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

  private rootOrder(): Map<string, number> {
    const order: Record<RootView['grupo'], number> = { musica: 0, projeto: 1, documentos: 2, vault: 3, legado: 4 };
    return new Map(this.roots().map((r, i) => [r.id, order[r.grupo] * 1000 + i]));
  }

  // Pastas que têm arquivos de um tipo (álbuns de fotos, discos, pastas de documentos).
  async groups(tipo: FileKind, rootId?: string): Promise<FileGroup[]> {
    const files = await this.index();
    const roots = new Map(this.roots().map((r) => [r.id, r]));
    const m = new Map<string, FileGroup>();
    for (const f of files) {
      if (f.tipo !== tipo || (rootId && f.r !== rootId) || !roots.has(f.r)) continue;
      const dir = this.dirOf(f.p);
      const key = `${f.r}\0${dir}`;
      let g = m.get(key);
      if (!g) {
        const root = roots.get(f.r)!;
        const shown = f.r === 'legado' ? (this.snapshot().legacy.find((x) => x.project === dir)?.projectName ?? dir) : dir.split('/').join(' / ');
        m.set(key, (g = { r: f.r, dir, nome: f.r === 'legado' ? shown : dir ? basename(dir) : root.nome, caminho: shown ? `${root.nome} / ${shown}` : root.nome, total: 0, capa: null, mtime: f.mtime }));
      }
      g.total++;
      if (!g.capa || f.nome.localeCompare(basename(g.capa)) < 0) g.capa = f.p;
      if (f.mtime > g.mtime) g.mtime = f.mtime;
    }
    const order = this.rootOrder();
    // Pastas mais rasas primeiro (as músicas finais costumam estar no topo; saídas de trabalho, no fundo).
    const depth = (g: FileGroup) => (g.dir ? g.dir.split('/').length : 0);
    return [...m.values()].sort((a, b) => (order.get(a.r) ?? 0) - (order.get(b.r) ?? 0) || depth(a) - depth(b) || b.mtime.localeCompare(a.mtime));
  }

  // Arquivos de um tipo: de uma pasta (em ordem de nome) ou de uma busca (mais recentes primeiro).
  async items(q: { tipo?: FileKind; r?: string; dir?: string; busca?: string; limite?: number }): Promise<{ itens: LibFile[]; total: number }> {
    const files = await this.index();
    const roots = new Set(this.roots().map((r) => r.id));
    const words = norm(q.busca ?? '').split(/\s+/).filter(Boolean);
    let list = files.filter(
      (f) =>
        roots.has(f.r) &&
        (!q.tipo || f.tipo === q.tipo) &&
        (!q.r || f.r === q.r) &&
        (q.dir === undefined || this.dirOf(f.p) === q.dir) &&
        (!words.length || words.every((w) => norm(f.p).includes(w) || norm(f.nome).includes(w))),
    );
    const coll = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
    if (q.dir !== undefined) list = list.sort((a, b) => coll.compare(a.nome, b.nome));
    else list = list.sort((a, b) => b.mtime.localeCompare(a.mtime));
    const limite = Math.min(Math.max(Number(q.limite) || 500, 1), 5000);
    return { itens: list.slice(0, limite), total: list.length };
  }

  // Um caminho do PC (ex.: o de uma tarefa da aba Hoje) dentro de alguma raiz.
  locate(path: string): { r: string; p: string; bytes: number } | null {
    const rp = real(path);
    if (!rp) return null;
    for (const root of this.roots()) {
      if (root.grupo === 'legado' || !inside(rp, root.path)) continue;
      const p = relative(root.path, rp).split(sep).join('/');
      try {
        const f = this.resolve(root.id, p);
        return f.st.isFile() ? { r: root.id, p, bytes: f.st.size } : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  // Miniatura (360 px) ou prévia (1280 px) de uma foto ou vídeo, feita pelo ffmpeg e guardada em cache.
  async thumb(rootId: string, rel: string, width: number): Promise<{ path: string; type: string } | null> {
    const { abs, st } = this.resolve(rootId, rel);
    if (!st.isFile()) throw notFound();
    const tipo = kindOf(abs);
    const w = width >= 1000 ? 1280 : 360;
    const original = tipo === 'image' ? { path: abs, type: mimeOf(abs) } : null;
    if (tipo !== 'image' && tipo !== 'video') throw notFound();
    if (!this.opts.ffmpeg || extname(abs).toLowerCase() === '.svg') return original;
    const key = createHash('sha1').update(`${abs}|${st.size}|${st.mtimeMs}|${w}`).digest('hex');
    const out = join(this.opts.cacheDir, key.slice(0, 2), `${key}.jpg`);
    if (existsSync(out)) return { path: out, type: 'image/jpeg' };
    if (this.failed.has(key)) return original;
    mkdirSync(join(this.opts.cacheDir, key.slice(0, 2)), { recursive: true });
    const ok = await this.thumbs(async () => {
      if (existsSync(out)) return true;
      const tmp = `${out}.${process.pid}.tmp.jpg`;
      const scale = `scale='min(${w},iw)':-2`;
      const attempts = tipo === 'video' ? [['-ss', '1'], []] : [[]];
      for (const pre of attempts) {
        if (await run(this.opts.ffmpeg!, ['-v', 'error', '-y', ...pre, '-i', abs, '-frames:v', '1', '-vf', scale, '-q:v', '5', tmp])) {
          try {
            renameSync(tmp, out);
          } catch {}
          return existsSync(out);
        }
      }
      return false;
    });
    if (ok) return { path: out, type: 'image/jpeg' };
    this.failed.add(key);
    return original;
  }
}

function run(exe: string, args: string[], timeoutMs = 30_000): Promise<boolean> {
  return new Promise((resolveP) => {
    const p = spawn(exe, args, { windowsHide: true, stdio: 'ignore' });
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.on('error', () => {
      clearTimeout(t);
      resolveP(false);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolveP(code === 0);
    });
  });
}

// Envia um arquivo do disco com suporte a pedaços (Range), para áudio e vídeo tocarem e avançarem.
// Sempre em "sandbox": um HTML ou SVG aberto aqui não roda scripts dentro do app.
export function sendFile(req: FastifyRequest, reply: FastifyReply, abs: string, opts: { type?: string; download?: boolean; name?: string; maxAge?: number } = {}) {
  const size = statSync(abs).size;
  const name = opts.name ?? basename(abs);
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  reply
    .header('Content-Type', opts.type ?? mimeOf(abs))
    .header('Content-Security-Policy', 'sandbox')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', `private, max-age=${opts.maxAge ?? 3600}`)
    .header('Accept-Ranges', 'bytes')
    .header('Content-Disposition', `${opts.download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', end - start + 1);
    return reply.send(createReadStream(abs, { start, end }));
  }
  reply.header('Content-Length', size);
  return reply.send(createReadStream(abs));
}
