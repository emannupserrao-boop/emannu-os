// Adaptador do vault Obsidian. Regras:
// - nunca reescreve uma nota existente: só cria notas novas ou acrescenta blocos datados no fim;
// - nunca sobrescreve um arquivo: se o nome existir, cria "Nome (2).md".
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

export const JOBS_FOLDER = join('80 - AUTOMATION', 'Jobs');
export const INBOX_FOLDER = '90 - INBOX';
export const PROJECTS_FOLDER = '20 - PROJECTS';

const safeName = (s: string) => s.replace(/[<>:"/\\|?*\u0000-\u001f#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
const today = () => new Date().toISOString().slice(0, 10);
const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

export function stripFrontmatter(md: string): { data: Record<string, string>; body: string } {
  const m = md.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: md };
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) data[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { data, body: md.slice(m[0].length) };
}

function yamlValue(v: string | number | null): string {
  if (v === null) return '';
  const s = String(v);
  return /[:#\[\]{}",]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

export class Vault {
  root: string;

  constructor(root: string) {
    this.root = root;
  }

  get name(): string {
    return basename(this.root);
  }

  exists(): boolean {
    return existsSync(this.root);
  }

  rel(abs: string): string {
    return relative(this.root, abs).split('\\').join('/');
  }

  // Pasta do projeto em 20 - PROJECTS cujo nome bate com o do projeto.
  findProjectFolder(projectName: string): string | null {
    const dir = join(this.root, PROJECTS_FOLDER);
    if (!existsSync(dir)) return null;
    const target = normalize(projectName);
    const hit = readdirSync(dir, { withFileTypes: true }).find((d) => d.isDirectory() && normalize(d.name) === target);
    return hit ? join(PROJECTS_FOLDER, hit.name) : null;
  }

  // Nota "<algo> - Current State.md" dentro da pasta do projeto (busca até 2 níveis).
  findCurrentState(vaultFolder: string): string | null {
    const base = join(this.root, vaultFolder);
    const walk = (dir: string, depth: number): string | null => {
      if (!existsSync(dir)) return null;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isFile() && /current state\.md$/i.test(e.name)) return p;
        if (e.isDirectory() && depth > 0 && !e.name.startsWith('.')) {
          const r = walk(p, depth - 1);
          if (r) return r;
        }
      }
      return null;
    };
    return walk(base, 2);
  }

  read(absPath: string): string {
    return readFileSync(absPath, 'utf8');
  }

  // Cria uma nota nova (nunca sobrescreve). Retorna o caminho relativo ao vault.
  createNote(folder: string, title: string, frontmatter: Record<string, string | number | null>, body: string): string {
    const dir = join(this.root, folder);
    mkdirSync(dir, { recursive: true });
    const base = safeName(title);
    let file = join(dir, `${base}.md`);
    for (let i = 2; existsSync(file); i++) file = join(dir, `${base} (${i}).md`);
    const fm = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${yamlValue(v)}`)
      .join('\n');
    writeFileSync(file, `---\n${fm}\n---\n${body.trimEnd()}\n`, { flag: 'wx' });
    return this.rel(file);
  }

  noteTitle(project: string, title: string): string {
    return `${today()} - ${project} - ${title}`;
  }

  writeJobNote(project: string, title: string, frontmatter: Record<string, string | number | null>, body: string): string {
    return this.createNote(JOBS_FOLDER, this.noteTitle(project, title), frontmatter, body);
  }

  // Acrescenta um bloco datado no fim da nota Current State do projeto.
  // Se a nota não existir, cria uma nova com o bloco.
  appendCurrentState(vaultFolder: string, projectName: string, heading: string, body: string): string {
    const block = `\n\n## ${today()} — ${heading}\n\n_Bloco acrescentado automaticamente pelo EMANNU OS._\n\n${body.trim()}\n`;
    const existing = this.findCurrentState(vaultFolder);
    if (existing) {
      appendFileSync(existing, block, 'utf8');
      return this.rel(existing);
    }
    return this.createNote(vaultFolder, `${projectName} - Current State`, { type: 'current-state', project: projectName, updated: today() }, `# ${projectName} — Current State${block}`);
  }

  // Nota gerada pelo sistema que se atualiza: só o trecho entre os marcadores é
  // trocado; o que você escrever antes ou depois deles fica intocado. Se existir
  // uma nota com esse nome sem os marcadores (escrita por você), ela não é tocada
  // e a versão gerada vai para "<nome> (gerado).md".
  upsertGeneratedNote(folder: string, name: string, frontmatter: Record<string, string | number | null>, content: string): string {
    const START = '<!-- emannu-os:inicio — este trecho é atualizado automaticamente; escreva fora dele -->';
    const END = '<!-- emannu-os:fim -->';
    const dir = join(this.root, folder);
    mkdirSync(dir, { recursive: true });
    const block = `${START}\n${content.trim()}\n${END}`;
    for (const file of [join(dir, `${safeName(name)}.md`), join(dir, `${safeName(name)} (gerado).md`)]) {
      if (!existsSync(file)) {
        const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${yamlValue(v)}`).join('\n');
        writeFileSync(file, `---\n${fm}\n---\n${block}\n`, { flag: 'wx' });
        return this.rel(file);
      }
      const text = readFileSync(file, 'utf8');
      const a = text.indexOf(START);
      const b = text.indexOf(END);
      if (a >= 0 && b > a) {
        const next = text.slice(0, a) + block + text.slice(b + END.length);
        if (next !== text) writeFileSync(file, next, 'utf8');
        return this.rel(file);
      }
    }
    throw new Error(`As notas "${name}" e "${name} (gerado)" existem sem marcadores; não vou alterá-las.`);
  }

  // Acrescenta um bloco no fim de uma nota criada pelo próprio EMANNU OS.
  appendToOwnNote(rel: string, block: string): void {
    const abs = join(this.root, rel);
    const { data } = stripFrontmatter(readFileSync(abs, 'utf8'));
    if (!['job', 'entrega'].includes(data.type ?? '')) throw new Error('Só acrescento em notas criadas pelo EMANNU OS');
    appendFileSync(abs, `\n${block.trim()}\n`, 'utf8');
  }

  // Notas do 90 - INBOX que pedem um objetivo (tag #objetivo).
  inboxObjectives(): { path: string; rel: string; title: string; body: string; project: string | null; mtime: number }[] {
    const dir = join(this.root, INBOX_FOLDER);
    if (!existsSync(dir)) return [];
    const out = [];
    for (const name of readdirSync(dir)) {
      if (!name.toLowerCase().endsWith('.md')) continue;
      const path = join(dir, name);
      const text = readFileSync(path, 'utf8');
      const { data, body } = stripFrontmatter(text);
      const tagged = /(^|\s)#objetivo\b/i.test(body) || /objetivo/i.test(data.tags ?? '');
      if (!tagged) continue;
      const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
      out.push({
        path,
        rel: this.rel(path),
        title: data.title || heading || name.replace(/\.md$/i, ''),
        body: body.replace(/(^|\s)#objetivo\b/gi, '$1').trim().slice(0, 4000),
        project: data.projeto || data.project || null,
        mtime: statSync(path).mtimeMs,
      });
    }
    return out;
  }
}
