// Adaptadores: transformam cada agente (CLI) em argumentos de linha de comando
// e convertem o stream JSON de cada um em eventos normalizados.
import type { EventKind, Job } from '../../../../packages/shared/types.ts';
import { CLAUDE_TOOLS, GOVERNANCE_PROMPT, IMMIGRATION_DOCS_DIR, USAGE_LIMIT_RE } from '../config.ts';
import type { UsageEvent } from './usage.ts';
import { existsSync } from 'node:fs';
import { RECEITA_AGENTS_FILE } from '../agents/receita.ts';

export interface Parsed {
  kind: EventKind;
  text: string;
  sessionId?: string;
  // Presente no evento final do agente.
  final?: { ok: boolean; text: string };
  usageLimit?: boolean;
  usageNote?: string;
  // Evento só para metadados, sem linha no log.
  silent?: boolean;
  // Tokens/contexto (ver usage.ts).
  usage?: UsageEvent;
}

export interface AgentAdapter {
  // prompt: o texto completo da tarefa (com context pack), montado pelo fluxo.
  buildArgs(job: Job, cwd: string, prompt: string): { args: string[]; stdin: string; env?: Record<string, string> };
  parse(line: string): Parsed[];
  // Leitor com estado próprio por job (ex.: JSON que ocupa várias linhas).
  createParser?(): (line: string) => Parsed[];
}

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

const readOnly = (job: Job) => job.kind === 'plan' || job.kind === 'review' || job.kind === 'research';

// Remove códigos de cor do terminal (ANSI) que poluem o log.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

const clip = (raw: string, n = 600) => {
  const s = raw.replace(ANSI_RE, '');
  return s.length > n ? s.slice(0, n) + ' …' : s;
};

function describeToolInput(input: any): string {
  if (!input || typeof input !== 'object') return '';
  return String(input.file_path ?? input.command ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.path ?? '');
}

function toolResultText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : (c?.text ?? ''))).join('\n');
  return '';
}

export const claudeAdapter: AgentAdapter = {
  buildArgs(job, _cwd, prompt) {
    const t = job.kind === 'plan' ? CLAUDE_TOOLS.plan : job.kind === 'research' ? CLAUDE_TOOLS.research : job.kind === 'review' ? CLAUDE_TOOLS.review : CLAUDE_TOOLS.task;
    return {
      args: [
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-mode', 'dontAsk',
        '--permission-prompts', 'none',
        '--tools', t.tools.join(','),
        '--allowedTools', t.allowed.join(','),
        '--append-system-prompt', GOVERNANCE_PROMPT,
        // Jobs da Imigração/IA podem LER a pasta de referência (currículos, plano migratório).
        ...(job.projectId === 'imigracao' ? ['--add-dir', IMMIGRATION_DOCS_DIR] : []),
        // Pesquisas têm os agentes de busca da Operação Receita como subagentes.
        ...(job.kind === 'research' && existsSync(RECEITA_AGENTS_FILE) ? ['--agents', RECEITA_AGENTS_FILE] : []),
      ],
      stdin: prompt,
    };
  },

  parse(line) {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return [{ kind: 'output', text: clip(line) }];
    }
    const out: Parsed[] = [];
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') out.push({ kind: 'system', text: `Sessão iniciada (modelo ${ev.model})`, sessionId: ev.session_id });
        break;
      case 'assistant': {
        const m = ev.message ?? {};
        if (m.usage && m.id) {
          const u = m.usage;
          out.push({
            kind: 'system', text: '', silent: true,
            usage: { type: 'call', id: String(m.id), model: m.model ?? null, input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens) },
          });
        }
        for (const c of m.content ?? []) {
          if (c.type === 'text' && c.text?.trim()) out.push({ kind: 'text', text: c.text.trim() });
          else if (c.type === 'tool_use') out.push({ kind: 'tool', text: `${c.name} ${clip(describeToolInput(c.input), 200)}`.trim() });
        }
        break;
      }
      case 'user':
        for (const c of ev.message?.content ?? []) {
          if (c.type === 'tool_result') {
            const t = toolResultText(c.content).trim();
            if (t) out.push({ kind: c.is_error ? 'warning' : 'output', text: clip(t, 400) });
          }
        }
        break;
      case 'rate_limit_event': {
        const info = ev.rate_limit_info ?? {};
        const w = info.unifiedWindows ?? {};
        const pct = (x: any) => (typeof x?.utilization === 'number' ? `${Math.round(x.utilization * 100)}%` : '?');
        const note = `uso 5h ${pct(w.five_hour)} · 7d ${pct(w.seven_day)}`;
        if (info.status === 'rejected') {
          out.push({ kind: 'error', text: `Limite de uso atingido (${info.rateLimitType ?? 'desconhecido'})`, usageLimit: true, usageNote: note });
        } else {
          out.push({ kind: 'system', text: '', silent: true, usageNote: note });
        }
        break;
      }
      case 'result': {
        const text = String(ev.result ?? ev.subtype ?? '');
        const ok = !ev.is_error && ev.subtype === 'success';
        if (ev.usage) {
          const u = ev.usage;
          const entries = Object.entries(ev.modelUsage ?? {}) as [string, any][];
          const [model, mu] = entries.sort((a, b) => num(b[1]?.costUSD) - num(a[1]?.costUSD))[0] ?? [null, null];
          out.push({
            kind: 'system', text: '', silent: true,
            usage: {
              type: 'total', model,
              totals: { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens) },
              contextMax: num(mu?.contextWindow) || null,
              contextByModel: Object.fromEntries(entries.filter(([, m]) => num(m?.contextWindow)).map(([k, m]) => [k, num(m.contextWindow)])),
              costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
            },
          });
        }
        out.push({
          kind: ok ? 'result' : 'error',
          text: ok ? text : `Falhou (${ev.subtype}): ${text}`,
          final: { ok, text },
          usageLimit: !ok && USAGE_LIMIT_RE.test(text),
        });
        break;
      }
    }
    return out;
  },
};

