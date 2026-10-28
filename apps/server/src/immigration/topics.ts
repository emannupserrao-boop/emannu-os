// Pesquisas do módulo Imigração Portugal: o texto enviado ao Claude e a leitura
// (validação + normalização) do JSON que ele devolve.
import { IMMIGRATION_DOCS_DIR } from '../config.ts';
import type {
  Apartment, ApartmentsResearch, DocItem, DocsResearch, Eligibility, JobOffer, JobsResearch, LegalResearch, LivingResearch, Person, ResearchTopic, Route, Source, Tri,
} from '../../../../packages/shared/immigration.ts';

export const FAMILY_CONTEXT = `# Situação da família (perfil de exemplo — o perfil real fica só no PC)
- Família de 3 pessoas: o usuário, o cônjuge e um filho em idade escolar.
- Pasta de referência (só leitura): ${IMMIGRATION_DOCS_DIR} — currículos e o plano migratório. Leia quando ajudarem; não copie dados pessoais para a resposta.
- Moram hoje fora de Portugal, com autorização de residência válida no país atual.
- Alvo: uma região prioritária em Portugal e uma alternativa com moradia mais barata e boa escola pública.
- Querem ir como trabalhadores, com a família junta, e o cônjuge precisa poder trabalhar. Aceitam remoto, híbrido ou presencial.
- Não querem ficar separados.`;

export const RESEARCH_RULES = `# Regras de pesquisa (obrigatórias)
- Requisitos legais SÓ de fontes oficiais: AIMA (aima.gov.pt), vistos.mne.gov.pt, portaldiplomatico.mne.gov.pt, ePortugal/gov.pt, Diário da República (diariodarepublica.pt), parlamento.pt e consulados/embaixadas. Notícia serve só como alerta para verificar, nunca como fonte de requisito.
- Abra (WebFetch) cada página que citar. Só use "verificadoEm" com a data de hoje para páginas que você abriu e leu. Se não conseguiu abrir, diga isso e marque como incerto.
- Toda afirmação importante precisa de pelo menos uma fonte com url, título, órgão e verificadoEm (AAAA-MM-DD).
- Não invente números, prazos ou valores. Se não achou, escreva "não encontrado na fonte oficial" e coloque em "confirmarCom".
- Isto é organização e pesquisa, não parecer jurídico. Marque o que precisa ser confirmado com advogado ou consulado.
- Não envie mensagens, não preencha formulários, não crie contas. Não edite arquivos: responda só com o resumo e o JSON.
- Responda em português do Brasil. No FINAL da resposta, um único bloco \`\`\`json no formato pedido (sem comentários dentro do JSON).`;

const FONTE = '{ "url": "https://...", "titulo": "...", "orgao": "AIMA", "verificadoEm": "AAAA-MM-DD" }';

