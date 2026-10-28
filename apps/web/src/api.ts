import { useEffect, useReducer, useState } from 'react';
import type { ImmigrationState, ImmigrationUser, ResearchTopic } from '../../../packages/shared/immigration.ts';
import type { ApplicationState, HojeTarefa, HojeTarefaEstado, HojeView, IncomeView, JobApplication, PaymentKind, Proposal, ProposalState, RoutineView } from '../../../packages/shared/renda.ts';
import type { SistemaView } from '../../../packages/shared/types.ts';
import type { DirEntry, FileGroup, FileKind, IndexStatus, LibFile, RootView } from '../../../packages/shared/arquivos.ts';
import type { AgentState, ClientConfig, Job, JobEvent, NewJobInput, NewObjectiveInput, Objective, Project, RunnableAgent, StreamMessage } from '../../../packages/shared/types.ts';

// Avisa o app quando o servidor recusa o aparelho (token revogado ou expirado).
export const UNAUTH_EVENT = 'emannu:unauth';

export async function api<T = unknown>(path: string, body?: unknown, method?: string, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Sem conexão com o PC (desligado, dormindo ou fora do Tailscale).');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event(UNAUTH_EVENT));
  if (!res.ok) throw new Error((data as any).error ?? `Erro ${res.status}`);
  return data as T;
}

export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
  device: Device | null;
  local: boolean;
}

export interface Device {
  id: string;
  name: string;
  createdAt: string;
  lastSeen: string;
  current?: boolean;
}

export const authApi = {
  status: () => api<AuthStatus>('/api/auth/status'),
  setup: (pin: string, deviceName: string) => api<{ device: Device }>('/api/auth/setup', { pin, deviceName }),
  login: (pin: string, deviceName: string) => api<{ device: Device }>('/api/auth/login', { pin, deviceName }),
  logout: () => api('/api/auth/logout', {}),
  devices: () => api<Device[]>('/api/auth/devices'),
  revoke: (id: string) => api(`/api/auth/devices/${id}`, undefined, 'DELETE'),
  changePin: (atual: string, novo: string) => api('/api/auth/pin', { atual, novo }),
};

export const pushApi = {
  key: () => api<{ publicKey: string | null; subscriptions: number }>('/api/push/key'),
  subscribe: (sub: PushSubscriptionJSON) => api('/api/push/subscribe', sub),
  unsubscribe: (endpoint: string) => api('/api/push/unsubscribe', { endpoint }),
  test: () => api<{ sent: number; removed: number }>('/api/push/test', {}),
};

export const actions = {
  createJob: (input: NewJobInput) => api<Job>('/api/jobs', input),
  cancel: (id: string) => api<Job>(`/api/jobs/${id}/cancel`, {}),
  retry: (id: string) => api<Job>(`/api/jobs/${id}/retry`, {}),
  approve: (id: string) => api<Job>(`/api/jobs/${id}/approve`, {}),
  discard: (id: string) => api<Job>(`/api/jobs/${id}/discard`, {}),
  requestReview: (id: string) => api<Job>(`/api/jobs/${id}/request-review`, {}),
  createObjective: (input: NewObjectiveInput) => api<Objective>('/api/objectives', input),
  planObjective: (id: string, body: { projectId?: string; feedback?: string } = {}) => api<Objective>(`/api/objectives/${id}/plan`, body),
  approvePlan: (id: string, agents: Record<string, RunnableAgent>) => api<Objective>(`/api/objectives/${id}/approve-plan`, { agents }),
  approveDelivery: (id: string) => api<Objective>(`/api/objectives/${id}/approve-delivery`, {}),
  cancelObjective: (id: string) => api<Objective>(`/api/objectives/${id}/cancel`, {}),
  events: (id: string) => api<JobEvent[]>(`/api/jobs/${id}/events`),
  diff: (id: string) => api<{ files: string[]; stat: string; diff: string; truncated: boolean }>(`/api/jobs/${id}/diff`),
  resumeAgent: (id: string) => api<AgentState[]>(`/api/agents/${id}/resume`, {}),
  refreshAgents: () => api<AgentState[]>('/api/agents/refresh', {}),
  addProject: (name: string, path: string) => api<Project>('/api/projects', { name, path }),
};

// Link que abre a nota no app Obsidian (PC ou celular).
export function obsidianLink(config: ClientConfig, relPath: string): string {
  return `obsidian://open?vault=${encodeURIComponent(config.vaultName)}&file=${encodeURIComponent(relPath.replace(/\.md$/, ''))}`;
}

// Preferências da interface guardadas no PC (valem para todos os aparelhos).
export interface Prefs {
  abas?: string[];
}
export const prefsApi = {
  get: () => api<Prefs>('/api/preferencias'),
  save: (p: Prefs) => api<Prefs>('/api/preferencias', p, 'PUT'),
};

