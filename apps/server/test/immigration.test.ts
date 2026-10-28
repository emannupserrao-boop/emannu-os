import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Scheduler } from '../src/scheduler.ts';
import { claudeAdapter, type AgentAdapter } from '../src/runners/adapters.ts';
import { Vault } from '../src/vault.ts';
import { Immigration } from '../src/immigration/index.ts';
import { isOfficialUrl, parseLegal, parseLiving, importLegacyOffers } from '../src/immigration/topics.ts';
import { computeScenarios, computeTimeline, allSources, isStale, DEFAULT_USER, type ImmigrationState } from '../../../packages/shared/immigration.ts';
import type { Job } from '../../../packages/shared/types.ts';

const FAKE = join(import.meta.dirname, 'fake-agent.mjs');
const TODAY = new Date().toISOString().slice(0, 10);
const say = (text: string) => ['say', Buffer.from(text).toString('base64')];
const json = (o: unknown) => 'Resumo.\n```json\n' + JSON.stringify(o) + '\n```';
const src = (url: string, verificadoEm = TODAY) => ({ url, titulo: 't', orgao: 'o', verificadoEm });

const LEGAL = {
  lei: { diploma: 'Lei n.º 61/2025', publicadoEm: '2025-10-22', emVigorDesde: '2025-10-23', situacao: 's', mudancas: [{ tema: 'Reagrupamento', antes: 'a', depois: 'd', impacto: 'i', fontes: [src('https://diariodarepublica.pt/x')] }], regulamentacao: [], fontes: [src('https://diariodarepublica.pt/x')] },
  rotas: [
    { id: 'Trabalho Qualificado', nome: 'Trabalho qualificado', elegibilidade: 'provavel', familiaJunta: 'sim', conjugePodeTrabalhar: 'sim', requisitos: ['contrato'], fontes: [src('https://vistos.mne.gov.pt/pt/x')] },
    { id: 'cplp', nome: 'CPLP', elegibilidade: 'talvez', familiaJunta: 'xx', fontes: [src('https://noticia.com/x')] },
  ],
  recomendacao: { rotaId: 'trabalho-qualificado', titulo: 'Ir com contrato', porque: 'p', passos: ['1'], planoB: 'b', incertezas: ['u'] },
};
const LIVING = {
  cambio: { ronPorEur: 5, data: TODAY, fonte: src('https://www.bnr.ro/x') },
  moradia: [{ cidade: 'Braga', zona: 'Centro', tipologia: 'T2', minEur: 800, maxEur: 1000 }, { cidade: 'Barcelos', zona: 'Centro', tipologia: 'T2', minEur: 600, maxEur: 800 }],
  custosMensais: [{ item: 'Mercado', bragaEur: 500, barcelosEur: 400 }],
  mudanca: [{ item: 'Passagens', minEur: 400, maxEur: 600 }],
  escola: { resumo: 'r', passos: ['p'], documentos: ['d'], prazos: [], fontes: [] },
  bairros: [],
  salarios: [],
};

