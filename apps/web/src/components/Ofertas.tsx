// Vagas e apartamentos: barra de filtros, ordenação e destaque das mais importantes.
import { useMemo, useState } from 'react';
import { Building2, Search, Sparkles, Star } from 'lucide-react';
import {
  APT_STATUS_LABEL, JOB_STATUS_LABEL,
  type Apartment, type ApartmentsResearch, type AptStatus, type ImmigrationState, type ImmigrationUser, type JobOffer, type JobPipelineStatus, type JobsResearch, type ResearchTopic,
} from '../../../../packages/shared/immigration.ts';
import { REGION_LABEL, aptScore, jobScore, offerDate, regionOf, salaryMonthlyEur, topIds, type Region, type Score } from '../../../../packages/shared/immigration-score.ts';
import { immigrationApi } from '../api.ts';
import { Badge, Empty, List } from './Imigracao.tsx';
import { HumanActionDialog, type HumanRequest } from './HumanAction.tsx';

const today = () => new Date().toISOString().slice(0, 10);
const eur = (n: number) => `€ ${Math.round(n).toLocaleString('pt-BR')}`;
const shortDate = (iso: string) => new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const isNew = (iso: string | undefined) => !!iso && (Date.now() - Date.parse(iso.slice(0, 10))) / 86_400_000 <= 2;

// Lembra a ordenação escolhida neste aparelho (se o navegador deixar).
function useStored<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T) || initial;
    } catch {
      return initial;
    }
  });
  return [
    v,
    (x: T) => {
      setV(x);
      try {
        localStorage.setItem(key, x);
      } catch {}
    },
  ];
}

type JobSort = 'importancia' | 'salario-desc' | 'salario-asc' | 'novas' | 'antigas';
const JOB_SORT: Record<JobSort, string> = {
  importancia: 'Mais importantes',
  'salario-desc': 'Salário: maior → menor',
  'salario-asc': 'Salário: menor → maior',
  novas: 'Mais novas primeiro',
  antigas: 'Mais antigas primeiro',
};
type AptSort = 'importancia' | 'preco-asc' | 'preco-desc' | 'novos' | 'antigos';
const APT_SORT: Record<AptSort, string> = {
  importancia: 'Mais importantes',
  'preco-asc': 'Renda: menor → maior',
  'preco-desc': 'Renda: maior → menor',
  novos: 'Mais novos primeiro',
  antigos: 'Mais antigos primeiro',
};

// Ordena e deixa "sem valor" (salário não publicado) sempre no fim.
function byNumber<T>(get: (x: T) => number | null, dir: 1 | -1) {
  return (a: T, b: T) => {
    const x = get(a);
    const y = get(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x - y) * dir;
  };
}

