// Tipos compartilhados entre servidor e interface.
import type { ImmigrationState } from './immigration.ts';

export type AgentId = 'claude' | 'codex' | 'rocky' | 'hermes' | 'openclaw';
// OpenClaw e Hermes: agentes abertos (rodam quando instalados e configurados).
export type RunnableAgent = 'claude' | 'codex' | 'openclaw' | 'hermes';
export const RUNNABLE_AGENTS: RunnableAgent[] = ['claude', 'codex', 'openclaw', 'hermes'];

// approval  = aguardando aprovação AMARELA antes de rodar
// reviewing = terminou; o outro agente está revisando (ou o autor corrigindo)
// review    = aguardando você: merge (AMARELO), descarte ou decisão após revisão reprovada
export type JobStatus = 'queued' | 'approval' | 'running' | 'reviewing' | 'review' | 'done' | 'failed' | 'canceled';
export type Risk = 'verde' | 'amarelo' | 'vermelho';

// task = trabalho; plan = plano do Rocky; review = revisão cruzada; fix = correção após revisão reprovada;
// research = pesquisa (só leitura + web) que alimenta um módulo, como Imigração
export type JobKind = 'task' | 'plan' | 'review' | 'fix' | 'research';
export type Verdict = 'aprovado' | 'reprovado' | 'indefinido';

export type Column = 'todo' | 'running' | 'waiting' | 'done' | 'failed';
export const COLUMN_OF: Record<JobStatus, Column> = {
  queued: 'todo',
  approval: 'waiting',
  running: 'running',
  reviewing: 'running',
  review: 'waiting',
  done: 'done',
  failed: 'failed',
  canceled: 'failed',
};

export interface Project {
  id: string;
  name: string;
  path: string;
  isGit: boolean;
  // Pasta do projeto no vault (20 - PROJECTS/...), quando existe.
  vaultFolder: string | null;
  // Projeto de teste: não gera notas no vault.
  isTest: boolean;
  isLegacy: boolean;
  createdAt: string;
}

export interface Job {
  id: string;
  title: string;
  prompt: string;
  agent: RunnableAgent;
  projectId: string;
  risk: Risk;
  status: JobStatus;
  step: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  sessionId: string | null;
  worktree: string | null;
  branch: string | null;
  baseCommit: string | null;
  error: string | null;
  summary: string | null;
  filesChanged: string[];
  timeoutMin: number;
  kind: JobKind;
  objectiveId: string | null;
  planKey: string | null;
  dependsOn: string[];
  acceptance: string | null;
  // Em revisões e correções: o job de trabalho revisado.
  targetJobId: string | null;
  // No job de trabalho: quantas correções já foram feitas após revisão reprovada.
  attempt: number;
  verdict: Verdict | null;
  vaultNote: string | null;
  // Tokens e contexto (ao vivo enquanto roda; total no fim).
  usage: JobUsage | null;
  // Rotina que criou o job (v3.1): conclusões de execuções antigas são rejeitadas.
  routineRunId: string | null;
  // Precisa da GPU (modelo local, render, instalação pesada): entra na fila de GPU e respeita o modo jogo.
  gpuRequired: boolean;
  lastCheckpointAt: string | null;
  parentJobId: string | null;
  depth: number;
}

export interface JobUsage {
  model: string | null;
  input: number; // entrada sem cache
  output: number;
  cacheRead: number;
  cacheWrite: number;
  context: number; // tamanho do contexto na última chamada ao modelo
  contextMax: number | null;
  // Quanto custaria na API (na assinatura não é cobrado por token).
  costUsd: number | null;
  calls: number;
  updatedAt: string;
}

// Aba Agentes: cada "harness" (programa que roda agentes) e o que está rodando nele.
export type HarnessId = 'claude-code' | 'codex' | 'hermes' | 'openclaw';
export interface HarnessAgent {
  id: string;
  nome: string;
  papel: string;
  origem: 'emannu' | 'harness';
  // Tipo de job do EMANNU OS que este agente executa (para contar quem está trabalhando).
  kind: JobKind | null;
  // Agentes agendados (ex.: caçador diário): quando roda e se está rodando agora.
  agenda?: { ultima: string | null; proxima: string | null; rodando: boolean; frequencia: string } | null;
}
export interface HarnessView {
  id: HarnessId;
  nome: string;
  agentId: AgentId;
  estado: 'ativo' | 'pausado' | 'nao_instalado' | 'sem_adaptador' | 'sem_login';
  versao: string | null;
  modelo: string | null;
  limites: string | null;
  caminho: string | null;
  // Agentes do EMANNU OS que rodam neste harness + agentes próprios do harness.
  agentes: HarnessAgent[];
  nota: string | null;
}

export type ObjectiveStatus = 'proposed' | 'planning' | 'plan_ready' | 'running' | 'attention' | 'ready' | 'done' | 'failed' | 'canceled';
// Estados em que o objetivo espera uma decisão sua.
export const OBJECTIVE_WAITING: ObjectiveStatus[] = ['proposed', 'plan_ready', 'attention', 'ready'];

export interface PlanItem {
  key: string;
  title: string;
  agent: RunnableAgent;
  task: string;
  acceptance: string;
  risk: Risk;
  dependsOn: string[];
  kind: 'implementacao' | 'pesquisa' | 'texto';
  minutes: number;
}