describe('leitura das pesquisas', () => {
  it('normaliza rotas, calcula "oficial" pelo domínio e exige fonte oficial', () => {
    const l = parseLegal(LEGAL, TODAY);
    expect(l.rotas.map((r) => r.id)).toEqual(['trabalho-qualificado', 'cplp']);
    expect(l.rotas[1].elegibilidade).toBe('incerto');
    expect(l.rotas[1].familiaJunta).toBe('depende');
    expect(l.rotas[0].fontes[0].oficial).toBe(true);
    expect(l.rotas[1].confirmarCom[0]).toMatch(/Sem fonte oficial/);
    expect(l.recomendacao.rotaId).toBe('trabalho-qualificado');
  });

  it('domínios oficiais', () => {
    for (const u of ['https://aima.gov.pt/pt/x', 'https://vistos.mne.gov.pt/pt/', 'https://diariodarepublica.pt/dr/x', 'https://www.gov.br/pf/x', 'https://eportugal.gov.pt/x']) expect(isOfficialUrl(u)).toBe(true);
    for (const u of ['https://postal.pt/x', 'https://gov.pt.fake.com/x', 'nada']) expect(isOfficialUrl(u)).toBe(false);
  });

  it('data de verificação no futuro ou inválida fica vazia', () => {
    const l = parseLegal({ ...LEGAL, rotas: [{ nome: 'x', fontes: [src('https://aima.gov.pt/x', '2999-01-01')] }] }, TODAY);
    expect(l.rotas[0].fontes[0].verificadoEm).toBe('');
  });

  it('recusa câmbio absurdo', () => {
    expect(() => parseLiving({ ...LIVING, cambio: { ronPorEur: 0.2 } }, TODAY)).toThrow(/Câmbio/);
  });

  it('importa as vagas do legado', () => {
    const v = importLegacyOffers({ verifiedAt: '2026-10-21T05:19:10Z', items: [{ id: 'RADAR-MERCOR', company: 'Mercor', title: 'QA', pay: { label: 'US$15/h' }, url: 'https://x', conditions: ['a'] }] });
    expect(v[0]).toMatchObject({ id: 'radar-mercor', empresa: 'Mercor', salario: 'US$15/h', origem: 'legado', verificadoEm: '2026-10-21' });
  });
});

describe('cálculos', () => {
  const state = (): ImmigrationState => ({
    verificacao: null,
    legal: parseLegal(LEGAL, TODAY),
    docs: null,
    living: parseLiving(LIVING, TODAY),
    jobs: null,
    aiJobs: null,
    apartamentos: null,
    arquivos: [],
    user: { ...DEFAULT_USER, fimEmprego: '2026-11-30', orcamento: { ...DEFAULT_USER.orcamento, reservaLei: 50000, rescisaoLei: 10000, salarioPresencialEur: 1200, salarioEsposaEur: 870 } },
    research: [],
    docsFolder: 'X',
    vaultFolder: 'Y',
  });

  it('cenários de orçamento: capital, custo e quanto a reserva dura', () => {
    const r = computeScenarios(state(), 'braga')!;
    expect(r.mudancaEur).toBe(500);
    expect(r.capitalEur).toBe(60000 / 5 - 500); // 11500
    expect(r.cenarios[0].custoEur).toBe(900 + 500); // aluguel médio T2 + custos
    expect(r.cenarios[0].mesesReserva).toBeCloseTo(11500 / 1400, 1);
    const both = r.cenarios.find((c) => c.id === 'presencial-2')!;
    expect(both.saldoEur).toBe(1200 + 870 - 1400);
    expect(both.mesesReserva).toBeNull();
  });

  it('linha do tempo: fim do emprego + prazo de 90 dias', () => {
    const t = computeTimeline(state(), '2026-10-27');
    expect(t[0]).toMatchObject({ data: '2026-11-30', tipo: 'critico', diasAte: 34 });
    expect(t[1].data).toBe('2027-02-28');
  });

  it('fontes com mais de 30 dias ficam para rever', () => {
    expect(isStale(src('https://x', '2026-01-01') as any, '2026-10-27')).toBe(true);
    expect(isStale(src('https://x', '2026-10-20') as any, '2026-10-27')).toBe(false);
    expect(allSources(state()).length).toBeGreaterThan(0);
  });
});