const PROMPTS: Record<ResearchTopic, (today: string) => string> = {
  legal: (today) => `Você é pesquisador do EMANNU OS. Hoje é ${today}.
${FAMILY_CONTEXT}
${RESEARCH_RULES}

# Tarefa: rotas de imigração e a Lei de Estrangeiros
1. Ponto de partida A VERIFICAR (não confie, confirme no texto legal): uma nova alteração da Lei de Estrangeiros (Lei n.º 23/2007) teria sido promulgada em outubro de 2025 (notícia do Postal do Algarve de 16/10/2025). Ela exigiria 2 anos de residência para pedir reagrupamento familiar, com exceção para filhos menores e para o cônjuge que é pai/mãe de filho menor a cargo. Também limitaria o visto de procura de trabalho a profissionais altamente qualificados e impediria que cidadãos da CPLP pedissem residência entrando como turistas. Encontre o diploma publicado no Diário da República (número, data, entrada em vigor). Leia o texto e diga o que está em vigor HOJE. Procure também portarias ou regulamentação publicadas depois. Para cada mudança, explique o impacto direto NESTE caso.
2. Compare estas rotas para a família: (a) visto de trabalho com contrato (subordinado), incluindo atividade altamente qualificada se existir; (b) rota CPLP para brasileiros (visto/autorização CPLP); (c) Cartão Azul UE: verifique se o requerente se qualifica (diploma, reconhecimento, salário mínimo exigido, duração do contrato); (d) visto de trabalho remoto/nômade digital (renda mínima exigida em euros); (e) visto de procura de trabalho (qualificado). Para cada rota informe requisitos, custos (taxas), prazos de decisão, onde pedir e, em destaque, se a família pode ir JUNTA ou quando pode se reunir, e se a esposa pode trabalhar.
3. Onde pedir: residente legal na Romênia pode pedir no posto consular de Portugal em Bucareste ou precisa ir ao Brasil? Confirme no site oficial (vistos.mne.gov.pt / embaixada).
4. Recomende a rota que mais protege o objetivo "família junta, cônjuge trabalhando". Dê um plano B e liste as incertezas.
5. Só marque "familiaJunta": "sim" se uma fonte oficial que você abriu confirmar que os familiares podem pedir e viajar ao mesmo tempo que o requerente principal. Se a lei permite, mas o procedimento simultâneo não está confirmado, use "depende" e explique.

# Formato do JSON
{
  "lei": {
    "diploma": "Lei n.º X/2025", "publicadoEm": "AAAA-MM-DD", "emVigorDesde": "AAAA-MM-DD",
    "situacao": "o que vale hoje, em 2-3 frases",
    "mudancas": [ { "tema": "Reagrupamento familiar", "antes": "...", "depois": "...", "impacto": "efeito direto para a família", "fontes": [${FONTE}] } ],
    "regulamentacao": [ { "titulo": "Portaria n.º ...", "resumo": "...", "fontes": [${FONTE}] } ],
    "fontes": [${FONTE}]
  },
  "rotas": [
    {
      "id": "trabalho-qualificado", "nome": "...", "resumo": "...",
      "elegibilidade": "sim|provavel|incerto|nao", "motivoElegibilidade": "...",
      "familiaJunta": "sim|nao|depende", "familiaDetalhe": "...",
      "conjugePodeTrabalhar": "sim|nao|depende", "conjugeDetalhe": "...",
      "requisitos": ["..."], "custos": ["Taxa do visto: € ... (fonte)"], "prazos": ["..."],
      "ondePedir": "...", "pros": ["..."], "contras": ["..."],
      "confirmarCom": ["advogado: ...", "consulado: ..."],
      "fontes": [${FONTE}]
    }
  ],
  "recomendacao": { "rotaId": "id da rota", "titulo": "...", "porque": "...", "passos": ["1. ...", "2. ..."], "planoB": "...", "incertezas": ["..."] }
}`,

  docs: (today) => `Você é pesquisador do EMANNU OS. Hoje é ${today}.
${FAMILY_CONTEXT}
${RESEARCH_RULES}

# Tarefa: checklist de documentos por pessoa
Monte a lista de documentos que a família vai precisar para a rota de visto de trabalho em Portugal (com reagrupamento/visto familiar para o cônjuge e os dependentes) e para a vida inicial em Portugal. Exemplos: passaporte; antecedentes criminais do Brasil (Polícia Federal) e da Romênia; certidões de casamento e de nascimento (inteiro teor? apostila de Haia?); NIF; NISS; contrato ou oferta de trabalho; comprovante de meios de subsistência e de alojamento; seguro de viagem/saúde; documentos escolares da filha; diploma de Direito e reconhecimento, se a rota exigir.
Para cada documento: para que serve, onde obter (órgão e país), se precisa de apostila, se precisa de tradução e qual, validade ou prazo máximo de emissão aceito. Use fontes oficiais (vistos.mne.gov.pt, AIMA, gov.br/Polícia Federal, Itamaraty, Ministério da Justiça romeno, ePortugal). NÃO peça nem registre números de documentos.
Inclua também regras gerais, por exemplo: "documentos estrangeiros precisam de apostila", "antecedentes valem 90 dias".

# Formato do JSON
{
  "itens": [
    { "id": "passaporte-emmanuel", "pessoa": "emmanuel|esposa|filha|familia", "documento": "...", "paraQue": "...", "ondeObter": "...",
      "apostila": true, "traducao": false, "validade": "ex.: emitido há no máximo 90 dias", "observacoes": "...", "fontes": [${FONTE}] }
  ],
  "regras": ["..."]
}`,

  living: (today) => `Você é pesquisador do EMANNU OS. Hoje é ${today}.
${FAMILY_CONTEXT}
${RESEARCH_RULES}
(Para custos de mercado, como aluguel e supermercado, fontes não oficiais servem: portais de imóveis, INE, câmara municipal. Indique sempre a fonte e a data.)

# Tarefa: custo de vida, escola e moradia em Braga e Barcelos
1. Câmbio atual RON→EUR (BNR ou BCE).
2. Aluguel: faixas em euros/mês para T1, T2 e T3 em Braga e em Barcelos, por zona quando possível. Fontes: idealista, imovirtual, INE.
3. Custos mensais de uma família de 3 (luz/água/gás, internet+celular, supermercado, transporte público ou carro, saúde, extras), com valor para Braga e para Barcelos.
4. Custos de mudança únicos: passagens Bucareste→Porto para 3, caução/depósito de aluguel (quantas rendas), mudança/bagagem, primeiros móveis, taxas de visto e documentos.
5. Escola pública das crianças: como funciona a matrícula para estrangeiros (Portal das Matrículas, agrupamentos), documentos, prazos, se pode matricular antes de ter autorização de residência. Fontes oficiais (DGEstE, ePortugal, gov.pt).
6. Bairros/freguesias recomendados para família nas duas cidades (custo, escola, transporte), com motivo.
7. Referências de salário: salário mínimo nacional vigente (oficial), salário médio da região, se encontrar.

# Formato do JSON
{
  "cambio": { "ronPorEur": 4.97, "data": "AAAA-MM-DD", "fonte": ${FONTE} },
  "moradia": [ { "cidade": "Braga", "zona": "...", "tipologia": "T2", "minEur": 700, "maxEur": 950, "observacao": "...", "fontes": [${FONTE}] } ],
  "custosMensais": [ { "item": "Supermercado (3 pessoas)", "bragaEur": 450, "barcelosEur": 420, "observacao": "...", "fontes": [${FONTE}] } ],
  "mudanca": [ { "item": "Passagens Bucareste→Porto (3)", "minEur": 300, "maxEur": 700, "observacao": "...", "fontes": [${FONTE}] } ],
  "escola": { "resumo": "...", "passos": ["..."], "documentos": ["..."], "prazos": ["..."], "fontes": [${FONTE}] },
  "bairros": [ { "cidade": "Braga", "nome": "...", "porque": "..." } ],
  "salarios": [ { "referencia": "Salário mínimo nacional 2026", "valorEur": 0, "observacao": "...", "fontes": [${FONTE}] } ]
}
Não inclua o aluguel em "custosMensais": ele já vem de "moradia".`,

  jobs: (today) => `Você é pesquisador do EMANNU OS. Hoje é ${today}.
${FAMILY_CONTEXT}
${RESEARCH_RULES}
(Para vagas, as fontes são os próprios anúncios: site da empresa, LinkedIn, Net-Empregos, IEFP, EURES. Abra o anúncio antes de citar.)

# Tarefa: vagas EM PORTUGAL
Procure até 10 vagas ABERTAS hoje, com empregador e contrato em Portugal, que combinem com o perfil do requerente (veja o currículo em português na pasta de referência) e permitam a família ir junta:
- PRIORIDADE: região de Leiria, região prioritária (Leiria, Marinha Grande, Batalha, Pombal, Ourém/Fátima, Alcobaça, Porto de Mós, Caldas da Rainha, até ~40 km). Traga pelo menos 6 vagas dessa região se existirem; complete com Braga/Barcelos/Porto.
- Presencial ou híbrido (remoto só se o contrato for com empresa portuguesa): servem de base para visto de trabalho.
- Áreas: atendimento multilíngue (inglês/espanhol/português), operações, conteúdo, apoio jurídico em português, QA.
- NÃO inclua plataformas de trabalho remoto de IA (Mercor, Turing, DataAnnotation, Appen/CrowdGen, OpenTrain etc.): elas têm uma pesquisa própria na seção IA.
Para cada vaga: diga por que combina, a elegibilidade (aceita candidatos de fora? patrocina visto?), se um contrato dela permite visto de trabalho em Portugal (sim/nao/incerto, com motivo), o salário publicado ou "não publicado" e o próximo passo. NÃO se candidate, não crie conta, não envie nada.

# Formato do JSON
{
  "vagas": [
    { "id": "empresa-cargo-curto", "empresa": "...", "titulo": "...", "local": "Braga, PT", "modalidade": "remoto|hibrido|presencial",
      "porque": "...", "elegibilidade": "...", "permiteVisto": "sim|nao|incerto", "salario": "...", "url": "https://...",
      "publicadaEm": "AAAA-MM-DD ou null (data de publicação mostrada no anúncio)",
      "verificadoEm": "AAAA-MM-DD", "condicoes": ["..."], "proximoPasso": "..." }
  ]
}
No "salario", copie o valor do anúncio com a unidade (ex.: "1.300 a 1.500 € brutos/mês", "16.000 € brutos/ano") ou "não publicado".`,

  aiJobs: (today) => `Você é pesquisador do EMANNU OS. Hoje é ${today}.
${FAMILY_CONTEXT}
${RESEARCH_RULES}
(Para vagas, as fontes são os próprios anúncios nas plataformas. Abra o anúncio antes de citar.)

# Tarefa: VAGAS DE IA (trabalho remoto)
Leia o currículo de IA na pasta de referência e procure até 10 vagas ABERTAS hoje de trabalho remoto com IA que combinem com ele: treinamento e avaliação de modelos (AI trainer, rater, evaluator), anotação de dados, especialista jurídico ou de idiomas (português do Brasil, inglês, espanhol) para IA, QA de respostas de IA. Plataformas como Mercor, Turing, DataAnnotation, Outlier, Appen/CrowdGen, OpenTrain, Scale/Remotasks, Alignerr, empresas de IA.
Para cada vaga: por que combina com o currículo, se aceita residentes na Romênia e em Portugal, pagamento publicado (por hora, por tarefa) ou "não publicado", volume garantido ou não, e o próximo passo. Diga também se a renda poderia, em tese, servir ao visto de trabalho remoto de Portugal (permiteVisto: sim/nao/incerto). NÃO se candidate, não crie conta, não envie nada.

# Formato do JSON
{
  "vagas": [
    { "id": "plataforma-cargo-curto", "empresa": "...", "titulo": "...", "local": "Remoto", "modalidade": "remoto",
      "porque": "...", "elegibilidade": "...", "permiteVisto": "sim|nao|incerto", "salario": "...", "url": "https://...",
      "publicadaEm": "AAAA-MM-DD ou null", "verificadoEm": "AAAA-MM-DD", "condicoes": ["..."], "proximoPasso": "..." }
  ]
}
No "salario", copie o valor com a unidade e a moeda (ex.: "US$ 15–20/h") ou "não publicado".`,

  apartamentos: (today) => `Você é pesquisador do EMANNU OS. Hoje é ${today}.
${FAMILY_CONTEXT}
${RESEARCH_RULES}
(Para apartamentos, as fontes são os próprios anúncios: idealista.pt, imovirtual.com, casa.sapo.pt, OLX, sites de imobiliárias. Abra o anúncio antes de citar.)

# Tarefa: APARTAMENTOS PARA ALUGAR (pesquisa diária)
Procure até 12 apartamentos para ARRENDAR (aluguel de longa duração, não férias) anunciados hoje ou nos últimos dias, para uma família de 3 (casal + 1 criança):
- PRIORIDADE: região de Leiria (Leiria, Marinha Grande, Batalha, Pombal, Ourém/Fátima, Alcobaça, Porto de Mós). Traga pelo menos 8 dessa região se existirem; complete com Braga e Barcelos.
- Tipologia T2 ou T3 (T1 só se for muito barato e grande). Renda até cerca de 1.100 €/mês.
- Diga a zona/freguesia, a área em m² se o anúncio mostrar, se é mobiliado, e observações úteis (perto de escola, transporte, exige fiador, caução de quantas rendas).
NÃO entre em contato, não agende visitas, não crie conta, não envie nada.

# Formato do JSON
{
  "apartamentos": [
    { "id": "cidade-zona-tipologia-preco", "titulo": "...", "cidade": "Leiria", "zona": "...", "tipologia": "T2",
      "precoEur": 750, "areaM2": 85, "mobiliado": "sim|nao|incerto", "url": "https://...", "fonte": "idealista",
      "publicadaEm": "AAAA-MM-DD ou null", "verificadoEm": "AAAA-MM-DD", "observacao": "..." }
  ]
}`,
};

