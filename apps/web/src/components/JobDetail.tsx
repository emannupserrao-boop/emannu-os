import { useEffect, useRef, useState } from 'react';
import type { Job, JobEvent, Project } from '../../../../packages/shared/types.ts';
import { AgentMark } from './AgentMark.tsx';
import { KIND_LABEL, actionsFor, type JobAction } from './JobActions.tsx';
import { STATUS_LABEL, jobDuration } from './JobCard.tsx';
import { actions, formatTime } from '../api.ts';
import { X } from 'lucide-react';
import { ContextBar, TokenLine } from './Agentes.tsx';

const EVENT_LABEL: Record<JobEvent['kind'], string> = {
  status: 'status',
  system: 'sistema',
  text: 'agente',
  tool: 'ação',
  output: 'saída',
  result: 'resultado',
  warning: 'aviso',
  error: 'erro',
  stderr: 'stderr',
};

export function JobDetail(props: {
  job: Job;
  project?: Project;
  events: JobEvent[];
  now: number;
  vaultLink?: string | null;
  target?: Job | null;
  onOpenJob(id: string): void;
  onClose(): void;
  onAction(action: JobAction): void;
}) {
  const { job, project, events, now } = props;
  const logRef = useRef<HTMLOListElement>(null);
  const [follow, setFollow] = useState(true);
  const [diff, setDiff] = useState<{ stat: string; diff: string; truncated: boolean } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

  useEffect(() => {
    if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [events.length, follow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]);

  const loadDiff = async () => {
    setDiffError(null);
    try {
      setDiff(await actions.diff(job.id));
    } catch (e: any) {
      setDiffError(e.message);
    }
  };

  return (
    <div className="drawer-backdrop" onClick={props.onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={job.title} onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <AgentMark id={job.kind === 'plan' ? 'rocky' : job.agent} size={36} />
          <div className="drawer-title">
            <h2>{job.title}</h2>
            <div className="job-meta">
              {KIND_LABEL[job.kind] && <span className={`kind kind-${job.kind}`}>{KIND_LABEL[job.kind]}</span>}
              <span className={`pill pill-${job.status}`}>{STATUS_LABEL[job.status]}</span>
              {job.verdict && <span className={`verdict verdict-${job.verdict}`}>{job.verdict.toUpperCase()}</span>}
              <span>{project?.name ?? job.projectId}</span>
              <span>início {formatTime(job.startedAt)}</span>
              {jobDuration(job, now) && <span className="mono">{jobDuration(job, now)}</span>}
            </div>
          </div>
          <button className="btn btn-icon btn-ghost" onClick={props.onClose} aria-label="Fechar">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>

        <div className="drawer-body">
          {props.target && (
            <section>
              <h4>{job.kind === 'review' ? 'Trabalho revisado' : 'Trabalho corrigido'}</h4>
              <button className="btn btn-small" onClick={() => props.onOpenJob(props.target!.id)}>
                {props.target.title} ({props.target.agent === 'claude' ? 'Claude' : 'Codex'})
              </button>
            </section>
          )}

          <section>
            <h4>{job.kind === 'plan' ? 'Objetivo' : 'Tarefa'}</h4>
            <p className="prompt">{job.prompt}</p>
          </section>

          {job.acceptance && (
            <section>
              <h4>{job.kind === 'plan' ? 'Ajustes pedidos ao plano' : 'Critério de aceite'}</h4>
              <p className="prompt">{job.acceptance}</p>
            </section>
          )}

          {job.summary && (
            <section>
              <h4>{job.kind === 'review' ? 'Parecer do revisor' : job.kind === 'plan' ? 'Resposta do Planejador' : 'Resumo do agente'}</h4>
              <p className="prompt">{job.summary}</p>
            </section>
          )}

          {job.error && (
            <section>
              <h4>Erro</h4>
              <p className="job-error">{job.error}</p>
            </section>
          )}

          <section>
            <div className="section-head">
              <h4>Log ao vivo</h4>
              <label className="follow">
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> seguir
              </label>
            </div>
            <ol className="log" ref={logRef}>
              {events.length === 0 && <li className="ev-system">Sem eventos ainda.</li>}
              {events.map((e) => (
                <li key={e.id} className={`ev-${e.kind}`}>
                  <span className="log-time">{new Date(e.ts).toLocaleTimeString('pt-BR')}</span>
                  <span className="log-kind">{EVENT_LABEL[e.kind]}</span>
                  <span className="log-text">{e.text}</span>
                </li>
              ))}
            </ol>
          </section>

          {(job.filesChanged.length > 0 || job.worktree) && (
            <section>
              <div className="section-head">
                <h4>Arquivos alterados ({job.filesChanged.length})</h4>
                {job.worktree && (
                  <button className="btn btn-small" onClick={loadDiff}>
                    {diff ? 'Atualizar diff' : 'Ver diff'}
                  </button>
                )}
              </div>
              <ul className="files">
                {job.filesChanged.map((f) => (
                  <li key={f} className="mono">
                    {f}
                  </li>
                ))}
              </ul>
              {diffError && <p className="job-error">{diffError}</p>}
              {diff && (
                <pre className="diff">
                  {diff.diff.split('\n').map((l, i) => (
                    <span key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>
                      {l + '\n'}
                    </span>
                  ))}
                  {diff.truncated && <span className="hunk">… diff cortado (muito grande)</span>}
                </pre>
              )}
            </section>
          )}

          {job.usage ? (
            <section>
              <h4>Contexto e tokens{job.usage.model ? ` · ${job.usage.model}` : ''}</h4>
              <ContextBar u={job.usage} />
              <TokenLine u={job.usage} />
            </section>
          ) : (
            job.startedAt && (
              <section>
                <h4>Contexto e tokens</h4>
                <p className="hint">Desconhecido: o agente não informou o uso nesta execução (não é zero).</p>
              </section>
            )
          )}

          <section className="tech">
            <h4>Detalhes técnicos</h4>
            <dl>
              <dt>Job</dt>
              <dd className="mono">{job.id}</dd>
              <dt>Sessão</dt>
              <dd className="mono">{job.sessionId ?? '—'}</dd>
              <dt>Worktree</dt>
              <dd className="mono">{job.worktree ?? '—'}</dd>
              <dt>Branch</dt>
              <dd className="mono">{job.branch ?? '—'}</dd>
              <dt>Risco</dt>
              <dd>{job.risk.toUpperCase()}</dd>
              <dt>Tempo limite</dt>
              <dd>{job.timeoutMin} min</dd>
            </dl>
          </section>
        </div>

        <footer className="drawer-actions">
          {props.vaultLink && (
            <a className="btn btn-link" href={props.vaultLink}>
              Abrir nota no vault
            </a>
          )}
          {actionsFor(job).map((a) => (
            <button key={a.action} className={`btn ${a.primary ? 'btn-primary' : ''} ${a.danger ? 'btn-danger' : ''}`} onClick={() => props.onAction(a.action)}>
              {a.label}
            </button>
          ))}
        </footer>
      </aside>
    </div>
  );
}
