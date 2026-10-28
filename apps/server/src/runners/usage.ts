// Tokens e contexto de cada job, montados a partir do stream de cada agente.
// Claude: uso por mensagem (ao vivo) e o total no "result".
// Codex: o stream do "exec" só traz o total no fim; o uso ao vivo vem do arquivo de
// sessão que o próprio Codex grava em ~/.codex/sessions (eventos "token_count").
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { JobUsage } from '../../../../packages/shared/types.ts';

export type UsageEvent =
  // Uma chamada ao modelo (Claude: uma mensagem; o mesmo id pode chegar várias vezes).
  | { type: 'call'; id: string; model: string | null; input: number; output: number; cacheRead: number; cacheWrite: number }
  // Retrato do contexto atual (Codex, arquivo de sessão).
  | { type: 'context'; model: string | null; context: number; contextMax: number | null; totals?: Totals }
  // Total oficial do fim do job.
  // contextByModel: o Claude usa modelos auxiliares (ex.: Haiku para ler páginas); a janela
  // certa é a do modelo principal.
  | { type: 'total'; model: string | null; totals: Totals; contextMax: number | null; costUsd: number | null; contextByModel?: Record<string, number> };

export interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

export function emptyUsage(): JobUsage {
  return { model: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, context: 0, contextMax: null, costUsd: null, calls: 0, updatedAt: new Date().toISOString() };
}

// "Desconhecido" e "zero" são coisas diferentes: um job sem nenhum evento de uso
// fica com usage = null (a interface mostra "—"), nunca com zeros inventados.
export class UsageTracker {
  usage: JobUsage;
  // Recebeu pelo menos um evento de uso do agente.
  seen = false;
  private calls = new Map<string, Totals>();
  private final = false;

  constructor(contextMaxFor: (model: string) => number | null = () => null) {
    this.usage = emptyUsage();
    this.contextMaxFor = contextMaxFor;
  }
  private contextMaxFor: (model: string) => number | null;

  apply(ev: UsageEvent): void {
    this.seen = true;
    const u = this.usage;
    // O modelo principal é o da primeira chamada; o total do fim não troca o modelo.
    if (ev.model && (!u.model || ev.type === 'context')) {
      u.model = ev.model;
      u.contextMax ??= this.contextMaxFor(ev.model);
    }
    if (ev.type === 'call' && !this.final) {
      const t = { input: ev.input, output: ev.output, cacheRead: ev.cacheRead, cacheWrite: ev.cacheWrite };
      this.calls.set(ev.id, t);
      const sum = [...this.calls.values()].reduce((a, b) => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite }));
      Object.assign(u, sum);
      u.calls = this.calls.size;
      u.context = t.input + t.cacheRead + t.cacheWrite + t.output;
    } else if (ev.type === 'context') {
      u.context = ev.context;
      if (ev.contextMax) u.contextMax = ev.contextMax;
      if (ev.totals && !this.final) Object.assign(u, ev.totals);
      u.calls = Math.max(u.calls, 1);
    } else if (ev.type === 'total') {
      this.final = true;
      Object.assign(u, ev.totals);
      const max = (u.model && ev.contextByModel?.[u.model]) || ev.contextMax;
      if (max) u.contextMax = max;
      if (ev.costUsd !== null) u.costUsd = ev.costUsd;
      // Agentes que só mandam o total (Hermes, OpenClaw) fizeram ao menos uma chamada.
      u.calls = Math.max(u.calls, 1);
      if (!u.context) u.context = ev.totals.input + ev.totals.cacheRead + ev.totals.cacheWrite;
    }
    u.updatedAt = new Date().toISOString();
  }
}

// ---------- Codex: arquivo de sessão ----------

export const CODEX_SESSIONS_DIR = process.env.EMANNU_CODEX_SESSIONS_DIR ?? join(homedir(), '.codex', 'sessions');

// Os arquivos ficam em sessions/AAAA/MM/DD/rollout-...-<threadId>.jsonl.
export function findRollout(threadId: string, root = CODEX_SESSIONS_DIR, now = new Date()): string | null {
  for (const back of [0, 1]) {
    const d = new Date(now.getTime() - back * 86_400_000);
    const dir = join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    if (!existsSync(dir)) continue;
    const f = readdirSync(dir).find((x) => x.endsWith(`${threadId}.jsonl`));
    if (f) return join(dir, f);
  }
  return null;
}

export function parseRolloutLine(line: string, model: { current: string | null }): UsageEvent | null {
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (ev.type === 'turn_context' && ev.payload?.model) {
    model.current = String(ev.payload.model);
    return null;
  }
  const info = ev.type === 'event_msg' && ev.payload?.type === 'token_count' ? ev.payload.info : ev.type === 'token_count' ? ev.info : null;
  if (!info) return null;
  const last = info.last_token_usage ?? {};
  const tot = info.total_token_usage ?? {};
  const cached = n(tot.cached_input_tokens);
  return {
    type: 'context',
    model: model.current,
    // input_tokens do Codex já inclui a parte em cache.
    context: n(last.input_tokens) + n(last.output_tokens),
    contextMax: n(info.model_context_window) || null,
    totals: { input: Math.max(0, n(tot.input_tokens) - cached), output: n(tot.output_tokens), cacheRead: cached, cacheWrite: n(tot.cache_write_input_tokens) },
  };
}

// Lê o arquivo de sessão aos poucos enquanto o job roda.
export function watchRollout(threadId: string, onEvent: (e: UsageEvent) => void, opts: { root?: string; intervalMs?: number } = {}): () => void {
  let file: string | null = null;
  let offset = 0;
  let rest = '';
  const model = { current: null as string | null };
  const poll = () => {
    try {
      file ??= findRollout(threadId, opts.root);
      if (!file) return;
      const size = statSync(file).size;
      if (size <= offset) return;
      const fd = openSync(file, 'r');
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      closeSync(fd);
      offset = size;
      const lines = (rest + buf.toString('utf8')).split('\n');
      rest = lines.pop() ?? '';
      for (const l of lines) {
        const e = l.trim() && parseRolloutLine(l, model);
        if (e) onEvent(e);
      }
    } catch {
      // Arquivo ainda não criado ou em uso: tenta de novo no próximo ciclo.
    }
  };
  const t = setInterval(poll, opts.intervalMs ?? 2000);
  poll();
  return () => {
    clearInterval(t);
    poll();
  };
}

// Retomada (ex.: limite de uso): soma a tentativa anterior à atual, sem contar duas vezes
// a mesma tentativa (a base é o que estava gravado quando o job voltou para a fila).
export function combineUsage(base: JobUsage | null, cur: JobUsage): JobUsage {
  if (!base) return cur;
  return {
    ...cur,
    model: cur.model ?? base.model,
    input: base.input + cur.input,
    output: base.output + cur.output,
    cacheRead: base.cacheRead + cur.cacheRead,
    cacheWrite: base.cacheWrite + cur.cacheWrite,
    calls: base.calls + cur.calls,
    contextMax: cur.contextMax ?? base.contextMax,
    costUsd: base.costUsd === null && cur.costUsd === null ? null : (base.costUsd ?? 0) + (cur.costUsd ?? 0),
  };
}

export const totalTokens = (u: JobUsage | null) => (u ? u.input + u.output + u.cacheRead + u.cacheWrite : 0);
