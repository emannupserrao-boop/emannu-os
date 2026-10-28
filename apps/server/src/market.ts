// Pesquisa de mercado da Operação Receita (sites e presença online) numa região,
// feita pelo Claude com os subagentes da Receita (pesquisador → analista). Só leitura:
// o resultado vira uma nota do sistema no vault; contato com empresas é sempre você.
import type { Job } from '../../../packages/shared/types.ts';
import type { Scheduler } from './scheduler.ts';
import type { Outcome } from './flow.ts';
import { RECEITA_DIR } from './config.ts';

export const MARKET_PROJECT = 'operacao-receita';
const NOTE_FOLDER = '80 - AUTOMATION/Projetos';
const today = () => new Date().toISOString().slice(0, 10);

export interface MarketRegion {
  id: string;
  nome: string;
  foco: string;
}

export const REGIONS: Record<string, MarketRegion> = {
  portugal: {
    id: 'portugal',
    nome: 'Portugal',
    foco: 'região de Leiria (Leiria, Marinha Grande, Batalha, Pombal, Ourém/Fátima, Alcobaça, Porto de Mós) em primeiro lugar, depois Braga e Barcelos',
  },
};

export interface MarketReport {
  regiao: string;
  geradoEm: string;
  jobId: string;
  texto: string;
  vaultNote: string | null;
}

export class Market {
  private s: Scheduler;

  constructor(s: Scheduler) {
    this.s = s;
    s.market = this;
  }

  handles(planKey: string): boolean {
    return planKey.startsWith('mercado:') && planKey.slice('mercado:'.length) in REGIONS;
  }

  report(regiao: string): MarketReport | null {
    return this.s.store.kvGet<MarketReport>(`mercado.${regiao}`);
  }

  run(regiao: string): Job {
    const r = REGIONS[regiao];
    if (!r) throw new Error(`Região desconhecida: ${regiao}`);
    if (!this.s.store.getProject(MARKET_PROJECT)) throw new Error('Projeto Operação Receita não está vinculado');
    const busy = this.s.store.listJobs(50).find((j) => j.planKey === `mercado:${regiao}` && ['queued', 'running'].includes(j.status));
    if (busy) return busy;
    return this.s.enqueue({
      title: `Mercado ${r.nome}: sites e presença online (Operação Receita)`,
      prompt: `Pesquisa de mercado da Operação Receita em ${r.nome}, com os agentes pesquisador e analista. Só leitura, sem contato.`,
      agent: 'claude',
      projectId: MARKET_PROJECT,
      risk: 'verde',
      timeoutMin: 45, // acima de 45 min viraria AMARELO (precisaria de aprovação)
      kind: 'research',
      planKey: `mercado:${regiao}`,
    });
  }

  prompt(job: Job): string {
    const r = REGIONS[job.planKey!.slice('mercado:'.length)];
    return `Você coordena uma pesquisa de mercado da Operação Receita para o Emannuel (escreva sempre "Emannuel"). Hoje é ${today()}.

Contexto: o usuário avalia trabalhar em Portugal (${r.foco}). A Operação Receita vende SITES PROFISSIONAIS E PRESENÇA ONLINE para pequenas empresas. A pergunta é: existe mercado pagante para esse serviço em ${r.nome}, quem são os concorrentes e quanto cobram, e é viável o Emannuel oferecer isso morando lá?
Regras e método da equipe: ${RECEITA_DIR}\\Equipe-Especialistas-Duravel (AGENTS.md, DIRECAO-COMERCIAL.md, MERCADO-E-VIABILIDADE.md) — só leitura.

Use os subagentes (ferramenta Task):
1. receita-pesquisador — demanda e preços: pedidos de criação de sites em marketplaces portugueses de serviços (ex.: Zaask, Fixando), preços publicados por agências e freelancers da região (moeda, escopo, mensalidade), construtores de sites usados em Portugal, e dados oficiais de digitalização das PME (INE, Eurostat, PORDATA).
2. receita-pesquisador — até 5 empresas candidatas na ${r.foco.split(',')[0]}: reputação pública verificável e presença digital possivelmente fraca. Identidade confirmada; site oficial ou null. Nada de contato.
3. receita-analista — parecer separado sobre a oferta e as candidatas, alternativas (inclusive não construir) e viabilidade: como o Emannuel poderia faturar o serviço em Portugal (abertura de atividade nas Finanças, regime simplificado, isenção de IVA, Segurança Social), com fontes oficiais (portaldasfinancas.gov.pt, seg-social.pt, eportugal.gov.pt); o que depende do tipo de visto/autorização de residência fica marcado "a confirmar".

Regras: nunca contate empresas, não envie nada, não crie contas; dados de empresa só públicos; cada afirmação com fonte, data e classificação (confirmed/indirect/hypothesis/estimate); interesse e orçamento das empresas ficam desconhecidos. Não edite arquivos.

Responda em português do Brasil, em Markdown, com estas seções:
## Resumo (5 linhas)
## Demanda pagante (evidências)
## Preços e concorrentes (tabela: quem, o que inclui, preço, fonte, data, classificação)
## Empresas candidatas (tabela: empresa, cidade, site, reputação, hipótese, decisão do analista)
## Parecer do analista (alternativas, inclusive não construir)
## Viabilidade para o Emannuel em Portugal (fiscal e prática, com fontes oficiais)
## Recomendação (advance / hold / reject) e próximos passos que dependem do Emannuel
## Fontes (lista com URL e data)`;
  }

  afterResearch(job: Job, o: Outcome): Job {
    const regiao = job.planKey!.slice('mercado:'.length);
    if (!o.ok || !o.text?.trim()) {
      return this.s.finish(job.id, { status: o.canceled ? 'canceled' : 'failed', error: o.error ?? 'Pesquisa sem resposta', summary: o.text, step: o.canceled ? 'Cancelada' : 'Falhou' });
    }
    let vaultNote: string | null = null;
    const vault = this.s.vault;
    if (vault?.exists()) {
      try {
        // upsertGeneratedNote já devolve o caminho relativo ao vault.
        vaultNote = vault.upsertGeneratedNote(
          NOTE_FOLDER,
          `Operação Receita - Mercado ${REGIONS[regiao]?.nome ?? regiao}`,
          { type: 'mercado', gerado_por: 'emannu-os', atualizado: today() },
          `# Operação Receita — Mercado ${REGIONS[regiao]?.nome ?? regiao}\n\n> Pesquisa do EMANNU OS com os agentes pesquisador e analista da Operação Receita (só leitura). **Contato com empresas, propostas e envio são sempre o Emannuel.**\n\n${o.text.trim()}`,
        );
      } catch (e: any) {
        console.warn('Nota de mercado:', e.message);
      }
    }
    this.s.store.kvSet(`mercado.${regiao}`, { regiao, geradoEm: new Date().toISOString(), jobId: job.id, texto: o.text, vaultNote } satisfies MarketReport);
    return this.s.finish(job.id, { status: 'done', exitCode: o.code, step: 'Pesquisa de mercado salva no vault', summary: o.text, vaultNote });
  }
}
