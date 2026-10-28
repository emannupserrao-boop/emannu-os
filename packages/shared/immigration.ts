// Imigração Portugal: tipos e cálculos usados pelo servidor e pela interface.
// Organização e pesquisa — não é parecer jurídico.

export interface Source {
  url: string;
  titulo: string;
  orgao: string;
  verificadoEm: string; // AAAA-MM-DD
  oficial: boolean; // calculado pelo servidor a partir do domínio
}

export type Tri = 'sim' | 'nao' | 'depende';
export type Eligibility = 'sim' | 'provavel' | 'incerto' | 'nao';

export interface Route {
  id: string;
  nome: string;
  resumo: string;
  elegibilidade: Eligibility;
  motivoElegibilidade: string;
  familiaJunta: Tri;
  familiaDetalhe: string;
  conjugePodeTrabalhar: Tri;
  conjugeDetalhe: string;
  requisitos: string[];
  custos: string[];
  prazos: string[];
  ondePedir: string;
  pros: string[];
  contras: string[];
  confirmarCom: string[];
  fontes: Source[];
}

export interface LawChange {
  tema: string;
  antes: string;
  depois: string;
  impacto: string;
  fontes: Source[];
}

export interface LegalResearch {
  geradoEm: string;
  lei: {
    diploma: string;
    publicadoEm: string;
    emVigorDesde: string;
    situacao: string;
    mudancas: LawChange[];
    regulamentacao: { titulo: string; resumo: string; fontes: Source[] }[];
    fontes: Source[];
  };
  rotas: Route[];
  recomendacao: { rotaId: string; titulo: string; porque: string; passos: string[]; planoB: string; incertezas: string[] };
}

export type Person = 'emmanuel' | 'esposa' | 'filha' | 'familia';
export const PERSON_LABEL: Record<Person, string> = { emmanuel: 'Requerente', esposa: 'Cônjuge', filha: 'Dependente', familia: 'Família' };

export interface DocItem {
  id: string;
  pessoa: Person;
  documento: string;
  paraQue: string;
  ondeObter: string;
  apostila: boolean | null;
  traducao: boolean | null;
  validade: string;
  observacoes: string;
  fontes: Source[];
}

export interface DocsResearch {
  geradoEm: string;
  itens: DocItem[];
  regras: string[]; // regras gerais (apostila, tradução certificada, validade de antecedentes...)
}

export interface LivingResearch {
  geradoEm: string;
  cambio: { ronPorEur: number; data: string; fonte: Source | null };
  moradia: { cidade: string; zona: string; tipologia: string; minEur: number; maxEur: number; observacao: string; fontes: Source[] }[];
  custosMensais: { item: string; bragaEur: number; barcelosEur: number; observacao: string; fontes: Source[] }[];
  mudanca: { item: string; minEur: number; maxEur: number; observacao: string; fontes: Source[] }[];
  escola: { resumo: string; passos: string[]; documentos: string[]; prazos: string[]; fontes: Source[] };
  bairros: { cidade: string; nome: string; porque: string }[];
  salarios: { referencia: string; valorEur: number; observacao: string; fontes: Source[] }[];
}

export interface JobOffer {
  id: string;
  empresa: string;
  titulo: string;
  local: string;
  modalidade: 'remoto' | 'hibrido' | 'presencial';
  porque: string;
  elegibilidade: string;
  // Um contrato desta vaga serve de base para um visto de trabalho em Portugal?
  permiteVisto: 'sim' | 'nao' | 'incerto';
  salario: string;
  url: string;
  verificadoEm: string;
  condicoes: string[];
  proximoPasso: string;
  origem: 'legado' | 'pesquisa';
  // portugal = vaga com contrato em Portugal (Imigração); ai = trabalho remoto de IA (seção IA).
  categoria?: 'portugal' | 'ai';
  // Data em que o anúncio foi publicado (se o anúncio mostrar) e em que o EMANNU OS a viu pela primeira vez.
  publicadaEm?: string | null;
  encontradaEm?: string;
}

