// Notas do vault em 40 - PERSONAL/Imigração Portugal, geradas a partir dos dados.
// Só status dos documentos: nunca números nem digitalizações (o vault sincroniza).
import {
  DOC_DONE, DOC_STATUS_LABEL, PERSON_LABEL, TOPIC_LABEL, allSources, computeScenarios, computeTimeline, isStale,
  type ImmigrationState, type Source,
} from '../../../../packages/shared/immigration.ts';
import { aptScore, jobScore, salaryMonthlyEur, topIds } from '../../../../packages/shared/immigration-score.ts';

const DISCLAIMER = '> Organização e pesquisa feitas pelo EMANNU OS — **não é parecer jurídico**. Itens marcados com ⚠ precisam ser confirmados com advogado ou consulado.';
const TRI: Record<string, string> = { sim: '✅ sim', nao: '❌ não', depende: '⚠ depende', provavel: '🟡 provável', incerto: '⚠ incerto' };
const eur = (n: number) => `€ ${Math.round(n).toLocaleString('pt-PT')}`;

const link = (f: Source, today: string) =>
  `[${f.titulo.replace(/[[\]|]/g, ' ')}](${f.url}) — ${f.orgao || 'fonte'}${f.oficial ? ' (oficial)' : ''}, verificado em ${f.verificadoEm || '⚠ sem data'}${isStale(f, today) ? ' · **rever**' : ''}`;
const sourcesMd = (list: Source[], today: string) => (list.length ? list.map((f) => `  - ${link(f, today)}`).join('\n') : '  - ⚠ sem fonte');
const bullets = (list: string[]) => list.map((x) => `- ${x}`).join('\n');
// "1. Já: ..." → "Já: ..." (a pesquisa às vezes já numera os passos).
export const stripNumber = (s: string) => s.replace(/^\s*\d+[.)]\s*/, '');

export const NOTE_NAMES = ['Painel', 'Rotas', 'Documentos', 'Linha do tempo', 'Orçamento', 'Fontes', 'Vagas e apartamentos'] as const;

const cell = (x: string) => x.replace(/\|/g, '/').replace(/\n/g, ' ');

// Caçador diário: vagas em Portugal e apartamentos, os mais importantes primeiro.
export function buildDailyNote(s: ImmigrationState, today: string): string {
  const vagas = [...(s.jobs?.vagas ?? [])]
    .map((v) => ({ v, sc: jobScore(v, s.user, today) }))
    .filter((x) => x.sc.score > -100)
    .sort((a, b) => b.sc.score - a.sc.score);
  const apts = [...(s.apartamentos?.apartamentos ?? [])]
    .map((a) => ({ a, sc: aptScore(a, s.user, today) }))
    .filter((x) => x.sc.score > -100)
    .sort((a, b) => b.sc.score - a.sc.score);
  const topV = topIds(vagas.map((x) => x.v), (v) => jobScore(v, s.user, today));
  const topA = topIds(apts.map((x) => x.a), (a) => aptScore(a, s.user, today));
  const star = (on: boolean) => (on ? '⭐ ' : '');
  return [
    '# Vagas e apartamentos',
    '',
    `> Caçador diário do EMANNU OS (1x ao dia). Vagas atualizadas em ${s.jobs?.geradoEm ?? '—'}; apartamentos em ${s.apartamentos?.geradoEm ?? '—'}. ⭐ = destaque (região de Leiria, serve para visto, salário/preço). **Candidatar-se, contatar e visitar é sempre você.**`,
    '',
    '## Vagas em Portugal',
    '| Vaga | Local | Salário (≈ €/mês) | Visto | Por quê |',
    '|---|---|---|---|---|',
    ...vagas.map(({ v, sc }) => {
      const m = salaryMonthlyEur(v.salario);
      return `| ${star(topV.has(v.id))}[${cell(v.empresa)} — ${cell(v.titulo)}](${v.url}) | ${cell(v.local)} | ${m ? `≈ ${eur(m)}` : 'não publicado'} | ${TRI[v.permiteVisto] ?? v.permiteVisto} | ${sc.motivos.join(', ') || '—'} |`;
    }),
    '',
    '## Apartamentos para alugar',
    apts.length ? '| Apartamento | Cidade | Renda | Tipologia | Por quê |\n|---|---|---|---|---|' : '_A primeira pesquisa de apartamentos ainda não terminou._',
    ...apts.map(({ a, sc }) => `| ${star(topA.has(a.id))}[${cell(a.titulo || `${a.tipologia} em ${a.zona}`)}](${a.url}) | ${cell(a.cidade)}${a.zona ? ` · ${cell(a.zona)}` : ''} | ${eur(a.precoEur)} | ${a.tipologia}${a.areaM2 ? ` · ${a.areaM2} m²` : ''} | ${sc.motivos.join(', ') || '—'} |`),
  ].join('\n');
}

