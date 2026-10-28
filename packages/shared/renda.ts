// Renda (Criativos Motion), candidaturas, rotinas e o painel "Hoje" (v3.1).
// Dinheiro sempre em centavos, com a moeda (ISO de 3 letras) ao lado.

export type LeadStatus = 'new' | 'qualified' | 'discarded' | 'converted';
export type ProposalState = 'ready' | 'sent' | 'replied' | 'paid' | 'lost';
export type PaymentKind = 'deposit' | 'balance' | 'recurring';
export type DeliveryState = 'briefing' | 'approved_scope' | 'in_production' | 'preview_sent' | 'revision' | 'final_sent' | 'accepted';
export type ApplicationState = 'found' | 'package_ready' | 'applied' | 'interview' | 'offer' | 'rejected' | 'discarded';

// Critérios da pontuação de lead (seção 5.1). Cada um vale 0, metade ou integral.
export const LEAD_CRITERIA = {
  demanda: { label: 'Demanda explícita e recente', max: 30 },
  aderencia: { label: 'Aderência ao pacote de 5 motions', max: 25 },
  orcamento: { label: 'Orçamento ou capacidade de compra', max: 20 },
  contato: { label: 'Contato comercial disponível', max: 15 },
  briefing: { label: 'Briefing viável e materiais autorizados', max: 10 },
} as const;
export type LeadCriterion = keyof typeof LEAD_CRITERIA;
export type CriterionLevel = 'zero' | 'metade' | 'integral';

export const LEAD_PROPOSAL_MIN = 70;
export const LEAD_PREVIEW_MIN = 85;

// Oferta principal (decisão do Emannuel, seção 11).
export const MOTION_OFFER = {
  nome: '5 motions de até 15 s',
  precos: { BRL: 29000, USD: 7900 } as Record<string, number>,
  entradaPct: 50,
  prazoDiasUteis: 3,
  ajustes: 1,
};

export interface Lead {
  id: string;
  projectId: string;
  sourceUrl: string;
  collectedAt: string;
  postedAt: string | null;
  company: string | null;
  channel: string | null;
  need: string;
  evidence: string;
  score: number;
  scoreDetail: Partial<Record<LeadCriterion, CriterionLevel>> | null;
  status: LeadStatus;
  discardReason: string | null;
}

export interface Proposal {
  id: string;
  leadId: string;
  body: string;
  scope: string;
  state: ProposalState;
  amountCents: number;
  currency: string;
  sentAt: string | null;
  repliedAt: string | null;
  nextAction: string | null;
  dueAt: string | null;
  lostReason: string | null;
  recurring: boolean;
  humanMinutes: number;
  createdAt: string;
  // Calculados no servidor.
  receivedCents: number;
  lead: Pick<Lead, 'company' | 'channel' | 'sourceUrl' | 'need' | 'score'> | null;
}

export interface Payment {
  id: string;
  proposalId: string;
  currency: string;
  amountCents: number;
  kind: PaymentKind;
  receivedAt: string;
  receiptRef: string;
}

export interface Delivery {
  id: string;
  proposalId: string;
  state: DeliveryState;
  dueAt: string | null;
  revisions: number;
  late: boolean;
  costCents: number;
  currency: string;
}

export interface JobApplication {
  id: string;
  sourceUrl: string;
  collectedAt: string;
  employer: string | null;
  title: string;
  location: string | null;
  score: number;
  state: ApplicationState;
  appliedAt: string | null;
  nextAction: string | null;
  dueAt: string | null;
  notes: string | null;
}

export const PROPOSAL_STATE_LABEL: Record<ProposalState, string> = {
  ready: 'Pronto',
  sent: 'Enviado',
  replied: 'Respondeu',
  paid: 'Pago',
  lost: 'Perdido',
};

export const APPLICATION_STATE_LABEL: Record<ApplicationState, string> = {
  found: 'Encontrada',
  package_ready: 'Pacote pronto',
  applied: 'Candidatura enviada',
  interview: 'Entrevista',
  offer: 'Proposta',
  rejected: 'Recusada',
  discarded: 'Descartada',
};