// Apartamento para alugar (pesquisa diária). Só dados do anúncio; contato e visita são com você.
export interface Apartment {
  id: string;
  titulo: string;
  cidade: string;
  zona: string;
  tipologia: string; // T1, T2, T3...
  precoEur: number; // renda mensal
  areaM2: number | null;
  mobiliado: 'sim' | 'nao' | 'incerto';
  url: string;
  fonte: string; // idealista, imovirtual, casa sapo...
  publicadaEm: string | null;
  verificadoEm: string;
  encontradaEm?: string;
  observacao: string;
}

export interface ApartmentsResearch {
  geradoEm: string;
  apartamentos: Apartment[];
}

export type AptStatus = 'novo' | 'interessante' | 'visitar' | 'descartado';
export const APT_STATUS_LABEL: Record<AptStatus, string> = { novo: 'Novo', interessante: 'Interessante', visitar: 'Quero visitar', descartado: 'Descartado' };

export interface JobsResearch {
  geradoEm: string;
  vagas: JobOffer[];
}

export type DocStatus = 'falta' | 'pedido' | 'pronto' | 'apostilado' | 'traduzido' | 'nao_precisa';
export const DOC_STATUS_LABEL: Record<DocStatus, string> = {
  falta: 'Falta',
  pedido: 'Pedido',
  pronto: 'Pronto',
  apostilado: 'Apostilado',
  traduzido: 'Traduzido',
  nao_precisa: 'Não precisa',
};
export const DOC_DONE: DocStatus[] = ['pronto', 'apostilado', 'traduzido', 'nao_precisa'];

// Candidatura é VERMELHO: o sistema prepara, você envia.
export type JobPipelineStatus = 'nova' | 'interessante' | 'preparar' | 'pronta' | 'enviada' | 'entrevista' | 'descartada';
export const JOB_STATUS_LABEL: Record<JobPipelineStatus, string> = {
  nova: 'Nova',
  interessante: 'Interessante',
  preparar: 'Preparando',
  pronta: 'Pronta (você envia)',
  enviada: 'Enviada por você',
  entrevista: 'Entrevista',
  descartada: 'Descartada',
};

export interface UserEvent {
  id: string;
  data: string; // AAAA-MM-DD
  titulo: string;
  tipo: 'agendamento' | 'prazo' | 'outro';
}

export interface Budget {
  reservaLei: number;
  rescisaoLei: number;
  custoAtualLei: number; // custo mensal atual da família em Bucareste
  salarioPresencialEur: number; // líquido mensal
  salarioRemotoEur: number; // líquido mensal
  salarioEsposaEur: number; // líquido mensal
}

export interface ImmigrationUser {
  docs: Record<string, { status: DocStatus; validoAte: string | null }>;
  vagas: Record<string, { status: JobPipelineStatus; nota: string }>;
  apartamentos: Record<string, { status: AptStatus }>;
  eventos: UserEvent[];
  orcamento: Budget;
  fimEmprego: string; // AAAA-MM-DD (previsão)
  diasParaNovoEmpregador: number;
  autorizacaoRomeniaAte: string; // AAAA-MM-DD ou ''
}

// jobs = vagas em Portugal (seção Imigração); aiJobs = trabalhos remotos de IA (seção IA).
export type ResearchTopic = 'legal' | 'docs' | 'living' | 'jobs' | 'aiJobs' | 'apartamentos';
// Pesquisas do "caçador diário" (1x ao dia); as outras são semanais.
export const DAILY_TOPICS: ResearchTopic[] = ['jobs', 'aiJobs', 'apartamentos'];
export const TOPIC_LABEL: Record<ResearchTopic, string> = {
  legal: 'Rotas e Lei de Estrangeiros',
  docs: 'Documentos',
  living: 'Custo de vida, escola e moradia',
  jobs: 'Vagas em Portugal',
  aiJobs: 'Vagas de IA',
  apartamentos: 'Apartamentos para alugar',
};

// Arquivo da sua pasta de referência (só nome/tamanho/data; o conteúdo não é lido pelo app).
export interface DocFile {
  nome: string;
  pasta: string;
  kb: number;
  modificado: string;
  sugestao: string | null; // id do item do checklist que parece corresponder
}