export const codexAdapter: AgentAdapter = {
  buildArgs(job, cwd, prompt) {
    return {
      args: ['exec', '--json', '-C', cwd, '-s', readOnly(job) ? 'read-only' : 'workspace-write', '-'],
      stdin: `${GOVERNANCE_PROMPT}\n\n${prompt}`,
    };
  },

  parse(line) {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return [{ kind: 'output', text: clip(line) }];
    }
    const it = ev.item ?? {};
    switch (ev.type) {
      case 'thread.started':
        return [{ kind: 'system', text: 'Sessão iniciada', sessionId: ev.thread_id }];
      case 'item.started':
        if (it.type === 'command_execution') return [{ kind: 'tool', text: `$ ${clip(String(it.command), 300)}` }];
        return [];
      case 'item.completed':
        switch (it.type) {
          case 'agent_message':
            return it.text?.trim() ? [{ kind: 'text', text: it.text.trim() }] : [];
          case 'command_execution':
            return [{ kind: it.exit_code === 0 ? 'output' : 'warning', text: clip(`exit ${it.exit_code ?? '?'}: ${it.aggregated_output ?? ''}`.trim(), 400) }];
          case 'file_change':
            return [{ kind: 'tool', text: 'Arquivos: ' + (it.changes ?? []).map((c: any) => `${c.path} (${c.kind})`).join(', ') }];
          case 'web_search':
            return [{ kind: 'tool', text: `Pesquisa: ${it.query ?? ''}` }];
          case 'mcp_tool_call':
            return [{ kind: 'tool', text: `${it.server ?? ''}.${it.tool ?? ''}` }];
          case 'error':
            return [{ kind: 'warning', text: String(it.message ?? '') }];
          default:
            return [];
        }
      case 'turn.completed': {
        const u = ev.usage ?? {};
        const cached = num(u.cached_input_tokens);
        const usage: UsageEvent | undefined = ev.usage
          ? { type: 'total', model: null, totals: { input: Math.max(0, num(u.input_tokens) - cached), output: num(u.output_tokens), cacheRead: cached, cacheWrite: num(u.cache_write_input_tokens) }, contextMax: null, costUsd: null }
          : undefined;
        return [{ kind: 'result', text: 'Turno concluído', final: { ok: true, text: '' }, usage }];
      }
      case 'turn.failed':
      case 'error': {
        const msg = String(ev.error?.message ?? ev.message ?? 'erro desconhecido');
        return [{ kind: 'error', text: msg, final: ev.type === 'turn.failed' ? { ok: false, text: msg } : undefined, usageLimit: USAGE_LIMIT_RE.test(msg) }];
      }
      default:
        return [];
    }
  },
};

import { hermesAdapter, openclawAdapter } from './open-agents.ts';

export const adapters = { claude: claudeAdapter, codex: codexAdapter, openclaw: openclawAdapter, hermes: hermesAdapter };
