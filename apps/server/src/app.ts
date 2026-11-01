// Monta o servidor HTTP: acesso por PIN/token, API, notificações e os arquivos do app.
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import type { Scheduler } from './scheduler.ts';
import { registerApi } from './api.ts';
import { registerProjectsApi } from './projectsApi.ts';
import { registerRendaApi } from './renda/api.ts';
import { registerChatApi } from './chatApi.ts';
import { registerArquivosApi } from './arquivosApi.ts';
import type { Library } from './arquivos.ts';
import type { GitHubStatus } from './github.ts';
import { HumanConfirm } from './renda/human.ts';
import { Auth, parseCookies, type Device } from './auth.ts';
import type { Push, PushSubscriptionJSON } from './push.ts';

const COOKIE = 'emannu_token';
const PUBLIC_API = new Set(['/api/health', '/api/auth/status', '/api/auth/login', '/api/auth/setup']);

declare module 'fastify' {
  interface FastifyRequest {
    device: Device | 'admin' | null;
  }
}

// Pedido feito no próprio PC (sem passar pelo Tailscale, que acrescenta cabeçalhos de proxy).
export function isLocalRequest(req: FastifyRequest): boolean {
  const ip = req.socket.remoteAddress ?? '';
  const h = req.headers;
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip) && !h['x-forwarded-for'] && !h['x-forwarded-host'] && !h['tailscale-user-login'];
}

function tokenOf(req: FastifyRequest): string | undefined {
  const header = req.headers['x-emannu-token'];
  return (typeof header === 'string' && header) || parseCookies(req.headers.cookie)[COOKIE];
}

function setTokenCookie(req: FastifyRequest, reply: FastifyReply, token: string | null) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.protocol === 'https';
  const value = token ? encodeURIComponent(token) : '';
  const age = token ? 400 * 24 * 3600 : 0;
  reply.header('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`);
}

export async function buildApp(opts: { sched: Scheduler; auth: Auth; push: Push | null; webDist?: string | null; legacyDir?: string | null; library?: Library | null; github?: GitHubStatus | null; logger?: boolean }) {
  const { sched, auth, push } = opts;
  const app = Fastify({ logger: opts.logger ? { level: 'warn' } : false });
  app.decorateRequest('device', null);

  // Toda a API exige um aparelho registrado (ou o token local de administrador).
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/')) return;
    req.device = auth.verify(tokenOf(req));
    if (PUBLIC_API.has(path)) return;
    if (!req.device) return reply.code(401).send({ error: 'Entre com o PIN.' });
  });

  // ---------- acesso ----------
  app.get('/api/auth/status', async (req) => ({
    configured: auth.isConfigured(),
    authenticated: !!req.device,
    device: req.device && req.device !== 'admin' ? req.device : null,
    local: isLocalRequest(req),
  }));

  app.post<{ Body: { pin?: string; deviceName?: string } }>('/api/auth/setup', async (req, reply) => {
    if (auth.isConfigured()) return reply.code(409).send({ error: 'O PIN já foi definido.' });
    if (!isLocalRequest(req) && req.device !== 'admin') return reply.code(403).send({ error: 'Defina o PIN no próprio PC.' });
    if (!Auth.validPin(req.body?.pin)) return reply.code(400).send({ error: 'O PIN precisa ter de 6 a 12 números.' });
    auth.setPin(req.body!.pin!);
    const { device, token } = auth.createDevice(req.body?.deviceName || 'PC');
    setTokenCookie(req, reply, token);
    return { device };
  });

  app.post<{ Body: { pin?: string; deviceName?: string } }>('/api/auth/login', async (req, reply) => {
    const r = auth.checkPin(req.body?.pin);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    const { device, token } = auth.createDevice(req.body?.deviceName || 'Aparelho');
    setTokenCookie(req, reply, token);
    return { device };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.device && req.device !== 'admin') {
      auth.revoke(req.device.id);
      push?.forgetDevice(req.device.id);
    }
    setTokenCookie(req, reply, null);
    return { ok: true };
  });

  app.get('/api/auth/devices', async (req) => {
    const current = req.device && req.device !== 'admin' ? req.device.id : null;
    return auth.listDevices().map((d) => ({ ...d, current: d.id === current }));
  });

  app.delete<{ Params: { id: string } }>('/api/auth/devices/:id', async (req) => {
    const ok = auth.revoke(req.params.id);
    push?.forgetDevice(req.params.id);
    return { ok };
  });

  app.post<{ Body: { atual?: string; novo?: string } }>('/api/auth/pin', async (req, reply) => {
    const r = auth.checkPin(req.body?.atual);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    if (!Auth.validPin(req.body?.novo)) return reply.code(400).send({ error: 'O PIN precisa ter de 6 a 12 números.' });
    auth.setPin(req.body!.novo!);
    return { ok: true };
  });

  // ---------- notificações ----------
  app.get('/api/push/key', async () => ({ publicKey: push?.publicKey ?? null, subscriptions: push?.count() ?? 0 }));
  app.post<{ Body: PushSubscriptionJSON }>('/api/push/subscribe', async (req) => {
    if (!push) throw new Error('Notificações desativadas');
    push.subscribe(req.body, req.device && req.device !== 'admin' ? req.device.id : null);
    return { ok: true };
  });
  app.post<{ Body: { endpoint: string } }>('/api/push/unsubscribe', async (req) => {
    push?.unsubscribe(req.body?.endpoint ?? '');
    return { ok: true };
  });
  app.post('/api/push/test', async () => {
    if (!push) throw new Error('Notificações desativadas');
    return push.notify({ title: 'EMANNU OS', body: 'Teste de notificação: está funcionando.', url: '/', tag: 'teste' });
  });

  registerApi(app, sched);
  registerProjectsApi(app, sched, opts.legacyDir ?? null, opts.github ?? null);
  // Uma única fila de confirmações humanas para renda, candidaturas e integrações.
  const human = new HumanConfirm();
  registerRendaApi(app, sched, human);
  registerChatApi(app, sched, human);
  if (opts.library) registerArquivosApi(app, opts.library);

  if (opts.webDist && existsSync(opts.webDist)) {
    await app.register(fastifyStatic, {
      root: opts.webDist,
      // O service worker e o index.html não podem ficar presos em cache; os assets têm hash no nome.
      setHeaders(res, path) {
        if (/[\\/]assets[\\/]/.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.setHeader('Cache-Control', 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/agents/')) return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
      reply.code(404).send({ error: 'Não encontrado' });
    });
  }
  return app;
}
