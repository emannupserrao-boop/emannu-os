import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { ImmigrationState, ImmigrationUser } from '../../../../packages/shared/immigration.ts';
import type { ClientConfig } from '../../../../packages/shared/types.ts';
import { api, immigrationApi, obsidianLink } from '../api.ts';
import { Skeleton, useTabIndicator } from '../motion.tsx';
import { Vagas } from './Ofertas.tsx';

// Seção IA: carreira e trabalho com IA. As vagas de IA (remotas, plataformas de
// treinamento de modelos) ficam aqui, separadas das vagas em Portugal.
type Tab = 'vagas' | 'panorama';
interface Panorama {
  titulo: string;
  fonte: string | null;
  texto: string | null;
}

export function IA(props: { state: ImmigrationState | null; config: ClientConfig; onState(s: ImmigrationState): void; onError(m: string): void }) {
  const [tab, setTab] = useState<Tab>('vagas');
  const tabsRef = useTabIndicator<HTMLElement>(`${tab}|${!!props.state}`);
  const s = props.state;
  if (!s) return <Skeleton cards={3} label="Carregando a seção IA" />;

  const save = (patch: Partial<ImmigrationUser>) => immigrationApi.update(patch).then(props.onState).catch((e) => props.onError(e.message));
  const run = s.research.find((r) => r.topic === 'aiJobs');
  const busy = run?.status === 'rodando' || run?.status === 'na_fila';
  const total = s.aiJobs?.vagas.length ?? 0;

  return (
    <main className="imm">
      <header className="imm-head">
        <span className="plogo mono-logo ia-logo" aria-hidden>
          <Sparkles size={26} strokeWidth={1.5} />
        </span>
        <div>
          <h2>IA</h2>
          <p className="hint">Carreira e trabalho com IA · {total} vaga(s) de IA</p>
        </div>
      </header>
      <nav className="tabs subtabs seg" role="tablist" aria-label="Seções da IA" ref={tabsRef}>
        <button role="tab" aria-selected={tab === 'vagas'} className={tab === 'vagas' ? 'on' : ''} onClick={() => setTab('vagas')}>
          Vagas de IA <span className="count">{total}</span>
        </button>
        <button role="tab" aria-selected={tab === 'panorama'} className={tab === 'panorama' ? 'on' : ''} onClick={() => setTab('panorama')}>
          Panorama
        </button>
      </nav>
      {tab === 'vagas' && (
        <>
          <section className="icard">
            <p>
              Trabalhos remotos de IA (anotação, avaliação e treinamento de modelos). As candidaturas usam o currículo <span className="mono">Resume Emannuel AI.pdf</span> da sua pasta de
              referência.
            </p>
            <p className="hint">
              Pesquisa: {busy ? 'rodando agora…' : run?.lastOkAt ? `atualizada em ${run.lastOkAt.slice(0, 10)}` : 'ainda não feita'}
              {run?.status === 'falhou' && ` · a última tentativa falhou: ${run.error}`}
            </p>
            <button className="btn btn-small" disabled={busy} onClick={() => immigrationApi.research(['aiJobs']).catch((e) => props.onError(e.message))}>
              {busy ? 'Pesquisando…' : 'Atualizar vagas de IA'}
            </button>
          </section>
          <Vagas s={s} research={s.aiJobs} topic="aiJobs" save={save} onError={props.onError} />
        </>
      )}
      {tab === 'panorama' && <PanoramaTab config={props.config} onError={props.onError} />}
    </main>
  );
}

function PanoramaTab({ config, onError }: { config: ClientConfig; onError(m: string): void }) {
  const [list, setList] = useState<Panorama[] | null>(null);
  useEffect(() => {
    api<Panorama[]>('/api/ia/panorama')
      .then(setList)
      .catch((e) => {
        setList([]);
        onError(e.message);
      });
  }, []);
  if (!list) return <Skeleton cards={2} label="Carregando o panorama" />;
  if (!list.length) return <p className="empty">O vault não está disponível agora.</p>;
  return (
    <div className="igrid">
      {list.map((p) => (
        <section key={p.titulo} className="icard">
          <h3>{p.titulo}</h3>
          {p.texto ? <p className="pstate">{p.texto}</p> : <p className="hint">Nenhuma nota “Current State” encontrada nesta pasta do vault.</p>}
          {p.fonte && config.vaultName && (
            <a className="btn btn-small btn-link" href={obsidianLink(config, p.fonte)}>
              Abrir no Obsidian
            </a>
          )}
        </section>
      ))}
    </div>
  );
}