// Nota da seção IA (50 - CAREER & AI WORK): vagas de trabalho remoto com IA.
export function buildAiJobsNote(s: ImmigrationState, today: string): string {
  const vagas = s.aiJobs?.vagas ?? [];
  return [
    '# Vagas de IA',
    '',
    `> Trabalho remoto com IA (treinamento, avaliação, anotação). Pesquisa do EMANNU OS refeita todo dia; atualizada em ${s.aiJobs?.geradoEm ?? '—'}. **Candidatar-se é sempre você** — o app só prepara rascunhos.`,
    '',
    '| Vaga | Pagamento | Aceita RO/PT? | Status | Verificada |',
    '|---|---|---|---|---|',
    ...vagas.map((v) => {
      const st = s.user.vagas[v.id]?.status ?? 'nova';
      return `| [${v.empresa} — ${v.titulo}](${v.url}) | ${v.salario} | ${v.elegibilidade.replace(/\|/g, '/').slice(0, 120)} | ${st} | ${v.verificadoEm}${v.verificadoEm && isStale({ url: v.url, titulo: '', orgao: '', verificadoEm: v.verificadoEm, oficial: false }, today) ? ' · **rever**' : ''} |`.replace(/\n/g, ' ');
    }),
  ].join('\n');
}

export function buildNotes(s: ImmigrationState, today: string): Record<(typeof NOTE_NAMES)[number], string> {
  const legal = s.legal;
  const rec = legal?.rotas.find((r) => r.id === legal.recomendacao.rotaId);
  const timeline = computeTimeline(s, today);
  const docs = s.docs?.itens ?? [];
  const done = (id: string) => DOC_DONE.includes(s.user.docs[id]?.status ?? 'falta');
  const research = s.research.map((r) => `- ${TOPIC_LABEL[r.topic]}: ${r.lastOkAt ? `atualizada em ${r.lastOkAt.slice(0, 10)}` : 'ainda não feita'}${r.status === 'falhou' ? ` · ⚠ última tentativa falhou: ${r.error}` : ''}`);

  const unconfirmed = (s.verificacao?.itens ?? []).filter((v) => v.resultado !== 'confirmado');
  const painel = [
    '# Imigração Portugal — Painel',
    '',
    DISCLAIMER,
    '',
    '## Rota recomendada',
    rec
      ? [
          `**${legal!.recomendacao.titulo || rec.nome}**`,
          '',
          `Família junta: ${TRI[rec.familiaJunta]} — ${rec.familiaDetalhe}`,
          '',
          `Cônjuge pode trabalhar: ${TRI[rec.conjugePodeTrabalhar]} — ${rec.conjugeDetalhe}`,
          '',
          ...(unconfirmed.length
            ? ['> [!warning] A conferência no texto oficial NÃO confirmou:', ...unconfirmed.map((v) => `> - ${v.afirmacao} — ${v.detalhe}`), '']
            : []),
          legal!.recomendacao.porque,
          '',
          '**Passos**',
          legal!.recomendacao.passos.map((p, i) => `${i + 1}. ${stripNumber(p)}`).join('\n'),
          '',
          `**Plano B:** ${legal!.recomendacao.planoB}`,
        ].join('\n')
      : 'Pesquisa legal ainda não feita.',
    '',
    '## ⚠ Incertezas (confirmar com advogado/consulado)',
    legal ? bullets(legal.recomendacao.incertezas) : '—',
    '',
    ...(s.verificacao ? [`Conferência independente no texto oficial: ${s.verificacao.itens.length} ponto(s), ver [[Rotas]].`, ''] : []),
    '## Próximos prazos',
    timeline.filter((t) => t.diasAte >= 0).slice(0, 6).map((t) => `- **${t.data}** (${t.diasAte} dias) — ${t.titulo}`).join('\n') || '—',
    '',
    '## Documentos',
    (['emmanuel', 'esposa', 'filha', 'familia'] as const)
      .map((p) => {
        const list = docs.filter((d) => d.pessoa === p);
        return list.length ? `- ${PERSON_LABEL[p]}: ${list.filter((d) => done(d.id)).length}/${list.length} prontos` : '';
      })
      .filter(Boolean)
      .join('\n') || '—',
    '',
    '## Vagas',
    `- ${s.jobs?.vagas.length ?? 0} vaga(s) em Portugal no pipeline; ${(s.jobs?.vagas ?? []).filter((v) => s.user.vagas[v.id]?.status === 'pronta').length} candidatura(s) pronta(s) para **você** enviar. (Vagas de IA ficam na seção IA.)`,
    '',
    '## Pesquisas',
    research.join('\n'),
    '',
    `Arquivos e digitalizações ficam fora do vault, em \`${s.docsFolder}\`.`,
  ].join('\n');

  const v = s.verificacao;
  const verificacao = v
    ? [
        `## Conferência independente no texto oficial (${v.feitaEm}, ${v.por})`,
        '',
        ...v.itens.flatMap((it) => [`- **${{ confirmado: '✅ Confirmado', diverge: '❌ Diverge', nao_confirmado: '⚠ Não confirmado' }[it.resultado]}** — ${it.afirmacao}`, `  ${it.detalhe}`, sourcesMd(it.fontes, today)]),
        '',
      ].join('\n')
    : '';

  const rotas = !legal
    ? '# Rotas\n\nPesquisa legal ainda não feita.\n\n' + verificacao
    : [
        '# Rotas de imigração',
        '',
        DISCLAIMER,
        '',
        verificacao,
        `## ${legal.lei.diploma}`,
        `Publicado em ${legal.lei.publicadoEm || '?'} · em vigor desde ${legal.lei.emVigorDesde || '?'}`,
        '',
        legal.lei.situacao,
        '',
        '| Tema | Antes | Depois | Impacto para vocês |',
        '|---|---|---|---|',
        ...legal.lei.mudancas.map((m) => `| ${m.tema} | ${m.antes} | ${m.depois} | ${m.impacto} |`.replace(/\n/g, ' ')),
        '',
        '**Fontes da lei**',
        sourcesMd([...legal.lei.fontes, ...legal.lei.mudancas.flatMap((m) => m.fontes)], today),
        ...(legal.lei.regulamentacao.length ? ['', '**Regulamentação posterior**', ...legal.lei.regulamentacao.map((r) => `- ${r.titulo}: ${r.resumo}\n${sourcesMd(r.fontes, today)}`)] : []),
        '',
        ...legal.rotas.flatMap((r) => [
          `## ${r.id === legal.recomendacao.rotaId ? '⭐ ' : ''}${r.nome}`,
          '',
          r.resumo,
          '',
          `- Elegibilidade: ${TRI[r.elegibilidade]} — ${r.motivoElegibilidade}`,
          `- Família junta: ${TRI[r.familiaJunta]} — ${r.familiaDetalhe}`,
          `- Cônjuge pode trabalhar: ${TRI[r.conjugePodeTrabalhar]} — ${r.conjugeDetalhe}`,
          `- Onde pedir: ${r.ondePedir}`,
          '',
          '**Requisitos**',
          bullets(r.requisitos),
          '',
          '**Custos**',
          bullets(r.custos),
          '',
          '**Prazos**',
          bullets(r.prazos),
          '',
          `**Prós:** ${r.pros.join('; ')}`,
          '',
          `**Contras:** ${r.contras.join('; ')}`,
          '',
          '**⚠ Confirmar com**',
          bullets(r.confirmarCom),
          '',
          '**Fontes**',
          sourcesMd(r.fontes, today),
          '',
        ]),
      ].join('\n');

  const documentos = [
    '# Documentos por pessoa',
    '',
    'Só o **status** fica aqui. Números de documentos e digitalizações ficam fora do vault, em `' + s.docsFolder + '`.',
    '',
    ...(s.docs?.regras.length ? ['## Regras gerais', bullets(s.docs.regras), ''] : []),
    ...(['emmanuel', 'esposa', 'filha', 'familia'] as const).flatMap((p) => {
      const list = docs.filter((d) => d.pessoa === p);
      if (!list.length) return [];
      return [
        `## ${PERSON_LABEL[p]}`,
        '',
        '| Documento | Status | Válido até | Apostila | Tradução | Onde obter |',
        '|---|---|---|---|---|---|',
        ...list.map((d) => {
          const st = s.user.docs[d.id];
          const yn = (v: boolean | null) => (v === null ? '?' : v ? 'sim' : 'não');
          return `| ${d.documento} | ${DOC_STATUS_LABEL[st?.status ?? 'falta']} | ${st?.validoAte ?? '—'} | ${yn(d.apostila)} | ${yn(d.traducao)} | ${d.ondeObter} |`.replace(/\n/g, ' ');
        }),
        '',
      ];
    }),
  ].join('\n');

  const linha = [
    '# Linha do tempo',
    '',
    '| Data | Faltam | O quê |',
    '|---|---|---|',
    ...timeline.map((t) => `| ${t.data} | ${t.diasAte >= 0 ? `${t.diasAte} dias` : 'passou'} | ${t.tipo === 'critico' ? '**' + t.titulo + '**' : t.titulo} |`),
    '',
    'Edite as datas (fim do emprego, agendamentos AIMA/consulado, validade de documentos) no app, na seção Imigração.',
  ].join('\n');

  const orc = (['braga', 'barcelos'] as const).map((c) => [c, computeScenarios(s, c)] as const);
  const living = s.living;
  const orcamento = !living
    ? '# Orçamento\n\nPesquisa de custo de vida ainda não feita.'
    : [
        '# Orçamento',
        '',
        `Câmbio: 1 € = ${living.cambio.ronPorEur} lei (${living.cambio.data}). Reserva: ${s.user.orcamento.reservaLei.toLocaleString('pt-PT')} lei + rescisão ${s.user.orcamento.rescisaoLei.toLocaleString('pt-PT')} lei.`,
        '',
        ...orc.flatMap(([cidade, r]) =>
          !r
            ? []
            : [
                `## ${cidade === 'braga' ? 'Braga' : 'Barcelos'}`,
                `Custo mensal estimado: ${eur(r.cenarios[0].custoEur)} · mudança: ${eur(r.mudancaEur)} · capital após a mudança: ${eur(r.capitalEur)}${r.custoAtualEur ? ` · custo atual em Bucareste: ${eur(r.custoAtualEur)}` : ''}`,
                '',
                '| Cenário | Renda | Saldo/mês | Reserva dura |',
                '|---|---|---|---|',
                ...r.cenarios.filter((c) => c.id === 'procura' || c.rendaEur > 0).map((c) => `| ${c.nome} | ${eur(c.rendaEur)} | ${eur(c.saldoEur)} | ${c.mesesReserva === null ? 'não consome' : `${c.mesesReserva} meses`} |`),
                '',
              ],
        ),
        '## Moradia',
        '| Cidade | Zona | Tipo | Faixa |',
        '|---|---|---|---|',
        ...living.moradia.map((m) => `| ${m.cidade} | ${m.zona} | ${m.tipologia} | ${eur(m.minEur)}–${eur(m.maxEur)} |`),
        '',
        '## Custos mensais (sem aluguel)',
        '| Item | Braga | Barcelos |',
        '|---|---|---|',
        ...living.custosMensais.map((c) => `| ${c.item} | ${eur(c.bragaEur)} | ${eur(c.barcelosEur)} |`),
        '',
        '## Mudança (custos únicos)',
        ...living.mudanca.map((m) => `- ${m.item}: ${eur(m.minEur)}–${eur(m.maxEur)}${m.observacao ? ` (${m.observacao})` : ''}`),
        '',
        '## Escola da filha',
        living.escola.resumo,
        '',
        bullets(living.escola.passos),
        '',
        '**Documentos:** ' + living.escola.documentos.join('; '),
        '',
        '**Prazos:** ' + living.escola.prazos.join('; '),
        '',
        '## Bairros sugeridos',
        ...living.bairros.map((b) => `- **${b.cidade} — ${b.nome}:** ${b.porque}`),
      ].join('\n');

  const all = allSources(s);
  const stale = all.filter((f) => isStale(f, today));
  const fontes = [
    '# Fontes',
    '',
    `${all.length} fonte(s); ${all.filter((f) => f.oficial).length} oficial(is); ${stale.length} para **rever** (verificadas há mais de 30 dias ou sem data).`,
    '',
    '| Fonte | Órgão | Oficial | Verificado em | Usada em |',
    '|---|---|---|---|---|',
    ...all
      .sort((a, b) => (a.verificadoEm || '').localeCompare(b.verificadoEm || ''))
      .map((f) => `| [${f.titulo.replace(/[[\]|]/g, ' ')}](${f.url}) | ${f.orgao} | ${f.oficial ? 'sim' : 'não'} | ${f.verificadoEm || '⚠ sem data'}${isStale(f, today) ? ' · **rever**' : ''} | ${f.onde.replace(/\|/g, '/')} |`),
  ].join('\n');

  return { Painel: painel, Rotas: rotas, Documentos: documentos, 'Linha do tempo': linha, Orçamento: orcamento, Fontes: fontes, 'Vagas e apartamentos': buildDailyNote(s, today) };
}