// Trabalho remoto de IA (plataformas de treinamento/anotação) → seção IA, não Imigração.
const AI_RE = /\b(mercor|turing|crowdgen|appen|dataannotation|data annotation|opentrain|gramian|outlier|remotasks|scale ai|alignerr|annotat\w*|anota[çc][ãa]o|ai trainer|rater|llm|ai training|treinamento de ia|quality reviewer|transcription expert)\b/i;
export function isAiOffer(v: { empresa: string; titulo: string; origem?: string; categoria?: string }): boolean {
  if (v.categoria) return v.categoria === 'ai';
  return v.origem === 'legado' || AI_RE.test(`${v.empresa} ${v.titulo}`);
}

// Sugere o item do checklist que um arquivo parece ser, pelas palavras do nome.
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
export function matchDoc(fileName: string, items: { id: string; documento: string; pessoa: string }[]): string | null {
  const name = norm(fileName);
  let best: { id: string; score: number } | null = null;
  for (const it of items) {
    const words = norm(it.documento).split(/[^a-z0-9]+/).filter((w) => w.length >= 5);
    const score = words.filter((w) => name.includes(w)).length + (name.includes(norm(it.pessoa)) ? 0.5 : 0);
    if (score >= 1 && (!best || score > best.score)) best = { id: it.id, score };
  }
  return best?.id ?? null;
}

