// Banco da renda (leads → propostas → pagamentos → entregas) e das candidaturas.
// Regras que valem para qualquer chamador:
// - só o servidor calcula a pontuação de um lead (a partir dos critérios);
// - o preço da proposta vem da oferta, nunca do agente;
// - enviar, marcar resposta, registrar pagamento e "perdido" exigem uma autorização
//   humana verificada pela API (ver human.ts). Agentes nunca confirmam envio nem recebimento.
import { randomBytes } from 'node:crypto';
import type { Store } from '../db.ts';
import {
  LEAD_CRITERIA, LEAD_PROPOSAL_MIN, MOTION_OFFER,
  type ApplicationState, type CriterionLevel, type Delivery, type IncomeView, type JobApplication, type Lead, type LeadCriterion, type Payment, type PaymentKind, type Proposal, type ProposalState,
} from '../../../../packages/shared/renda.ts';

const iso = () => new Date().toISOString();
const rid = (p: string) => `${p}-${randomBytes(6).toString('hex')}`;

export function leadScore(detail: Partial<Record<LeadCriterion, CriterionLevel>> | null): number {
  let s = 0;
  for (const [k, c] of Object.entries(LEAD_CRITERIA) as [LeadCriterion, { max: number }][]) {
    const lv = detail?.[k];
    s += lv === 'integral' ? c.max : lv === 'metade' ? Math.floor(c.max / 2) : 0;
  }
  return s;
}

// Soma dias úteis (seg–sex) a uma data.
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) left--;
  }
  return d;
}

const toLead = (r: any): Lead => ({
  id: r.id,
  projectId: r.project_id,
  sourceUrl: r.source_url,
  collectedAt: r.collected_at,
  postedAt: r.posted_at,
  company: r.company,
  channel: r.channel,
  need: r.need,
  evidence: r.evidence,
  score: r.score,
  scoreDetail: r.score_json ? JSON.parse(r.score_json) : null,
  status: r.status,
  discardReason: r.discard_reason,
});

const toPayment = (r: any): Payment => ({ id: r.id, proposalId: r.proposal_id, currency: r.currency, amountCents: r.amount_cents, kind: r.kind, receivedAt: r.received_at, receiptRef: r.receipt_ref });

const toApplication = (r: any): JobApplication => ({
  id: r.id, sourceUrl: r.source_url, collectedAt: r.collected_at, employer: r.employer, title: r.title, location: r.location, score: r.score,
  state: r.state, appliedAt: r.applied_at, nextAction: r.next_action, dueAt: r.due_at, notes: r.notes,
});

export interface NewLead {
  projectId: string;
  sourceUrl: string;
  postedAt: string | null;
  company: string | null;
  channel: string | null;
  need: string;
  evidence: string;
  scoreDetail: Partial<Record<LeadCriterion, CriterionLevel>>;
  discardReason?: string | null;
}

// Transições permitidas da proposta pelos botões humanos. "paid" só por pagamento.
const TRANSITIONS: Record<ProposalState, ProposalState[]> = {
  ready: ['sent', 'lost'],
  sent: ['replied', 'lost'],
  replied: ['lost'],
  paid: [],
  lost: [],
};

export class RendaStore {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  private get db() {
    return this.store.db;
  }

