// Adaptadores dos agentes abertos: OpenClaw e Hermes Agent.
// OpenClaw roda sem gateway ("agent exec") e usa o Claude Code como motor (runtime
// claude-cli: sua assinatura, sem chave paga). Hermes usa o modo sem tela
// ("chat --format stream-json"); só é chamado quando estiver instalado e configurado.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Job } from '../../../../packages/shared/types.ts';
import { GOVERNANCE_PROMPT, USAGE_LIMIT_RE, VAR_DIR } from '../config.ts';
import { LMSTUDIO_URL } from '../benchmark.ts';
import type { AgentAdapter, Parsed } from './adapters.ts';

export const OPENCLAW_DIR = join(VAR_DIR, 'openclaw');
// Hermes instalado na pasta do projeto (o app do Claude virtualiza o AppData): config,
// sessões e login ficam aqui, e o servidor precisa apontar o HERMES_HOME para cá.
export const HERMES_HOME = process.env.EMANNU_HERMES_HOME ?? join(VAR_DIR, 'ferramentas', 'hermes');
export const OPENCLAW_MODEL = process.env.EMANNU_OPENCLAW_MODEL ?? 'anthropic/claude-sonnet-5-5';
const readOnly = (job: Job) => job.kind === 'plan' || job.kind === 'review' || job.kind === 'research';
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

// Configs próprias do EMANNU OS (não mexem no ~/.openclaw do usuário): todos os
// modelos Claude passam pelo Claude Code; a versão "leitura" nega ferramentas de escrita.
export function writeOpenClawConfigs(): void {
  mkdirSync(join(OPENCLAW_DIR, 'state'), { recursive: true });
  const base = {
    agents: {
      defaults: {
        model: OPENCLAW_MODEL,
        models: { 'anthropic/*': { agentRuntime: { id: 'claude-cli' } }, [OPENCLAW_MODEL]: { agentRuntime: { id: 'claude-cli' } } },
      },
    },
  };
  writeFileSync(join(OPENCLAW_DIR, 'openclaw.json'), JSON.stringify(base, null, 2));
  writeFileSync(join(OPENCLAW_DIR, 'openclaw-leitura.json'), JSON.stringify({ ...base, tools: { deny: ['exec', 'write', 'edit', 'apply_patch', 'process'] } }, null, 2));
  // Motor local (LM Studio, servidor compatível com a API da OpenAI só em 127.0.0.1):
  // sem chave paga e sem dados saindo do PC. Só leitura e classificação.
  writeFileSync(
    join(OPENCLAW_DIR, 'openclaw-local.json'),
    JSON.stringify({ models: { providers: { lmstudio: { baseUrl: LMSTUDIO_URL, api: 'openai-completions', apiKey: 'lm-studio' } } }, agents: { defaults: { model: OPENCLAW_LOCAL_MODEL } }, tools: { deny: ['exec', 'write', 'edit', 'apply_patch', 'process'] } }, null, 2),
  );
}

export const OPENCLAW_LOCAL_MODEL = process.env.EMANNU_OPENCLAW_LOCAL_MODEL ?? 'lmstudio/local';

// O OpenClaw devolve um único JSON (com quebras de linha) no fim: junta as linhas.
function openclawParser(): (line: string) => Parsed[] {
  let buf: string[] | null = null;
  return (raw) => {
    // No Windows as linhas chegam com "\r" no fim; só a chave sem recuo fecha o JSON.
    const line = raw.replace(/\r$/, '');
    if (buf === null && line === '{') buf = [];
    if (buf === null) return line.trim() ? [{ kind: 'output', text: line.slice(0, 400) }] : [];
    buf.push(line);
    if (line !== '}') return [];
    let ev: any;
    try {
      ev = JSON.parse(buf.join('\n'));
    } catch {
      buf = null;
      return [];
    }
    buf = null;
    const out: Parsed[] = [];
    if (ev.sessionId) out.push({ kind: 'system', text: `Sessão OpenClaw (motor: ${ev.provider ?? 'anthropic'} · ${ev.model ?? '?'})`, sessionId: String(ev.sessionId) });
    const tools = ev.toolSummary;
    if (tools?.calls) out.push({ kind: 'tool', text: `Ferramentas: ${tools.calls} chamada(s)${tools.tools?.length ? ` — ${tools.tools.join(', ')}` : ''}${tools.failures ? ` · ${tools.failures} falha(s)` : ''}` });
    const u = ev.usage;
    if (u) {
      out.push({
        kind: 'system', text: '', silent: true,
        usage: { type: 'total', model: ev.model ? `${ev.model}` : null, totals: { input: num(u.input), output: num(u.output), cacheRead: num(u.cacheRead), cacheWrite: num(u.cacheWrite) }, contextMax: null, costUsd: typeof ev.costUsd === 'number' ? ev.costUsd : null },
      });
    }
    const text = String(ev.final ?? (ev.payloads ?? []).map((p: any) => p.text ?? '').join('\n') ?? '');
    if (ev.ok) {
      if (text.trim()) out.push({ kind: 'text', text: text.trim() });
      out.push({ kind: 'result', text: 'Concluído', final: { ok: true, text } });
    } else {
      const msg = String(ev.error?.message ?? ev.status ?? 'erro');
      out.push({ kind: 'error', text: msg.slice(0, 600), final: { ok: false, text: msg }, usageLimit: USAGE_LIMIT_RE.test(msg) });
    }
    return out;
  };
}

