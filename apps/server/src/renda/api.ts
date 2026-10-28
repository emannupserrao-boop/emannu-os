// API da renda, das candidaturas, das rotinas e do painel Hoje (v3.1, seção 4.2).
import type { FastifyInstance } from 'fastify';
import type { ApplicationState, HojeTarefaEstado, NovaHojeTarefa, PaymentKind, ProposalState } from '../../../../packages/shared/renda.ts';
import type { Scheduler } from '../scheduler.ts';
import { HumanConfirm } from './human.ts';
import { buildHoje } from './hoje.ts';
import { HojeTarefas } from './hoje-tarefas.ts';

// Ações que exigem você (aparelho registrado + confirmação na interface).
const HUMAN_ACTIONS = ['integracao:slack', 'automerge:retomar', 'proposta:sent', 'proposta:replied', 'proposta:lost', 'pagamento', 'candidatura:applied', 'candidatura:interview', 'candidatura:offer', 'candidatura:rejected', 'candidatura:discarded', 'lead:discard', 'tarefa:feita', 'tarefa:pulada', 'tarefa:aberta'];
const CONFIRM_HEADER = 'x-emannu-confirm';

export function registerRendaApi(app: FastifyInstance, sched: Scheduler, human = new HumanConfirm()) {
  const renda = () => {
    if (!sched.renda) throw new Error('Módulo de renda desativado');
    return sched.renda;
  };
  const changed = () => sched.emit('renda', null);
  const tarefas = new HojeTarefas(sched.store);

  // Pede uma confirmação para uma ação humana (só um aparelho seu consegue).
  app.post<{ Body: { acao?: string; alvo?: string } }>('/api/confirmacoes', async (req) => {
    const acao = String(req.body?.acao ?? '');
    const alvo = String(req.body?.alvo ?? '');
    if (!HUMAN_ACTIONS.includes(acao) || !alvo) throw new Error('Ação inválida');
    return human.request(req.device, acao, alvo);
  });

  app.get('/api/income', async () => renda().store.income());
  app.get('/api/hoje', async () => buildHoje(sched));

  // Agentes preparam tarefas; só o Emannuel confirma o estado.
  app.post<{ Body: NovaHojeTarefa }>('/api/hoje/tarefas', async (req) => {
    const tarefa = tarefas.criar(req.body);
    changed();
    return tarefa;
  });
  app.get<{ Querystring: { data?: string } }>('/api/hoje/tarefas', async (req) => tarefas.listar(req.query.data));
  app.post<{ Params: { id: string }; Body: { estado?: HojeTarefaEstado } }>('/api/hoje/tarefas/:id', async (req) => {
    const estado = req.body?.estado;
    if (!estado || !['feita', 'pulada', 'aberta'].includes(estado)) throw new Error('Estado inválido.');
    human.verify(req.device, req.headers[CONFIRM_HEADER], `tarefa:${estado}`, req.params.id);
    const tarefa = tarefas.mudarEstado(req.params.id, estado);
    changed();
    return tarefa;
  });
  app.delete<{ Params: { id: string } }>('/api/hoje/tarefas/:id', async (req) => {
    tarefas.remover(req.params.id);
    changed();
    return { ok: true };
  });

  // Leads
  app.get('/api/leads', async () => renda().store.leads());
  app.post('/api/leads', async () => renda().enqueueLeads());
  app.post<{ Params: { id: string }; Body: { motivo?: string } }>('/api/leads/:id/discard', async (req) => {
    human.verify(req.device, req.headers[CONFIRM_HEADER], 'lead:discard', req.params.id);
    const l = renda().store.discardLead(req.params.id, String(req.body?.motivo ?? ''));
    changed();
    return l;
  });

  // Propostas: os agentes só criam "Pronto"; tudo depois disso é você.
  app.get('/api/proposals', async () => renda().store.proposals());
  app.post('/api/proposals', async () => renda().enqueueProposals());
  app.post<{ Params: { id: string }; Body: { para?: ProposalState; motivo?: string; minutos?: number } }>('/api/proposals/:id/transition', async (req) => {
    const to = req.body?.para as ProposalState;
    if (!['sent', 'replied', 'lost'].includes(to)) throw new Error('Transição inválida');
    human.verify(req.device, req.headers[CONFIRM_HEADER], `proposta:${to}`, req.params.id);
    const p = renda().store.transitionProposal(req.params.id, to, { lostReason: req.body?.motivo, humanMinutes: Number(req.body?.minutos ?? 0) || 0 });
    changed();
    return p;
  });

  // Pagamentos: só você registra (o comprovante fica com você; aqui vai só a referência).
  app.post<{ Body: { proposalId?: string; valorCents?: number; tipo?: PaymentKind; comprovante?: string } }>('/api/payments', async (req) => {
    const proposalId = String(req.body?.proposalId ?? '');
    human.verify(req.device, req.headers[CONFIRM_HEADER], 'pagamento', proposalId);
    const r = renda().store.recordPayment({ proposalId, amountCents: Number(req.body?.valorCents), kind: (req.body?.tipo ?? 'deposit') as PaymentKind, receiptRef: String(req.body?.comprovante ?? '') });
    changed();
    return r;
  });

  // Candidaturas (vagas da Imigração e da IA)
  app.get('/api/applications', async () => renda().store.applications());
  app.post<{ Params: { id: string }; Body: { para?: ApplicationState } }>('/api/applications/:id/transition', async (req) => {
    const to = req.body?.para as ApplicationState;
    if (!['applied', 'interview', 'offer', 'rejected', 'discarded'].includes(to)) throw new Error('Transição inválida');
    human.verify(req.device, req.headers[CONFIRM_HEADER], `candidatura:${to}`, req.params.id);
    const a = renda().store.transitionApplication(req.params.id, to);
    // Mantém o status da vaga na Imigração igual ao da candidatura.
    const map: Partial<Record<ApplicationState, 'enviada' | 'entrevista' | 'descartada'>> = { applied: 'enviada', interview: 'entrevista', discarded: 'descartada', rejected: 'descartada' };
    if (map[to] && sched.immigration) sched.immigration.updateUser({ vagas: { [a.id]: { status: map[to]!, nota: sched.immigration.user().vagas[a.id]?.nota ?? '' } } } as any);
    changed();
    return a;
  });

  // Sistema: capacidade por grupo, GPU, modo jogo e auto-merge.
  app.get('/api/sistema', async () => ({ ...sched.sistema(), autoMerge: sched.autoMerge.state() }));
  app.get('/api/capacity', async () => sched.capacity.view());
  app.put<{ Body: { pausarTudo?: boolean } }>('/api/modo-jogo', async (req) => {
    const s = sched.gameMode.setPauseAll(!!req.body?.pausarTudo);
    sched.emit('sistema', sched.sistema());
    return s;
  });
  app.post('/api/automerge/retomar', async (req) => {
    human.verify(req.device, req.headers[CONFIRM_HEADER], 'automerge:retomar', 'automerge');
    return sched.autoMerge.resume();
  });

  // Rocky: último plano e respostas aos pedidos de tempo extra.
  app.get('/api/rocky', async () => sched.rocky?.last() ?? null);
  app.post<{ Params: { id: string }; Body: { resposta?: string } }>('/api/rocky/pedidos/:id', async (req) => {
    if (!sched.rocky) throw new Error('Rocky desativado');
    const r = req.body?.resposta;
    if (r !== 'sim' && r !== 'nao') throw new Error('Responda sim ou nao');
    if (!req.device || req.device === 'admin') throw Object.assign(new Error('Só o Emannuel responde, pelo app.'), { statusCode: 403 });
    return sched.rocky.answer(req.params.id, r);
  });

  // Conselho: a mesma pergunta para Claude e Hermes em paralelo, depois a síntese.
  app.get('/api/conselho', async () => sched.conselho?.list() ?? []);
  app.post<{ Body: { pergunta?: string } }>('/api/conselho', async (req) => {
    if (!sched.conselho) throw new Error('Conselho desativado');
    return sched.conselho.ask(String(req.body?.pergunta ?? ''));
  });

  // Memória do Hermes (perfil "pesquisa") e benchmark local.
  app.get('/api/memoria', async () => sched.memory.list());
  app.delete<{ Params: { i: string } }>('/api/memoria/:i', async (req) => {
    sched.memory.forget(Number(req.params.i));
    return sched.memory.list();
  });
  app.get('/api/benchmark', async () => ({ ultimo: sched.benchmark?.last() ?? null, lmStudio: (await sched.benchmark?.lmStudioModels()) ?? null, rodando: !!sched.benchRunner?.running }));
  // Roda o benchmark agora (só fora do modo jogo; GPU exclusiva). Responde logo; o resultado chega pelo job de notas.
  app.post<{ Body: { modelos?: unknown } }>('/api/benchmark/rodar', async (req) => {
    if (!sched.benchRunner) throw new Error('Benchmark desativado');
    if (sched.benchRunner.running) throw new Error('O benchmark já está rodando.');
    const block = sched.gameMode.blocks({ gpuRequired: true });
    if (block) throw new Error(block);
    const modelos = Array.isArray(req.body?.modelos) ? req.body!.modelos.map(String).slice(0, 4) : null;
    sched.benchRunner.run(fetch, modelos).catch((e) => console.warn('Benchmark:', e.message));
    return { ok: true };
  });

  // Rotinas
  app.get('/api/routines', async () => ({ rotinas: sched.routines.views(), modoJogo: sched.gameMode.state().historico }));
  app.patch<{ Params: { id: string }; Body: { enabled?: boolean } }>('/api/routines/:id', async (req) => {
    if (typeof req.body?.enabled !== 'boolean') throw new Error('Informe enabled: true ou false');
    if (!sched.routines.get(req.params.id)) throw new Error('Rotina não encontrada');
    sched.routines.store.setEnabled(req.params.id, req.body.enabled);
    return sched.routines.views().find((r) => r.id === req.params.id);
  });
}