export interface ResearchRun {
  topic: ResearchTopic;
  jobId: string | null;
  status: 'nunca' | 'na_fila' | 'rodando' | 'ok' | 'falhou';
  lastOkAt: string | null;
  error: string | null;
}

// Conferência independente de pontos críticos contra o texto oficial (feita fora
// da pesquisa automática, por outro agente ou por você).
export interface VerificationItem {
  afirmacao: string;
  resultado: 'confirmado' | 'diverge' | 'nao_confirmado';
  detalhe: string;
  fontes: Source[];
}

export interface Verification {
  feitaEm: string;
  por: string;
  itens: VerificationItem[];
}

export interface ImmigrationState {
  verificacao: Verification | null;
  legal: LegalResearch | null;
  docs: DocsResearch | null;
  living: LivingResearch | null;
  jobs: JobsResearch | null;
  aiJobs: JobsResearch | null;
  apartamentos: ApartmentsResearch | null;
  arquivos: DocFile[];
  user: ImmigrationUser;
  research: ResearchRun[];
  docsFolder: string;
  vaultFolder: string;
}

export const DEFAULT_USER: ImmigrationUser = {
  docs: {},
  vagas: {},
  apartamentos: {},
  eventos: [],
  orcamento: { reservaLei: 0, rescisaoLei: 0, custoAtualLei: 0, salarioPresencialEur: 0, salarioRemotoEur: 0, salarioEsposaEur: 0 },
  fimEmprego: '',
  diasParaNovoEmpregador: 90,
  autorizacaoRomeniaAte: '',
};

// ---------------- cálculos ----------------

export const STALE_DAYS = 30;

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

