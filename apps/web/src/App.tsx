import { useCallback, useEffect, useMemo, useState } from 'react';
import { COLUMN_OF, OBJECTIVE_WAITING, type Column, type Job, type Objective } from '../../../packages/shared/types.ts';
import { actions, formatTime, obsidianLink, prefsApi, useLive, useNow } from './api.ts';
import { Aparelhos } from './components/Aparelhos.tsx';
import { AgentBar } from './components/AgentBar.tsx';
import { JobCard } from './components/JobCard.tsx';
import { JobDetail } from './components/JobDetail.tsx';
import { NewJob } from './components/NewJob.tsx';
import { Confirm } from './components/Confirm.tsx';
import { NewObjective, ObjectiveCard, ObjectiveDetail } from './components/Objectives.tsx';
import { confirmationFor, type JobAction } from './components/JobActions.tsx';
import { Imigracao } from './components/Imigracao.tsx';
import { Projetos } from './components/Projetos.tsx';
import { IA } from './components/IA.tsx';
import { Agentes } from './components/Agentes.tsx';
import { useTabIndicator, withTransition } from './motion.tsx';
import { TabsBar, mergeOrder } from './components/TabsBar.tsx';
import { Bot, CalendarClock, FolderOpen, MessageSquare, FolderKanban, LayoutGrid, ListChecks, Plane, Plus, Settings, Sparkles, Target, Wallet } from 'lucide-react';
import { Renda } from './components/Renda.tsx';
import { Hoje } from './components/Hoje.tsx';
import { Rotinas } from './components/Rotinas.tsx';
import { Chat } from './components/Chat.tsx';
import { Arquivos } from './components/Arquivos.tsx';
import { PlayerBar } from './components/Player.tsx';

const COLUMNS: { key: Column; label: string; empty: string }[] = [
  { key: 'todo', label: 'A executar', empty: 'Fila vazia.' },
  { key: 'running', label: 'Em execução', empty: 'Nenhum agente trabalhando agora.' },
  { key: 'waiting', label: 'Aguardando você', empty: 'Nada esperando por você.' },
  { key: 'done', label: 'Concluídas', empty: 'Nenhum job concluído ainda.' },
  { key: 'failed', label: 'Falharam', empty: 'Nenhuma falha.' },
];

const SHOW_LIMIT = 40;

const VIEWS = [
  { key: 'renda', label: 'Renda', Icon: Wallet },
  { key: 'chat', label: 'Chat', Icon: MessageSquare },
  { key: 'hoje', label: 'Hoje', Icon: ListChecks },
  { key: 'atividades', label: 'Atividades', Icon: LayoutGrid },
  { key: 'objetivos', label: 'Objetivos', Icon: Target },
  { key: 'agentes', label: 'Agentes', Icon: Bot },
  { key: 'projetos', label: 'Projetos', Icon: FolderKanban },
  { key: 'arquivos', label: 'Arquivos', Icon: FolderOpen },
  { key: 'imigracao', label: 'Imigração Portugal', Icon: Plane },
  { key: 'ia', label: 'IA', Icon: Sparkles },
  { key: 'rotinas', label: 'Rotinas', Icon: CalendarClock },
] as const;
type View = 'arquivos' | 'chat' | 'rotinas' | 'renda' | 'hoje' | 'atividades' | 'objetivos' | 'agentes' | 'projetos' | 'imigracao' | 'ia';

function sortJobs(col: Column, jobs: Job[]): Job[] {
  const t = (s: string | null) => (s ? Date.parse(s) : 0);
  if (col === 'todo') return jobs.sort((a, b) => t(a.createdAt) - t(b.createdAt));
  if (col === 'running') return jobs.sort((a, b) => t(a.startedAt) - t(b.startedAt));
  return jobs.sort((a, b) => t(b.finishedAt ?? b.createdAt) - t(a.finishedAt ?? a.createdAt));
}

