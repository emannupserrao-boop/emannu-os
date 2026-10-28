import type { FastifyInstance } from 'fastify';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NewJobInput, NewObjectiveInput, RunnableAgent, StreamMessage } from '../../../packages/shared/types.ts';
import type { ImmigrationUser, ResearchTopic, Verification } from '../../../packages/shared/immigration.ts';
import type { Scheduler } from './scheduler.ts';
import { isGitRepo, slug } from './worktrees.ts';
import { AI_LEARNING_VAULT_FOLDER, AI_VAULT_FOLDER } from './config.ts';
import { clipWords } from './context.ts';
import { stripFrontmatter } from './vault.ts';

export function registerApi(app: FastifyInstance, sched: Scheduler) {
  const store = sched.store;
  const flow = sched.flow;
  const config = () => ({ vaultName: sched.vault?.name ?? '' });

  app.setErrorHandler((err: any, _req, reply) => {
    reply.code(err.statusCode && err.statusCode < 500 ? err.statusCode : 400).send({ error: err.message });
  });

  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));

  // Agentes
  app.get('/api/agents', async () => sched.agents());
  app.post('/api/agents/refresh', async () => sched.refreshAgents());
  app.get('/api/agentes', async () => sched.harnesses());

  // Pesquisa de mercado da Operação Receita (sites e presença online) por região.
  const market = () => {
    if (!sched.market) throw new Error('Módulo de mercado desativado');
    return sched.market;
  };
  app.get<{ Params: { regiao: string } }>('/api/mercado/:regiao', async (req) => market().report(req.params.regiao));
  app.post<{ Params: { regiao: string } }>('/api/mercado/:regiao/pesquisar', async (req) => market().run(req.params.regiao));

  // Preferências da interface (ex.: ordem das abas), as mesmas em todos os aparelhos.
  app.get('/api/preferencias', async () => store.kvGet('preferencias') ?? {});
  app.put<{ Body: { abas?: unknown } }>('/api/preferencias', async (req) => {
    const prev = store.kvGet<Record<string, unknown>>('preferencias') ?? {};
    const abas = req.body?.abas;
    if (abas !== undefined && !(Array.isArray(abas) && abas.length <= 20 && abas.every((x) => typeof x === 'string' && /^[a-z]{2,20}$/.test(x)))) {
      throw new Error('Ordem de abas inválida');
    }
    const next = { ...prev, ...(abas ? { abas } : {}) };
    store.kvSet('preferencias', next);
    return next;
  });
  app.post<{ Params: { id: RunnableAgent } }>('/api/agents/:id/resume', async (req) => {
    sched.resumeAgent(req.params.id);
    return sched.agents();
  });

  // Projetos
  app.get('/api/projects', async () => store.listProjects());
  app.post<{ Body: { name: string; path: string } }>('/api/projects', async (req) => {
    const name = req.body?.name?.trim();
    const path = req.body?.path?.trim() && resolve(req.body.path.trim());
    if (!name || !path) throw new Error('Informe nome e pasta do projeto');
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error('Pasta não encontrada');
    const p = store.upsertProject({ id: slug(name), name, path, isGit: isGitRepo(path), vaultFolder: sched.vault?.findProjectFolder(name) ?? null });
    sched.emit('projects', store.listProjects());
    return p;
  });

  // Objetivos
  app.get('/api/objectives', async () => store.listObjectives());
  app.post<{ Body: NewObjectiveInput }>('/api/objectives', async (req, reply) => {
    reply.code(201);
    return flow.createObjective(req.body ?? ({} as NewObjectiveInput));
  });
  app.get<{ Params: { id: string } }>('/api/objectives/:id', async (req) => ({
    objective: flow.mustObjective(req.params.id),
    jobs: store.jobsOfObjective(req.params.id),
  }));
  app.post<{ Params: { id: string }; Body: { projectId?: string; feedback?: string } }>('/api/objectives/:id/plan', async (req) =>
    flow.startPlanning(req.params.id, { projectId: req.body?.projectId, feedback: req.body?.feedback }),
  );
  app.post<{ Params: { id: string }; Body: { agents?: Record<string, RunnableAgent> } }>('/api/objectives/:id/approve-plan', async (req) =>
    flow.approvePlan(req.params.id, req.body?.agents ?? {}),
  );
  app.post<{ Params: { id: string } }>('/api/objectives/:id/approve-delivery', async (req) => flow.approveDelivery(req.params.id));
  app.post<{ Params: { id: string } }>('/api/objectives/:id/cancel', async (req) => flow.cancelObjective(req.params.id));

  // Imigração Portugal
  const imm = () => {
    if (!sched.immigration) throw new Error('Módulo Imigração desativado');
    return sched.immigration;
  };
  app.get('/api/imigracao', async () => imm().state());
  app.patch<{ Body: Partial<ImmigrationUser> }>('/api/imigracao/user', async (req) => {
    // Candidatura enviada / entrevista: só pelo botão com confirmação (aparelho seu).
    if (Object.values(req.body?.vagas ?? {}).some((v: any) => ['enviada', 'entrevista'].includes(v?.status))) {
      throw Object.assign(new Error('Marque a candidatura pelo botão de confirmação.'), { statusCode: 403 });
    }
    return imm().updateUser(req.body ?? {});
  });
  app.post<{ Body: { topics?: ResearchTopic[] } }>('/api/imigracao/pesquisar', async (req) => imm().runResearch(req.body?.topics));
  app.post<{ Params: { id: string } }>('/api/imigracao/vagas/:id/preparar', async (req) => imm().prepareApplication(req.params.id));
  app.put<{ Body: Verification }>('/api/imigracao/verificacao', async (req) => imm().setVerification(req.body));

  // Seção IA: panorama de carreira e aprendizado (notas Current State do vault).
  app.get('/api/ia/panorama', async () => {
    const vault = sched.vault;
    if (!vault?.exists()) return [];
    return [
      { titulo: 'Carreira & trabalho com IA', pasta: AI_VAULT_FOLDER },
      { titulo: 'AI Learning Center', pasta: AI_LEARNING_VAULT_FOLDER },
    ].map((x) => {
      const note = vault.findCurrentState(x.pasta);
      return {
        titulo: x.titulo,
        fonte: note ? vault.rel(note) : null,
        texto: note ? clipWords(stripFrontmatter(vault.read(note)).body.replace(/^#\s+.*$/m, '').replace(/<!--[\s\S]*?-->/g, '').trim(), 120) : null,
      };
    });
  });

  // Jobs
  app.get('/api/jobs', async () => store.listJobs());
  app.post<{ Body: NewJobInput }>('/api/jobs', async (req, reply) => {
    reply.code(201);
    return sched.createJob(req.body ?? ({} as NewJobInput));
  });
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req) => {
    const job = store.getJob(req.params.id);
    if (!job) throw Object.assign(new Error('Job não encontrado'), { statusCode: 404 });
    return job;
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/jobs/:id/events', async (req) =>
    store.listEvents(req.params.id, Number(req.query.after ?? 0)),
  );
  app.get<{ Params: { id: string } }>('/api/jobs/:id/diff', async (req) => sched.diff(req.params.id));
  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (req) => sched.cancel(req.params.id));
  app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', async (req) => sched.retry(req.params.id));
  app.post<{ Params: { id: string } }>('/api/jobs/:id/approve', async (req) => sched.approve(req.params.id));
  app.post<{ Params: { id: string } }>('/api/jobs/:id/discard', async (req) => sched.discard(req.params.id));
  app.post<{ Params: { id: string } }>('/api/jobs/:id/request-review', async (req) => sched.requestReview(req.params.id));

  // Tempo real (SSE): um snapshot ao conectar e depois cada mudança.
  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (msg: StreamMessage) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
    send({ type: 'sistema', sistema: sched.sistema() });
    send({ type: 'snapshot', jobs: store.listJobs(), agents: sched.agents(), projects: store.listProjects(), objectives: store.listObjectives(), config: config() });

    const handlers: Record<string, (x: any) => void> = {
      job: (job) => send({ type: 'job', job }),
      event: (event) => send({ type: 'event', event }),
      agents: (agents) => send({ type: 'agents', agents }),
      projects: (projects) => send({ type: 'projects', projects }),
      objective: (objective) => send({ type: 'objective', objective }),
      immigration: (state) => send({ type: 'immigration', state }),
      renda: () => send({ type: 'renda' }),
      sistema: (sistema) => send({ type: 'sistema', sistema }),
      chat: (c) => send({ type: 'chat', chatId: c.chatId, message: c.message }),
    };
    for (const [name, fn] of Object.entries(handlers)) sched.on(name, fn);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      for (const [name, fn] of Object.entries(handlers)) sched.off(name, fn);
    });
  });
}