describe('módulo Imigração com o agendador', () => {
  let dir: string;
  let vaultDir: string;
  let sched: Scheduler;
  let imm: Immigration;
  let script: (job: Job) => string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'emannu-imm-'));
    vaultDir = join(dir, 'vault');
    mkdirSync(vaultDir);
    const legacy = join(dir, 'legacy.json');
    writeFileSync(legacy, JSON.stringify({ verifiedAt: '2026-10-21T00:00:00Z', items: [{ id: 'L1', company: 'Antiga', title: 'Vaga antiga', url: 'https://antiga/1' }] }));
    const fake: AgentAdapter = { buildArgs: (job, _c, prompt) => ({ args: [FAKE, ...script(job)], stdin: prompt }), parse: claudeAdapter.parse };
    sched = new Scheduler({ store: new Store(':memory:'), vault: new Vault(vaultDir), logDir: join(dir, 'logs'), worktreesDir: join(dir, 'wt'), adapters: { claude: fake, codex: fake }, resolveExe: () => process.execPath });
    imm = new Immigration(sched, { projectPath: join(dir, 'imigracao'), docsDir: join(dir, 'docs-local'), vaultFolder: '40 - PERSONAL/Imigração Portugal', legacyOffersPath: legacy, researchEveryDays: 7 });
    imm.init();
  });

  afterEach(async () => {
    for (const [, a] of sched.active) a.proc.kill();
    // No Windows, a pasta só pode ser apagada depois que o processo morreu de fato.
    await waitFor(() => sched.active.size === 0, 10_000);
    await new Promise((r) => setTimeout(r, 300));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function waitFor(fn: () => boolean, ms = 15_000) {
    const t = Date.now();
    while (!fn()) {
      if (Date.now() - t > ms) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('a pasta de referência é sua: não cria subpastas; vagas do legado vão para IA', () => {
    expect(existsSync(join(dir, 'docs-local'))).toBe(true);
    expect(readdirSync(join(dir, 'docs-local'))).toEqual([]);
    expect(imm.state().aiJobs!.vagas[0]).toMatchObject({ id: 'l1', origem: 'legado', categoria: 'ai' });
    expect(imm.state().jobs).toBeNull();
  });

  it('lista os arquivos da pasta e sugere o item do checklist', async () => {
    script = () => say(json({ itens: [{ id: 'passaporte-filha', pessoa: 'filha', documento: 'Passaporte da filha', fontes: [] }, { id: 'certidao-casamento', pessoa: 'familia', documento: 'Certidão de casamento', fontes: [] }] }));
    imm.runResearch(['docs']);
    await waitFor(() => imm.state().research.find((r) => r.topic === 'docs')!.status === 'ok');
    mkdirSync(join(dir, 'docs-local', 'Filha'));
    writeFileSync(join(dir, 'docs-local', 'Filha', 'passaporte filha.pdf'), 'x');
    writeFileSync(join(dir, 'docs-local', 'Certidao_Casamento.pdf'), 'x');
    writeFileSync(join(dir, 'docs-local', 'CV_Emannuel.pdf'), 'x');
    const files = imm.state().arquivos;
    expect(files.map((f) => [f.nome, f.sugestao])).toEqual([
      ['Certidao_Casamento.pdf', 'certidao-casamento'],
      ['CV_Emannuel.pdf', null],
      ['passaporte filha.pdf', 'passaporte-filha'],
    ]);
  });

  it('separa vagas: Portugal na Imigração, plataformas de IA na seção IA', async () => {
    script = (job) =>
      say(json({ vagas: job.planKey === 'jobs'
        ? [{ empresa: 'Fujitsu', titulo: 'IT Support', local: 'Braga', url: 'https://f/1', modalidade: 'hibrido' }, { empresa: 'Mercor', titulo: 'Legal Expert', url: 'https://m/1' }]
        : [{ empresa: 'Toloka', titulo: 'Portuguese Evaluator', url: 'https://t/1' }] }));
    imm.runResearch(['jobs', 'aiJobs']);
    await waitFor(() => imm.state().research.filter((r) => r.topic === 'jobs' || r.topic === 'aiJobs').every((r) => r.status === 'ok'), 20_000);
    const s = imm.state();
    expect(s.jobs!.vagas.map((v) => v.empresa)).toEqual(['Fujitsu']); // Mercor não entra em Portugal
    expect(s.aiJobs!.vagas.map((v) => v.empresa).sort()).toEqual(['Antiga', 'Toloka']); // legado continua
    expect(s.aiJobs!.vagas.every((v) => v.categoria === 'ai')).toBe(true);
    imm.writeNotes();
    expect(readFileSync(join(vaultDir, '50 - CAREER & AI WORK', 'Vagas de IA.md'), 'utf8')).toContain('Toloka');
  });

  it('pesquisa → dados salvos → notas no vault (só a região do sistema é trocada)', async () => {
    script = (job) => say(json(job.planKey === 'legal' ? LEGAL : job.planKey === 'living' ? LIVING : job.planKey === 'docs' ? { itens: [{ id: 'passaporte', pessoa: 'filha', documento: 'Passaporte', fontes: [] }], regras: ['apostila'] } : { vagas: [{ empresa: 'Nova', titulo: 'Atendimento', url: 'https://nova/1', permiteVisto: 'sim', modalidade: 'presencial' }] }));
    imm.runResearch();
    await waitFor(() => imm.state().research.every((r) => r.status === 'ok'), 25_000);
    const s = imm.state();
    expect(s.legal!.lei.diploma).toBe('Lei n.º 61/2025');
    expect(s.docs!.itens[0].pessoa).toBe('filha');
    // Vaga de Portugal na Imigração; a do legado (IA) continua na seção IA.
    expect(s.jobs!.vagas.map((v) => v.empresa)).toEqual(['Nova']);
    expect(s.aiJobs!.vagas.map((v) => v.empresa)).toContain('Antiga');

    const files = imm.writeNotes();
    expect(files).toHaveLength(8); // 7 da Imigração (inclui Vagas e apartamentos) + Vagas de IA
    const painel = join(vaultDir, '40 - PERSONAL', 'Imigração Portugal', 'Painel.md');
    expect(readFileSync(painel, 'utf8')).toContain('Ir com contrato');
    // Você escreve fora dos marcadores; a próxima atualização preserva o seu texto.
    writeFileSync(painel, readFileSync(painel, 'utf8') + '\nMinha anotação pessoal.\n');
    imm.updateUser({ docs: { passaporte: { status: 'pronto', validoAte: '2030-01-01' } } });
    imm.writeNotes();
    const after = readFileSync(painel, 'utf8');
    expect(after).toContain('Minha anotação pessoal.');
    expect(after).toContain('Dependente: 1/1 prontos');
    // Documentos: só status, nada de número.
    expect(readFileSync(join(vaultDir, '40 - PERSONAL', 'Imigração Portugal', 'Documentos.md'), 'utf8')).toContain('| Passaporte | Pronto | 2030-01-01 |');
  });

  it('rotinas: vagas e apartamentos todo dia às 06h30; o resto às segundas; sem duplicar', async () => {
    script = () => say('sem json'); // termina logo (e falha), para não prender a fila
    imm.registerRoutines(sched.routines);
    // Terça, 07:00 em Bucareste (05:00 UTC, horário de inverno): só a rotina diária dispara.
    const tue = new Date('2026-10-27T05:00:00Z');
    expect(await sched.routines.tick(tue)).toEqual(['hermes-vagas']);
    const topics = () => sched.store.listJobs().filter((j) => j.kind === 'research').map((j) => j.planKey).sort();
    expect(topics()).toEqual(['aiJobs', 'apartamentos', 'jobs']);
    // Outro relógio no mesmo horário (ex.: reinício): nada novo.
    expect(await sched.routines.tick(new Date('2026-10-27T05:30:00Z'))).toEqual([]);
    expect(topics()).toHaveLength(3);
    // Segunda: também a semanal.
    expect((await sched.routines.tick(new Date('2026-11-02T05:00:00Z'))).sort()).toEqual(['hermes-legal', 'hermes-vagas']);
    // Sem o Hermes instalado, quem pesquisa é o Claude; a agenda aparece na aba Agentes.
    expect(sched.store.listJobs().every((j) => j.agent === 'claude')).toBe(true);
    expect(sched.routines.views().find((r) => r.id === 'hermes-vagas')).toMatchObject({ schedule: '30 6 * * *', timezone: 'Europe/Bucharest', enabled: true });
    // Espera a fila esvaziar (os jobs falsos falham rápido) antes de apagar a pasta.
    await waitFor(() => sched.store.listJobs().every((j) => !['queued', 'running'].includes(j.status)), 20_000);
  });

  it('apartamentos: lê, guarda quando foi visto pela primeira vez e mantém os que você marcou', async () => {
    let round = 1;
    script = () =>
      say(json({ apartamentos: round === 1
        ? [
            { id: 'leiria-t2', titulo: 'T2 no centro', cidade: 'Leiria', zona: 'Centro', tipologia: 't2', precoEur: 750, areaM2: 90, mobiliado: 'sim', url: 'https://idealista/1', fonte: 'idealista', publicadaEm: '2026-10-26' },
            { id: 'braga-t3', titulo: 'T3', cidade: 'Braga', tipologia: 'T3', precoEur: 1200, url: 'https://idealista/2' },
            { id: 'sem-link', cidade: 'Leiria', precoEur: 500, url: '' },
          ]
        : [{ id: 'pombal-t2', cidade: 'Pombal', tipologia: 'T2', precoEur: 600, url: 'https://imovirtual/3' }] }));
    imm.runResearch(['apartamentos']);
    await waitFor(() => imm.state().research.find((r) => r.topic === 'apartamentos')!.status === 'ok');
    const first = imm.state().apartamentos!.apartamentos;
    expect(first.map((a) => [a.id, a.tipologia, a.mobiliado])).toEqual([['leiria-t2', 'T2', 'sim'], ['braga-t3', 'T3', 'incerto']]);
    expect(first[0].encontradaEm).toBe(new Date().toISOString().slice(0, 10));
    imm.updateUser({ apartamentos: { 'leiria-t2': { status: 'visitar' } } });

    round = 2;
    imm.runResearch(['apartamentos']);
    await waitFor(() => imm.state().apartamentos!.apartamentos.some((a) => a.id === 'pombal-t2'));
    // Os da rodada anterior (vistos há menos de 14 dias) continuam na lista.
    expect(imm.state().apartamentos!.apartamentos.map((a) => a.id).sort()).toEqual(['braga-t3', 'leiria-t2', 'pombal-t2']);
    expect(imm.state().user.apartamentos['leiria-t2'].status).toBe('visitar');
    imm.writeNotes();
    const note = readFileSync(join(vaultDir, '40 - PERSONAL', 'Imigração Portugal', 'Vagas e apartamentos.md'), 'utf8');
    expect(note).toContain('⭐ [T2 no centro](https://idealista/1)');
  });

  it('nota escrita por você com o mesmo nome não é tocada', () => {
    const folder = join(vaultDir, '40 - PERSONAL', 'Imigração Portugal');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'Rotas.md'), '# Minhas rotas\n');
    imm.writeNotes();
    expect(readFileSync(join(folder, 'Rotas.md'), 'utf8')).toBe('# Minhas rotas\n');
    expect(existsSync(join(folder, 'Rotas (gerado).md'))).toBe(true);
  });

  it('JSON inválido marca a pesquisa como falha sem apagar os dados anteriores', async () => {
    script = () => say('sem json');
    imm.runResearch(['legal']);
    await waitFor(() => imm.state().research.find((r) => r.topic === 'legal')!.status === 'falhou');
    expect(imm.state().research.find((r) => r.topic === 'legal')!.error).toMatch(/JSON/);
  });

  it('não duplica pesquisa que já está na fila', () => {
    script = () => ['sleep', '60000'];
    imm.runResearch(['legal']);
    imm.runResearch(['legal']);
    expect(sched.store.listJobs().filter((j) => j.kind === 'research')).toHaveLength(1);
  });

  it('preparar candidatura: rascunho por agente, vaga fica "pronta (você envia)"', async () => {
    script = () => ['write', 'rascunho.md'];
    const job = imm.prepareApplication('l1');
    expect(job.title).toMatch(/Rascunho de candidatura/);
    expect(job.prompt).toMatch(/NÃO envie nada/);
    expect(imm.state().user.vagas.l1.status).toBe('preparar');
    await waitFor(() => imm.state().user.vagas.l1?.status === 'pronta');
  });
});