function useIsMobile() {
  const q = '(max-width: 899px)';
  const [mobile, setMobile] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setMobile(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return mobile;
}

export function App(props: { onLoggedOut(): void }) {
  const { state, connected, dataAt, loadEvents, setImmigration } = useLive();
  const [settings, setSettings] = useState(false);
  // Só mostra o aviso de PC fora do ar depois de alguns segundos sem conexão.
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    if (connected) return setOffline(false);
    const t = setTimeout(() => setOffline(true), 4000);
    return () => clearTimeout(t);
  }, [connected]);
  const now = useNow();
  const mobile = useIsMobile();
  const [view, setView] = useState<View>('atividades');
  const [projectFilter, setProjectFilter] = useState<string>('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [openObjectiveId, setOpenObjectiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState<'job' | 'objective' | null>(null);
  const [tab, setTab] = useState<Column>('running');
  const [pending, setPending] = useState<{ message: string; run: () => Promise<unknown> } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const go = (v: View) => v !== view && withTransition(() => setView(v));
  const close = (fn: () => void) => () => withTransition(fn, 'close');
  // Ordem das abas: salva no PC (vale para todos os aparelhos) e uma cópia no aparelho.
  const ALL_VIEWS = VIEWS.map((v) => v.key) as View[];
  const [order, setOrder] = useState<View[]>(() => {
    try {
      return mergeOrder(JSON.parse(localStorage.getItem('emannu.abas') ?? 'null'), ALL_VIEWS);
    } catch {
      return ALL_VIEWS;
    }
  });
  useEffect(() => {
    if (connected) prefsApi.get().then((p) => p.abas && setOrder(mergeOrder(p.abas, ALL_VIEWS))).catch(() => {});
  }, [connected]);
  const saveOrder = (o: View[]) => {
    setOrder(o);
    try {
      localStorage.setItem('emannu.abas', JSON.stringify(o));
    } catch {}
    prefsApi.save({ abas: o }).catch((e) => setToast(e.message));
  };
  // Clicar num agente (barra do topo) abre a aba Agentes no card dele.
  const [agentFocus, setAgentFocus] = useState<{ id: string; at: number } | null>(null);
  const openAgent = (id: string) => {
    setAgentFocus({ id, at: Date.now() });
    go('agentes');
  };
  const colTabsRef = useTabIndicator<HTMLElement>(`${tab}|${view}|${mobile}`);

  const projectsById = useMemo(() => Object.fromEntries(state.projects.map((p) => [p.id, p])), [state.projects]);
  const jobsByObjective = useMemo(() => {
    const m: Record<string, Job[]> = {};
    for (const j of Object.values(state.jobs)) if (j.objectiveId) (m[j.objectiveId] ??= []).push(j);
    for (const list of Object.values(m)) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return m;
  }, [state.jobs]);

  const byColumn = useMemo(() => {
    const cols: Record<Column, Job[]> = { todo: [], running: [], waiting: [], done: [], failed: [] };
    for (const j of Object.values(state.jobs)) {
      if (projectFilter && j.projectId !== projectFilter) continue;
      cols[COLUMN_OF[j.status]].push(j);
    }
    for (const c of Object.keys(cols) as Column[]) sortJobs(c, cols[c]);
    return cols;
  }, [state.jobs, projectFilter]);

  const objectives = useMemo(
    () => Object.values(state.objectives).filter((o) => !projectFilter || o.projectId === projectFilter).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [state.objectives, projectFilter],
  );
  const waitingObjectives = objectives.filter((o) => OBJECTIVE_WAITING.includes(o.status));
  // Muda quando o status de algum job/objetivo/projeto muda: a aba Projetos recarrega os números.
  const projectsVersion = useMemo(
    () => [...Object.values(state.jobs).map((j) => j.status), ...Object.values(state.objectives).map((o) => o.status), state.projects.length].join(','),
    [state.jobs, state.objectives, state.projects],
  );
  const waitingCount = byColumn.waiting.length + waitingObjectives.length;

  useEffect(() => {
    document.title = waitingCount ? `(${waitingCount}) EMANNU OS` : 'EMANNU OS';
  }, [waitingCount]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const open = useCallback(
    (id: string) => {
      setOpenId(id);
      loadEvents(id).catch((e) => setToast(e.message));
    },
    [loadEvents],
  );

  // Links das notificações: /?job=<id> ou /?objetivo=<id>.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const job = q.get('job');
    const obj = q.get('objetivo');
    if (job) open(job);
    if (obj) {
      setView('objetivos');
      setOpenObjectiveId(obj);
    }
    if (job || obj) history.replaceState(null, '', '/');
  }, []);

  // Ao conectar, carrega o histórico de log dos jobs que estão rodando.
  const runningIds = byColumn.running.map((j) => j.id).join(',');
  useEffect(() => {
    for (const id of runningIds.split(',').filter(Boolean)) loadEvents(id).catch(() => {});
  }, [runningIds, connected]);

  const confirm = (message: string, run: () => Promise<unknown>) => setPending({ message, run });

  const request = (job: Job, action: JobAction) => {
    const run = () => actions[action](job.id);
    const message = confirmationFor(job, action);
    if (message) confirm(message, run);
    else run().catch((e) => setToast(e.message));
  };

  const vaultLinkOf = (rel: string | null) => (rel && state.config.vaultName ? obsidianLink(state.config, rel) : null);

  const renderJob = (j: Job) => (
    <JobCard
      key={j.id}
      job={j}
      project={projectsById[j.projectId]}
      objectiveTitle={j.objectiveId ? state.objectives[j.objectiveId]?.title : undefined}
      events={state.events[j.id] ?? []}
      now={now}
      vaultLink={vaultLinkOf(j.vaultNote)}
      onOpen={() => open(j.id)}
      onAction={(a) => request(j, a)}
    />
  );

  const renderObjective = (o: Objective) => (
    <ObjectiveCard key={o.id} objective={o} project={o.projectId ? projectsById[o.projectId] : undefined} jobs={jobsByObjective[o.id] ?? []} onOpen={() => setOpenObjectiveId(o.id)} />
  );

  const renderColumn = (col: Column, empty: string) => {
    const jobs = byColumn[col];
    const objs = col === 'waiting' ? waitingObjectives : [];
    if (!jobs.length && !objs.length) return <p className="empty">{empty}</p>;
    return (
      <>
        {objs.map(renderObjective)}
        {jobs.slice(0, SHOW_LIMIT).map(renderJob)}
        {jobs.length > SHOW_LIMIT && <p className="empty">+ {jobs.length - SHOW_LIMIT} mais antigos</p>}
      </>
    );
  };

  const openJob = openId ? state.jobs[openId] : null;
  const openObjective = openObjectiveId ? state.objectives[openObjectiveId] : null;
  const activeObjectives = objectives.filter((o) => !['done', 'failed', 'canceled'].includes(o.status));
  const pastObjectives = objectives.filter((o) => ['done', 'failed', 'canceled'].includes(o.status));

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            E
          </span>
          <div>
            <div className="brand-name">EMANNU OS</div>
            <div className="brand-sub">Integração &amp; Atividades</div>
          </div>
        </div>
        <div className="topbar-right">
          <span className={`conn ${connected ? 'on' : 'off'}`} role="status">
            {connected ? 'ao vivo' : 'sem conexão com o PC'}
          </span>
          <button className="btn btn-icon btn-ghost" onClick={() => setSettings(true)} aria-label="Celular e notificações" title="Celular e notificações">
            <Settings size={18} strokeWidth={1.75} />
          </button>
          <button className="btn" onClick={() => setCreating('job')}>
            <Plus size={16} strokeWidth={2} /> Job
          </button>
          <button className="btn btn-primary" onClick={() => setCreating('objective')}>
            <Plus size={16} strokeWidth={2} /> Objetivo
          </button>
        </div>
      </header>

      {offline && (
        <div className="offline-banner" role="alert">
          <b>Sem conexão com o PC.</b> Ele pode estar desligado ou dormindo, ou o Tailscale está desligado neste aparelho.
          {dataAt ? ` Mostrando os dados de ${formatTime(dataAt)}; ações ficam indisponíveis até reconectar.` : ''}
        </div>
      )}

      <AgentBar agents={state.agents} sistema={state.sistema} onOpen={openAgent} onResume={(id) => actions.resumeAgent(id).catch((e) => setToast(e.message))} />

      <div className="filters">
        <TabsBar
          tabs={[...VIEWS]}
          order={order}
          active={view}
          indicatorKey={`${view}|${mobile}`}
          onGo={go}
          onOrder={saveOrder}
          badge={(key) =>
            key === 'atividades' && waitingCount > 0 ? (
              <span key={waitingCount} className="count count-alert">
                {waitingCount}
              </span>
            ) : key === 'objetivos' ? (
              <span className="count">{activeObjectives.length}</span>
            ) : null
          }
        />
        <label hidden={view === 'imigracao' || view === 'projetos' || view === 'ia' || view === 'agentes' || view === 'renda' || view === 'hoje' || view === 'rotinas' || view === 'chat' || view === 'arquivos'}>
          <span>Projeto</span>
          <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
            <option value="">Todos</option>
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="view">
      {view === 'arquivos' ? (
        <Arquivos onError={setToast} onToast={setToast} />
      ) : view === 'chat' ? (
        <Chat
          projects={state.projects.filter((p) => p.isGit)}
          chatEvent={state.chatEvent}
          onOpenJob={open}
          onOpenObjective={(id) => {
            setView('objetivos');
            setOpenObjectiveId(id);
          }}
          onError={setToast}
          onToast={setToast}
        />
      ) : view === 'rotinas' ? (
        <Rotinas
          version={`${state.rendaVersion}|${Object.values(state.jobs).filter((j) => ['done', 'failed', 'running'].includes(j.status)).length}|${state.sistema?.modoJogo.ativo}|${state.sistema?.modoJogo.historico.length ?? 0}`}
          onError={setToast} onToast={setToast} onOpenJob={open} />
      ) : view === 'renda' ? (
        <Renda version={state.rendaVersion} onError={setToast} onToast={setToast} />
      ) : view === 'hoje' ? (
        <Hoje
          version={state.rendaVersion * 1000 + waitingCount}
          onOpenJob={open}
          onOpenObjective={(id) => {
            setView('objetivos');
            setOpenObjectiveId(id);
          }}
          onError={setToast}
          onToast={setToast}
        />
      ) : view === 'imigracao' ? (
        <Imigracao state={state.immigration} onState={setImmigration} onError={setToast} />
      ) : view === 'agentes' ? (
        <Agentes sistema={state.sistema} jobs={state.jobs} agents={state.agents} projectsById={projectsById} config={state.config} now={now} focus={agentFocus} onOpenJob={open} onError={setToast} />
      ) : view === 'ia' ? (
        <IA state={state.immigration} config={state.config} onState={setImmigration} onError={setToast} />
      ) : view === 'projetos' ? (
        <Projetos
          config={state.config}
          version={projectsVersion}
          jobs={Object.values(state.jobs)}
          onOpenJob={open}
          onError={setToast}
          onOpenImmigration={() => go('imigracao')}
          onNewObjective={(pid) => {
            setProjectFilter(pid);
            setCreating('objective');
          }}
        />
      ) : view === 'objetivos' ? (
        <main className="objectives">
          <section className="column">
            <h2 className="column-title">
              Em andamento <span className="count">{activeObjectives.length}</span>
            </h2>
            {activeObjectives.length ? activeObjectives.map(renderObjective) : <p className="empty">Nenhum objetivo em andamento. Crie um em “+ Objetivo”.</p>}
          </section>
          <section className="column">
            <h2 className="column-title">
              Encerrados <span className="count">{pastObjectives.length}</span>
            </h2>
            {pastObjectives.length ? pastObjectives.map(renderObjective) : <p className="empty">Nenhum ainda.</p>}
          </section>
        </main>
      ) : mobile ? (
        <main className="board-mobile">
          {waitingCount > 0 && (
            <section className="column waiting-top" aria-label="Aguardando você">
              <h2 className="column-title">
                Aguardando você <span className="count count-alert">{waitingCount}</span>
              </h2>
              {renderColumn('waiting', '')}
            </section>
          )}
          <nav className="tabs seg" role="tablist" ref={colTabsRef}>
            {COLUMNS.filter((c) => c.key !== 'waiting').map((c) => (
              <button key={c.key} role="tab" aria-selected={tab === c.key} className={tab === c.key ? 'on' : ''} onClick={() => setTab(c.key)}>
                {c.label} <span className="count">{byColumn[c.key].length}</span>
              </button>
            ))}
          </nav>
          <section className="column" role="tabpanel">
            {renderColumn(tab, COLUMNS.find((c) => c.key === tab)!.empty)}
          </section>
        </main>
      ) : (
        <main className="board">
          {COLUMNS.map((c) => (
            <section key={c.key} className={`column col-${c.key}`} aria-label={c.label}>
              <h2 className="column-title">
                {c.label}{' '}
                <span className={`count ${c.key === 'waiting' && waitingCount ? 'count-alert' : ''}`}>{c.key === 'waiting' ? waitingCount : byColumn[c.key].length}</span>
              </h2>
              {renderColumn(c.key, c.empty)}
            </section>
          ))}
        </main>
      )}
      </div>

      {openObjective && (
        <ObjectiveDetail
          objective={openObjective}
          project={openObjective.projectId ? projectsById[openObjective.projectId] : undefined}
          projects={state.projects}
          jobs={jobsByObjective[openObjective.id] ?? []}
          config={state.config}
          now={now}
          onOpenJob={open}
          onClose={close(() => setOpenObjectiveId(null))}
          onError={setToast}
          confirm={confirm}
        />
      )}
      {openJob && (
        <JobDetail
          job={openJob}
          project={projectsById[openJob.projectId]}
          events={state.events[openJob.id] ?? []}
          now={now}
          vaultLink={vaultLinkOf(openJob.vaultNote)}
          target={openJob.targetJobId ? state.jobs[openJob.targetJobId] : null}
          onOpenJob={open}
          onClose={close(() => setOpenId(null))}
          onAction={(a) => request(openJob, a)}
        />
      )}
      {creating === 'job' && (
        <NewJob
          projects={state.projects}
          agents={state.agents}
          defaultProject={projectFilter || null}
          onClose={close(() => setCreating(null))}
          onCreated={() => {
            setCreating(null);
            setTab('running');
          }}
        />
      )}
      {creating === 'objective' && (
        <NewObjective
          projects={state.projects}
          defaultProject={projectFilter || null}
          onClose={close(() => setCreating(null))}
          onCreated={(o) => {
            setCreating(null);
            setOpenObjectiveId(o.id);
          }}
        />
      )}
      {settings && <Aparelhos sistema={state.sistema} onClose={close(() => setSettings(false))} onError={setToast} onLoggedOut={props.onLoggedOut} confirm={confirm} />}
      {pending && (
        <Confirm
          message={pending.message}
          onNo={() => setPending(null)}
          onYes={() => {
            pending.run().catch((e) => setToast(e.message));
            setPending(null);
          }}
        />
      )}
      <PlayerBar />
      {toast && (
        <div className="toast" role="alert" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}