export function isStale(src: Source, today: string): boolean {
  return !src.verificadoEm || daysBetween(src.verificadoEm, today) > STALE_DAYS;
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface TimelineItem {
  data: string;
  titulo: string;
  tipo: 'critico' | 'documento' | 'agendamento' | 'prazo' | 'outro';
  detalhe: string;
  diasAte: number;
}

export function computeTimeline(s: ImmigrationState, today: string): TimelineItem[] {
  const items: Omit<TimelineItem, 'diasAte'>[] = [];
  const u = s.user;
  if (u.fimEmprego) {
    items.push({ data: u.fimEmprego, titulo: 'Fim do emprego atual (previsão)', tipo: 'critico', detalhe: 'Ajuste a data quando souber o dia exato.' });
    items.push({
      data: addDays(u.fimEmprego, u.diasParaNovoEmpregador),
      titulo: `Fim do prazo para novo empregador na Romênia (${u.diasParaNovoEmpregador} dias)`,
      tipo: 'critico',
      detalhe: 'Prazo informado por você; confirme as regras exatas com o IGI (Romênia).',
    });
  }
  if (u.autorizacaoRomeniaAte) items.push({ data: u.autorizacaoRomeniaAte, titulo: 'Autorização de residência/trabalho na Romênia vence', tipo: 'critico', detalhe: '' });
  for (const d of s.docs?.itens ?? []) {
    const st = u.docs[d.id];
    if (st?.validoAte) items.push({ data: st.validoAte, titulo: `Vence: ${d.documento} (${PERSON_LABEL[d.pessoa]})`, tipo: 'documento', detalhe: d.validade });
  }
  for (const e of u.eventos) items.push({ data: e.data, titulo: e.titulo, tipo: e.tipo, detalhe: '' });
  return items
    .filter((i) => /^\d{4}-\d{2}-\d{2}$/.test(i.data))
    .map((i) => ({ ...i, diasAte: daysBetween(today, i.data) }))
    .sort((a, b) => a.data.localeCompare(b.data));
}

export interface Scenario {
  id: string;
  nome: string;
  rendaEur: number;
  custoEur: number;
  saldoEur: number;
  // Meses que a reserva aguenta quando o saldo é negativo (null = não consome a reserva).
  mesesReserva: number | null;
}

export function cityMonthlyCost(l: LivingResearch, cidade: 'braga' | 'barcelos'): number {
  const rents = l.moradia.filter((m) => m.cidade.toLowerCase().includes(cidade) && /t2/i.test(m.tipologia));
  const pool = rents.length ? rents : l.moradia.filter((m) => m.cidade.toLowerCase().includes(cidade));
  const rent = pool.length ? pool.reduce((s, m) => s + (m.minEur + m.maxEur) / 2, 0) / pool.length : 0;
  const other = l.custosMensais.reduce((s, c) => s + (cidade === 'braga' ? c.bragaEur : c.barcelosEur), 0);
  return Math.round(rent + other);
}

export function computeScenarios(s: ImmigrationState, cidade: 'braga' | 'barcelos'): { capitalEur: number; mudancaEur: number; custoAtualEur: number; cenarios: Scenario[] } | null {
  const l = s.living;
  if (!l || !l.cambio.ronPorEur) return null;
  const b = s.user.orcamento;
  const fx = l.cambio.ronPorEur;
  const mudancaEur = Math.round(l.mudanca.reduce((sum, m) => sum + (m.minEur + m.maxEur) / 2, 0));
  const capitalEur = Math.round((b.reservaLei + b.rescisaoLei) / fx - mudancaEur);
  const custo = cityMonthlyCost(l, cidade);
  const mk = (id: string, nome: string, renda: number): Scenario => {
    const saldo = Math.round(renda - custo);
    return { id, nome, rendaEur: Math.round(renda), custoEur: custo, saldoEur: saldo, mesesReserva: saldo < 0 ? Math.max(0, Math.round((capitalEur / -saldo) * 10) / 10) : null };
  };
  return {
    capitalEur,
    mudancaEur,
    custoAtualEur: Math.round(b.custoAtualLei / fx),
    cenarios: [
      mk('procura', 'Ainda procurando emprego (sem renda)', 0),
      mk('presencial', 'Requerente presencial/híbrido, cônjuge sem emprego', b.salarioPresencialEur),
      mk('presencial-2', 'Requerente presencial/híbrido + cônjuge trabalhando', b.salarioPresencialEur + b.salarioEsposaEur),
      mk('remoto', 'Requerente remoto, cônjuge sem emprego', b.salarioRemotoEur),
      mk('remoto-2', 'Requerente remoto + cônjuge trabalhando', b.salarioRemotoEur + b.salarioEsposaEur),
    ],
  };
}

export function allSources(s: ImmigrationState): (Source & { onde: string })[] {
  const out: (Source & { onde: string })[] = [];
  const add = (list: Source[] | undefined, onde: string) => list?.forEach((f) => out.push({ ...f, onde }));
  s.verificacao?.itens.forEach((v) => add(v.fontes, 'Conferência independente'));
  if (s.legal) {
    add(s.legal.lei.fontes, 'Lei de Estrangeiros');
    s.legal.lei.mudancas.forEach((m) => add(m.fontes, `Lei: ${m.tema}`));
    s.legal.lei.regulamentacao.forEach((r) => add(r.fontes, `Regulamentação: ${r.titulo}`));
    s.legal.rotas.forEach((r) => add(r.fontes, `Rota: ${r.nome}`));
  }
  s.docs?.itens.forEach((d) => add(d.fontes, `Documento: ${d.documento}`));
  if (s.living) {
    if (s.living.cambio.fonte) add([s.living.cambio.fonte], 'Câmbio');
    s.living.moradia.forEach((m) => add(m.fontes, `Moradia: ${m.cidade}`));
    s.living.custosMensais.forEach((c) => add(c.fontes, `Custo: ${c.item}`));
    s.living.mudanca.forEach((c) => add(c.fontes, `Mudança: ${c.item}`));
    add(s.living.escola.fontes, 'Escola');
    s.living.salarios.forEach((c) => add(c.fontes, `Salário: ${c.referencia}`));
  }
  // Uma linha por URL, guardando a verificação mais antiga (a que precisa de revisão primeiro).
  const byUrl = new Map<string, Source & { onde: string }>();
  for (const f of out) {
    const prev = byUrl.get(f.url);
    if (!prev) byUrl.set(f.url, f);
    else byUrl.set(f.url, { ...prev, onde: prev.onde.includes(f.onde) ? prev.onde : `${prev.onde}; ${f.onde}`, verificadoEm: prev.verificadoEm < f.verificadoEm ? prev.verificadoEm : f.verificadoEm });
  }
  return [...byUrl.values()];
}
