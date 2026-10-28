// API do Chat (v3.1, seção 13) e da ponte do Rocky pelo Slack (13.1).
import type { FastifyInstance } from 'fastify';
import type { Scheduler } from './scheduler.ts';
import type { Attachment, ChatEvent } from './chat.ts';
import type { HumanConfirm } from './renda/human.ts';

export function registerChatApi(app: FastifyInstance, sched: Scheduler, human: HumanConfirm) {
  const chats = () => {
    if (!sched.chats) throw new Error('Chat desativado');
    return sched.chats;
  };

  app.get('/api/chats/agentes', async () => chats().agents());
  app.get('/api/chats', async () => chats().list());
  app.post<{ Body: { agent?: string; mode?: string; title?: string; projectId?: string } }>('/api/chats', async (req) => chats().create(req.body ?? {}));
  app.get<{ Params: { id: string } }>('/api/chats/:id', async (req) => {
    const d = chats().get(req.params.id);
    if (!d) throw Object.assign(new Error('Conversa não encontrada'), { statusCode: 404 });
    return d;
  });

  // Envia uma mensagem; a resposta chega ao vivo (SSE no próprio corpo da resposta).
  app.post<{ Params: { id: string }; Body: { texto?: string; anexos?: Attachment[] } }>('/api/chats/:id/messages', (req, reply) => {
    const c = chats();
    if (!c.get(req.params.id)) return reply.code(404).send({ error: 'Conversa não encontrada' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    const send = (e: ChatEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    c.send(req.params.id, String(req.body?.texto ?? ''), Array.isArray(req.body?.anexos) ? req.body!.anexos : [], send)
      .catch((e) => send({ type: 'error', error: e.message }))
      .finally(() => res.end());
  });

  app.post<{ Params: { id: string }; Body: { projectId?: string } }>('/api/chats/:id/to-objective', async (req) => chats().toObjective(req.params.id, req.body?.projectId));

  // Ponte do Rocky (Slack). O token nunca volta pela API.
  app.get('/api/integracoes/slack', async () => chats().bridge?.status() ?? { configurada: false, canal: null, estado: 'nao_configurada', testadoEm: null, motivo: null });
  app.put<{ Body: { token?: string; canal?: string } }>('/api/integracoes/slack', async (req) => {
    human.verify(req.device, req.headers['x-emannu-confirm'], 'integracao:slack', 'slack');
    return chats().bridge!.configure(String(req.body?.token ?? ''), String(req.body?.canal ?? ''));
  });
  app.delete('/api/integracoes/slack', async (req) => {
    human.verify(req.device, req.headers['x-emannu-confirm'], 'integracao:slack', 'slack');
    return chats().bridge!.remove();
  });
  app.post('/api/integracoes/slack/testar', async () => chats().bridge!.test());
}
