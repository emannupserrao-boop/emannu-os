// Ponte para o Rocky, o dot do ChatGPT do Emannuel (v3.1, seção 13.1, experimental).
// Os dots não têm API pública; o canal oficial usado aqui é o Slack:
// o EMANNU OS posta no canal privado #rocky em nome do Emannuel e lê a resposta na thread.
// - O token é colado pelo próprio Emannuel (⚙ → Integrações) e fica em var\integracoes,
//   fora do git e do vault. A API nunca devolve o token.
// - Primeiro teste antes de usar: se o Rocky não responder a mensagens postadas pela
//   integração, a ponte é abandonada e o Rocky sai do seletor. Nada de automatizar o navegador.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { VAR_DIR } from './config.ts';

export const SLACK_CONFIG = join(VAR_DIR, 'integracoes', 'slack.json');
const API = 'https://slack.com/api';

export type BridgeState = 'nao_configurada' | 'nao_testada' | 'ativa' | 'abandonada';

interface Config {
  token: string;
  canal: string;
  estado: BridgeState;
  testadoEm: string | null;
  motivo: string | null;
  // Quem é o Rocky no Slack (bot_id/app_id ou usuário), aprendido no teste. Só ele responde.
  rocky?: string | null;
}

export interface BridgeStatus {
  configurada: boolean;
  canal: string | null;
  estado: BridgeState;
  testadoEm: string | null;
  motivo: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SlackBridge {
  private path: string;
  private fetchFn: typeof fetch;
  pollMs: number;

  constructor(opts: { path?: string; fetchFn?: typeof fetch; pollMs?: number } = {}) {
    this.path = opts.path ?? SLACK_CONFIG;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.pollMs = opts.pollMs ?? 15_000;
  }

  private read(): Config | null {
    try {
      return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as Config) : null;
    } catch {
      return null;
    }
  }

  private write(c: Config) {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(c, null, 2), { mode: 0o600 });
  }

  status(): BridgeStatus {
    const c = this.read();
    return { configurada: !!c?.token, canal: c?.canal ?? null, estado: c?.token ? c.estado : 'nao_configurada', testadoEm: c?.testadoEm ?? null, motivo: c?.motivo ?? null };
  }

  active(): boolean {
    return this.read()?.estado === 'ativa';
  }

  // Guarda o token (só pela API com confirmação humana). Canal = id do #rocky (ex.: C0123…).
  configure(token: string, canal: string): BridgeStatus {
    const t = token.trim();
    const ch = canal.trim();
    if (!/^xox[pb]-[\w-]{10,}$/.test(t)) throw new Error('Token do Slack inválido (começa com xoxp- ou xoxb-).');
    if (!/^[CG][A-Z0-9]{6,}$/.test(ch)) throw new Error('Informe o ID do canal #rocky (começa com C ou G).');
    this.write({ token: t, canal: ch, estado: 'nao_testada', testadoEm: null, motivo: null, rocky: null });
    return this.status();
  }

  remove(): BridgeStatus {
    const c = this.read();
    if (c) this.write({ ...c, token: '', estado: 'nao_configurada' });
    return this.status();
  }

  private async call(method: string, params: Record<string, string>, post = false): Promise<any> {
    const c = this.read();
    if (!c?.token) throw new Error('Ponte do Slack não configurada.');
    const url = post ? `${API}/${method}` : `${API}/${method}?${new URLSearchParams(params)}`;
    const r = await this.fetchFn(url, {
      method: post ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${c.token}`, ...(post ? { 'Content-Type': 'application/json; charset=utf-8' } : {}) },
      body: post ? JSON.stringify(params) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const j: any = await r.json();
    if (!j?.ok) throw new Error(`Slack: ${j?.error ?? r.status}`);
    return j;
  }

  // Posta no #rocky (numa thread nova ou na da conversa) e espera a resposta do Rocky.
  // "expect": no teste, a resposta precisa conter o texto pedido (outro bot no canal não vira "Rocky").
  async ask(text: string, thread: string | null = null, timeoutMs = 10 * 60_000, expect: RegExp | null = null): Promise<{ text: string; thread: string; from: string }> {
    const c = this.read()!;
    const auth = await this.call('auth.test', {});
    const me = auth.user_id as string;
    const myBot = (auth.bot_id as string | undefined) ?? null;
    const idOf = (m: any): string | null => m.bot_id ?? m.app_id ?? null;
    const posted = await this.call('chat.postMessage', { channel: c.canal, text, ...(thread ? { thread_ts: thread } : {}) }, true);
    const root = thread ?? (posted.ts as string);
    const after = Number(posted.ts);
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      await sleep(this.pollMs);
      // Todas as páginas da thread (threads longas).
      const messages: any[] = [];
      let cursor = '';
      do {
        const r = await this.call('conversations.replies', { channel: c.canal, ts: root, limit: '200', ...(cursor ? { cursor } : {}) });
        messages.push(...((r.messages as any[]) ?? []));
        cursor = r.has_more ? String(r.response_metadata?.next_cursor ?? '') : '';
      } while (cursor);
      const reply = messages.find((m) => {
        if (Number(m.ts) <= after || !(m.text ?? '').trim() || m.user === me) return false;
        const id = idOf(m);
        // Antes do teste: só um app/bot que não seja o nosso. Depois: a identidade aprendida.
        return c.rocky ? id === c.rocky : !!id && id !== myBot && (!expect || expect.test(String(m.text)));
      });
      if (reply) return { text: String(reply.text), thread: root, from: idOf(reply)! };
    }
    throw new Error('O Rocky não respondeu no Slack dentro do tempo.');
  }

  // Primeiro teste: o Rocky responde a uma mensagem postada pela integração?
  async test(timeoutMs = 3 * 60_000): Promise<BridgeStatus> {
    const c = this.read();
    if (!c?.token) throw new Error('Configure o token e o canal primeiro.');
    let next: Partial<Config>;
    try {
      const r = await this.ask('Teste da ponte do EMANNU OS: responda "ok" nesta thread, por favor.', null, timeoutMs, /\bok\b/i);
      next = { estado: 'ativa', rocky: r.from, motivo: null };
    } catch (e: any) {
      // Sem resposta à integração: a ponte é abandonada e o Rocky sai do seletor.
      next = { estado: 'abandonada', rocky: null, motivo: e.message };
    }
    // Se a integração foi removida ou trocada durante o teste, o resultado é descartado.
    const now = this.read();
    if (now?.token && now.token === c.token && now.canal === c.canal) this.write({ ...now, ...next, testadoEm: new Date().toISOString() });
    return this.status();
  }
}
