import { describe, it, expect } from 'vitest';
import { DEFAULT_USER, type Apartment, type JobOffer } from '../../../packages/shared/immigration.ts';
import { aptScore, jobScore, offerDate, regionOf, salaryMonthlyEur, topIds } from '../../../packages/shared/immigration-score.ts';

const TODAY = '2026-10-27';

// Textos reais de salário das vagas pesquisadas.
describe('salário mensal aproximado', () => {
  it.each([
    ['1.300 a 1.500 € brutos/mês (publicado)', 1400],
    ['13.000 a 16.000 € brutos/ano (publicado)', 1036], // ÷14 salários
    ['Até 1.000 €/mês, conforme experiência (publicado)', 1000],
    ['920 € a 1.543 €/mês + comissão (anúncio cita média de cerca de 250 €/mês)', 1232],
    ['920 €/mês x14 + 110 €/mês x12 + subsídio de alimentação de 7,90 €/dia', 920],
    ['US$15–20/h · contrato horário, sem volume garantido', 2408],
    ['não publicado', null],
    ['não publicado (salário base e subsídio de alimentação, sem valor)', null],
  ])('%s → %s', (text, eur) => {
    expect(salaryMonthlyEur(text)).toBe(eur);
  });
});

const job = (o: Partial<JobOffer>): JobOffer => ({
  id: 'x', empresa: 'E', titulo: 'T', local: 'Porto, PT', modalidade: 'presencial', porque: '', elegibilidade: '', permiteVisto: 'incerto',
  salario: 'não publicado', url: 'https://x', verificadoEm: '2026-10-20', condicoes: [], proximoPasso: '', origem: 'pesquisa', categoria: 'portugal', ...o,
});

describe('importância e destaques', () => {
  it('região de Leiria', () => {
    expect(['Leiria, PT', 'Fátima (Ourém), PT', 'Marinha Grande, PT'].map(regionOf)).toEqual(['leiria', 'leiria', 'leiria']);
    expect(regionOf('Barcelos, PT')).toBe('braga');
  });

  it('Leiria + visto + bom salário + nova ficam em destaque; descartada nunca', () => {
    const user = { ...DEFAULT_USER, vagas: { ruim: { status: 'descartada' as const, nota: '' } } };
    const top = job({ id: 'top', local: 'Leiria, PT', permiteVisto: 'sim', salario: '1.300 a 1.500 € brutos/mês', encontradaEm: TODAY });
    const meio = job({ id: 'meio', local: 'Porto, PT', permiteVisto: 'sim', salario: '1.000 €/mês' });
    const ruim = job({ id: 'ruim', local: 'Leiria, PT', permiteVisto: 'sim' });
    expect(jobScore(top, user, TODAY)).toEqual({ score: 8, motivos: ['Perto de Leiria', 'Serve para visto', 'Salário acima de € 1.300', 'Nova'] });
    expect(jobScore(ruim, user, TODAY).score).toBe(-100);
    expect([...topIds([top, meio, ruim], (v) => jobScore(v, user, TODAY))]).toEqual(['top']);
  });

  it('"mais novas" usa a data de publicação; sem ela, quando o sistema a viu', () => {
    expect(offerDate(job({ publicadaEm: '2026-10-25', encontradaEm: '2026-10-27' }))).toBe('2026-10-25');
    expect(offerDate(job({ encontradaEm: '2026-10-27' }))).toBe('2026-10-27');
  });

  it('apartamento T2 barato perto de Leiria', () => {
    const a: Apartment = { id: 'a', titulo: '', cidade: 'Leiria', zona: 'Marrazes', tipologia: 'T2', precoEur: 750, areaM2: 90, mobiliado: 'sim', url: 'https://a', fonte: 'idealista', publicadaEm: null, verificadoEm: TODAY, encontradaEm: TODAY, observacao: '' };
    expect(aptScore(a, DEFAULT_USER, TODAY).motivos).toEqual(['Perto de Leiria', 'T2', 'Preço bom', '€/m² baixo', 'Novo']);
  });
});
