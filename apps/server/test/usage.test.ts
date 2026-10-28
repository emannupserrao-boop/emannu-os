import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeAdapter, codexAdapter } from '../src/runners/adapters.ts';
import { UsageTracker, findRollout, parseRolloutLine, watchRollout, type UsageEvent } from '../src/runners/usage.ts';
import { buildHarnesses, claudeSubagents } from '../src/agents/harness.ts';

const usageOf = (parsed: { usage?: UsageEvent }[]) => parsed.find((p) => p.usage)?.usage!;

// Linhas reais (encurtadas) dos logs de jobs.
describe('tokens e contexto', () => {
  it('Claude: soma mensagens sem contar duas vezes o mesmo id e usa o total oficial no fim', () => {
    const t = new UsageTracker(() => 200_000);
    const msg = (id: string, out: number) =>
      `{"type":"assistant","message":{"id":"${id}","model":"claude-opus-5-5","content":[],"usage":{"input_tokens":2,"cache_creation_input_tokens":21584,"cache_read_input_tokens":18297,"output_tokens":${out}}}}`;
    t.apply(usageOf(claudeAdapter.parse(msg('m1', 8))));
    t.apply(usageOf(claudeAdapter.parse(msg('m1', 300)))); // mesma mensagem, bloco seguinte
    expect(t.usage).toMatchObject({ model: 'claude-opus-5-5', calls: 1, output: 300, cacheRead: 18297, context: 2 + 21584 + 18297 + 300, contextMax: 200_000 });
    t.apply(usageOf(claudeAdapter.parse(msg('m2', 50))));
    expect(t.usage.calls).toBe(2);
    expect(t.usage.output).toBe(350);

    const result = claudeAdapter.parse(
      '{"type":"result","subtype":"success","is_error":false,"result":"ok","usage":{"input_tokens":6,"cache_creation_input_tokens":23984,"cache_read_input_tokens":52424,"output_tokens":5820},"modelUsage":{"claude-opus-5-5":{"outputTokens":5820,"contextWindow":1000000,"costUSD":0.3187808}},"total_cost_usd":0.3187808}',
    );
    expect(result.at(-1)).toMatchObject({ kind: 'result', final: { ok: true } });
    t.apply(usageOf(result));
    expect(t.usage).toMatchObject({ input: 6, output: 5820, cacheRead: 52424, cacheWrite: 23984, contextMax: 1_000_000, costUsd: 0.3187808 });
  });

  it('Claude: modelo auxiliar (Haiku lendo páginas) não troca o modelo principal', () => {
    const t = new UsageTracker();
    t.apply(usageOf(claudeAdapter.parse('{"type":"assistant","message":{"id":"m1","model":"claude-opus-5-5","content":[],"usage":{"input_tokens":5,"output_tokens":10}}}')));
    t.apply(
      usageOf(
        claudeAdapter.parse(
          '{"type":"result","subtype":"success","is_error":false,"result":"ok","usage":{"input_tokens":10,"output_tokens":9163},"modelUsage":{"claude-haiku-5-5":{"outputTokens":8000,"contextWindow":200000,"costUSD":0.05},"claude-opus-5-5":{"outputTokens":1163,"contextWindow":1000000,"costUSD":0.4}},"total_cost_usd":0.45}',
        ),
      ),
    );
    expect(t.usage).toMatchObject({ model: 'claude-opus-5-5', contextMax: 1_000_000, costUsd: 0.45 });
  });

  it('Codex: total no fim do turno (entrada sem a parte em cache)', () => {
    const p = codexAdapter.parse('{"type":"turn.completed","usage":{"input_tokens":95951,"cached_input_tokens":74368,"cache_write_input_tokens":0,"output_tokens":597}}');
    expect(p[0]).toMatchObject({ kind: 'result', usage: { type: 'total', totals: { input: 21583, cacheRead: 74368, output: 597 } } });
  });

  it('Codex: contexto ao vivo pelo arquivo de sessão', () => {
    const model = { current: null as string | null };
    expect(parseRolloutLine('{"type":"turn_context","payload":{"model":"gpt-6.1-sol"}}', model)).toBeNull();
    const e = parseRolloutLine(
      '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":337252,"cached_input_tokens":285952,"output_tokens":2264},"last_token_usage":{"input_tokens":65793,"output_tokens":140},"model_context_window":475000}}}',
      model,
    );
    expect(e).toMatchObject({ type: 'context', model: 'gpt-6.1-sol', context: 65933, contextMax: 475000, totals: { input: 51300, cacheRead: 285952, output: 2264 } });
  });

  it('acha e acompanha o arquivo de sessão do Codex pelo id da conversa', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-sess-'));
    const now = new Date();
    const dir = join(root, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'rollout-2026-abc-thread42.jsonl');
    writeFileSync(file, '{"type":"turn_context","payload":{"model":"gpt-x"}}\n');
    expect(findRollout('thread42', root, now)).toBe(file);
    const seen: UsageEvent[] = [];
    const stop = watchRollout('thread42', (e) => seen.push(e), { root, intervalMs: 20 });
    appendFileSync(file, '{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1000,"output_tokens":10},"model_context_window":5000}}}\n');
    await new Promise((r) => setTimeout(r, 80));
    stop();
    expect(seen).toEqual([expect.objectContaining({ type: 'context', model: 'gpt-x', context: 1010, contextMax: 5000 })]);
  });

  it('aba Agentes: harnesses, papéis do EMANNU OS e subagentes do Claude Code', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(home, '.claude', 'agents', 'tradutor.md'), '---\nname: tradutor\ndescription: "Traduz textos para PT-PT"\n---\nCorpo');
    expect(claudeSubagents([], home)).toEqual([{ id: 'tradutor', nome: 'tradutor', papel: 'Traduz textos para PT-PT', origem: 'harness', kind: null }]);

    const views = buildHarnesses({
      agents: [
        { id: 'claude', installed: true, authenticated: true, paused: false, version: '2.1.302', note: 'uso 5h 4%' } as any,
        { id: 'codex', installed: true, authenticated: true, paused: true, pausedReason: 'Limite de uso', version: '0.164' } as any,
      ],
      projects: [],
      extras: { hermes: { installed: false, exe: null, version: null, agents: [] } },
      lastModel: { claude: 'claude-opus-5-5' },
    });
    expect(views.map((v) => [v.id, v.estado])).toEqual([
      ['claude-code', 'ativo'],
      ['codex', 'pausado'],
      ['hermes', 'nao_instalado'],
      ['openclaw', 'nao_instalado'],
    ]);
    expect(views[0].agentes.find((a) => a.id === 'rocky')).toMatchObject({ kind: 'plan', origem: 'emannu' });
    expect(views[0].modelo).toBe('claude-opus-5-5');
    expect(views[1].limites).toBe('Limite de uso');
  });
});
