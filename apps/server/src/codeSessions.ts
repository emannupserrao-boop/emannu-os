// Lê o histórico das sessões do Claude Code (~/.claude/projects/<pasta>/*.jsonl):
// título, datas e quantos pedidos cada sessão teve; e monta um texto condensado
// (seus pedidos + respostas do Claude, sem ferramentas) para o resumo do projeto.
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Store } from './db.ts';

export interface CodeSession {
  id: string;
  title: string;
  firstPrompt: string;
  firstAt: string;
  lastAt: string;
  prompts: number;
  cwd: string;
  file: string;
  mtimeMs: number;
  size: number;
  // "claude-desktop" = sessão sua no app; "sdk-cli" = execução automática (ex.: jobs do EMANNU OS).
  entrypoint: string;
  hasTitle: boolean;
  v: number;
}

const CACHE_VERSION = 2;
// Execuções automáticas sem título (jobs do próprio EMANNU OS) não são trabalho seu no Code.
const isAutomated = (s: CodeSession) => s.entrypoint === 'sdk-cli' && !s.hasTitle;

// "D:\Neon Vanguard" → "D--Neon-Vanguard" (nome da pasta de histórico do Claude Code).
export const sessionDirName = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-');

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + ' …' : s);

// Texto de um pedido seu (ignora resultados de ferramentas e mensagens internas).
function promptText(o: any): string | null {
  if (o.type !== 'user' || o.isMeta || o.isSidechain) return null;
  const c = o.message?.content;
  if (typeof c === 'string') return c.startsWith('<') ? null : c.trim() || null;
  if (Array.isArray(c) && !c.some((x: any) => x?.type === 'tool_result')) {
    const t = c.filter((x: any) => x?.type === 'text').map((x: any) => x.text).join('\n').trim();
    return t && !t.startsWith('<') ? t : null;
  }
  return null;
}

function answerText(o: any): string | null {
  if (o.type !== 'assistant' || o.isSidechain) return null;
  const c = o.message?.content;
  if (!Array.isArray(c)) return null;
  const t = c.filter((x: any) => x?.type === 'text').map((x: any) => x.text).join('\n').trim();
  return t || null;
}

async function* lines(file: string): AsyncGenerator<any> {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"type":"custom-title"')) continue;
    try {
      yield JSON.parse(line);
    } catch {}
  }
}

async function readSession(file: string): Promise<CodeSession> {
  const st = statSync(file);
  let title = '';
  let firstPrompt = '';
  let firstAt = '';
  let lastAt = '';
  let prompts = 0;
  let cwd = '';
  let entrypoint = '';
  for await (const o of lines(file)) {
    if (o.type === 'custom-title' && o.customTitle) title = o.customTitle;
    if (!entrypoint && o.entrypoint) entrypoint = o.entrypoint;
    if (o.timestamp) {
      if (!firstAt) firstAt = o.timestamp;
      lastAt = o.timestamp;
    }
    if (!cwd && o.cwd) cwd = o.cwd;
    const p = promptText(o);
    if (p) {
      prompts++;
      if (!firstPrompt) firstPrompt = clip(p.replace(/\s+/g, ' '), 200);
    }
  }
  const id = file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, '');
  return { id, title: title || clip(firstPrompt, 70) || id, firstPrompt, firstAt, lastAt, prompts, cwd, file, mtimeMs: st.mtimeMs, size: st.size, entrypoint, hasTitle: !!title, v: CACHE_VERSION };
}

export class CodeSessionIndex {
  private store: Store;
  private root: string;
  private cache = new Map<string, CodeSession>();

  constructor(store: Store, claudeProjectsDir: string) {
    this.store = store;
    this.root = claudeProjectsDir;
    for (const s of store.kvGet<CodeSession[]>('codigo.sessoes') ?? []) this.cache.set(s.file, s);
  }

  // Sessões cujas pastas de trabalho são estas (ignora sessões sem pedidos).
  async sessionsFor(paths: string[]): Promise<CodeSession[]> {
    const out: CodeSession[] = [];
    let changed = false;
    // Windows não diferencia maiúsculas: "System32" e "system32" são a mesma pasta.
    for (const p of new Set(paths.map((x) => x.toLowerCase()))) {
      const dir = join(this.root, sessionDirName(p));
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue;
        const file = join(dir, name);
        const st = statSync(file);
        let s = this.cache.get(file);
        if (!s || s.v !== CACHE_VERSION || s.mtimeMs !== st.mtimeMs || s.size !== st.size) {
          s = await readSession(file);
          this.cache.set(file, s);
          changed = true;
        }
        if (s.prompts > 0 && !isAutomated(s)) out.push(s);
      }
    }
    if (changed) this.store.kvSet('codigo.sessoes', [...this.cache.values()]);
    return out.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  // Texto condensado das sessões (mais antigas primeiro), dentro de um limite de caracteres.
  async digest(sessions: CodeSession[], maxChars = 110_000): Promise<string> {
    const ordered = [...sessions].sort((a, b) => a.firstAt.localeCompare(b.firstAt));
    const perSession = Math.floor(maxChars / Math.max(1, ordered.length));
    const parts: string[] = [];
    for (const s of ordered) {
      const entries: string[] = [];
      for await (const o of lines(s.file)) {
        const p = promptText(o);
        if (p) entries.push(`**Você:** ${clip(p, 700)}`);
        const a = answerText(o);
        if (a) entries.push(`**Claude:** ${clip(a, 900)}`);
      }
      // Cabe tudo? Senão, guarda o começo (contexto) e o fim (onde a sessão chegou).
      let body = entries.join('\n\n');
      if (body.length > perSession) {
        const head: string[] = [];
        const tail: string[] = [];
        let size = 0;
        for (const e of entries.slice(0, 6)) {
          if (size + e.length > perSession * 0.3) break;
          head.push(e);
          size += e.length;
        }
        for (let i = entries.length - 1; i >= head.length; i--) {
          if (size + entries[i].length > perSession) break;
          tail.unshift(entries[i]);
          size += entries[i].length;
        }
        body = [...head, `_(… ${entries.length - head.length - tail.length} trechos do meio omitidos …)_`, ...tail].join('\n\n');
      }
      parts.push(`## Sessão: ${s.title}\n_${s.firstAt.slice(0, 10)} a ${s.lastAt.slice(0, 10)} · ${s.prompts} pedidos · pasta ${s.cwd}_\n\n${body}`);
    }
    return parts.join('\n\n---\n\n');
  }
}
