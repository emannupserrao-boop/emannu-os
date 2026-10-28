// Filtros, ordenação e destaques de vagas e apartamentos (usado no servidor e na interface).
import { daysBetween, type Apartment, type ImmigrationUser, type JobOffer } from './immigration.ts';

// Região de Leiria: prioridade desde 2026-10-27 (região prioritária configurada).
export const LEIRIA_RE = /leiria|marinha grande|batalha|pombal|our[ée]m|f[áa]tima|alcoba[çc]a|porto de m[óo]s|caldas da rainha|nazar[ée]|ansi[ãa]o|figueir[óo] dos vinhos/i;
export type Region = 'leiria' | 'braga' | 'porto' | 'lisboa' | 'remoto' | 'outra';
export const REGION_LABEL: Record<Region, string> = { leiria: 'Região de Leiria', braga: 'Braga e Barcelos', porto: 'Porto', lisboa: 'Lisboa', remoto: 'Remoto', outra: 'Outras' };

export function regionOf(local: string): Region {
  if (LEIRIA_RE.test(local)) return 'leiria';
  if (/braga|barcelos|guimar[ãa]es|famalic[ãa]o/i.test(local)) return 'braga';
  if (/porto|matosinhos|maia|gaia|gondomar/i.test(local)) return 'porto';
  if (/lisboa|oeiras|sintra|cascais|almada/i.test(local)) return 'lisboa';
  if (/remot/i.test(local)) return 'remoto';
  return 'outra';
}

// "1.300", "13.000" → milhar; "7,90", "4.97" → decimal.
function parseNum(x: string): number {
  if (/^\d{1,3}([.,]\d{3})+$/.test(x)) return Number(x.replace(/[.,]/g, ''));
  return Number(x.replace(',', '.'));
}

const USD_TO_EUR = 0.86;

// Salário mensal aproximado em euros a partir do texto do anúncio (null = não publicado).
// Faixa → média; anual em € → ÷14 (Portugal paga 14 salários); por hora → ×160 h.
export function salaryMonthlyEur(text: string): number | null {
  if (!text || /n[ãa]o publicad|not (published|disclosed)/i.test(text)) return null;
  const main = text.split('+')[0];
  const nums = [...main.matchAll(/(?<![x×\d.,])(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)/g)].map((m) => parseNum(m[1])).filter((n) => n >= 5);
  if (!nums.length) return null;
  let v = nums.length >= 2 && !/at[ée]\s*\d/i.test(main) ? (nums[0] + nums[1]) / 2 : nums[0];
  const usd = /us\$|usd|\$/i.test(main);
  if (/\/\s*h\b|hora|hour|\/hr/i.test(main)) v *= 160;
  else if (/ano|year|anual|annual/i.test(main)) v /= usd ? 12 : 14;
  if (usd) v *= USD_TO_EUR;
  return Math.round(v);
}

export interface Score {
  score: number;
  motivos: string[];
}

const daysAgo = (date: string | null | undefined, today: string) => (date ? daysBetween(date.slice(0, 10), today) : 999);

// Data usada em "mais novas / mais antigas": publicação do anúncio ou, sem ela, quando o EMANNU OS a viu.
export const offerDate = (v: { publicadaEm?: string | null; encontradaEm?: string; verificadoEm: string }) => v.publicadaEm || v.encontradaEm || v.verificadoEm;

// Importância de uma vaga (quanto maior, mais no topo; as melhores ganham destaque).
export function jobScore(v: JobOffer, user: ImmigrationUser, today: string): Score {
  const motivos: string[] = [];
  let score = 0;
  const add = (n: number, motivo?: string) => {
    score += n;
    if (motivo) motivos.push(motivo);
  };
  const st = user.vagas[v.id]?.status;
  if (st === 'descartada') return { score: -100, motivos: [] };
  const sal = salaryMonthlyEur(v.salario);
  if (v.categoria === 'ai') {
    if (/portugu/i.test(`${v.titulo} ${v.porque}`)) add(2, 'Em português');
    if (sal !== null && sal >= 2000) add(2, 'Paga bem');
    else if (sal !== null && sal >= 1000) add(1);
  } else {
    const r = regionOf(v.local);
    if (r === 'leiria') add(3, 'Perto de Leiria');
    else if (r === 'braga') add(1);
    if (v.permiteVisto === 'sim') add(2, 'Serve para visto');
    else if (v.permiteVisto === 'incerto') add(0.5);
    if (sal !== null && sal >= 1300) add(2, 'Salário acima de € 1.300');
    else if (sal !== null && sal >= 1000) add(1, 'Salário acima de € 1.000');
  }
  if (daysAgo(v.encontradaEm, today) <= 2) add(1, 'Nova');
  if (st && ['interessante', 'preparar', 'pronta', 'entrevista'].includes(st)) add(1.5, 'Você marcou');
  return { score, motivos };
}

export function aptScore(a: Apartment, user: ImmigrationUser, today: string): Score {
  const motivos: string[] = [];
  let score = 0;
  const add = (n: number, motivo?: string) => {
    score += n;
    if (motivo) motivos.push(motivo);
  };
  const st = user.apartamentos?.[a.id]?.status;
  if (st === 'descartado') return { score: -100, motivos: [] };
  if (regionOf(`${a.cidade} ${a.zona}`) === 'leiria') add(3, 'Perto de Leiria');
  if (/^t[23]/i.test(a.tipologia)) add(1, a.tipologia.toUpperCase());
  if (a.precoEur > 0 && a.precoEur <= 850) add(2, 'Preço bom');
  else if (a.precoEur > 0 && a.precoEur <= 1050) add(1);
  if (a.areaM2 && a.precoEur && a.precoEur / a.areaM2 <= 9) add(1, '€/m² baixo');
  if (a.mobiliado === 'sim') add(0.5);
  if (daysAgo(a.encontradaEm, today) <= 2) add(1, 'Novo');
  if (st === 'interessante' || st === 'visitar') add(1.5, 'Você marcou');
  return { score, motivos };
}

// Os N mais importantes acima do mínimo ganham o efeito de destaque.
export function topIds<T extends { id: string }>(list: T[], score: (x: T) => Score, n = 3, min = 4): Set<string> {
  return new Set(
    list
      .map((x) => ({ id: x.id, s: score(x).score }))
      .filter((x) => x.s >= min)
      .sort((a, b) => b.s - a.s)
      .slice(0, n)
      .map((x) => x.id),
  );
}