export interface Plan {
  summary: string;
  items: PlanItem[];
  // Itens VERMELHOS: o sistema só prepara, você faz.
  manual: string[];
}

export interface Objective {
  id: string;
  title: string;
  description: string;
  projectId: string | null;
  status: ObjectiveStatus;
  plan: Plan | null;
  contextPack: string | null;
  planJobId: string | null;
  branch: string | null;
  worktree: string | null;
  baseCommit: string | null;
  createdAt: string;
  approvedAt: string | null;
  finishedAt: string | null;
  vaultNote: string | null;
  source: 'ui' | 'inbox';
  sourcePath: string | null;
  error: string | null;
  summary: string | null;
}

export interface NewObjectiveInput {
  title: string;
  description: string;
  projectId: string;
}

export type EventKind = 'status' | 'system' | 'text' | 'tool' | 'output' | 'result' | 'warning' | 'error' | 'stderr';

export interface JobEvent {
  id: number;
  jobId: string;
  ts: string;
  kind: EventKind;
  text: string;
}

export interface AgentState {
  id: AgentId;
  name: string;
  role: string;
  runnable: boolean;
  installed: boolean;
  authenticated: boolean | null;
  version: string | null;
  runningJobs: string[];
  limit: number;
  paused: boolean;
  pausedReason: string | null;
  note: string | null;
}

export interface NewJobInput {
  // Usa a GPU (render, modelo local, instalação pesada): fila de GPU e modo jogo.
  gpuRequired?: boolean;
  title: string;
  prompt: string;
  agent: RunnableAgent;
  projectId: string;
  risk?: Risk;
  timeoutMin?: number;
}

// Card da aba Projetos: junta o cockpit antigo, o vault e o que roda no v3.
export interface ProjectCard {
  id: string;
  nome: string;
  isLegacy: boolean;
  logo: string | null;
  badge: string | null;
  proposito: string | null;
  estadoAtual: { texto: string; fonte: string } | null;
  legado: { estado: string; feito: string; planejado: string; proximos: string[]; bloqueios: string[]; importadoEm: string } | null;
  pasta: { projectId: string; path: string; isGit: boolean } | null;
  // Aviso sobre a pasta (ex.: "código não localizado").
  nota?: string | null;
  vaultFolder: string | null;
  jobsAbertos: number;
  aguardandoVoce: number;
  entregas: { id: string; titulo: string; data: string; tipo: 'objetivo' | 'job' }[];
  midias: { total: number; porTipo: Record<string, number>; amostra: { id: string; title: string; kind: string }[] };
  documentos: { id: string; title: string; kind: string; path: string }[];
  // O que já foi feito em sessões do Claude Code nas pastas do projeto.
  codigo?: {
    total: number;
    sessoes: { id: string; title: string; firstAt: string; lastAt: string; prompts: number; cwd: string }[];
    historico: {
      geradoEm: string;
      sessoes: number;
      resumo: string;
      feito: string[];
      decisoes: string[];
      entregas: { titulo: string; caminho: string }[];
      pendencias: string[];
      proximos: string[];
      vaultNote: string | null;
    } | null;
    gerando: boolean;
  };
  // Só no card da Imigração Portugal: resumo do espaço próprio.
  imigracao?: {
    rota: string | null;
    familiaJunta: string | null;
    naoConfirmados: number;
    vagas: number;
    vagasComVisto: number;
    candidaturasProntas: number;
    docsProntos: number;
    docsTotal: number;
    proximoPrazo: { data: string; titulo: string; diasAte: number } | null;
    fontes: number;
    fontesRever: number;
    pesquisadoEm: string | null;
  };
}

export interface ClientConfig {
  vaultName: string;
}

export type StreamMessage =
  | { type: 'snapshot'; jobs: Job[]; agents: AgentState[]; projects: Project[]; objectives: Objective[]; config: ClientConfig }
  | { type: 'job'; job: Job }
  | { type: 'objective'; objective: Objective }
  | { type: 'immigration'; state: ImmigrationState }
  | { type: 'renda' }
  | { type: 'sistema'; sistema: SistemaView }
  | { type: 'chat'; chatId: string; message: { id: number; chatId: string; role: string; text: string; jobId: string | null; createdAt: string; meta: Record<string, unknown> | null } }
  | { type: 'event'; event: JobEvent }
  | { type: 'agents'; agents: AgentState[] }
  | { type: 'projects'; projects: Project[] };

// v3.1: capacidade por grupo, GPU e modo jogo (aba Agentes e barra).
export interface SistemaView {
  capacidade: { id: string; agentes: string[]; maxParallel: number; dailyMinutes: number; reservedPct: number; usadoHoje: number; reservadoAgora: number; rodando: number; pausadoAte: string | null }[];
  gpu: { jobId: string; titulo: string | null } | null;
  modoJogo: { ativo: boolean; desde: string | null; motivo: string | null; pausarTudo: boolean; historico: { inicio: string; fim: string | null; motivo: string }[] };
  autoMerge?: { limpas: number; desde: string | null; suspenso: string | null; todos: boolean };
}
