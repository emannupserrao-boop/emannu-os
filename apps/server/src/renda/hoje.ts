// Painel "Hoje": as ações humanas do dia, em ordem, com tempo estimado e um botão
// para cada uma (bloco de 45 min: propostas 15, respostas/cobrança 10, candidaturas 10,
// decisões/QA 10). Tudo aqui é preparado pelos agentes; quem envia, cobra e decide é você.
import { HOJE_BLOCOS, MOTION_OFFER, type HojeBloco, type HojeItem, type HojeView, type Proposal } from '../../../../packages/shared/renda.ts';
import type { Scheduler } from '../scheduler.ts';
import { TIMEZONE } from '../config.ts';
import { localDate } from '../routines.ts';
import { HojeTarefas } from './hoje-tarefas.ts';

const ORDER: HojeBloco[] = ['propostas', 'respostas', 'candidaturas', 'decisoes'];
const MAX_APPLICATIONS = 2;
const money = (cents: number, cur: string) => (cur === 'BRL' ? `R$ ${(cents / 100).toFixed(2).replace('.', ',')}` : `US$ ${(cents / 100).toFixed(2)}`);
const who = (p: Proposal) => p.lead?.company || p.lead?.channel || 'lead';

export function followUpText(p: Proposal, last: boolean): string {
  if (p.currency === 'BRL') {
    return last
      ? `Olá! Passando uma última vez sobre os 5 motions de até 15 s para ${p.lead?.need ?? 'seus anúncios'}. Se não for o momento, sem problema — fico à disposição.`
      : `Olá! Conseguiu ver minha proposta dos 5 motions de até 15 s (${money(p.amountCents, p.currency)})? Se fizer sentido, te mando o briefing.`;
  }
  return last
    ? `Hi! One last note about the five 15-second motion ads for ${p.lead?.need ?? 'your campaigns'}. If the timing isn't right, no worries.`
    : `Hi! Did you get a chance to look at my offer for five 15-second motion ads (${money(p.amountCents, p.currency)})? Happy to send the brief.`;
}

export function chargeText(p: Proposal): string {
  const entrada = Math.round((p.amountCents * MOTION_OFFER.entradaPct) / 100);
  if (p.receivedCents > 0) {
    const saldo = p.amountCents - p.receivedCents;
    return p.currency === 'BRL'
      ? `Que bom que aprovou a versão com marca d'água! O saldo é de ${money(saldo, p.currency)}. Assim que cair, envio os arquivos finais sem marca d'água.`
      : `Glad you approved the watermarked version! The balance is ${money(saldo, p.currency)}. As soon as it clears, I'll send the final files without the watermark.`;
  }
  return p.currency === 'BRL'
    ? `Perfeito! Para começar: entrada de ${MOTION_OFFER.entradaPct}% (${money(entrada, p.currency)}). O saldo é pago depois que você aprovar a versão com marca d'água, antes dos arquivos finais. O prazo de ${MOTION_OFFER.prazoDiasUteis} dias úteis conta a partir do briefing, dos materiais e da entrada.`
    : `Great! To start: a ${MOTION_OFFER.entradaPct}% deposit (${money(entrada, p.currency)}). The balance is due after you approve the watermarked version, before the final files. The ${MOTION_OFFER.prazoDiasUteis}-business-day turnaround starts after the brief, the materials and the deposit.`;
}

