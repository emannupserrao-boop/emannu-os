import { useMemo, useState } from 'react';
import {
  DOC_DONE, DOC_STATUS_LABEL, JOB_STATUS_LABEL, PERSON_LABEL, TOPIC_LABEL, allSources, computeScenarios, computeTimeline, isStale,
  type DocFile, type DocStatus, type ImmigrationState, type ImmigrationUser, type JobOffer, type JobPipelineStatus, type JobsResearch, type Person,
  type ResearchTopic, type Route, type Source, type UserEvent,
} from '../../../../packages/shared/immigration.ts';
import { immigrationApi } from '../api.ts';
import { Skeleton, useTabIndicator } from '../motion.tsx';
import { FileText, FolderOpen, Plane } from 'lucide-react';
import { Apartamentos, Vagas } from './Ofertas.tsx';
import { jobScore, topIds } from '../../../../packages/shared/immigration-score.ts';

type Tab = 'painel' | 'rotas' | 'documentos' | 'tempo' | 'orcamento' | 'vagas' | 'apartamentos' | 'escola' | 'fontes';
const TABS: { key: Tab; label: string }[] = [
  { key: 'painel', label: 'Painel' },
  { key: 'rotas', label: 'Rotas' },
  { key: 'documentos', label: 'Documentos' },
  { key: 'tempo', label: 'Linha do tempo' },
  { key: 'orcamento', label: 'Orçamento' },
  { key: 'vagas', label: 'Vagas em Portugal' },
  { key: 'apartamentos', label: 'Apartamentos' },
  { key: 'escola', label: 'Escola e moradia' },
  { key: 'fontes', label: 'Fontes' },
];

const today = () => new Date().toISOString().slice(0, 10);
const eur = (n: number) => `€ ${Math.round(n).toLocaleString('pt-PT')}`;
const TRI_LABEL: Record<string, string> = { sim: 'Sim', nao: 'Não', depende: 'Depende', provavel: 'Provável', incerto: 'Incerto' };
const TRI_TONE: Record<string, string> = { sim: 'ok', provavel: 'ok', nao: 'bad', depende: 'warn', incerto: 'warn' };

export function Badge({ value, label }: { value: string; label?: string }) {
  return <span className={`ibadge tone-${TRI_TONE[value] ?? 'neutral'}`}>{label ? `${label}: ` : ''}{TRI_LABEL[value] ?? value}</span>;
}

export function Sources({ list }: { list: Source[] }) {
  if (!list.length) return <p className="hint">⚠ Sem fonte — confirmar.</p>;
  return (
    <ul className="sources">
      {list.map((f, i) => (
        <li key={f.url + i}>
          <a href={f.url} target="_blank" rel="noreferrer">
            {f.titulo}
          </a>{' '}
          <span className="hint">
            · {f.orgao || 'fonte'}
            {f.oficial ? ' · oficial' : ''} · verificado em {f.verificadoEm || '?'}
          </span>
          {isStale(f, today()) && <span className="ibadge tone-warn">rever</span>}
        </li>
      ))}
    </ul>
  );
}

export function List({ items }: { items: string[] }) {
  return items.length ? (
    <ul className="ilist">
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  ) : (
    <p className="hint">—</p>
  );
}

export function Empty({ topic, s }: { topic: ResearchTopic; s: ImmigrationState }) {
  const run = s.research.find((r) => r.topic === topic);
  return (
    <div className="icard">
      <p>
        Pesquisa “{TOPIC_LABEL[topic]}” ainda não terminou
        {run?.status === 'rodando' ? ' — o Claude está pesquisando agora.' : run?.status === 'na_fila' ? ' — está na fila.' : run?.status === 'falhou' ? `. A última tentativa falhou: ${run.error}` : '.'}
      </p>
    </div>
  );
}

