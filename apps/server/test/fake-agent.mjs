// Agente falso para testes: imita o stream-json do Claude.
// Uso: node fake-agent.mjs <modo> [args]
//   write [arquivo] [need:outro]  cria o arquivo (falha se "outro" não existir)
//   say <base64>                  responde o texto (plano, veredito...)
//   sleep [ms] | limit | fail
import { existsSync, writeFileSync } from 'node:fs';

const [mode, arg1, arg2] = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const result = (text, ok = true) => emit({ type: 'result', subtype: ok ? 'success' : 'error_during_execution', is_error: !ok, result: text });

let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', async () => {
  // Chamado como o Claude real ("-p … [--resume <id>]"): ecoa o pedido e mantém a sessão.
  if (mode === '-p') {
    const args = process.argv.slice(2);
    const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
    emit({ type: 'system', subtype: 'init', session_id: resume ?? `sess-${process.pid}`, model: 'fake' });
    result(`eco: ${prompt.trim()}${resume ? ` (retomou ${resume})` : ''}`);
    process.exit(0);
  }
  emit({ type: 'system', subtype: 'init', session_id: `fake-${process.pid}`, model: 'fake' });
  if (mode === 'write') {
    const need = arg2?.startsWith('need:') ? arg2.slice(5) : null;
    if (need && !existsSync(need)) {
      result(`faltou ${need}`, false);
      process.exit(1);
    }
    const file = arg1 ?? 'saida.txt';
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: file } }] } });
    writeFileSync(file, `prompt: ${prompt.trim()}\n`);
    result(`Arquivo ${file} criado`);
    process.exit(0);
  } else if (mode === 'say') {
    result(Buffer.from(arg1 ?? '', 'base64').toString('utf8'));
    process.exit(0);
  } else if (mode === 'sleep') {
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'trabalhando...' }] } });
    setTimeout(() => {
      result('acordei');
      process.exit(0);
    }, Number(arg1 ?? 60_000));
  } else if (mode === 'limit') {
    emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } });
    result('usage limit reached', false);
    process.exit(1);
  } else {
    result('falhou de propósito', false);
    process.exit(1);
  }
});