export function buildHoje(s: Scheduler, now = new Date()): HojeView {
  const itens: HojeItem[] = [];
  const data = localDate(now);
  const endOfDay = new Date(now.getTime() + 24 * 3_600_000).toISOString();
  const props = s.renda?.store.proposals() ?? [];

  for (const p of props.filter((x) => x.state === 'ready')) {
    itens.push({
      id: `enviar-${p.id}`, bloco: 'propostas', minutos: 3, prazo: null,
      titulo: `Enviar proposta para ${who(p)}`,
      detalhe: p.lead?.need ?? p.scope,
      acoes: [
        { tipo: 'copiar', rotulo: 'Copiar texto', texto: p.body },
        ...(p.lead?.sourceUrl ? [{ tipo: 'abrir' as const, rotulo: 'Abrir link', url: p.lead.sourceUrl }] : []),
        { tipo: 'proposta', rotulo: 'Marquei como enviado', proposalId: p.id, para: 'sent' },
        { tipo: 'proposta', rotulo: 'Perdido (motivo)', proposalId: p.id, para: 'lost' },
      ],
    });
  }
  for (const p of props.filter((x) => x.state === 'sent' && x.dueAt && x.dueAt <= endOfDay)) {
    const last = !!p.sentAt && now.getTime() - Date.parse(p.sentAt) >= 7 * 86_400_000;
    itens.push({
      id: `follow-${p.id}`, bloco: 'propostas', minutos: 2, prazo: p.dueAt,
      titulo: `${last ? 'Último contato' : 'Follow-up'}: ${who(p)}`,
      detalhe: last ? 'Dia 7 sem resposta: depois disso, marque como perdido com o motivo.' : '2 dias úteis sem resposta.',
      acoes: [
        { tipo: 'copiar', rotulo: 'Copiar follow-up', texto: followUpText(p, last) },
        ...(p.lead?.sourceUrl ? [{ tipo: 'abrir' as const, rotulo: 'Abrir link', url: p.lead.sourceUrl }] : []),
        { tipo: 'proposta', rotulo: 'Respondeu', proposalId: p.id, para: 'replied' },
        { tipo: 'proposta', rotulo: 'Perdido (motivo)', proposalId: p.id, para: 'lost' },
      ],
    });
  }
  for (const p of props.filter((x) => x.state === 'replied')) {
    const entrada = Math.round((p.amountCents * MOTION_OFFER.entradaPct) / 100);
    const paidSome = p.receivedCents > 0;
    itens.push({
      id: `cobrar-${p.id}`, bloco: 'respostas', minutos: 5, prazo: null,
      titulo: paidSome ? `Saldo de ${who(p)}` : `Briefing e entrada: ${who(p)}`,
      detalhe: paidSome ? `Recebido ${money(p.receivedCents, p.currency)} de ${money(p.amountCents, p.currency)}.` : `Entrada de ${money(entrada, p.currency)} antes da produção.`,
      acoes: [
        { tipo: 'copiar', rotulo: 'Copiar texto da cobrança', texto: chargeText(p) },
        { tipo: 'pagamento', rotulo: `Recebi ${p.currency === 'BRL' ? 'R$' : 'US$'}…`, proposalId: p.id, sugestaoCents: paidSome ? p.amountCents - p.receivedCents : entrada, moeda: p.currency },
        { tipo: 'proposta', rotulo: 'Perdido (motivo)', proposalId: p.id, para: 'lost' },
      ],
    });
  }

  const apps = (s.renda?.store.applications() ?? []).filter((a) => a.state === 'package_ready').slice(0, MAX_APPLICATIONS);
  for (const a of apps) {
    itens.push({
      id: `cand-${a.id}`, bloco: 'candidaturas', minutos: 5, prazo: a.dueAt,
      titulo: `Enviar candidatura: ${a.title}`,
      detalhe: [a.employer, a.location].filter(Boolean).join(' · ') || 'Pacote pronto (CV, carta e respostas).',
      acoes: [
        { tipo: 'abrir', rotulo: 'Abrir anúncio', url: a.sourceUrl },
        { tipo: 'candidatura', rotulo: 'Marquei como enviada', applicationId: a.id, para: 'applied' },
        { tipo: 'candidatura', rotulo: 'Descartar', applicationId: a.id, para: 'discarded' },
      ],
    });
  }

  for (const j of s.store.jobsByStatus('approval')) {
    itens.push({ id: `aprovar-${j.id}`, bloco: 'decisoes', minutos: 2, prazo: null, titulo: `Aprovar início (AMARELO): ${j.title}`, detalhe: j.step ?? 'Job longo ou sensível.', acoes: [{ tipo: 'job', rotulo: 'Abrir job', jobId: j.id }] });
  }
  for (const j of s.store.jobsByStatus('review').filter((x) => x.kind === 'task')) {
    itens.push({ id: `revisar-${j.id}`, bloco: 'decisoes', minutos: 3, prazo: null, titulo: `Decidir: ${j.title}`, detalhe: j.step ?? 'Aguardando você.', acoes: [{ tipo: 'job', rotulo: 'Abrir job', jobId: j.id }] });
  }
  const OBJ: Record<string, [string, string]> = {
    proposed: ['Começar objetivo do INBOX', 'Veio de uma nota sua com #objetivo.'],
    plan_ready: ['Aprovar plano', 'Plano do Planejador pronto.'],
    ready: ['Aprovar entrega', 'Merge final aguardando você.'],
  };
  for (const o of s.store.listObjectives(100).filter((x) => OBJ[x.status])) {
    itens.push({
      id: `obj-${o.id}`, bloco: 'decisoes', minutos: o.status === 'proposed' ? 2 : 3, prazo: null,
      titulo: `${OBJ[o.status][0]}: ${o.title}`,
      detalhe: OBJ[o.status][1],
      acoes: [{ tipo: 'objetivo', rotulo: 'Abrir objetivo', objectiveId: o.id }],
    });
  }

  // Pedidos de tempo extra do Rocky: só aloca depois do seu "sim".
  for (const p of (s.rocky?.last()?.pedidos ?? []).filter((x) => !x.resposta)) {
    itens.push({
      id: `pedido-${p.id}`, bloco: 'decisoes', minutos: 1, prazo: null,
      titulo: `O Planejador pede ${p.minutos} min seus: ${p.titulo}`,
      detalhe: p.motivo || 'Tempo além do bloco de 45 min.',
      acoes: [
        { tipo: 'pedido', rotulo: 'Sim', pedidoId: p.id, resposta: 'sim' },
        { tipo: 'pedido', rotulo: 'Não', pedidoId: p.id, resposta: 'nao' },
      ],
    });
  }

  for (const t of new HojeTarefas(s.store).abertasAte(data)) {
    itens.push({
      id: t.id, bloco: t.bloco, titulo: t.titulo, detalhe: t.detalhe,
      minutos: t.minutos, ordem: t.ordem, deOntem: t.data < data, prazo: null,
      acoes: [
        ...(t.textoCopiar ? [{ tipo: 'copiar' as const, rotulo: 'Copiar texto', texto: t.textoCopiar }] : []),
        ...(t.url ? [{ tipo: 'abrir' as const, rotulo: 'Abrir link', url: t.url }] : []),
        ...(t.arquivo ? [{ tipo: 'arquivo' as const, rotulo: 'Abrir arquivo', arquivo: t.arquivo }] : []),
        { tipo: 'tarefa', rotulo: 'Feito', tarefaId: t.id, estado: 'feita' },
        { tipo: 'tarefa', rotulo: 'Pular', tarefaId: t.id, estado: 'pulada' },
      ],
    });
  }

  itens.sort((a, b) => ORDER.indexOf(a.bloco) - ORDER.indexOf(b.bloco) || (a.ordem ?? 0) - (b.ordem ?? 0) || (a.prazo ?? '9').localeCompare(b.prazo ?? '9'));
  return {
    prioridades: (s.rocky?.last()?.resultados ?? []).map((r) => ({ tipo: r.tipo, titulo: r.titulo })),
    data,
    timezone: TIMEZONE,
    orcamentoMin: Object.values(HOJE_BLOCOS).reduce((a, b) => a + b.minutos, 0),
    totalMin: itens.reduce((a, i) => a + i.minutos, 0),
    itens,
  };
}
