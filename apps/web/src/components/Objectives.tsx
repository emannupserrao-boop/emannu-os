import { useEffect, useMemo, useState } from 'react';
import type { ClientConfig, Job, Objective, ObjectiveStatus, Project, RunnableAgent } from '../../../../packages/shared/types.ts';
import { projectsForNewJobs } from '../../../../packages/shared/projects.ts';
import { AgentMark } from './AgentMark.tsx';
import { AGENT_LABEL, STATUS_LABEL, jobDuration } from './JobCard.tsx';
import { actions, formatTime, obsidianLink } from '../api.ts';
import { X } from 'lucide-react';

export const OBJECTIVE_LABEL: Record<ObjectiveStatus, string> = {
  proposed: 'Proposto — começar?',
  planning: 'Planejador trabalhando',
  plan_ready: 'Aprovar plano',
  running: 'Em execução',
  attention: 'Precisa de você',
  ready: 'Aprovar entrega',
  done: 'Concluído',
  failed: 'Falhou',
  canceled: 'Cancelado',
};

const PILL: Record<ObjectiveStatus, string> = {
  proposed: 'review', planning: 'running', plan_ready: 'review', running: 'running', attention: 'review',
  ready: 'review', done: 'done', failed: 'failed', canceled: 'canceled',
};

function progress(o: Objective, jobs: Job[]) {
  const total = o.plan?.items.length ?? 0;
  const latest = new Map<string, Job>();
  for (const j of jobs) if (j.kind === 'task' && j.planKey) latest.set(j.planKey, j);
  const done = [...latest.values()].filter((j) => j.status === 'done').length;
  return { total, done };
}

export function ObjectiveCard(props: { objective: Objective; project?: Project; jobs: Job[]; onOpen(): void }) {
  const o = props.objective;
  const { total, done } = progress(o, props.jobs);
  const active = props.jobs.filter((j) => j.status === 'running');
  return (
    <article className={`job-card objective-card ostatus-${o.status}`}>
      <button className="job-card-main" onClick={props.onOpen} aria-label={`Abrir objetivo ${o.title}`}>
        <div className="job-card-head">
          <AgentMark id="rocky" size={28} />
          <span className="job-agent">Objetivo</span>
          <span className="job-project">{props.project?.name ?? 'sem projeto'}</span>
          {o.source === 'inbox' && <span className="kind kind-plan">INBOX</span>}
        </div>
        <h3 className="job-title">{o.title}</h3>
        <div className="job-meta">
          <span className={`pill pill-${PILL[o.status]}`}>{OBJECTIVE_LABEL[o.status]}</span>
          {total > 0 && (
            <span>
              {done}/{total} job(s)
            </span>
          )}
          <span>criado {formatTime(o.createdAt)}</span>
        </div>
        {total > 0 && (
          <div className="progress" aria-hidden>
            <span style={{ width: `${(done / total) * 100}%` }} />
          </div>
        )}
        {active.length > 0 && <div className="job-step">Agora: {active.map((j) => `${j.title} (${AGENT_LABEL[j.agent]})`).join(' · ')}</div>}
        {o.error && <div className="job-error">{o.error}</div>}
      </button>
    </article>
  );
}

function JobLine({ job, now, onOpen, depth = 0 }: { job: Job; now: number; onOpen(id: string): void; depth?: number }) {
  const label = job.kind === 'review' ? `Revisão pelo ${AGENT_LABEL[job.agent]}` : job.kind === 'fix' ? `Correção pelo ${AGENT_LABEL[job.agent]}` : `${job.title}`;
  return (
    <li className={`tl-item depth-${depth}`}>
      <button className="tl-button" onClick={() => onOpen(job.id)}>
        <AgentMark id={job.kind === 'plan' ? 'rocky' : job.agent} size={22} />
        <span className="tl-label">{label}</span>
        <span className={`pill pill-${job.status}`}>{job.verdict ? job.verdict.toUpperCase() : STATUS_LABEL[job.status]}</span>
        {jobDuration(job, now) && <span className="mono tl-dur">{jobDuration(job, now)}</span>}
      </button>
    </li>
  );
}

