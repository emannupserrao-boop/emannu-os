// Servidor isolado para os testes de ponta a ponta (Playwright): dados, vault e
// worktrees em uma pasta temporária, porta 8861. Nunca toca nos dados reais.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'emannu-e2e-'));
const vault = join(dir, 'vault');
mkdirSync(join(vault, '90 - INBOX'), { recursive: true });
// Um objetivo vindo do INBOX deixa algo em "Aguardando você".
writeFileSync(join(vault, '90 - INBOX', 'ideia.md'), '# Objetivo de teste do celular\n\nVer se aparece no topo. #objetivo\n');

Object.assign(process.env, {
  EMANNU_VAR_DIR: join(dir, 'var'),
  EMANNU_VAULT_DIR: vault,
  EMANNU_WORKTREES_DIR: join(dir, 'wt'),
  EMANNU_IMMIGRATION_DOCS_DIR: join(dir, 'docs-local'),
  EMANNU_CLAUDE_PROJECTS_DIR: join(dir, 'claude-projects'),
  EMANNU_PORT: process.env.EMANNU_PORT ?? '8861',
  // As rotinas (06h30, 07h15…) chamariam os agentes de verdade: desligadas nos testes.
  EMANNU_NO_ROUTINES: '1',
});
console.log('Dados de teste em', dir);

// Aba Arquivos: uma pasta de músicas pequena (WAV de 2 s, uma capa e uma nota).
const music = join(dir, 'Musicas');
mkdirSync(join(music, 'The Abyss', 'WAV'), { recursive: true });
mkdirSync(join(music, 'Visual content'), { recursive: true });
const wav = (seconds) => {
  const rate = 8000;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + rate * seconds, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate, 28);
  h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34); h.write('data', 36); h.writeUInt32LE(rate * seconds, 40);
  return Buffer.concat([h, Buffer.alloc(rate * seconds, 128)]);
};
writeFileSync(join(music, 'The Abyss', 'WAV', 'Ashes in my veins.wav'), wav(2));
writeFileSync(join(music, 'The Abyss', 'WAV', 'Bitter End.wav'), wav(2));
writeFileSync(join(music, 'Visual content', 'Capa.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
writeFileSync(join(music, 'Letras.md'), ['# Letras', '', 'Ashes in my veins, **ao vivo**.', ''].join(String.fromCharCode(10)));
process.env.EMANNU_MUSIC_DIRS = music;

// Dados de exemplo de vagas e apartamentos (para filtros e destaques) e pesquisas
// marcadas como recentes: o caçador diário não chama o Claude de verdade nos testes.
const { Store } = await import('../apps/server/src/db.ts');
const store = new Store(join(dir, 'var', 'emannu.db'));
const today = new Date().toISOString().slice(0, 10);
const now = new Date().toISOString();
const vaga = (id, empresa, titulo, local, permiteVisto, salario, extra = {}) => ({
  id, empresa, titulo, local, modalidade: 'presencial', porque: 'Combina com atendimento multilíngue.', elegibilidade: 'Aceita candidatos de fora.',
  permiteVisto, salario, url: `https://exemplo.pt/${id}`, verificadoEm: today, encontradaEm: '2026-10-20', condicoes: [], proximoPasso: 'Revisar o anúncio.', origem: 'pesquisa', categoria: 'portugal', ...extra,
});
store.kvSet('imigracao.jobs', {
  geradoEm: today,
  vagas: [
    vaga('smartidiom-pm', 'Grupo SMARTIDIOM', 'Project Manager - Tradução', 'Leiria, PT', 'sim', '1.300 a 1.500 € brutos/mês', { modalidade: 'hibrido', encontradaEm: today }),
    vaga('bridge-apoio', 'The Bridge', 'Apoio ao Cliente (inglês fluente)', 'Marinha Grande, PT', 'sim', 'Até 1.000 €/mês'),
    vaga('nortempo', 'Nortempo', 'Apoio ao Cliente Online', 'Leiria, PT', 'incerto', '13.000 a 16.000 € brutos/ano'),
    vaga('foundever', 'Foundever', 'English Sales Advisor', 'Porto, PT', 'incerto', '920 € a 1.243 €/mês + comissão', { publicadaEm: '2026-10-10' }),
    vaga('valerius', 'Valérius HUB', 'Assistente Comercial', 'Barcelos, PT', 'sim', 'não publicado'),
  ],
});
store.kvSet('imigracao.apartamentos', {
  geradoEm: today,
  apartamentos: [
    { id: 'leiria-t2', titulo: 'T2 renovado perto da escola', cidade: 'Leiria', zona: 'Marrazes', tipologia: 'T2', precoEur: 750, areaM2: 90, mobiliado: 'sim', url: 'https://exemplo.pt/a1', fonte: 'idealista', publicadaEm: today, verificadoEm: today, encontradaEm: today, observacao: 'Caução de 2 rendas.' },
    { id: 'pombal-t3', titulo: 'T3 com varanda', cidade: 'Pombal', zona: 'Centro', tipologia: 'T3', precoEur: 820, areaM2: 110, mobiliado: 'nao', url: 'https://exemplo.pt/a2', fonte: 'imovirtual', publicadaEm: null, verificadoEm: today, encontradaEm: '2026-10-20', observacao: '' },
    { id: 'braga-t2', titulo: 'T2 em Braga', cidade: 'Braga', zona: 'São Vicente', tipologia: 'T2', precoEur: 980, areaM2: 80, mobiliado: 'incerto', url: 'https://exemplo.pt/a3', fonte: 'idealista', publicadaEm: null, verificadoEm: today, encontradaEm: '2026-10-20', observacao: '' },
  ],
});
store.kvSet(
  'imigracao.runs',
  ['legal', 'docs', 'living', 'jobs', 'aiJobs', 'apartamentos'].map((topic) => ({ topic, jobId: null, status: 'ok', lastOkAt: now, error: null })),
);
// Renda: um lead qualificado com proposta pronta (para a aba Renda e a aba Hoje).
const { RendaStore } = await import('../apps/server/src/renda/store.ts');
store.upsertProject({ id: 'renda', name: 'Renda — Criativos Motion', path: join(dir, 'var', 'renda'), isGit: false, isTest: true });
const rs = new RendaStore(store);
const { lead } = rs.addLead({
  projectId: 'renda', sourceUrl: 'https://www.reddit.com/r/TrafegoPago/comments/exemplo', postedAt: today, company: 'Agência Exemplo', channel: 'reddit',
  need: 'Procura editor para criativos curtos de anúncio', evidence: 'Preciso de 5 criativos de 15s por semana para Meta Ads.',
  scoreDetail: { demanda: 'integral', aderencia: 'integral', orcamento: 'metade', contato: 'integral' },
});
rs.createProposal({ leadId: lead.id, currency: 'BRL', scope: '5 motions de até 15 s', body: 'Olá! Vi que vocês procuram criativos curtos. Posso entregar cinco motions de até 15 s por R$ 290, com uma rodada de ajustes.' });
store.db.close();

await import('../apps/server/src/index.ts');