export function researchPrompt(topic: ResearchTopic, today: string): string {
  return PROMPTS[topic](today);
}

// ---------------- leitura do JSON ----------------

const OFFICIAL_HOSTS = [
  /(^|\.)gov\.pt$/, /(^|\.)mne\.gov\.pt$/, /(^|\.)diariodarepublica\.pt$/, /(^|\.)dre\.pt$/, /(^|\.)parlamento\.pt$/,
  /(^|\.)aima\.gov\.pt$/, /(^|\.)seg-social\.pt$/, /(^|\.)iefp\.pt$/, /(^|\.)ine\.pt$/, /(^|\.)bportugal\.pt$/,
  /(^|\.)gov\.br$/, /(^|\.)gov\.ro$/, /(^|\.)bnr\.ro$/, /(^|\.)europa\.eu$/, /(^|\.)cm-braga\.pt$/, /(^|\.)cm-barcelos\.pt$/,
  /(^|\.)min-edu\.pt$/, /(^|\.)dgeste\.mec\.pt$/, /(^|\.)mec\.pt$/, /(^|\.)portaldasfinancas\.gov\.pt$/,
];

export function isOfficialUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return OFFICIAL_HOSTS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v.trim() : v == null ? fallback : String(v));
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const strs = (v: unknown): string[] => arr(v).map((x) => str(x)).filter(Boolean);
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
const oneOf = <T extends string>(v: unknown, opts: readonly T[], fallback: T): T => (opts.includes(v as T) ? (v as T) : fallback);
const slugId = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export function normalizeSource(v: any, today: string): Source | null {
  const url = str(v?.url);
  if (!/^https?:\/\//.test(url)) return null;
  const date = str(v?.verificadoEm);
  return {
    url,
    titulo: str(v?.titulo) || url,
    orgao: str(v?.orgao),
    verificadoEm: /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= today ? date : '',
    oficial: isOfficialUrl(url),
  };
}

const sources = (v: unknown, today: string): Source[] => arr(v).map((s) => normalizeSource(s, today)).filter((s): s is Source => !!s);

export function extractJson(text: string | null): any {
  if (!text) throw new Error('Pesquisa sem resposta.');
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]).reverse();
  for (const c of blocks.length ? blocks : [text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    try {
      return JSON.parse(c);
    } catch {}
  }
  throw new Error('A pesquisa não devolveu um JSON válido.');
}