export function Imigracao(props: { state: ImmigrationState | null; onState(s: ImmigrationState): void; onError(m: string): void }) {
  const [tab, setTab] = useState<Tab>('painel');
  const tabsRef = useTabIndicator<HTMLElement>(`${tab}|${!!props.state}`);
  const s = props.state;
  if (!s) return <Skeleton cards={4} label="Carregando a Imigração" />;

  const save = (patch: Partial<ImmigrationUser>) => immigrationApi.update(patch).then(props.onState).catch((e) => props.onError(e.message));

  return (
    <main className="imm">
      <header className="imm-head">
        <img src="/projetos/imigracao.png" alt="" className="plogo" />
        <div>
          <h2>
            <Plane size={18} strokeWidth={1.75} aria-hidden /> Imigração Portugal
          </h2>
          <p className="hint">
            Rotas, documentos, prazos, orçamento, vagas em Portugal e fontes · {s.jobs?.vagas.length ?? 0} vagas · {s.docs?.itens.length ?? 0} documentos ·{' '}
            {s.arquivos.length} arquivo(s) na sua pasta
          </p>
        </div>
      </header>
      <nav className="tabs subtabs seg" role="tablist" aria-label="Seções da imigração" ref={tabsRef}>
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>
      <p className="disclaimer">Organização e pesquisa — não é parecer jurídico. Itens com ⚠ precisam ser confirmados com advogado ou consulado.</p>
      {tab === 'painel' && <Painel s={s} go={setTab} onError={props.onError} />}
      {tab === 'rotas' && <Rotas s={s} />}
      {tab === 'documentos' && <Documentos s={s} save={save} />}
      {tab === 'tempo' && <Tempo s={s} save={save} />}
      {tab === 'orcamento' && <Orcamento s={s} save={save} />}
      {tab === 'vagas' && <Vagas s={s} research={s.jobs} topic="jobs" save={save} onError={props.onError} />}
      {tab === 'apartamentos' && <Apartamentos s={s} research={s.apartamentos} save={save} />}
      {tab === 'escola' && <Escola s={s} />}
      {tab === 'fontes' && <Fontes s={s} />}
    </main>
  );
}

const VERIF_LABEL = { confirmado: 'Confirmado', diverge: 'Diverge', nao_confirmado: 'Não confirmado' } as const;
const VERIF_TONE = { confirmado: 'ok', diverge: 'bad', nao_confirmado: 'warn' } as const;

function VerificationCard({ s }: { s: ImmigrationState }) {
  const v = s.verificacao;
  if (!v) return null;
  return (
    <section className="icard">
      <h3>Conferência independente no texto oficial</h3>
      <p className="hint">
        Feita em {v.feitaEm} por {v.por}.
      </p>
      {v.itens.map((it, i) => (
        <div key={i} className="change">
          <div className="badges">
            <span className={`ibadge tone-${VERIF_TONE[it.resultado]}`}>{VERIF_LABEL[it.resultado]}</span>
          </div>
          <p className="ititle">{it.afirmacao}</p>
          <p>{it.detalhe}</p>
          <Sources list={it.fontes} />
        </div>
      ))}
    </section>
  );
}

// ---------------- Painel ----------------

