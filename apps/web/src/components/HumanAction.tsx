// Ações que só você faz (enviar, marcar resposta, receber, perder, candidatura enviada):
// cada uma abre uma confirmação na tela antes de ir para o servidor.
import { useState } from 'react';
import type { ApplicationState, HojeTarefaEstado, PaymentKind, ProposalState } from '../../../../packages/shared/renda.ts';
import { APPLICATION_STATE_LABEL } from '../../../../packages/shared/renda.ts';
import { rendaApi } from '../api.ts';

export type HumanRequest =
  | { tipo: 'tarefa'; tarefaId: string; estado: HojeTarefaEstado; quem: string }
  | { tipo: 'proposta'; proposalId: string; para: ProposalState; quem: string }
  | { tipo: 'pagamento'; proposalId: string; quem: string; sugestaoCents: number; moeda: string }
  | { tipo: 'candidatura'; applicationId: string; para: ApplicationState; quem: string };

export const money = (cents: number, cur: string) =>
  new Intl.NumberFormat(cur === 'BRL' ? 'pt-BR' : 'en-US', { style: 'currency', currency: cur }).format(cents / 100);

const TITLE: Record<string, string> = {
  sent: 'Você enviou esta proposta?',
  replied: 'O cliente respondeu?',
  lost: 'Marcar como perdido',
};

export function HumanActionDialog(props: { req: HumanRequest; onDone(): void; onCancel(): void; onError(msg: string): void }) {
  const { req } = props;
  const [motivo, setMotivo] = useState('');
  const [minutos, setMinutos] = useState('');
  const [valor, setValor] = useState(req.tipo === 'pagamento' ? (req.sugestaoCents / 100).toFixed(2) : '');
  const [kind, setKind] = useState<PaymentKind>('deposit');
  const [comprovante, setComprovante] = useState('');
  const [busy, setBusy] = useState(false);

  const needsReason = req.tipo === 'proposta' && req.para === 'lost';
  const ok =
    !busy &&
    (!needsReason || motivo.trim().length > 2) &&
    (req.tipo !== 'pagamento' || (Number(valor.replace(',', '.')) > 0 && comprovante.trim().length > 0));

  const submit = async () => {
    setBusy(true);
    try {
      if (req.tipo === 'proposta') await rendaApi.proposal(req.proposalId, req.para, { motivo: motivo.trim() || undefined, minutos: Number(minutos) || 0 });
      else if (req.tipo === 'pagamento') await rendaApi.payment(req.proposalId, Math.round(Number(valor.replace(',', '.')) * 100), kind, comprovante.trim());
      else if (req.tipo === 'tarefa') await rendaApi.tarefa(req.tarefaId, req.estado);
      else await rendaApi.application(req.applicationId, req.para);
      props.onDone();
    } catch (e: any) {
      props.onError(e.message);
      setBusy(false);
    }
  };

  const title =
    req.tipo === 'tarefa' ? (req.estado === 'feita' ? 'Concluir tarefa?' : req.estado === 'pulada' ? 'Pular tarefa?' : 'Reabrir tarefa?') :
    req.tipo === 'proposta' ? TITLE[req.para] : req.tipo === 'pagamento' ? `Recebi de ${req.quem}` : `Candidatura: ${APPLICATION_STATE_LABEL[req.para]}`;

  return (
    <div className="drawer-backdrop center" onClick={props.onCancel}>
      <div className="confirm human-dialog" role="alertdialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p className="hint">{req.tipo === 'pagamento' ? 'Registre só o que já caiu na conta. Os agentes nunca confirmam recebimento.' : `${req.quem} — só você confirma esta ação.`}</p>
        {needsReason && (
          <label className="field">
            <span>Motivo</span>
            <input autoFocus value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: sem resposta em 7 dias, preço, já tinha editor" />
          </label>
        )}
        {req.tipo === 'proposta' && (
          <label className="field">
            <span>Seu tempo nesta etapa (min, opcional)</span>
            <input inputMode="numeric" value={minutos} onChange={(e) => setMinutos(e.target.value.replace(/\D/g, ''))} placeholder="Ex.: 5" />
          </label>
        )}
        {req.tipo === 'pagamento' && (
          <>
            <label className="field">
              <span>Valor recebido ({req.moeda})</span>
              <input autoFocus inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} />
            </label>
            <label className="field">
              <span>Tipo</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as PaymentKind)}>
                <option value="deposit">Entrada (50%)</option>
                <option value="balance">Saldo</option>
                <option value="recurring">Mensalidade</option>
              </select>
            </label>
            <label className="field">
              <span>Referência do comprovante</span>
              <input value={comprovante} onChange={(e) => setComprovante(e.target.value)} placeholder="Ex.: id do Pix ou da transação" />
            </label>
          </>
        )}
        <div className="confirm-actions">
          <button className="btn" onClick={props.onCancel}>
            Voltar
          </button>
          <button className="btn btn-primary" disabled={!ok} onClick={submit}>
            {busy ? 'Salvando…' : 'Confirmar'}
          </button>
        </div>
      </div>
    </div>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