const TRI = ['sim', 'nao', 'depende'] as const;
const ELIG = ['sim', 'provavel', 'incerto', 'nao'] as const;
const PERSONS = ['emmanuel', 'esposa', 'filha', 'familia'] as const;

export function parseLegal(raw: any, today: string): LegalResearch {
  const lei = raw?.lei ?? {};
  const rotas: Route[] = arr(raw?.rotas).map((r, i) => {
    const fontes = sources(r.fontes, today);
    const confirmarCom = strs(r.confirmarCom);
    // Requisito legal sem fonte oficial: vira algo a confirmar.
    if (!fontes.some((f) => f.oficial)) confirmarCom.unshift('Sem fonte oficial aberta nesta pesquisa — confirmar no consulado/AIMA.');
    return {
      id: slugId(str(r.id) || str(r.nome) || `rota-${i + 1}`),
      nome: str(r.nome) || `Rota ${i + 1}`,
      resumo: str(r.resumo),
      elegibilidade: oneOf<Eligibility>(r.elegibilidade, ELIG, 'incerto'),
      motivoElegibilidade: str(r.motivoElegibilidade),
      familiaJunta: oneOf<Tri>(r.familiaJunta, TRI, 'depende'),
      familiaDetalhe: str(r.familiaDetalhe),
      conjugePodeTrabalhar: oneOf<Tri>(r.conjugePodeTrabalhar, TRI, 'depende'),
      conjugeDetalhe: str(r.conjugeDetalhe),
      requisitos: strs(r.requisitos),
      custos: strs(r.custos),
      prazos: strs(r.prazos),
      ondePedir: str(r.ondePedir),
      pros: strs(r.pros),
      contras: strs(r.contras),
      confirmarCom,
      fontes,
    };
  });
  if (!rotas.length) throw new Error('A pesquisa legal não trouxe rotas.');
  const rec = raw?.recomendacao ?? {};
  const recId = slugId(str(rec.rotaId));
  return {
    geradoEm: today,
    lei: {
      diploma: str(lei.diploma, 'não identificado'),
      publicadoEm: str(lei.publicadoEm),
      emVigorDesde: str(lei.emVigorDesde),
      situacao: str(lei.situacao),
      mudancas: arr(lei.mudancas).map((m) => ({ tema: str(m.tema), antes: str(m.antes), depois: str(m.depois), impacto: str(m.impacto), fontes: sources(m.fontes, today) })),
      regulamentacao: arr(lei.regulamentacao).map((m) => ({ titulo: str(m.titulo), resumo: str(m.resumo), fontes: sources(m.fontes, today) })),
      fontes: sources(lei.fontes, today),
    },
    rotas,
    recomendacao: {
      rotaId: rotas.some((r) => r.id === recId) ? recId : rotas[0].id,
      titulo: str(rec.titulo),
      porque: str(rec.porque),
      passos: strs(rec.passos),
      planoB: str(rec.planoB),
      incertezas: strs(rec.incertezas),
    },
  };
}

