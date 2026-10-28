import { describe, it, expect } from 'vitest';
import { claudeAdapter, codexAdapter } from '../src/runners/adapters.ts';

// Linhas reais (encurtadas) gravadas na Fase 0.
describe('claudeAdapter', () => {
  it('lê init, ferramenta, uso e resultado', () => {
    expect(claudeAdapter.parse('{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-5-5"}')[0]).toMatchObject({ kind: 'system', sessionId: 's1' });
    expect(claudeAdapter.parse('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"hello.md"}}]}}')[0]).toMatchObject({ kind: 'tool', text: 'Write hello.md' });
    const usage = claudeAdapter.parse('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.04},"seven_day":{"utilization":0.41}}}}')[0];
    expect(usage).toMatchObject({ silent: true, usageNote: 'uso 5h 4% · 7d 41%' });
    expect(claudeAdapter.parse('{"type":"result","subtype":"success","is_error":false,"result":"feito"}')[0]).toMatchObject({ kind: 'result', final: { ok: true, text: 'feito' } });
  });

  it('detecta limite de uso', () => {
    expect(claudeAdapter.parse('{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour"}}')[0].usageLimit).toBe(true);
  });

  it('passa o prompt pelo stdin', () => {
    const { args, stdin } = claudeAdapter.buildArgs({ kind: 'task' } as any, 'C:\\wt', 'faça X');
    expect(stdin).toBe('faça X');
    expect(args).toContain('stream-json');
    expect(args).not.toContain('faça X');
  });

  it('plano e revisão não recebem ferramentas de escrita', () => {
    for (const kind of ['plan', 'review']) {
      const { args } = claudeAdapter.buildArgs({ kind } as any, 'C:\\wt', 'x');
      const tools = args[args.indexOf('--tools') + 1];
      expect(tools).not.toMatch(/Write|Edit/);
    }
    const { args } = claudeAdapter.buildArgs({ kind: 'fix' } as any, 'C:\\wt', 'x');
    expect(args[args.indexOf('--tools') + 1]).toMatch(/Write/);
  });
});

describe('codexAdapter', () => {
  it('lê thread, mensagens, arquivos e fim de turno', () => {
    expect(codexAdapter.parse('{"type":"thread.started","thread_id":"t1"}')[0]).toMatchObject({ sessionId: 't1' });
    expect(codexAdapter.parse('{"type":"item.completed","item":{"type":"agent_message","text":"feito"}}')[0]).toMatchObject({ kind: 'text', text: 'feito' });
    expect(codexAdapter.parse('{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"a.md","kind":"add"}]}}')[0].text).toBe('Arquivos: a.md (add)');
    expect(codexAdapter.parse('{"type":"item.completed","item":{"type":"error","message":"Codex is ignoring 1 unrecognized configuration setting."}}')[0].kind).toBe('warning');
    expect(codexAdapter.parse('{"type":"turn.completed","usage":{}}')[0].final).toEqual({ ok: true, text: '' });
  });

  it('remove códigos de cor ANSI da saída de comandos', () => {
    const line = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 0, aggregated_output: '\u001b[32m✔ soma\u001b[39m ok' } });
    expect(codexAdapter.parse(line)[0].text).toBe('exit 0: ✔ soma ok');
  });

  it('turn.failed com limite de uso', () => {
    const p = codexAdapter.parse('{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit"}}')[0];
    expect(p).toMatchObject({ kind: 'error', usageLimit: true, final: { ok: false } });
  });

  it('inclui as regras de governança no prompt e usa sandbox só leitura na revisão', () => {
    const { args, stdin } = codexAdapter.buildArgs({ kind: 'task' } as any, 'C:\\wt', 'faça Y');
    expect(args).toEqual(['exec', '--json', '-C', 'C:\\wt', '-s', 'workspace-write', '-']);
    expect(stdin).toContain('EMANNU OS');
    expect(stdin).toContain('faça Y');
    expect(codexAdapter.buildArgs({ kind: 'review' } as any, 'C:\\wt', 'r').args).toContain('read-only');
  });
});