export interface IncomeGoal {
  id: string;
  titulo: string;
  prazo: string;
  alvo: number;
  atual: number;
}

export interface IncomeView {
  metas: IncomeGoal[];
  funil: Record<ProposalState, number>;
  recebido: Record<string, number>;
  // Faturamento previsto (propostas abertas) não é caixa.
  previsto: Record<string, number>;
  conversao: number | null;
  minutosPorPacote: number | null;
  motivosPerda: { motivo: string; n: number }[];
  leads: { novos: number; qualificados: number; descartados: number };
  propostas: Proposal[];
  leadsRecentes: Lead[];
}

// ---------- rotinas ----------
export type RunState = 'pending' | 'running' | 'done' | 'failed';

export interface RoutineView {
  id: string;
  nome: string;
  descricao: string;
  agente: string;
  schedule: string;
  timezone: string;
  enabled: boolean;
  proxima: string | null;
  ultima: { em: string; estado: RunState; jobId: string | null; escopo: string } | null;
}

// ---------- painel Hoje (bloco humano de 45 min) ----------
export type HojeBloco = 'propostas' | 'respostas' | 'candidaturas' | 'decisoes';
export type HojeTarefaEstado = 'aberta' | 'feita' | 'pulada';
export type HojeTarefaOrigem = 'claude' | 'codex' | 'rocky' | 'emannuel';

export interface NovaHojeTarefa {
  data?: string;
  bloco: HojeBloco;
  titulo: string;
  detalhe?: string;
  minutos: number;
  ordem?: number;
  textoCopiar?: string;
  url?: string;
  arquivo?: string;
  origem: HojeTarefaOrigem;
}

export interface HojeTarefa {
  id: string;
  data: string;
  bloco: HojeBloco;
  titulo: string;
  detalhe: string;
  minutos: number;
  ordem: number;
  textoCopiar: string | null;
  url: string | null;
  arquivo: string | null;
  estado: HojeTarefaEstado;
  criadaEm: string;
  feitaEm: string | null;
  origem: HojeTarefaOrigem;
}

export const HOJE_BLOCOS: Record<HojeBloco, { titulo: string; minutos: number }> = {
  propostas: { titulo: 'Propostas e follow-ups', minutos: 15 },
  respostas: { titulo: 'Respostas e cobrança', minutos: 10 },
  candidaturas: { titulo: 'Candidaturas', minutos: 10 },
  decisoes: { titulo: 'Decisões e QA visual', minutos: 10 },
};

export type HojeAcao =
  | { tipo: 'copiar'; rotulo: string; texto: string }
  | { tipo: 'abrir'; rotulo: string; url: string }
  | { tipo: 'arquivo'; rotulo: string; arquivo: string }
  | { tipo: 'tarefa'; rotulo: string; tarefaId: string; estado: HojeTarefaEstado }
  | { tipo: 'proposta'; rotulo: string; proposalId: string; para: ProposalState }
  | { tipo: 'candidatura'; rotulo: string; applicationId: string; para: ApplicationState }
  | { tipo: 'pagamento'; rotulo: string; proposalId: string; sugestaoCents: number; moeda: string }
  | { tipo: 'pedido'; rotulo: string; pedidoId: string; resposta: 'sim' | 'nao' }
  | { tipo: 'job'; rotulo: string; jobId: string }
  | { tipo: 'objetivo'; rotulo: string; objectiveId: string };

export interface HojeItem {
  id: string;
  ordem?: number;
  deOntem?: boolean;
  bloco: HojeBloco;
  titulo: string;
  detalhe: string;
  minutos: number;
  prazo: string | null;
  acoes: HojeAcao[];
}

export interface HojeView {
  // Até 3 resultados ativos definidos pelo Rocky (venda, entrega, desbloqueio).
  prioridades: { tipo: string; titulo: string }[];
  data: string;
  timezone: string;
  orcamentoMin: number;
  totalMin: number;
  itens: HojeItem[];
}