export function ObjectiveDetail(props: {
  objective: Objective;
  project?: Project;
  projects: Project[];
  jobs: Job[];
  config: ClientConfig;
  now: number;
  onOpenJob(id: string): void;
  onClose(): void;
  onError(msg: string): void;
  confirm(message: string, run: () => Promise<unknown>): void;
}) {
  const o = props.objective;
  const [agents, setAgents] = useState<Record<string, RunnableAgent>>({});
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const projects = projectsForNewJobs(props.projects);
  const [projectId, setProjectId] = useState(projects.find((p) => p.id === o.projectId)?.id ?? projects.find((p) => p.isGit && !p.isTest)?.id ?? '');
  const [showContext, setShowContext] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]);

  const run = (p: Promise<unknown>) => p.catch((e) => props.onError(e.message));
  const planJob = props.jobs.find((j) => j.id === o.planJobId);
  const byTarget = useMemo(() => {
    const m = new Map<string, Job[]>();
    for (const j of props.jobs) if (j.targetJobId) m.set(j.targetJobId, [...(m.get(j.targetJobId) ?? []), j]);
    return m;
  }, [props.jobs]);
  const tasksByKey = (key: string) => props.jobs.filter((j) => j.kind === 'task' && j.planKey === key);
  const agentOf = (key: string, fallback: RunnableAgent) => agents[key] ?? fallback;

  return (
    <div className="drawer-backdrop" onClick={props.onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={o.title} onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <AgentMark id="rocky" size={36} />
          <div className="drawer-title">
            <h2>{o.title}</h2>
            <div className="job-meta">
              <span className={`pill pill-${PILL[o.status]}`}>{OBJECTIVE_LABEL[o.status]}</span>
              <span>{props.project?.name ?? 'sem projeto'}</span>
              <span>criado {formatTime(o.createdAt)}</span>
            </div>
          </div>
          <button className="btn btn-icon btn-ghost" onClick={props.onClose} aria-label="Fechar">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>

        <div className="drawer-body">
          <section>
            <h4>Objetivo</h4>
            <p className="prompt">{o.description}</p>
            {o.sourcePath && <p className="hint">Veio do vault: {o.sourcePath}</p>}
          </section>

          {o.error && (
            <section>
              <h4>Erro</h4>
              <p className="job-error">{o.error}</p>
            </section>
          )}

          {o.status === 'proposed' && (
            <section>
              <h4>Começar</h4>
              <label className="field">
                <span>Projeto</span>
                <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.isGit}>
                      {p.name}
                      {p.isGit ? '' : ' (sem git)'}
                    </option>
                  ))}
                </select>
              </label>
            </section>
          )}

          {o.status === 'planning' && (
            <section>
              <h4>Plano</h4>
              <p className="hint">O Planejador está lendo o projeto e montando o plano…</p>
              {planJob && (
                <ol className="timeline">
                  <JobLine job={planJob} now={props.now} onOpen={props.onOpenJob} />
                </ol>
              )}
            </section>
          )}

          {o.plan && o.status === 'plan_ready' && (
            <section>
              <h4>Plano do Planejador</h4>
              {o.plan.summary && <p className="prompt">{o.plan.summary}</p>}
              <ol className="plan">
                {o.plan.items.map((it) => (
                  <li key={it.key} className="plan-item">
                    <div className="plan-head">
                      <span className="mono plan-key">{it.key}</span>
                      <strong>{it.title}</strong>
                      {it.risk !== 'verde' && <span className={`risk risk-${it.risk}`}>{it.risk.toUpperCase()}</span>}
                    </div>
                    <p>{it.task}</p>
                    {it.acceptance && (
                      <p className="hint">
                        <b>Aceite:</b> {it.acceptance}
                      </p>
                    )}
                    <p className="hint">
                      {it.kind} · ~{it.minutes} min{it.dependsOn.length ? ` · depois de ${it.dependsOn.join(', ')}` : ''}
                    </p>
                    <div className="segmented" role="radiogroup" aria-label={`Agente de ${it.title}`}>
                      {(['claude', 'codex'] as const).map((a) => (
                        <label key={a} className={agentOf(it.key, it.agent) === a ? 'on' : ''}>
                          <input type="radio" name={`agent-${it.key}`} checked={agentOf(it.key, it.agent) === a} onChange={() => setAgents({ ...agents, [it.key]: a })} />
                          {AGENT_LABEL[a]}
                          {a === it.agent ? ' (sugerido)' : ''}
                        </label>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
              {o.plan.manual.length > 0 && (
                <>
                  <h4>Ações manuais suas (VERMELHO)</h4>
                  <ul className="files">
                    {o.plan.manual.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                </>
              )}
              {showFeedback && (
                <label className="field">
                  <span>O que mudar no plano?</span>
                  <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={3} autoFocus />
                </label>
              )}
            </section>
          )}

          {o.plan && !['plan_ready', 'planning', 'proposed'].includes(o.status) && (
            <section>
              <h4>Linha do tempo</h4>
              <ol className="timeline">
                {planJob && <JobLine job={planJob} now={props.now} onOpen={props.onOpenJob} />}
                {o.plan.items.map((it) => (
                  <li key={it.key} className="tl-group">
                    <div className="tl-group-title">
                      <span className="mono plan-key">{it.key}</span> {it.title}
                      {it.dependsOn.length > 0 && <span className="hint"> · depois de {it.dependsOn.join(', ')}</span>}
                    </div>
                    <ol className="timeline">
                      {tasksByKey(it.key).length === 0 && <li className="hint">Ainda não criado.</li>}
                      {tasksByKey(it.key).map((t) => (
                        <TaskChain key={t.id} task={t} followUps={byTarget.get(t.id) ?? []} now={props.now} onOpen={props.onOpenJob} />
                      ))}
                    </ol>
                  </li>
                ))}
                <li className="tl-group">
                  <div className="tl-group-title">Entrega</div>
                  <p className="hint">
                    {o.status === 'ready'
                      ? 'Todos os jobs aprovados na revisão cruzada. Falta o seu merge final.'
                      : o.status === 'done'
                        ? `Concluído em ${formatTime(o.finishedAt)}.`
                        : 'Aguardando os jobs.'}
                  </p>
                  {o.summary && (o.status === 'ready' || o.status === 'done') && <pre className="diff">{o.summary}</pre>}
                </li>
              </ol>
              {o.plan.manual.length > 0 && (
                <>
                  <h4>Ações manuais suas (VERMELHO)</h4>
                  <ul className="files">
                    {o.plan.manual.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}

          {o.contextPack && (
            <section>
              <button className="btn btn-small" onClick={() => setShowContext(!showContext)}>
                {showContext ? 'Esconder' : 'Ver'} contexto enviado aos agentes
              </button>
              {showContext && <pre className="diff">{o.contextPack}</pre>}
            </section>
          )}
        </div>

        <footer className="drawer-actions">
          {o.vaultNote && props.config.vaultName && (
            <a className="btn btn-link" href={obsidianLink(props.config, o.vaultNote)}>
              Abrir nota no vault
            </a>
          )}
          {!['done', 'canceled'].includes(o.status) && (
            <button className="btn btn-danger" onClick={() => props.confirm(`Cancelar o objetivo "${o.title}"? Jobs em andamento serão encerrados.`, () => actions.cancelObjective(o.id))}>
              Cancelar objetivo
            </button>
          )}
          {o.status === 'proposed' && (
            <button className="btn btn-primary" disabled={!projectId} onClick={() => run(actions.planObjective(o.id, { projectId }))}>
              Planejar com o Planejador
            </button>
          )}
          {o.status === 'failed' && (
            <button className="btn btn-primary" onClick={() => run(actions.planObjective(o.id))}>
              Refazer plano
            </button>
          )}
          {o.status === 'plan_ready' && (
            <>
              {showFeedback ? (
                <button className="btn" disabled={!feedback.trim()} onClick={() => run(actions.planObjective(o.id, { feedback }))}>
                  Enviar ajustes ao Planejador
                </button>
              ) : (
                <button className="btn" onClick={() => setShowFeedback(true)}>
                  Pedir ajustes
                </button>
              )}
              <button className="btn btn-primary" onClick={() => props.confirm(`Aprovar o plano com ${o.plan!.items.length} job(s)? Os jobs VERDES vão rodar sozinhos.`, () => actions.approvePlan(o.id, agents))}>
                Aprovar plano
              </button>
            </>
          )}
          {o.status === 'ready' && (
            <button className="btn btn-primary" onClick={() => props.confirm(`Fazer o merge final de "${o.title}" no projeto ${props.project?.name ?? ''} e atualizar o Current State?`, () => actions.approveDelivery(o.id))}>
              Aprovar merge final
            </button>
          )}
        </footer>
      </aside>
    </div>
  );
}

function TaskChain({ task, followUps, now, onOpen }: { task: Job; followUps: Job[]; now: number; onOpen(id: string): void }) {
  return (
    <>
      <JobLine job={task} now={now} onOpen={onOpen} />
      {followUps.map((c) => (
        <JobLine key={c.id} job={c} now={now} onOpen={onOpen} depth={1} />
      ))}
      {task.status === 'review' && task.step && <li className="tl-item depth-1 hint">⚠ {task.step}</li>}
    </>
  );
}

export function NewObjective(props: { projects: Project[]; defaultProject: string | null; onClose(): void; onCreated(o: Objective): void }) {
  const gitProjects = projectsForNewJobs(props.projects).filter((p) => p.isGit);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState(
    (props.defaultProject && gitProjects.some((p) => p.id === props.defaultProject) ? props.defaultProject : null) ?? gitProjects.find((p) => !p.isTest)?.id ?? gitProjects[0]?.id ?? '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      props.onCreated(await actions.createObjective({ title, description, projectId }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drawer-backdrop" onClick={props.onClose}>
      <form className="drawer form" role="dialog" aria-modal="true" aria-label="Novo objetivo" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <AgentMark id="rocky" size={36} />
          <div className="drawer-title">
            <h2>Novo objetivo</h2>
            <div className="hint">O Planejador (Claude) monta um plano; você aprova; os agentes executam e revisam um ao outro.</div>
          </div>
          <button type="button" className="btn btn-icon btn-ghost" onClick={props.onClose} aria-label="Fechar">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>
        <div className="drawer-body">
          <label className="field">
            <span>Título</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: Mapa técnico do código" required autoFocus />
          </label>
          <label className="field">
            <span>O que você quer (pode ser em texto livre)</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={7} placeholder="Explique o resultado esperado. O Rocky lê o projeto e quebra em jobs." required />
          </label>
          <label className="field">
            <span>Projeto (precisa ter git)</span>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} required>
              {gitProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="job-error">{error}</p>}
        </div>
        <footer className="drawer-actions">
          <button type="button" className="btn" onClick={props.onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !projectId}>
            {busy ? 'Enviando…' : 'Pedir plano ao Planejador'}
          </button>
        </footer>
      </form>
    </div>
  );
}