export function parseDocs(raw: any, today: string): DocsResearch {
  const seen = new Set<string>();
  const itens: DocItem[] = [];
  for (const [i, d] of arr(raw?.itens).entries()) {
    const pessoa = oneOf<Person>(d.pessoa, PERSONS, 'familia');
    let id = slugId(str(d.id) || `${str(d.documento)}-${pessoa}`) || `doc-${i + 1}`;
    while (seen.has(id)) id += '-2';
    seen.add(id);
    const yesNo = (v: unknown) => (v === true || v === 'sim' ? true : v === false || v === 'nao' ? false : null);
    itens.push({
      id,
      pessoa,
      documento: str(d.documento) || id,
      paraQue: str(d.paraQue),
      ondeObter: str(d.ondeObter),
      apostila: yesNo(d.apostila),
      traducao: yesNo(d.traducao),
      validade: str(d.validade),
      observacoes: str(d.observacoes),
      fontes: sources(d.fontes, today),
    });
  }
  if (!itens.length) throw new Error('A pesquisa de documentos não trouxe itens.');
  return { geradoEm: today, itens, regras: strs(raw?.regras) };
}

export function parseLiving(raw: any, today: string): LivingResearch {
  const range = (m: any) => ({ minEur: num(m.minEur), maxEur: Math.max(num(m.maxEur), num(m.minEur)) });
  const fx = num(raw?.cambio?.ronPorEur);
  if (!(fx > 3 && fx < 7)) throw new Error(`Câmbio RON/EUR fora do esperado: ${raw?.cambio?.ronPorEur}`);
  return {
    geradoEm: today,
    cambio: { ronPorEur: fx, data: str(raw.cambio.data), fonte: normalizeSource(raw.cambio.fonte, today) },
    moradia: arr(raw.moradia).map((m) => ({ cidade: str(m.cidade), zona: str(m.zona), tipologia: str(m.tipologia), ...range(m), observacao: str(m.observacao), fontes: sources(m.fontes, today) })),
    custosMensais: arr(raw.custosMensais).map((c) => ({ item: str(c.item), bragaEur: num(c.bragaEur), barcelosEur: num(c.barcelosEur), observacao: str(c.observacao), fontes: sources(c.fontes, today) })),
    mudanca: arr(raw.mudanca).map((m) => ({ item: str(m.item), ...range(m), observacao: str(m.observacao), fontes: sources(m.fontes, today) })),
    escola: {
      resumo: str(raw.escola?.resumo),
      passos: strs(raw.escola?.passos),
      documentos: strs(raw.escola?.documentos),
      prazos: strs(raw.escola?.prazos),
      fontes: sources(raw.escola?.fontes, today),
    },
    bairros: arr(raw.bairros).map((b) => ({ cidade: str(b.cidade), nome: str(b.nome), porque: str(b.porque) })),
    salarios: arr(raw.salarios).map((s) => ({ referencia: str(s.referencia), valorEur: num(s.valorEur), observacao: str(s.observacao), fontes: sources(s.fontes, today) })),
  };
}

