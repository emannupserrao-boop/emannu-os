// Aba Renda: Criativos Motion — metas, funil das propostas e o que já virou caixa.
import { useEffect, useState } from 'react';
import { Banknote, Copy, ExternalLink, RefreshCw, Search, Wallet } from 'lucide-react';
import type { IncomeView, Proposal, ProposalState } from '../../../../packages/shared/renda.ts';
import { LEAD_PROPOSAL_MIN, PROPOSAL_STATE_LABEL } from '../../../../packages/shared/renda.ts';
import { rendaApi } from '../api.ts';
import { Skeleton } from '../motion.tsx';
import { HumanActionDialog, copyText, money, type HumanRequest } from './HumanAction.tsx';

const COLUMNS: ProposalState[] = ['ready', 'sent', 'replied', 'paid', 'lost'];
const sumMoney = (m: Record<string, number>) => (Object.keys(m).length ? Object.entries(m).map(([c, v]) => money(v, c)).join(' + ') : '—');
const who = (p: Proposal) => p.lead?.company || p.lead?.channel || 'Lead';

function daysLeft(date: string): number {
  return Math.ceil((Date.parse(`${date}T23:59:59`) - Date.now()) / 86_400_000);
}

export function Renda(props: { version: number; onError(msg: string): void; onToast(msg: string): void }) {
  const [data, setData] = useState<IncomeView | null>(null);
  const [req, setReq] = useState<HumanRequest | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    rendaApi.income().then(setData).catch((e) => props.onError(e.message));
  }, [props.version, reload]);

  if (!data) return <Skeleton cards={4} label="Carregando a renda…" />;

  const copy = async (p: Proposal) => props.onToast((await copyText(p.body)) ? 'Texto copiado' : 'Não consegui copiar: selecione o texto no card');
  const start = (fn: () => Promise<unknown>, msg: string) => fn().then(() => props.onToast(msg)).catch((e) => props.onError(e.message));

  return (
    <main className="imm renda">
      <header className="imm-head">
        <span className="plogo mono-logo ia-logo" aria-hidden>
          <Wallet size={26} strokeWidth={1.5} />
        </span>
        <div>
          <h2>Renda</h2>
          <p className="hint">Criativos Motion: 5 motions de até 15 s por R$ 290 ou US$ 79, 50% de entrada. Os agentes preparam; você envia, cobra e confirma. Previsto não é caixa.</p>
        </div>
      </header>

      <section className="metas" aria-label="Metas">
        {data.metas.map((m) => {
          const pct = Math.min(100, (m.atual / m.alvo) * 100);
          const d = daysLeft(m.prazo);
          return (
            <div key={m.id} className={`meta ${m.atual >= m.alvo ? 'meta-ok' : d <= 3 ? 'meta-urgente' : ''}`}>
              <div className="meta-top">
                <b>{m.titulo}</b>
                <span className="hint">até {new Date(`${m.prazo}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} · {d >= 0 ? `${d} dia(s)` : 'prazo passou'}</span>
              </div>
              <div className="meta-bar" role="progressbar" aria-valuemin={0} aria-valuemax={m.alvo} aria-valuenow={m.atual} aria-label={m.titulo}>
                <i style={{ width: `${pct}%` }} />
              </div>
              <span className="meta-num">
                {m.atual} / {m.alvo}
              </span>
            </div>
          );
        })}
      </section>

      <div className="kpis kpis-top">
        <div>
          <span className="hint">
            <Banknote size={14} aria-hidden /> Recebido (caixa)
          </span>
          <b>{sumMoney(data.recebido)}</b>
        </div>
        <div>
          <span className="hint">Previsto (em aberto)</span>
          <b className="muted-num">{sumMoney(data.previsto)}</b>
        </div>
        <div>
          <span className="hint">Conversão (pagos ÷ enviados)</span>
          <b>{data.conversao === null ? '—' : `${Math.round(data.conversao * 100)}%`}</b>
        </div>
        <div>
          <span className="hint">Seu tempo por pacote</span>
          <b>{data.minutosPorPacote === null ? '—' : `${data.minutosPorPacote} min`}</b>
        </div>
        <div>
          <span className="hint">Leads (qualificados / novos)</span>
          <b>
            {data.leads.qualificados} / {data.leads.novos}
          </b>
        </div>
      </div>

      <div className="renda-actions">
        <button className="btn btn-small" onClick={() => start(rendaApi.findLeads, 'Pesquisa de leads na fila')}>
          <Search size={14} aria-hidden /> Buscar leads agora
        </button>
        <button className="btn btn-small" onClick={() => start(rendaApi.makeProposals, 'Preparação de propostas na fila')}>
          <RefreshCw size={14} aria-hidden /> Preparar propostas
        </button>
        <span className="hint">Sozinho: leads às 06h30 e propostas às 07h15, dias úteis (horário de Bucareste).</span>
      </div>

      <section className="funil" aria-label="Funil de propostas">
        {COLUMNS.map((col) => {
          const items = data.propostas.filter((p) => p.state === col);
          return (
            <div key={col} className={`funil-col col-${col}`}>
              <h4>
                {PROPOSAL_STATE_LABEL[col]} <span className="count">{items.length}</span>
              </h4>
              {!items.length && <p className="empty">—</p>}
              {items.map((p) => (
                <article key={p.id} className="pcard-renda">
                  <div className="pcard-top">
                    <b>{who(p)}</b>
                    <span className="mono">{money(p.amountCents, p.currency)}</span>
                  </div>
                  <p className="hint clamp-2">{p.lead?.need ?? p.scope}</p>
                  {p.receivedCents > 0 && p.state !== 'paid' && <p className="hint">Recebido {money(p.receivedCents, p.currency)}</p>}
                  {p.state === 'lost' && <p className="hint">Motivo: {p.lostReason}</p>}
                  {p.nextAction && !['paid', 'lost'].includes(p.state) && <p className="next">{p.nextAction}</p>}
                  <div className="pcard-actions">
                    {p.state === 'ready' && (
                      <>
                        <button className="btn btn-small" onClick={() => copy(p)}>
                          <Copy size={13} aria-hidden /> Copiar texto
                        </button>
                        {p.lead?.sourceUrl && (
                          <a className="btn btn-small" href={p.lead.sourceUrl} target="_blank" rel="noreferrer noopener">
                            <ExternalLink size={13} aria-hidden /> Abrir link
                          </a>
                        )}
                        <button className="btn btn-small btn-primary" onClick={() => setReq({ tipo: 'proposta', proposalId: p.id, para: 'sent', quem: who(p) })}>
                          Marquei como enviado
                        </button>
                      </>
                    )}
                    {p.state === 'sent' && (
                      <button className="btn btn-small btn-primary" onClick={() => setReq({ tipo: 'proposta', proposalId: p.id, para: 'replied', quem: who(p) })}>
                        Respondeu
                      </button>
                    )}
                    {p.state === 'replied' && (
                      <button className="btn btn-small btn-primary" onClick={() => setReq({ tipo: 'pagamento', proposalId: p.id, quem: who(p), moeda: p.currency, sugestaoCents: p.receivedCents ? p.amountCents - p.receivedCents : Math.round(p.amountCents / 2) })}>
                        Recebi {p.currency === 'BRL' ? 'R$' : 'US$'}…
                      </button>
                    )}
                    {['ready', 'sent', 'replied'].includes(p.state) && (
                      <button className="btn btn-small btn-ghost" onClick={() => setReq({ tipo: 'proposta', proposalId: p.id, para: 'lost', quem: who(p) })}>
                        Perdido (motivo)
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          );
        })}
      </section>

      {data.motivosPerda.length > 0 && (
        <div className="icard">
          <h3>Motivos de perda</h3>
          <ul className="ilist">
            {data.motivosPerda.map((m) => (
              <li key={m.motivo}>
                {m.motivo} — {m.n}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="icard">
        <h3>Leads recentes</h3>
        {!data.leadsRecentes.length ? (
          <p className="hint">Nenhum lead ainda. O Hermes procura pedidos públicos às 06h30 dos dias úteis (ou toque em “Buscar leads agora”).</p>
        ) : (
          <ul className="leads">
            {data.leadsRecentes.map((l) => (
              <li key={l.id} className={l.status === 'discarded' ? 'lead-off' : ''}>
                <span className={`score ${l.score >= LEAD_PROPOSAL_MIN ? 'score-hi' : ''}`} title="Pontuação (0–100)">
                  {l.score}
                </span>
                <div>
                  <b>{l.company ?? l.channel ?? 'Lead'}</b> <span className="hint">· {l.channel}{l.postedAt ? ` · ${l.postedAt}` : ''}</span>
                  <p className="hint clamp-2">{l.need}</p>
                  {l.discardReason && <p className="hint">Descartado: {l.discardReason}</p>}
                </div>
                <a className="btn btn-small btn-ghost btn-icon" href={l.sourceUrl} target="_blank" rel="noreferrer noopener" aria-label={`Abrir o pedido de ${l.company ?? 'lead'}`}>
                  <ExternalLink size={14} aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      {req && (
        <HumanActionDialog
          req={req}
          onCancel={() => setReq(null)}
          onError={props.onError}
          onDone={() => {
            setReq(null);
            setReload((n) => n + 1);
            props.onToast('Registrado');
          }}
        />
      )}
    </main>
  );
}
