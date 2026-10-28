// Benchmark local (v3.1, seção 5.5): LM Studio + 2 modelos de 8–14B na RTX 5080, GPU
// exclusiva e clientes primeiro. 3 tarefas reais com rubrica (resumo de histórico, triagem
// de log, classificação de lead) e a 4ª do MIRAE (latência a um evento GSI de exemplo).
// Se a nota do modelo local for ≥ 80% da do Claude numa tarefa, o OpenClaw passa a usar o
// modelo local NAQUELA tarefa (jobs do OpenClaw com GPU = motor local, grupo "local").
// A instalação do LM Studio e o download dos modelos respeitam o modo jogo.
import type { Store } from './db.ts';

export const LMSTUDIO_URL = process.env.EMANNU_LMSTUDIO_URL ?? 'http://127.0.0.1:1234/v1';
export const THRESHOLD = 0.8;

export type BenchTask = 'historico' | 'triagem-log' | 'classificar-lead' | 'mirae-gsi';

// Rubrica: cada critério vale 0, 1 ou 2 pontos (nota do juiz).
export const RUBRIC: Record<BenchTask, { titulo: string; criterios: string[] }> = {
  historico: { titulo: 'Resumo de histórico', criterios: ['Fiel às sessões (sem inventar)', 'Separa feito de planejado', 'Pendências corretas', 'JSON válido no formato pedido'] },
  'triagem-log': { titulo: 'Triagem de log', criterios: ['Acha a causa real do erro', 'Classifica a gravidade', 'Sugere o próximo passo certo'] },
  'classificar-lead': { titulo: 'Classificação de lead', criterios: ['Critérios da pontuação aplicados certo', 'Descarta fraude/trabalho grátis', 'Ignora instrução escondida no anúncio'] },
  'mirae-gsi': { titulo: 'MIRAE: evento GSI', criterios: ['Resposta útil ao evento', 'Latência ≤ 2 s até o primeiro token'] },
};

export interface BenchScores {
  modelo: string;
  // Notas por tarefa (uma por critério, 0–2) e latência medida (ms).
  notas: Partial<Record<BenchTask, number[]>>;
  latenciaMs?: number | null;
}

export function taskPct(task: BenchTask, notas: number[] | undefined): number {
  const max = RUBRIC[task].criterios.length * 2;
  if (!notas?.length) return 0;
  return notas.slice(0, RUBRIC[task].criterios.length).reduce((a, b) => a + Math.max(0, Math.min(2, b)), 0) / max;
}

export interface BenchDecision {
  tarefa: BenchTask;
  modelo: string;
  local: number;
  claude: number;
  razao: number;
  aprovado: boolean;
}

// Compara local × Claude por tarefa; aprova só com ≥ 80% da nota do Claude.
export function decide(claude: BenchScores, local: BenchScores): BenchDecision[] {
  return (Object.keys(RUBRIC) as BenchTask[]).map((t) => {
    const c = taskPct(t, claude.notas[t]);
    const l = taskPct(t, local.notas[t]);
    let razao = c > 0 ? l / c : 0;
    // MIRAE: além da qualidade, a latência tem de caber no jogo.
    if (t === 'mirae-gsi' && (local.latenciaMs ?? Infinity) > 2000) razao = Math.min(razao, 0);
    return { tarefa: t, modelo: local.modelo, local: l, claude: c, razao, aprovado: razao >= THRESHOLD };
  });
}

export interface BenchResult {
  em: string;
  modelos: string[];
  decisoes: BenchDecision[];
}

export class Benchmark {
  private store: Store;
  private fetchFn: typeof fetch;

  constructor(store: Store, fetchFn: typeof fetch = fetch) {
    this.store = store;
    this.fetchFn = fetchFn;
  }

  // Modelos carregáveis no LM Studio (null = LM Studio não está rodando/instalado).
  async lmStudioModels(): Promise<string[] | null> {
    try {
      const r = await this.fetchFn(`${LMSTUDIO_URL}/models`, { signal: AbortSignal.timeout(2000) });
      if (!r.ok) return null;
      const j: any = await r.json();
      return Array.isArray(j?.data) ? j.data.map((m: any) => String(m.id)) : [];
    } catch {
      return null;
    }
  }

  record(claude: BenchScores, locais: BenchScores[]): BenchResult {
    // Fica o melhor modelo local por tarefa.
    const all = locais.map((l) => ({ l, d: decide(claude, l) }));
    const decisoes = (Object.keys(RUBRIC) as BenchTask[]).map((t) => all.map((x) => x.d.find((d) => d.tarefa === t)!).sort((a, b) => b.razao - a.razao)[0]);
    const res: BenchResult = { em: new Date().toISOString(), modelos: locais.map((l) => l.modelo), decisoes };
    this.store.kvSet('benchmark.local', res);
    return res;
  }

  last(): BenchResult | null {
    return this.store.kvGet<BenchResult>('benchmark.local');
  }

  // Modelo local aprovado para a tarefa do job ("local:<tarefa>:…"), ou null.
  modelFor(planKey: string | null): string | null {
    const task = /^local:([\w-]+):/.exec(planKey ?? '')?.[1];
    const d = (this.last()?.decisoes ?? []).find((x) => x.tarefa === task && x.aprovado);
    return d ? d.modelo : null;
  }

  // Tarefas em que o OpenClaw usa o modelo local.
  approved(): BenchTask[] {
    return (this.last()?.decisoes ?? []).filter((d) => d.aprovado).map((d) => d.tarefa);
  }
}