export function parseJobs(raw: any, today: string): JobsResearch {
  const vagas: JobOffer[] = arr(raw?.vagas)
    .map((v): JobOffer => ({
      id: slugId(str(v.id) || `${str(v.empresa)}-${str(v.titulo)}`),
      empresa: str(v.empresa),
      titulo: str(v.titulo),
      local: str(v.local),
      modalidade: oneOf(v.modalidade, ['remoto', 'hibrido', 'presencial'] as const, 'remoto'),
      porque: str(v.porque),
      elegibilidade: str(v.elegibilidade),
      permiteVisto: oneOf(v.permiteVisto, ['sim', 'nao', 'incerto'] as const, 'incerto'),
      salario: str(v.salario, 'não publicado'),
      url: str(v.url),
      verificadoEm: /^\d{4}-\d{2}-\d{2}$/.test(str(v.verificadoEm)) ? str(v.verificadoEm) : today,
      condicoes: strs(v.condicoes),
      proximoPasso: str(v.proximoPasso),
      publicadaEm: /^\d{4}-\d{2}-\d{2}$/.test(str(v.publicadaEm)) ? str(v.publicadaEm) : null,
      origem: 'pesquisa',
    }))
    .filter((v) => v.empresa && v.titulo && /^https?:\/\//.test(v.url));
  return { geradoEm: today, vagas };
}

const isoOrNull = (x: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(str(x)) ? str(x) : null);

export function parseApartments(raw: any, today: string): ApartmentsResearch {
  const apartamentos: Apartment[] = arr(raw?.apartamentos)
    .map((a): Apartment => ({
      id: slugId(str(a.id) || `${str(a.cidade)}-${str(a.zona)}-${str(a.tipologia)}-${num(a.precoEur)}`),
      titulo: str(a.titulo),
      cidade: str(a.cidade),
      zona: str(a.zona),
      tipologia: str(a.tipologia).toUpperCase(),
      precoEur: num(a.precoEur),
      areaM2: num(a.areaM2) || null,
      mobiliado: oneOf(a.mobiliado, ['sim', 'nao', 'incerto'] as const, 'incerto'),
      url: str(a.url),
      fonte: str(a.fonte),
      publicadaEm: isoOrNull(a.publicadaEm),
      verificadoEm: isoOrNull(a.verificadoEm) ?? today,
      observacao: str(a.observacao),
    }))
    .filter((a) => a.cidade && a.precoEur > 0 && /^https?:\/\//.test(a.url));
  return { geradoEm: today, apartamentos };
}

export const PARSERS: Record<ResearchTopic, (raw: any, today: string) => unknown> = {
  legal: parseLegal,
  docs: parseDocs,
  living: parseLiving,
  // Vagas de Portugal: plataformas de IA que escaparem são descartadas (têm pesquisa própria).
  jobs: (raw, today) => {
    const r = parseJobs(raw, today);
    return { ...r, vagas: r.vagas.filter((v) => !isAiOffer(v)).map((v) => ({ ...v, categoria: 'portugal' as const })) };
  },
  aiJobs: (raw, today) => {
    const r = parseJobs(raw, today);
    return { ...r, vagas: r.vagas.map((v) => ({ ...v, categoria: 'ai' as const })) };
  },
  apartamentos: parseApartments,
};

// Vagas do cockpit antigo (JOB-OFFERS-*.json), convertidas para o formato novo.
export function importLegacyOffers(raw: any): JobOffer[] {
  return arr(raw?.items).map((it) => ({
    id: slugId(str(it.id)),
    empresa: str(it.company),
    titulo: str(it.title),
    local: 'Remoto',
    modalidade: 'remoto' as const,
    porque: str(it.why),
    elegibilidade: str(it.eligibility),
    permiteVisto: 'incerto' as const,
    salario: str(it.pay?.label, 'não publicado'),
    url: str(it.url),
    verificadoEm: str(raw?.verifiedAt).slice(0, 10),
    condicoes: [
      ...strs(it.conditions),
      'Plataforma de trabalho por hora/projeto: não é contrato português; só serviria ao visto de trabalho remoto se a renda comprovada atingir o mínimo exigido.',
    ],
    proximoPasso: str(it.next),
    origem: 'legado' as const,
    categoria: 'ai' as const,
  }));
}