export const openclawAdapter: AgentAdapter = {
  buildArgs(job, cwd, prompt) {
    return {
      args: [
        'agent', 'exec', '--message-file', '-', '--json', '--no-auth-env-only',
        '--config', join(OPENCLAW_DIR, readOnly(job) ? 'openclaw-leitura.json' : 'openclaw.json'),
        '--state-dir', join(OPENCLAW_DIR, 'state'),
        '--cwd', cwd,
        '--model', OPENCLAW_MODEL,
        '--timeout', String(job.timeoutMin * 60),
      ],
      stdin: `${GOVERNANCE_PROMPT}\n\n${prompt}`,
    };
  },
  parse: openclawParser(),
  createParser: openclawParser,
};

// OpenClaw com motor local (adaptador separado, não só outra variável de modelo):
// config própria, sempre só leitura, sem a governança de escrita.
export const openclawLocalAdapter: AgentAdapter = makeOpenclawLocalAdapter(OPENCLAW_LOCAL_MODEL);

export function makeOpenclawLocalAdapter(model: string): AgentAdapter {
  return {
  buildArgs(job, cwd, prompt) {
    return {
      args: [
        'agent', 'exec', '--message-file', '-', '--json', '--no-auth-env-only',
        '--config', join(OPENCLAW_DIR, 'openclaw-local.json'),
        '--state-dir', join(OPENCLAW_DIR, 'state-local'),
        '--cwd', cwd,
        '--model', model.startsWith('lmstudio/') ? model : `lmstudio/${model}`,
        '--timeout', String(job.timeoutMin * 60),
      ],
      stdin: `${GOVERNANCE_PROMPT}\n\nModelo local: só leia, resuma e classifique.\n\n${prompt}`,
    };
  },
  parse: openclawParser(),
  createParser: openclawParser,
  };
}

// Hermes: JSONL do "--format stream-json" (conferido neste PC com o v0.22.5):
// {"type":"system","subtype":"init"}, {"type":"text","text":...} e no fim
// {"type":"result","exit_code":0,"text":...,"tokens":{input,output,cache_read,cache_write}}.
// Modelo: ChatGPT pela sua assinatura (provedor openai-codex, login feito no Hermes).
export const HERMES_MODEL = process.env.EMANNU_HERMES_MODEL ?? 'gpt-6.1-sol';
// Só estas ferramentas: nada de controle da tela, agendamentos, navegador ou conexões.
const HERMES_TOOLS_TASK = 'file,terminal,web,todo';
const HERMES_TOOLS_READ = 'web';

function hermesParser(): (line: string) => Parsed[] {
  let text = '';
  const flush = (): Parsed[] => {
    const t = text.trim();
    text = '';
    return t ? [{ kind: 'text', text: t.slice(0, 2000) }] : [];
  };
  return (line) => {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return hermesAdapter.parse(line);
    }
    if (ev.type === 'text' && typeof ev.text === 'string') {
      text += ev.text;
      // Parágrafo completo: mostra no log ao vivo sem esperar o fim.
      return /\n\s*\n$/.test(text) || text.length > 1500 ? flush() : [];
    }
    return [...flush(), ...hermesAdapter.parse(line)];
  };
}

export const hermesAdapter: AgentAdapter = {
  createParser: hermesParser,
  buildArgs(job, _cwd, prompt) {
    return {
      args: ['chat', '--query-file', '-', '--format', 'stream-json', '-Q', '--provider', 'openai-codex', '-m', HERMES_MODEL, '-t', readOnly(job) ? HERMES_TOOLS_READ : HERMES_TOOLS_TASK],
      stdin: `${GOVERNANCE_PROMPT}\n\n${prompt}`,
      env: { HERMES_HOME, PYTHONIOENCODING: 'utf-8' },
    };
  },
  parse(line) {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      // "Session: local-..." e avisos em texto: só vão para o log se tiverem conteúdo útil.
      return line.trim() && !/^(Session|session_id):/.test(line.trim()) ? [{ kind: 'output', text: line.slice(0, 400) }] : [];
    }
    const type = String(ev.type ?? '');
    if (type === 'result') {
      const t = ev.tokens ?? {};
      const cached = num(t.cache_read);
      const text = String(ev.text ?? ev.result ?? '');
      const ok = ev.exit_code === 0 || (ev.exit_code === undefined && !ev.error);
      const out: Parsed[] = [];
      if (ev.session_id) out.push({ kind: 'system', text: '', silent: true, sessionId: String(ev.session_id) });
      // "input" do Hermes já inclui a parte em cache.
      out.push({ kind: 'system', text: '', silent: true, usage: { type: 'total', model: HERMES_MODEL, totals: { input: Math.max(0, num(t.input) - cached), output: num(t.output), cacheRead: cached, cacheWrite: num(t.cache_write) }, contextMax: null, costUsd: null } });
      out.push(ok ? { kind: 'result', text: 'Concluído', final: { ok: true, text } } : { kind: 'error', text: text.slice(0, 600), final: { ok: false, text }, usageLimit: USAGE_LIMIT_RE.test(text) });
      return out;
    }
    if (type === 'system') return ev.session_id ? [{ kind: 'system', text: 'Sessão Hermes iniciada', sessionId: String(ev.session_id) }] : [{ kind: 'system', text: `Hermes iniciado (ChatGPT · ${HERMES_MODEL})` }];
    if (type === 'text' && typeof ev.text === 'string' && ev.text.trim()) return [{ kind: 'text', text: ev.text.trim().slice(0, 1200) }];
    if (/tool/.test(type)) return [{ kind: 'tool', text: `${ev.name ?? ev.tool ?? type} ${String(ev.args ?? ev.input ?? '').slice(0, 160)}`.trim() }];
    return [];
  },
};