function Toolbar(props: {
  q: string;
  onQ(v: string): void;
  regions?: { value: Region | 'todas'; onChange(r: Region | 'todas'): void; counts: Partial<Record<Region, number>> };
  extra?: React.ReactNode;
  sort: string;
  sorts: Record<string, string>;
  onSort(v: string): void;
  count: string;
  placeholder?: string;
}) {
  return (
    <section className="filterbar" aria-label="Filtros">
      <div className="filterbar-row">
        <label className="search">
          <Search size={16} strokeWidth={1.75} aria-hidden />
          <input type="search" value={props.q} onChange={(e) => props.onQ(e.target.value)} placeholder={props.placeholder ?? 'Buscar empresa, cargo, cidade…'} aria-label="Buscar" />
        </label>
        <label className="sortsel">
          <span>Ordenar</span>
          <select value={props.sort} onChange={(e) => props.onSort(e.target.value)}>
            {Object.entries(props.sorts).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      {props.regions && (
        <div className="chips" role="group" aria-label="Região">
          {(['todas', ...(Object.keys(REGION_LABEL) as Region[]).filter((r) => props.regions!.counts[r])] as (Region | 'todas')[]).map((r) => (
            <button key={r} className={`chip ${props.regions!.value === r ? 'on' : ''}`} aria-pressed={props.regions!.value === r} onClick={() => props.regions!.onChange(r)}>
              {r === 'todas' ? 'Todas' : REGION_LABEL[r]}
              {r !== 'todas' && <span className="count">{props.regions!.counts[r]}</span>}
            </button>
          ))}
        </div>
      )}
      {props.extra}
      <p className="hint filterbar-count">{props.count}</p>
    </section>
  );
}

function Highlight({ sc }: { sc: Score }) {
  return (
    <div className="destaque-head">
      <span className="destaque-badge">
        <Star size={13} strokeWidth={2} aria-hidden /> Destaque
      </span>
      {sc.motivos.map((m) => (
        <span key={m} className="ibadge tone-warn">
          {m}
        </span>
      ))}
    </div>
  );
}

// ---------------- Vagas ----------------

export function Vagas(props: { s: ImmigrationState; research: JobsResearch | null; topic: ResearchTopic; save(p: Partial<ImmigrationUser>): void; onError(m: string): void }) {
  const [req, setReq] = useState<HumanRequest | null>(null);
  const { s, research, topic, save, onError } = props;
  const portugal = topic === 'jobs';
  const [q, setQ] = useState('');
  const [region, setRegion] = useStored<Region | 'todas'>(`emannu.vagas.${topic}.regiao`, 'todas');
  const [sort, setSort] = useStored<JobSort>(`emannu.vagas.${topic}.ordem`, 'importancia');
  const [onlyVisa, setOnlyVisa] = useState(false);
  const [showDiscarded, setShowDiscarded] = useState(false);
  const t = today();

  const all = useMemo(() => (research?.vagas ?? []).map((v) => (portugal ? v : { ...v, categoria: 'ai' as const })), [research, portugal]);
  const score = (v: JobOffer) => jobScore(v, s.user, t);
  const top = useMemo(() => topIds(all, score, 3, portugal ? 4 : 3), [all, s.user]);
  const counts = useMemo(() => {
    const c: Partial<Record<Region, number>> = {};
    for (const v of all) c[regionOf(v.local)] = (c[regionOf(v.local)] ?? 0) + 1;
    return c;
  }, [all]);

  if (!research) return <Empty topic={topic} s={s} />;
  const needle = q.trim().toLowerCase();
  const list = all
    .filter((v) => showDiscarded || s.user.vagas[v.id]?.status !== 'descartada')
    .filter((v) => !portugal || region === 'todas' || regionOf(v.local) === region)
    .filter((v) => !onlyVisa || v.permiteVisto === 'sim')
    .filter((v) => !needle || `${v.empresa} ${v.titulo} ${v.local} ${v.porque}`.toLowerCase().includes(needle))
    .sort(
      sort === 'salario-desc' ? byNumber((v: JobOffer) => salaryMonthlyEur(v.salario), -1)
      : sort === 'salario-asc' ? byNumber((v: JobOffer) => salaryMonthlyEur(v.salario), 1)
      : sort === 'novas' ? (a, b) => offerDate(b).localeCompare(offerDate(a))
      : sort === 'antigas' ? (a, b) => offerDate(a).localeCompare(offerDate(b))
      : (a, b) => score(b).score - score(a).score,
    );

  return (
    <div className="istack">
      <p className="disclaimer red">Candidaturas são VERMELHAS: o sistema prepara um rascunho; quem envia é você.</p>
      {req && <HumanActionDialog req={req} onCancel={() => setReq(null)} onError={props.onError} onDone={() => setReq(null)} />}
      <Toolbar
        q={q}
        onQ={setQ}
        regions={portugal ? { value: region, onChange: setRegion, counts } : undefined}
        sort={sort}
        sorts={JOB_SORT}
        onSort={(v) => setSort(v as JobSort)}
        count={`${list.length} de ${all.length} vaga(s) · ${top.size} em destaque`}
        extra={
          <div className="toggles">
            {portugal && (
              <label className="follow">
                <input type="checkbox" checked={onlyVisa} onChange={(e) => setOnlyVisa(e.target.checked)} /> só as que servem para visto
              </label>
            )}
            <label className="follow">
              <input type="checkbox" checked={showDiscarded} onChange={(e) => setShowDiscarded(e.target.checked)} /> mostrar descartadas
            </label>
          </div>
        }
      />
      {!list.length && <p className="empty">Nenhuma vaga com esses filtros.</p>}
      {list.map((v) => {
        const st = s.user.vagas[v.id] ?? { status: 'nova' as JobPipelineStatus, nota: '' };
        const sal = salaryMonthlyEur(v.salario);
        const hot = top.has(v.id);
        return (
          <section key={v.id} className={`icard offer ${hot ? 'destaque' : ''}`}>
            {hot && <Highlight sc={score(v)} />}
            <div className="offer-head">
              <p className="ititle">
                {v.empresa} — {v.titulo}
              </p>
              <span className={`salary ${sal === null ? 'none' : ''}`} title={v.salario}>
                {sal === null ? 'salário não publicado' : `≈ ${eur(sal)}/mês`}
              </span>
            </div>
            <div className="badges">
              <span className="ibadge tone-neutral">{v.local}</span>
              <span className="ibadge tone-neutral">{v.modalidade}</span>
              {portugal && <Badge value={v.permiteVisto} label="Serve para visto" />}
              <span className="ibadge tone-neutral">{v.origem === 'legado' ? 'do cockpit antigo' : v.publicadaEm ? `publicada em ${shortDate(v.publicadaEm)}` : `vista em ${shortDate(offerDate(v))}`}</span>
              {isNew(v.encontradaEm) && (
                <span className="ibadge tone-ok new-pill">
                  <Sparkles size={12} aria-hidden /> Nova
                </span>
              )}
            </div>
            <p>
              <b>Salário:</b> {v.salario}
            </p>
            <p>{v.porque}</p>
            <p className="hint">
              <b>Elegibilidade:</b> {v.elegibilidade}
            </p>
            {v.condicoes.length > 0 && <List items={v.condicoes} />}
            <p>
              <b>Próximo passo:</b> {v.proximoPasso}
            </p>
            {st.nota && <p className="hint mono">{st.nota}</p>}
            <div className="docedit">
              <label>
                <span>Status</span>
                <select
                  value={st.status}
                  onChange={(e) => {
                    const status = e.target.value as JobPipelineStatus;
                    // Enviada / entrevista: ação sua, com confirmação (vira estado da candidatura).
                    if (status === 'enviada' || status === 'entrevista') setReq({ tipo: 'candidatura', applicationId: v.id, para: status === 'enviada' ? 'applied' : 'interview', quem: `${v.titulo} — ${v.empresa}` });
                    else save({ vagas: { [v.id]: { ...st, status } } });
                  }}
                >
                  {Object.entries(JOB_STATUS_LABEL).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="job-actions flat">
              <a className="btn btn-link" href={v.url} target="_blank" rel="noreferrer">
                Abrir anúncio
              </a>
              {['nova', 'interessante'].includes(st.status) && (
                <button className="btn" onClick={() => immigrationApi.prepare(v.id).catch((e) => onError(e.message))}>
                  Preparar rascunho de candidatura
                </button>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ---------------- Apartamentos ----------------

type Tipo = 'todos' | 'T1' | 'T2' | 'T3+';
const tipoOf = (a: Apartment): Tipo => (/^T[01]/.test(a.tipologia) ? 'T1' : /^T2/.test(a.tipologia) ? 'T2' : 'T3+');

export function Apartamentos(props: { s: ImmigrationState; research: ApartmentsResearch | null; save(p: Partial<ImmigrationUser>): void }) {
  const { s, research, save } = props;
  const [q, setQ] = useState('');
  const [region, setRegion] = useStored<Region | 'todas'>('emannu.apts.regiao', 'todas');
  const [sort, setSort] = useStored<AptSort>('emannu.apts.ordem', 'importancia');
  const [tipo, setTipo] = useState<Tipo>('todos');
  const [max, setMax] = useState('');
  const [showDiscarded, setShowDiscarded] = useState(false);
  const t = today();
  const all = research?.apartamentos ?? [];
  const score = (a: Apartment) => aptScore(a, s.user, t);
  const top = useMemo(() => topIds(all, score), [all, s.user]);
  const counts = useMemo(() => {
    const c: Partial<Record<Region, number>> = {};
    for (const a of all) c[regionOf(`${a.cidade} ${a.zona}`)] = (c[regionOf(`${a.cidade} ${a.zona}`)] ?? 0) + 1;
    return c;
  }, [all]);

  if (!research) return <Empty topic="apartamentos" s={s} />;
  const needle = q.trim().toLowerCase();
  const maxN = Number(max) || 0;
  const date = (a: Apartment) => a.publicadaEm || a.encontradaEm || a.verificadoEm;
  const list = all
    .filter((a) => showDiscarded || s.user.apartamentos[a.id]?.status !== 'descartado')
    .filter((a) => region === 'todas' || regionOf(`${a.cidade} ${a.zona}`) === region)
    .filter((a) => tipo === 'todos' || tipoOf(a) === tipo)
    .filter((a) => !maxN || a.precoEur <= maxN)
    .filter((a) => !needle || `${a.titulo} ${a.cidade} ${a.zona} ${a.observacao}`.toLowerCase().includes(needle))
    .sort(
      sort === 'preco-asc' ? (a, b) => a.precoEur - b.precoEur
      : sort === 'preco-desc' ? (a, b) => b.precoEur - a.precoEur
      : sort === 'novos' ? (a, b) => date(b).localeCompare(date(a))
      : sort === 'antigos' ? (a, b) => date(a).localeCompare(date(b))
      : (a, b) => score(b).score - score(a).score,
    );

  return (
    <div className="istack">
      <p className="disclaimer">Só anúncios: contato com o proprietário, visita e caução são sempre com você. Pesquisa refeita 1x ao dia.</p>
      <Toolbar
        q={q}
        onQ={setQ}
        regions={{ value: region, onChange: setRegion, counts }}
        sort={sort}
        sorts={APT_SORT}
        onSort={(v) => setSort(v as AptSort)}
        count={`${list.length} de ${all.length} apartamento(s) · ${top.size} em destaque`}
        placeholder="Buscar bairro, cidade, detalhe…"
        extra={
          <div className="toggles">
            <div className="chips" role="group" aria-label="Tipologia">
              {(['todos', 'T1', 'T2', 'T3+'] as Tipo[]).map((x) => (
                <button key={x} className={`chip ${tipo === x ? 'on' : ''}`} aria-pressed={tipo === x} onClick={() => setTipo(x)}>
                  {x === 'todos' ? 'Todas as tipologias' : x}
                </button>
              ))}
            </div>
            <label className="maxprice">
              <span>Renda até (€)</span>
              <input type="number" inputMode="numeric" min={0} step={50} value={max} onChange={(e) => setMax(e.target.value)} placeholder="sem limite" />
            </label>
            <label className="follow">
              <input type="checkbox" checked={showDiscarded} onChange={(e) => setShowDiscarded(e.target.checked)} /> mostrar descartados
            </label>
          </div>
        }
      />
      {!list.length && <p className="empty">Nenhum apartamento com esses filtros.</p>}
      {list.map((a) => {
        const st = s.user.apartamentos[a.id]?.status ?? ('novo' as AptStatus);
        const hot = top.has(a.id);
        return (
          <section key={a.id} className={`icard offer ${hot ? 'destaque' : ''}`}>
            {hot && <Highlight sc={score(a)} />}
            <div className="offer-head">
              <p className="ititle">
                <Building2 size={16} strokeWidth={1.75} aria-hidden /> {a.titulo || `${a.tipologia} em ${a.zona || a.cidade}`}
              </p>
              <span className="salary">{eur(a.precoEur)}/mês</span>
            </div>
            <div className="badges">
              <span className="ibadge tone-neutral">
                {a.cidade}
                {a.zona ? ` · ${a.zona}` : ''}
              </span>
              <span className="ibadge tone-neutral">{a.tipologia}</span>
              {a.areaM2 && <span className="ibadge tone-neutral">{a.areaM2} m² · {eur(a.precoEur / a.areaM2)}/m²</span>}
              {a.mobiliado !== 'incerto' && <span className="ibadge tone-neutral">{a.mobiliado === 'sim' ? 'mobiliado' : 'sem mobília'}</span>}
              <span className="ibadge tone-neutral">
                {a.fonte || 'anúncio'} · {a.publicadaEm ? `publicado em ${shortDate(a.publicadaEm)}` : `visto em ${shortDate(date(a))}`}
              </span>
              {isNew(a.encontradaEm) && (
                <span className="ibadge tone-ok new-pill">
                  <Sparkles size={12} aria-hidden /> Novo
                </span>
              )}
            </div>
            {a.observacao && <p>{a.observacao}</p>}
            <div className="docedit">
              <label>
                <span>Status</span>
                <select value={st} onChange={(e) => save({ apartamentos: { [a.id]: { status: e.target.value as AptStatus } } })}>
                  {Object.entries(APT_STATUS_LABEL).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="job-actions flat">
              <a className="btn btn-link" href={a.url} target="_blank" rel="noreferrer">
                Abrir anúncio
              </a>
            </div>
          </section>
        );
      })}
    </div>
  );
}