export const immigrationApi = {
  get: () => api<ImmigrationState>('/api/imigracao'),
  update: (patch: Partial<ImmigrationUser>) => api<ImmigrationState>('/api/imigracao/user', patch, 'PATCH'),
  research: (topics?: ResearchTopic[]) => api('/api/imigracao/pesquisar', { topics }),
  prepare: (vagaId: string) => api<Job>(`/api/imigracao/vagas/${encodeURIComponent(vagaId)}/preparar`, {}),
};

// Renda e painel Hoje. Ações humanas pedem antes uma confirmação ao servidor (só um
// aparelho seu consegue) e a mandam junto, de uso único.
async function human<T>(acao: string, alvo: string, path: string, body: unknown): Promise<T> {
  const { id } = await api<{ id: string }>('/api/confirmacoes', { acao, alvo });
  return api<T>(path, body, 'POST', { 'X-Emannu-Confirm': id });
}

export const rendaApi = {
  income: () => api<IncomeView>('/api/income'),
  hoje: () => api<HojeView>('/api/hoje'),
  tarefa: (id: string, estado: HojeTarefaEstado) => human<HojeTarefa>(`tarefa:${estado}`, id, `/api/hoje/tarefas/${encodeURIComponent(id)}`, { estado }),
  routines: () => api<{ rotinas: RoutineView[]; modoJogo: { inicio: string; fim: string | null; motivo: string }[] }>('/api/routines'),
  setRoutine: (id: string, enabled: boolean) => api<RoutineView>(`/api/routines/${encodeURIComponent(id)}`, { enabled }, 'PATCH'),
  findLeads: () => api<Job>('/api/leads', {}),
  makeProposals: () => api<Job>('/api/proposals', {}),
  proposal: (id: string, para: ProposalState, extra: { motivo?: string; minutos?: number } = {}) => human<Proposal>(`proposta:${para}`, id, `/api/proposals/${encodeURIComponent(id)}/transition`, { para, ...extra }),
  payment: (proposalId: string, valorCents: number, tipo: PaymentKind, comprovante: string) => human('pagamento', proposalId, '/api/payments', { proposalId, valorCents, tipo, comprovante }),
  answerRocky: (id: string, resposta: 'sim' | 'nao') => api(`/api/rocky/pedidos/${encodeURIComponent(id)}`, { resposta }),
  setPauseAll: (pausarTudo: boolean) => api('/api/modo-jogo', { pausarTudo }, 'PUT'),
  application: (id: string, para: ApplicationState) => human<JobApplication>(`candidatura:${para}`, id, `/api/applications/${encodeURIComponent(id)}/transition`, { para }),
};

export interface LiveState {
  // Muda quando algo da renda muda (as abas Renda e Hoje recarregam).
  rendaVersion: number;
  // Capacidade por grupo, GPU e modo jogo.
  sistema: SistemaView | null;
  chatEvent: { chatId: string; messageId: number } | null;
  immigration: ImmigrationState | null;
  jobs: Record<string, Job>;
  objectives: Record<string, Objective>;
  config: ClientConfig;
  agents: AgentState[];
  projects: Project[];
  // Últimos eventos de cada job (para o mini-log do card e o log ao vivo).
  events: Record<string, JobEvent[]>;
}

const MAX_EVENTS_PER_JOB = 400;

function reducer(state: LiveState, msg: StreamMessage | { type: 'events'; jobId: string; events: JobEvent[] }): LiveState {
  switch (msg.type) {
    case 'snapshot':
      return {
        ...state,
        jobs: Object.fromEntries(msg.jobs.map((j) => [j.id, j])),
        objectives: Object.fromEntries(msg.objectives.map((o) => [o.id, o])),
        config: msg.config,
        agents: msg.agents,
        projects: msg.projects,
        // Reconexão: Renda e Hoje recarregam (algo pode ter mudado enquanto estava fora).
        rendaVersion: state.rendaVersion + 1,
      };
    case 'job':
      return { ...state, jobs: { ...state.jobs, [msg.job.id]: msg.job } };
    case 'objective':
      return { ...state, objectives: { ...state.objectives, [msg.objective.id]: msg.objective } };
    case 'immigration':
      return { ...state, immigration: msg.state, rendaVersion: state.rendaVersion + 1 };
    case 'renda':
      return { ...state, rendaVersion: state.rendaVersion + 1 };
    case 'sistema':
      return { ...state, sistema: msg.sistema };
    case 'chat':
      // Mensagem nova numa conversa (ex.: síntese do Conselho chegando depois).
      return { ...state, chatEvent: { chatId: msg.chatId, messageId: msg.message.id } };
    case 'agents':
      return { ...state, agents: msg.agents };
    case 'projects':
      return { ...state, projects: msg.projects };
    case 'event': {
      const list = state.events[msg.event.jobId] ?? [];
      if (list.some((e) => e.id === msg.event.id)) return state;
      return { ...state, events: { ...state.events, [msg.event.jobId]: [...list, msg.event].slice(-MAX_EVENTS_PER_JOB) } };
    }
    case 'events': {
      // Junta o histórico carregado com o que já chegou ao vivo.
      const seen = new Map<number, JobEvent>();
      for (const e of [...msg.events, ...(state.events[msg.jobId] ?? [])]) seen.set(e.id, e);
      const merged = [...seen.values()].sort((a, b) => a.id - b.id).slice(-MAX_EVENTS_PER_JOB);
      return { ...state, events: { ...state.events, [msg.jobId]: merged } };
    }
  }
}