function Painel({ s, go, onError }: { s: ImmigrationState; go(t: Tab): void; onError(m: string): void }) {
  const legal = s.legal;
  const rec = legal?.rotas.find((r) => r.id === legal.recomendacao.rotaId);
  const next = computeTimeline(s, today()).filter((t) => t.diasAte >= 0).slice(0, 5);
  const docs = s.docs?.itens ?? [];
  const sources = allSources(s);
  const stale = sources.filter((f) => isStale(f, today())).length;
  const busy = s.research.some((r) => r.status === 'rodando' || r.status === 'na_fila');
  const unconfirmed = (s.verificacao?.itens ?? []).filter((v) => v.resultado !== 'confirmado');
  return (
    <div className="igrid">
      <section className="icard highlight">
        <h3>Rota recomendada</h3>
        {rec && legal ? (
          <>
            <p className="ititle">{legal.recomendacao.titulo || rec.nome}</p>
            <div className="badges">
              <Badge value={rec.familiaJunta} label="Família junta" />
              <Badge value={rec.conjugePodeTrabalhar} label="Cônjuge trabalha" />
              <Badge value={rec.elegibilidade} label="Elegível" />
            </div>
            {unconfirmed.length > 0 && (
              <div className="alert">
                <b>⚠ A conferência no texto oficial não confirmou:</b>
                <ul className="ilist">
                  {unconfirmed.map((v, i) => (
                    <li key={i}>{v.afirmacao}</li>
                  ))}
                </ul>
              </div>
            )}
            <p>{legal.recomendacao.porque}</p>
            <h4>Passos</h4>
            <ol className="ilist">
              {legal.recomendacao.passos.map((p, i) => (
                <li key={i}>{p.replace(/^\s*\d+[.)]\s*/, '')}</li>
              ))}
            </ol>
            <p>
              <b>Plano B:</b> {legal.recomendacao.planoB}
            </p>
            <button className="btn btn-small" onClick={() => go('rotas')}>
              Ver todas as rotas
            </button>
          </>
        ) : (
          <Empty topic="legal" s={s} />
        )}
      </section>

      <section className="icard warn">
        <h3>⚠ Incertezas — confirmar</h3>
        {legal ? <List items={legal.recomendacao.incertezas} /> : <p className="hint">Aguardando a pesquisa legal.</p>}
      </section>

      <VerificationCard s={s} />

      <section className="icard">
        <h3>Próximos prazos</h3>
        {next.length ? (
          <ul className="ilist">
            {next.map((t, i) => (
              <li key={i} className={t.tipo === 'critico' ? 'critical' : ''}>
                <b>{t.data}</b> · {t.diasAte} dias — {t.titulo}
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">Nenhum prazo futuro.</p>
        )}
        <button className="btn btn-small" onClick={() => go('tempo')}>
          Editar datas
        </button>
      </section>

      <section className="icard">
        <h3>Documentos</h3>
        {(['emmanuel', 'esposa', 'filha', 'familia'] as Person[]).map((p) => {
          const list = docs.filter((d) => d.pessoa === p);
          if (!list.length) return null;
          const ok = list.filter((d) => DOC_DONE.includes(s.user.docs[d.id]?.status ?? 'falta')).length;
          return (
            <div key={p} className="docprog">
              <span>{PERSON_LABEL[p]}</span>
              <div className="progress">
                <span style={{ width: `${(ok / list.length) * 100}%` }} />
              </div>
              <span className="mono">
                {ok}/{list.length}
              </span>
            </div>
          );
        })}
        {!docs.length && <p className="hint">Aguardando a pesquisa de documentos.</p>}
        <button className="btn btn-small" onClick={() => go('documentos')}>
          Atualizar status
        </button>
      </section>

      <section className="icard">
        <h3>Vagas em Portugal</h3>
        <p>
          {s.jobs?.vagas.length ?? 0} no pipeline · {s.jobs?.vagas.filter((v) => v.permiteVisto === 'sim').length ?? 0} com contrato que serve para visto ·{' '}
          {(s.jobs?.vagas ?? []).filter((v) => s.user.vagas[v.id]?.status === 'pronta').length} candidatura(s) pronta(s) para você enviar
        </p>
        <p className="hint">
          {topIds(s.jobs?.vagas ?? [], (v) => jobScore(v, s.user, today())).size} em destaque · {s.apartamentos?.apartamentos.length ?? 0} apartamento(s) na lista · caçador diário 1x ao dia
        </p>
        <button className="btn btn-small" onClick={() => go('vagas')}>
          Ver vagas
        </button>
        <button className="btn btn-small" onClick={() => go('apartamentos')}>
          Ver apartamentos
        </button>
      </section>

      <section className="icard">
        <h3>Pesquisas (vagas e apartamentos 1x ao dia; o resto 1x por semana)</h3>
        <ul className="ilist">
          {s.research.filter((r) => r.topic !== 'aiJobs').map((r) => (
            <li key={r.topic}>
              {TOPIC_LABEL[r.topic]}:{' '}
              {r.status === 'rodando' ? 'pesquisando agora…' : r.status === 'na_fila' ? 'na fila' : r.lastOkAt ? `atualizada em ${r.lastOkAt.slice(0, 10)}` : 'ainda não feita'}
              {r.status === 'falhou' && <span className="ibadge tone-bad">falhou</span>}
            </li>
          ))}
        </ul>
        <p className="hint">
          {sources.length} fontes · {stale} para rever
        </p>
        <button className="btn btn-small" disabled={busy} onClick={() => immigrationApi.research().catch((e) => onError(e.message))}>
          {busy ? 'Pesquisando…' : 'Atualizar pesquisas agora'}
        </button>
      </section>

      <section className="icard">
        <h3>Onde ficam os arquivos</h3>
        <p className="hint">Sua pasta de referência (fora do vault e do git):</p>
        <p className="mono">{s.docsFolder}</p>
        <p>{s.arquivos.length ? `${s.arquivos.length} arquivo(s) encontrados.` : 'Ainda vazia — os documentos aparecem aqui quando você colocá-los lá.'}</p>
        <p className="hint">No vault: {s.vaultFolder} (só status, nunca números de documentos).</p>
        <button className="btn btn-small" onClick={() => go('documentos')}>
          Ver arquivos
        </button>
      </section>
    </div>
  );
}

// ---------------- Rotas ----------------

function RouteCard({ r, recommended }: { r: Route; recommended: boolean }) {
  const [open, setOpen] = useState(recommended);
  return (
    <section className={`icard ${recommended ? 'highlight' : ''}`}>
      <button className="iexpand" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="ititle">
          {recommended ? '⭐ ' : ''}
          {r.nome}
        </span>
        <span>{open ? '−' : '+'}</span>
      </button>
      <div className="badges">
        <Badge value={r.elegibilidade} label="Elegível" />
        <Badge value={r.familiaJunta} label="Família junta" />
        <Badge value={r.conjugePodeTrabalhar} label="Cônjuge trabalha" />
      </div>
      <p>{r.resumo}</p>
      {open && (
        <>
          <p>
            <b>Elegibilidade:</b> {r.motivoElegibilidade}
          </p>
          <p>
            <b>Família:</b> {r.familiaDetalhe}
          </p>
          <p>
            <b>Cônjuge:</b> {r.conjugeDetalhe}
          </p>
          <p>
            <b>Onde pedir:</b> {r.ondePedir}
          </p>
          <h4>Requisitos</h4>
          <List items={r.requisitos} />
          <h4>Custos</h4>
          <List items={r.custos} />
          <h4>Prazos</h4>
          <List items={r.prazos} />
          <h4>Prós</h4>
          <List items={r.pros} />
          <h4>Contras</h4>
          <List items={r.contras} />
          <h4>⚠ Confirmar com</h4>
          <List items={r.confirmarCom} />
          <h4>Fontes</h4>
          <Sources list={r.fontes} />
        </>
      )}
    </section>
  );
}

function Rotas({ s }: { s: ImmigrationState }) {
  const legal = s.legal;
  if (!legal) return <Empty topic="legal" s={s} />;
  const routes = [...legal.rotas].sort((a, b) => (a.id === legal.recomendacao.rotaId ? -1 : b.id === legal.recomendacao.rotaId ? 1 : 0));
  return (
    <div className="istack">
      <VerificationCard s={s} />
      <section className="icard">
        <h3>{legal.lei.diploma}</h3>
        <p className="hint">
          Publicado em {legal.lei.publicadoEm || '?'} · em vigor desde {legal.lei.emVigorDesde || '?'}
        </p>
        <p>{legal.lei.situacao}</p>
        {legal.lei.mudancas.map((m, i) => (
          <div key={i} className="change">
            <p className="ititle">{m.tema}</p>
            <p>
              <b>Antes:</b> {m.antes}
            </p>
            <p>
              <b>Agora:</b> {m.depois}
            </p>
            <p className="impact">
              <b>Para vocês:</b> {m.impacto}
            </p>
            <Sources list={m.fontes} />
          </div>
        ))}
        {legal.lei.regulamentacao.length > 0 && (
          <>
            <h4>Regulamentação posterior</h4>
            {legal.lei.regulamentacao.map((r, i) => (
              <div key={i}>
                <p>
                  <b>{r.titulo}:</b> {r.resumo}
                </p>
                <Sources list={r.fontes} />
              </div>
            ))}
          </>
        )}
        <h4>Fontes da lei</h4>
        <Sources list={legal.lei.fontes} />
      </section>
      {routes.map((r) => (
        <RouteCard key={r.id} r={r} recommended={r.id === legal.recomendacao.rotaId} />
      ))}
    </div>
  );
}

// ---------------- Documentos ----------------

function Documentos({ s, save }: { s: ImmigrationState; save(p: Partial<ImmigrationUser>): void }) {
  if (!s.docs) return <Empty topic="docs" s={s} />;
  const docs = s.docs;
  const filesOf = (id: string) => s.arquivos.filter((f) => f.sugestao === id);
  return (
    <div className="istack">
      <FolderCard s={s} />
      <section className="icard">
        <h3>Regras gerais</h3>
        <List items={docs.regras} />
        <p className="hint">Aqui fica só o status; os arquivos ficam na sua pasta de referência.</p>
      </section>
      {(['emmanuel', 'esposa', 'filha', 'familia'] as Person[]).map((p) => {
        const list = docs.itens.filter((d) => d.pessoa === p);
        if (!list.length) return null;
        return (
          <section key={p} className="icard">
            <h3>{PERSON_LABEL[p]}</h3>
            {list.map((d) => {
              const st = s.user.docs[d.id] ?? { status: 'falta' as DocStatus, validoAte: null };
              return (
                <div key={d.id} className={`doc ${DOC_DONE.includes(st.status) ? 'done' : ''}`}>
                  <p className="ititle">{d.documento}</p>
                  <p className="hint">{d.paraQue}</p>
                  <div className="badges">
                    {d.apostila !== null && <span className="ibadge tone-neutral">{d.apostila ? 'Apostila: sim' : 'Sem apostila'}</span>}
                    {d.traducao !== null && <span className="ibadge tone-neutral">{d.traducao ? 'Tradução: sim' : 'Sem tradução'}</span>}
                    {d.validade && <span className="ibadge tone-warn">{d.validade}</span>}
                  </div>
                  <p>
                    <b>Onde obter:</b> {d.ondeObter}
                  </p>
                  {d.observacoes && <p className="hint">{d.observacoes}</p>}
                  {filesOf(d.id).map((f) => (
                    <p key={f.pasta + f.nome} className="docfile">
                      <FileText size={15} strokeWidth={1.75} aria-hidden /> Na pasta:{' '}
                      <span className="mono">
                        {f.pasta ? `${f.pasta}/` : ''}
                        {f.nome}
                      </span>
                    </p>
                  ))}
                  <div className="docedit">
                    <label>
                      <span>Status</span>
                      <select value={st.status} onChange={(e) => save({ docs: { [d.id]: { ...st, status: e.target.value as DocStatus } } })}>
                        {Object.entries(DOC_STATUS_LABEL).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Válido até</span>
                      <input type="date" value={st.validoAte ?? ''} onChange={(e) => save({ docs: { [d.id]: { ...st, validoAte: e.target.value || null } } })} />
                    </label>
                  </div>
                  <Sources list={d.fontes} />
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

const kb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} MB` : `${n} KB`);

// Pasta de referência: o app lista só nome, tamanho e data (não lê o conteúdo).
function FolderCard({ s }: { s: ImmigrationState }) {
  const title = (id: string | null) => (id ? s.docs?.itens.find((d) => d.id === id)?.documento ?? null : null);
  const files: DocFile[] = [...s.arquivos].sort((a, b) => b.modificado.localeCompare(a.modificado));
  return (
    <section className="icard">
      <h3>
        <FolderOpen size={17} strokeWidth={1.75} aria-hidden /> Sua pasta de documentos
      </h3>
      <p className="mono">{s.docsFolder}</p>
      {files.length ? (
        <ul className="filelist">
          {files.map((f) => (
            <li key={f.pasta + f.nome}>
              <FileText size={16} strokeWidth={1.75} aria-hidden />
              <span className="fname">
                {f.pasta && <span className="hint">{f.pasta}/</span>}
                {f.nome}
              </span>
              <span className="hint">
                {kb(f.kb)} · {f.modificado.slice(0, 10)}
              </span>
              {title(f.sugestao) && <span className="ibadge tone-ok">parece ser: {title(f.sugestao)}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">
          A pasta ainda está vazia. Quando você colocar os documentos (CVs, certidões, passaportes digitalizados…), eles aparecem aqui com a sugestão de qual item do checklist
          cada um cobre.
        </p>
      )}
    </section>
  );
}

// ---------------- Linha do tempo ----------------

function Tempo({ s, save }: { s: ImmigrationState; save(p: Partial<ImmigrationUser>): void }) {
  const items = computeTimeline(s, today());
  const [ev, setEv] = useState<Omit<UserEvent, 'id'>>({ data: '', titulo: '', tipo: 'agendamento' });
  return (
    <div className="istack">
      <section className="icard">
        <h3>Suas datas</h3>
        <div className="formgrid">
          <label className="field">
            <span>Fim do emprego (previsão)</span>
            <input type="date" defaultValue={s.user.fimEmprego} onBlur={(e) => e.target.value !== s.user.fimEmprego && save({ fimEmprego: e.target.value })} />
          </label>
          <label className="field">
            <span>Dias para achar novo empregador na Romênia</span>
            <input type="number" min={0} defaultValue={s.user.diasParaNovoEmpregador} onBlur={(e) => save({ diasParaNovoEmpregador: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>Autorização na Romênia válida até</span>
            <input type="date" defaultValue={s.user.autorizacaoRomeniaAte} onBlur={(e) => e.target.value !== s.user.autorizacaoRomeniaAte && save({ autorizacaoRomeniaAte: e.target.value })} />
          </label>
        </div>
      </section>
      <section className="icard">
        <h3>Prazos</h3>
        <ol className="itimeline">
          {items.map((t, i) => (
            <li key={i} className={`tt-${t.tipo} ${t.diasAte < 0 ? 'past' : ''}`}>
              <span className="mono">{t.data}</span>
              <span>
                <b>{t.titulo}</b>
                {t.detalhe && <span className="hint"> — {t.detalhe}</span>}
              </span>
              <span className="hint">{t.diasAte >= 0 ? `${t.diasAte} dias` : 'passou'}</span>
            </li>
          ))}
        </ol>
      </section>
      <section className="icard">
        <h3>Agendamentos e outros prazos</h3>
        {s.user.eventos.map((e) => (
          <div key={e.id} className="evrow">
            <span className="mono">{e.data}</span> <span>{e.titulo}</span>
            <button className="btn btn-small btn-danger" onClick={() => save({ eventos: s.user.eventos.filter((x) => x.id !== e.id) })}>
              Remover
            </button>
          </div>
        ))}
        <div className="formgrid">
          <label className="field">
            <span>Data</span>
            <input type="date" value={ev.data} onChange={(e) => setEv({ ...ev, data: e.target.value })} />
          </label>
          <label className="field">
            <span>O quê (ex.: agendamento AIMA, consulado)</span>
            <input value={ev.titulo} onChange={(e) => setEv({ ...ev, titulo: e.target.value })} />
          </label>
          <label className="field">
            <span>Tipo</span>
            <select value={ev.tipo} onChange={(e) => setEv({ ...ev, tipo: e.target.value as UserEvent['tipo'] })}>
              <option value="agendamento">Agendamento</option>
              <option value="prazo">Prazo</option>
              <option value="outro">Outro</option>
            </select>
          </label>
        </div>
        <button
          className="btn btn-primary"
          disabled={!ev.data || !ev.titulo.trim()}
          onClick={() => {
            save({ eventos: [...s.user.eventos, { ...ev, titulo: ev.titulo.trim(), id: `ev-${Date.now()}` }] });
            setEv({ data: '', titulo: '', tipo: 'agendamento' });
          }}
        >
          Adicionar
        </button>
      </section>
    </div>
  );
}

// ---------------- Orçamento ----------------

const BUDGET_FIELDS: { key: keyof ImmigrationUser['orcamento']; label: string; unit: string }[] = [
  { key: 'reservaLei', label: 'Reserva', unit: 'lei' },
  { key: 'rescisaoLei', label: 'Rescisão esperada', unit: 'lei' },
  { key: 'custoAtualLei', label: 'Custo mensal atual em Bucareste', unit: 'lei' },
  { key: 'salarioPresencialEur', label: 'Salário líquido — presencial/híbrido em PT', unit: '€/mês' },
  { key: 'salarioRemotoEur', label: 'Salário líquido — remoto', unit: '€/mês' },
  { key: 'salarioEsposaEur', label: 'Salário líquido do cônjuge', unit: '€/mês' },
];

function Orcamento({ s, save }: { s: ImmigrationState; save(p: Partial<ImmigrationUser>): void }) {
  const [city, setCity] = useState<'braga' | 'barcelos'>('barcelos');
  const r = useMemo(() => computeScenarios(s, city), [s, city]);
  return (
    <div className="istack">
      <section className="icard">
        <h3>Seus números</h3>
        <div className="formgrid">
          {BUDGET_FIELDS.map((f) => (
            <label key={f.key} className="field">
              <span>
                {f.label} ({f.unit})
              </span>
              <input
                type="number"
                min={0}
                inputMode="numeric"
                defaultValue={s.user.orcamento[f.key] || ''}
                onBlur={(e) => Number(e.target.value || 0) !== s.user.orcamento[f.key] && save({ orcamento: { ...s.user.orcamento, [f.key]: Number(e.target.value || 0) } })}
              />
            </label>
          ))}
        </div>
        {s.living?.salarios.length ? (
          <>
            <h4>Referências de salário</h4>
            <ul className="ilist">
              {s.living.salarios.map((x, i) => (
                <li key={i}>
                  {x.referencia}: <b>{eur(x.valorEur)}</b> {x.observacao && <span className="hint">— {x.observacao}</span>}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
      {!s.living || !r ? (
        <Empty topic="living" s={s} />
      ) : (
        <>
          <section className="icard">
            <div className="segmented" role="radiogroup" aria-label="Cidade">
              {(['barcelos', 'braga'] as const).map((c) => (
                <label key={c} className={city === c ? 'on' : ''}>
                  <input type="radio" name="city" checked={city === c} onChange={() => setCity(c)} />
                  {c === 'braga' ? 'Braga' : 'Barcelos'}
                </label>
              ))}
            </div>
            <div className="kpis">
              <div>
                <span className="hint">Custo mensal estimado</span>
                <b>{eur(r.cenarios[0].custoEur)}</b>
              </div>
              <div>
                <span className="hint">Mudança (única vez)</span>
                <b>{eur(r.mudancaEur)}</b>
              </div>
              <div>
                <span className="hint">Capital depois da mudança</span>
                <b>{eur(r.capitalEur)}</b>
              </div>
              {r.custoAtualEur > 0 && (
                <div>
                  <span className="hint">Custo atual em Bucareste</span>
                  <b>{eur(r.custoAtualEur)}</b>
                </div>
              )}
            </div>
            <p className="hint">
              Câmbio: 1 € = {s.living.cambio.ronPorEur} lei ({s.living.cambio.data}). Aluguel = média das faixas de T2 da cidade.
            </p>
          </section>
          <section className="icard">
            <h3>Cenários</h3>
            {r.cenarios.filter((c) => c.id === 'procura' || c.rendaEur > 0).map((c) => (
              <div key={c.id} className={`scenario ${c.saldoEur >= 0 ? 'pos' : 'neg'}`}>
                <p className="ititle">{c.nome}</p>
                <p>
                  Renda {eur(c.rendaEur)} − custo {eur(c.custoEur)} = <b>{eur(c.saldoEur)}/mês</b>
                </p>
                <p className="hint">{c.mesesReserva === null ? 'Não consome a reserva.' : `A reserva dura cerca de ${c.mesesReserva} meses.`}</p>
              </div>
            ))}
            {!s.user.orcamento.salarioPresencialEur && <p className="hint">Preencha os salários acima para ver os cenários com renda.</p>}
          </section>
          <section className="icard">
            <h3>Custos mensais (sem aluguel)</h3>
            {s.living.custosMensais.map((c, i) => (
              <div key={i} className="row">
                <span>{c.item}</span>
                <b>{eur(city === 'braga' ? c.bragaEur : c.barcelosEur)}</b>
              </div>
            ))}
            <h4>Mudança</h4>
            {s.living.mudanca.map((m, i) => (
              <div key={i} className="row">
                <span>{m.item}</span>
                <b>
                  {eur(m.minEur)}–{eur(m.maxEur)}
                </b>
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  );
}

// ---------------- Escola e moradia ----------------

function Escola({ s }: { s: ImmigrationState }) {
  const l = s.living;
  if (!l) return <Empty topic="living" s={s} />;
  return (
    <div className="istack">
      <section className="icard">
        <h3>Escola das crianças</h3>
        <p>{l.escola.resumo}</p>
        <h4>Passos</h4>
        <List items={l.escola.passos} />
        <h4>Documentos</h4>
        <List items={l.escola.documentos} />
        <h4>Prazos</h4>
        <List items={l.escola.prazos} />
        <Sources list={l.escola.fontes} />
      </section>
      <section className="icard">
        <h3>Bairros sugeridos</h3>
        {l.bairros.map((b, i) => (
          <p key={i}>
            <b>
              {b.cidade} — {b.nome}:
            </b>{' '}
            {b.porque}
          </p>
        ))}
      </section>
      <section className="icard">
        <h3>Aluguel</h3>
        {l.moradia.map((m, i) => (
          <div key={i} className="housing">
            <div className="row">
              <span>
                {m.cidade} · {m.zona} · {m.tipologia}
              </span>
              <b>
                {eur(m.minEur)}–{eur(m.maxEur)}
              </b>
            </div>
            {m.observacao && <p className="hint">{m.observacao}</p>}
            <Sources list={m.fontes} />
          </div>
        ))}
      </section>
    </div>
  );
}

// ---------------- Fontes ----------------

function Fontes({ s }: { s: ImmigrationState }) {
  const [onlyStale, setOnlyStale] = useState(false);
  const all = allSources(s);
  const list = all.filter((f) => !onlyStale || isStale(f, today())).sort((a, b) => Number(b.oficial) - Number(a.oficial) || a.titulo.localeCompare(b.titulo));
  return (
    <div className="istack">
      <section className="icard">
        <p>
          {all.length} fontes · {all.filter((f) => f.oficial).length} oficiais · {all.filter((f) => isStale(f, today())).length} para rever (mais de 30 dias ou sem data)
        </p>
        <label className="follow">
          <input type="checkbox" checked={onlyStale} onChange={(e) => setOnlyStale(e.target.checked)} /> só as que precisam de revisão
        </label>
      </section>
      {list.map((f) => (
        <section key={f.url} className="icard source">
          <a href={f.url} target="_blank" rel="noreferrer" className="ititle">
            {f.titulo}
          </a>
          <div className="badges">
            {f.oficial ? <span className="ibadge tone-ok">oficial</span> : <span className="ibadge tone-neutral">não oficial</span>}
            <span className="ibadge tone-neutral">{f.orgao || 'fonte'}</span>
            <span className={`ibadge ${isStale(f, today()) ? 'tone-warn' : 'tone-neutral'}`}>
              verificado em {f.verificadoEm || '?'}
              {isStale(f, today()) ? ' · rever' : ''}
            </span>
          </div>
          <p className="hint">Usada em: {f.onde}</p>
        </section>
      ))}
    </div>
  );
}