  // ---------- leads ----------
  addLead(input: NewLead): { lead: Lead; created: boolean } {
    const score = leadScore(input.scoreDetail);
    const status = input.discardReason ? 'discarded' : score >= LEAD_PROPOSAL_MIN ? 'qualified' : 'new';
    return this.store.transaction(() => {
      const prev = this.db.prepare('SELECT * FROM leads WHERE project_id = ? AND source_url = ?').get(input.projectId, input.sourceUrl);
      if (prev) return { lead: toLead(prev), created: false };
      const id = rid('lead');
      this.db
        .prepare(`INSERT INTO leads (id, project_id, source_url, collected_at, posted_at, company, channel, need, evidence, score, score_json, status, discard_reason)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.projectId, input.sourceUrl, iso(), input.postedAt, input.company, input.channel, input.need, input.evidence, score, JSON.stringify(input.scoreDetail), status, input.discardReason ?? null);
      return { lead: this.lead(id)!, created: true };
    });
  }

  lead(id: string): Lead | null {
    const r = this.db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    return r ? toLead(r) : null;
  }

  leads(limit = 200): Lead[] {
    return this.db.prepare('SELECT * FROM leads ORDER BY collected_at DESC, rowid DESC LIMIT ?').all(limit).map(toLead);
  }

  // Mesmo anunciante e mesma demanda = duplicado (seção 5.1).
  isDuplicate(company: string | null, need: string): boolean {
    if (!company) return false;
    return !!this.db.prepare('SELECT 1 FROM leads WHERE lower(company) = lower(?) AND lower(need) = lower(?)').get(company, need);
  }

  discardLead(id: string, reason: string): Lead {
    if (!reason.trim()) throw new Error('Diga o motivo do descarte.');
    const r = this.db.prepare("UPDATE leads SET status = 'discarded', discard_reason = ? WHERE id = ? AND status <> 'converted'").run(reason.trim(), id);
    if (!r.changes) throw new Error('Lead não encontrado (ou já virou venda).');
    return this.lead(id)!;
  }

  // Leads qualificados ainda sem proposta (entrada do Claude às 07h15).
  leadsAwaitingProposal(projectId?: string): Lead[] {
    return this.db
      .prepare("SELECT l.* FROM leads l WHERE l.status = 'qualified' AND (? IS NULL OR l.project_id = ?) AND NOT EXISTS (SELECT 1 FROM proposals p WHERE p.lead_id = l.id) ORDER BY l.score DESC, l.collected_at")
      .all(projectId ?? null, projectId ?? null)
      .map(toLead);
  }

  // ---------- propostas ----------
  createProposal(input: { leadId: string; body: string; scope: string; currency: string; recurring?: boolean }): Proposal {
    const amount = MOTION_OFFER.precos[input.currency];
    if (!amount) throw new Error(`Moeda sem preço definido: ${input.currency}`);
    return this.store.transaction(() => {
      const lead = this.lead(input.leadId);
      if (!lead || lead.status !== 'qualified') throw new Error('Só leads qualificados recebem proposta.');
      if (this.db.prepare('SELECT 1 FROM proposals WHERE lead_id = ?').get(lead.id)) throw new Error('Este lead já tem proposta.');
      const id = rid('prop');
      this.db
        .prepare(`INSERT INTO proposals (id, lead_id, body, scope, state, amount_cents, currency, next_action, recurring, created_at)
          VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?)`)
        .run(id, lead.id, input.body, input.scope, amount, input.currency, 'Revisar e enviar (aba Hoje)', input.recurring ? 1 : 0, iso());
      return this.proposal(id)!;
    });
  }

  private toProposal(r: any): Proposal {
    const lead = this.lead(r.lead_id);
    const received = (this.db.prepare('SELECT coalesce(sum(amount_cents), 0) s FROM payments WHERE proposal_id = ?').get(r.id) as any).s as number;
    return {
      id: r.id, leadId: r.lead_id, body: r.body, scope: r.scope, state: r.state, amountCents: r.amount_cents, currency: r.currency,
      sentAt: r.sent_at, repliedAt: r.replied_at, nextAction: r.next_action, dueAt: r.due_at, lostReason: r.lost_reason,
      recurring: !!r.recurring, humanMinutes: r.human_minutes, createdAt: r.created_at, receivedCents: received,
      lead: lead ? { company: lead.company, channel: lead.channel, sourceUrl: lead.sourceUrl, need: lead.need, score: lead.score } : null,
    };
  }

  proposal(id: string): Proposal | null {
    const r = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
    return r ? this.toProposal(r) : null;
  }

  proposals(): Proposal[] {
    return this.db.prepare('SELECT * FROM proposals ORDER BY created_at DESC, rowid DESC').all().map((r) => this.toProposal(r));
  }

  // Só chamado pela API depois de conferir a autorização humana.
  transitionProposal(id: string, to: ProposalState, opts: { lostReason?: string; humanMinutes?: number; now?: Date } = {}): Proposal {
    const now = opts.now ?? new Date();
    return this.store.transaction(() => {
      const p = this.proposal(id);
      if (!p) throw new Error('Proposta não encontrada');
      if (!TRANSITIONS[p.state].includes(to)) throw new Error(`Não dá para passar de "${p.state}" para "${to}".`);
      const minutes = Math.max(0, Math.round(opts.humanMinutes ?? 0));
      const at = now.toISOString();
      if (to === 'sent') {
        // Follow-up depois de 2 dias úteis sem resposta (seção 5.1, passo 8).
        this.db.prepare("UPDATE proposals SET state = 'sent', sent_at = ?, due_at = ?, next_action = ?, human_minutes = human_minutes + ? WHERE id = ?").run(at, addBusinessDays(now, 2).toISOString(), 'Follow-up se não responder', minutes, id);
      } else if (to === 'replied') {
        this.db.prepare("UPDATE proposals SET state = 'replied', replied_at = ?, due_at = NULL, next_action = ?, human_minutes = human_minutes + ? WHERE id = ?").run(at, 'Briefing, escopo e cobrança da entrada (50%)', minutes, id);
        if (!this.db.prepare('SELECT 1 FROM deliveries WHERE proposal_id = ?').get(id)) {
          this.db.prepare("INSERT INTO deliveries (id, proposal_id, state, currency, created_at) VALUES (?, ?, 'briefing', ?, ?)").run(rid('ent'), id, p.currency, at);
        }
      } else if (to === 'lost') {
        const reason = opts.lostReason?.trim();
        if (!reason) throw new Error('Diga o motivo da perda.');
        this.db.prepare("UPDATE proposals SET state = 'lost', lost_reason = ?, due_at = NULL, next_action = NULL, human_minutes = human_minutes + ? WHERE id = ?").run(reason, minutes, id);
      }
      return this.proposal(id)!;
    });
  }

  // Pagamento recebido (registrado por você). "paid" só quando a soma cobre o valor.
  recordPayment(input: { proposalId: string; amountCents: number; kind: PaymentKind; receiptRef: string; receivedAt?: string }): { payment: Payment; proposal: Proposal } {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new Error('Valor inválido.');
    if (!['deposit', 'balance', 'recurring'].includes(input.kind)) throw new Error('Tipo de pagamento inválido.');
    if (!input.receiptRef?.trim()) throw new Error('Informe a referência do comprovante (ex.: id do Pix).');
    return this.store.transaction(() => {
      const p = this.proposal(input.proposalId);
      if (!p) throw new Error('Proposta não encontrada');
      if (!['sent', 'replied', 'paid'].includes(p.state)) throw new Error('Só dá para registrar pagamento de uma proposta enviada.');
      const id = rid('pag');
      this.db
        .prepare('INSERT INTO payments (id, proposal_id, currency, amount_cents, kind, received_at, receipt_ref) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, p.id, p.currency, input.amountCents, input.kind, input.receivedAt ?? iso(), input.receiptRef.trim());
      const total = p.receivedCents + input.amountCents;
      if (total >= p.amountCents && p.state !== 'paid') {
        this.db.prepare("UPDATE proposals SET state = 'paid', due_at = NULL, next_action = ? WHERE id = ?").run('Entrega e proposta de renovação mensal', p.id);
        this.db.prepare("UPDATE leads SET status = 'converted' WHERE id = ?").run(p.leadId);
      } else if (input.kind === 'deposit') {
        this.db.prepare('UPDATE proposals SET next_action = ? WHERE id = ?').run('Entrada recebida: produção pode começar', p.id);
      }
      return { payment: toPayment(this.db.prepare('SELECT * FROM payments WHERE id = ?').get(id)), proposal: this.proposal(p.id)! };
    });
  }

  payments(): Payment[] {
    return this.db.prepare('SELECT * FROM payments ORDER BY received_at DESC').all().map(toPayment);
  }

  deliveries(): Delivery[] {
    return this.db
      .prepare('SELECT * FROM deliveries ORDER BY created_at DESC')
      .all()
      .map((r: any) => ({ id: r.id, proposalId: r.proposal_id, state: r.state, dueAt: r.due_at, revisions: r.revisions, late: !!r.late, costCents: r.cost_cents, currency: r.currency }));
  }

  // ---------- painel da renda ----------
  income(): IncomeView {
    const props = this.proposals();
    const funil = { ready: 0, sent: 0, replied: 0, paid: 0, lost: 0 } as Record<ProposalState, number>;
    for (const p of props) funil[p.state]++;
    const recebido: Record<string, number> = {};
    for (const pay of this.payments()) recebido[pay.currency] = (recebido[pay.currency] ?? 0) + pay.amountCents;
    const previsto: Record<string, number> = {};
    for (const p of props) if (['ready', 'sent', 'replied'].includes(p.state)) previsto[p.currency] = (previsto[p.currency] ?? 0) + (p.amountCents - p.receivedCents);
    const sent = props.filter((p) => p.sentAt);
    const paid = props.filter((p) => p.state === 'paid');
    const lost = new Map<string, number>();
    for (const p of props) if (p.state === 'lost' && p.lostReason) lost.set(p.lostReason, (lost.get(p.lostReason) ?? 0) + 1);
    const counts = this.db.prepare('SELECT status, count(*) n FROM leads GROUP BY status').all() as any[];
    const c = (s: string) => counts.find((x) => x.status === s)?.n ?? 0;
    const withPayment = props.filter((p) => p.receivedCents > 0).length;
    return {
      metas: [
        { id: 'primeiro-pagamento', titulo: '1º pagamento recebido', prazo: '2026-11-08', alvo: 1, atual: Math.min(1, withPayment) },
        { id: 'pilotos', titulo: '3 pilotos pagos', prazo: '2026-11-27', alvo: 3, atual: paid.filter((p) => !p.recurring).length },
        { id: 'recorrente', titulo: '1 proposta recorrente apresentada', prazo: '2026-11-27', alvo: 1, atual: props.filter((p) => p.recurring && p.sentAt).length },
      ],
      funil,
      recebido,
      previsto,
      conversao: sent.length ? paid.length / sent.length : null,
      minutosPorPacote: paid.length ? Math.round(paid.reduce((a, p) => a + p.humanMinutes, 0) / paid.length) : null,
      motivosPerda: [...lost].map(([motivo, n]) => ({ motivo, n })).sort((a, b) => b.n - a.n),
      leads: { novos: c('new'), qualificados: c('qualified') + c('converted'), descartados: c('discarded') },
      propostas: props,
      leadsRecentes: this.leads(30),
    };
  }

  // ---------- candidaturas ----------
  upsertApplication(a: Omit<JobApplication, 'appliedAt' | 'nextAction' | 'dueAt' | 'notes' | 'collectedAt'> & { collectedAt?: string; notes?: string | null }): JobApplication {
    this.db
      .prepare(`INSERT INTO job_applications (id, source_url, collected_at, employer, title, location, score, state, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_url) DO UPDATE SET employer = excluded.employer, title = excluded.title, location = excluded.location, score = excluded.score,
          state = CASE WHEN job_applications.state IN ('applied','interview','offer','rejected') AND excluded.state IN ('found','package_ready','discarded') THEN job_applications.state ELSE excluded.state END,
          notes = coalesce(excluded.notes, job_applications.notes)`)
      .run(a.id, a.sourceUrl, a.collectedAt ?? iso(), a.employer, a.title, a.location, Math.round(a.score), a.state, a.notes ?? null);
    return this.application(a.sourceUrl, 'url')!;
  }

  application(key: string, by: 'id' | 'url' = 'id'): JobApplication | null {
    const r = this.db.prepare(`SELECT * FROM job_applications WHERE ${by === 'id' ? 'id' : 'source_url'} = ?`).get(key);
    return r ? toApplication(r) : null;
  }

  applications(): JobApplication[] {
    return this.db.prepare('SELECT * FROM job_applications ORDER BY score DESC, collected_at DESC').all().map(toApplication);
  }

  // "applied" é humano (você envia a candidatura); os outros estados também vêm dos seus botões.
  transitionApplication(id: string, to: ApplicationState, now = new Date()): JobApplication {
    const a = this.application(id);
    if (!a) throw new Error('Candidatura não encontrada');
    const states: ApplicationState[] = ['found', 'package_ready', 'applied', 'interview', 'offer', 'rejected', 'discarded'];
    if (!states.includes(to)) throw new Error('Estado inválido');
    const at = now.toISOString();
    this.db
      .prepare('UPDATE job_applications SET state = ?, applied_at = CASE WHEN ? = \'applied\' THEN ? ELSE applied_at END, due_at = CASE WHEN ? = \'applied\' THEN ? ELSE due_at END WHERE id = ?')
      .run(to, to, at, to, addBusinessDays(now, 7).toISOString(), id);
    return this.application(id)!;
  }
}