// Último retrato dos dados, guardado no aparelho para abrir com o PC desligado.
const SNAPSHOT_KEY = 'emannu.snapshot.v1';
const EMPTY: LiveState = { rendaVersion: 0, sistema: null, chatEvent: null, immigration: null, jobs: {}, objectives: {}, config: { vaultName: '' }, agents: [], projects: [], events: {} };

function loadSnapshot(): { state: LiveState; savedAt: string } | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return { state: { ...EMPTY, ...s.state, events: {}, rendaVersion: 0 }, savedAt: s.savedAt };
  } catch {
    return null;
  }
}

function saveSnapshot(state: LiveState): string | null {
  const savedAt = new Date().toISOString();
  try {
    const { events: _e, ...rest } = state;
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ state: rest, savedAt }));
    return savedAt;
  } catch {
    return null;
  }
}

export function hasSnapshot(): boolean {
  return !!loadSnapshot();
}

export function clearSnapshot(): void {
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
  } catch {}
}

export function useLive() {
  const [cached] = useState(loadSnapshot);
  const [state, dispatch] = useReducer(reducer, cached?.state ?? EMPTY);
  const [connected, setConnected] = useState(false);
  // Hora dos dados exibidos: agora (ao vivo) ou a do último retrato salvo.
  const [dataAt, setDataAt] = useState<string | null>(cached?.savedAt ?? null);

  useEffect(() => {
    if (!connected) return;
    const t = setTimeout(() => {
      const at = saveSnapshot(state);
      if (at) setDataAt(at);
    }, 2000);
    return () => clearTimeout(t);
  }, [state, connected]);

  // O estado da Imigração não vem no snapshot: carrega ao conectar e depois chega pelo stream.
  useEffect(() => {
    if (connected) immigrationApi.get().then((s) => dispatch({ type: 'immigration', state: s })).catch(() => {});
  }, [connected]);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      es = new EventSource('/api/stream');
      es.onopen = () => setConnected(true);
      es.onmessage = (e) => dispatch(JSON.parse(e.data));
      es.onerror = () => {
        setConnected(false);
        es?.close();
        retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      clearTimeout(retry);
      es?.close();
    };
  }, []);

  const loadEvents = async (jobId: string) => {
    const events = await actions.events(jobId);
    dispatch({ type: 'events', jobId, events });
  };

  const setImmigration = (s: ImmigrationState) => dispatch({ type: 'immigration', state: s });

  return { state, connected, dataAt, loadEvents, setImmigration };
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ---------- aba Arquivos ----------
const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
export const fileUrl = (r: string, p: string, baixar = false) => `/api/arquivos/f/${encodeURIComponent(r)}/${encPath(p)}${baixar ? '?baixar=1' : ''}`;
export const miniUrl = (r: string, p: string, w = 360) => `/api/arquivos/mini/${encodeURIComponent(r)}/${encPath(p)}?w=${w}`;
const qs = (o: Record<string, string | undefined>) => new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => e[1] !== undefined)).toString();
export const arquivosApi = {
  info: () => api<{ raizes: RootView[]; indice: IndexStatus }>('/api/arquivos'),
  reindexar: () => api<IndexStatus>('/api/arquivos/reindexar', {}),
  pasta: (r: string, p: string) => api<{ raiz: RootView; p: string; itens: DirEntry[] }>(`/api/arquivos/pasta?${qs({ r, p })}`),
  grupos: (tipo: FileKind, r?: string) => api<FileGroup[]>(`/api/arquivos/grupos?${qs({ tipo, r })}`),
  itens: (q: { tipo?: FileKind; r?: string; dir?: string; q?: string; limite?: number }) =>
    api<{ itens: LibFile[]; total: number }>(`/api/arquivos/itens?${qs({ tipo: q.tipo, r: q.r, dir: q.dir, q: q.q, limite: q.limite ? String(q.limite) : undefined })}`),
  localizar: (caminho: string) => api<{ r: string | null; p: string | null; bytes?: number }>(`/api/arquivos/localizar?${qs({ caminho })}`),
};
