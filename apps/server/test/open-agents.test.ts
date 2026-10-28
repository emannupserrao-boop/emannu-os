import { describe, it, expect } from 'vitest';
import { hermesAdapter, openclawAdapter } from '../src/runners/open-agents.ts';
import { otherAgent } from '../src/prompts.ts';
import { RECEITA_AGENTS } from '../src/agents/receita.ts';
import { claudeAdapter } from '../src/runners/adapters.ts';

// Saída real do "openclaw agent exec --json" (2026.10.10-beta.3, motor claude-cli).
const ENVELOPE = `{
  "ok": true,
  "status": "ok",
  "final": "OK",
  "payloads": [
    {
      "text": "OK",
      "mediaUrl": null
    }
  ],
  "usage": {
    "input": 2,
    "output": 4,
    "cacheWrite": 55613
  },
  "toolSummary": {
    "calls": 0,
    "tools": [],
    "failures": 0
  },
  "model": "claude-haiku-5-5",
  "provider": "anthropic",
  "sessionId": "8d04fcca-05ee-4f2a-a84c-9edc9b434d26"
}`;

describe('OpenClaw', () => {
  it('sem gateway, com config própria do EMANNU OS; revisão e pesquisa sem ferramentas de escrita', () => {
    const task = openclawAdapter.buildArgs({ kind: 'task', timeoutMin: 30 } as any, 'C:\\wt', 'faça X');
    expect(task.args.slice(0, 2)).toEqual(['agent', 'exec']);
    expect(task.args).toContain('--json');
    expect(task.args[task.args.indexOf('--cwd') + 1]).toBe('C:\\wt');
    expect(task.args[task.args.indexOf('--timeout') + 1]).toBe('1800');
    expect(task.args.some((a) => a.endsWith('openclaw.json'))).toBe(true);
    expect(task.stdin).toContain('Nunca envie mensagens');
    const review = openclawAdapter.buildArgs({ kind: 'review', timeoutMin: 10 } as any, 'C:\\wt', 'revise');
    expect(review.args.some((a) => a.endsWith('openclaw-leitura.json'))).toBe(true);
    expect(task.args.join(' ')).not.toMatch(/gateway|deliver/);
  });

  it('lê o JSON de várias linhas do fim: texto, tokens, sessão e resultado', () => {
    const parse = openclawAdapter.createParser!();
    const out = ENVELOPE.split('\n').flatMap((l) => parse(l));
    expect(out.find((p) => p.sessionId)?.sessionId).toBe('8d04fcca-05ee-4f2a-a84c-9edc9b434d26');
    expect(out.find((p) => p.usage)?.usage).toMatchObject({ type: 'total', model: 'claude-haiku-5-5', totals: { input: 2, output: 4, cacheWrite: 55613 } });
    expect(out.at(-1)).toMatchObject({ kind: 'result', final: { ok: true, text: 'OK' } });
  });

  it('linhas do Windows (CRLF)', () => {
    const parse = openclawAdapter.createParser!();
    const out = ENVELOPE.split('\n').flatMap((l) => parse(l + '\r'));
    expect(out.at(-1)).toMatchObject({ kind: 'result', final: { ok: true, text: 'OK' } });
  });

  it('erro do OpenClaw vira falha do job', () => {
    const parse = openclawAdapter.createParser!();
    const out = '{\n  "ok": false,\n  "status": "error",\n  "error": { "message": "No API key found", "kind": "exception" }\n}'.split('\n').flatMap((l) => parse(l));
    expect(out.at(-1)).toMatchObject({ kind: 'error', final: { ok: false } });
  });

  it('revisão cruzada: OpenClaw (motor Claude) é revisado pelo Codex', () => {
    expect(otherAgent('openclaw')).toBe('codex');
    expect(otherAgent('codex')).toBe('claude');
    expect(otherAgent('claude')).toBe('codex');
  });
});

describe('Hermes', () => {
  // Linhas reais do "hermes chat --format stream-json" (v0.22.5, provedor openai-codex).
  const LINES = [
    '{"type": "system", "subtype": "init", "model": "", "session_id": "", "timestamp": 1793138751898}',
    'Session: local-7add58395b0f',
    '{"type": "text", "text": "OK", "timestamp": 1793138755230}',
    '{"type": "result", "session_id": "local-7add58395b0f", "exit_code": 0, "text": "OK", "tokens": {"input": 15602, "output": 5, "total": 15607, "cache_read": 3968, "cache_write": 0}, "duration_ms": 3921}',
  ];

  it('roda com a assinatura do ChatGPT e só com ferramentas liberadas', () => {
    const task = hermesAdapter.buildArgs({ kind: 'task' } as any, 'C:\wt', 'x');
    expect(task.args).toEqual(expect.arrayContaining(['--provider', 'openai-codex', '--format', 'stream-json']));
    expect(task.args[task.args.indexOf('-t') + 1]).toBe('file,terminal,web,todo');
    expect(task.args.join(' ')).not.toMatch(/computer_use|browser|cronjob|gateway|yolo/);
    expect(task.env?.HERMES_HOME?.split('\\').join('/')).toMatch(/ferramentas\/hermes$/);
    const review = hermesAdapter.buildArgs({ kind: 'review' } as any, 'C:\wt', 'x');
    expect(review.args[review.args.indexOf('-t') + 1]).toBe('web');
  });

  it('lê texto, tokens (entrada sem o cache), sessão e resultado', () => {
    const out = LINES.flatMap((l) => hermesAdapter.parse(l));
    expect(out.find((p) => p.kind === 'text')?.text).toBe('OK');
    expect(out.find((p) => p.usage)?.usage).toMatchObject({ type: 'total', totals: { input: 11634, output: 5, cacheRead: 3968 } });
    expect(out.find((p) => p.sessionId)?.sessionId).toBe('local-7add58395b0f');
    expect(out.at(-1)).toMatchObject({ kind: 'result', final: { ok: true, text: 'OK' } });
    expect(out.some((p) => p.text.startsWith('Session:'))).toBe(false);
  });

  it('junta o texto que chega em pedaços', () => {
    const parse = hermesAdapter.createParser!();
    const out = ['{"type": "text", "text": "Arquivo "}', '{"type": "text", "text": "alter"}', '{"type": "text", "text": "ado."}', LINES[3]].flatMap((l) => parse(l));
    expect(out.filter((p) => p.kind === 'text').map((p) => p.text)).toEqual(['Arquivo alterado.']);
    expect(out.at(-1)).toMatchObject({ kind: 'result' });
  });

  it('modelo recusado vira falha do job', () => {
    const out = hermesAdapter.parse('{"type": "result", "exit_code": 1, "text": "Provider said: HTTP 400"}');
    expect(out.at(-1)).toMatchObject({ kind: 'error', final: { ok: false } });
  });
});

describe('agentes da Operação Receita no Claude', () => {
  it('pesquisador e analista só leem e nunca contatam', () => {
    for (const a of Object.values(RECEITA_AGENTS)) {
      expect(a.tools).toEqual(['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep']);
      expect(a.prompt).toMatch(/Nunca contatar/);
    }
  });

  it('pesquisas recebem os subagentes (--agents) e a ferramenta Task', () => {
    const { args } = claudeAdapter.buildArgs({ kind: 'research', projectId: 'operacao-receita' } as any, 'C:\\p', 'x');
    expect(args[args.indexOf('--tools') + 1]).toContain('Task');
    const task = claudeAdapter.buildArgs({ kind: 'task', projectId: 'x' } as any, 'C:\\p', 'x');
    expect(task.args).not.toContain('--agents');
  });
});
