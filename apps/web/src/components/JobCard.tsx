import type { Job, JobEvent, Project } from '../../../../packages/shared/types.ts';
import { AgentMark } from './AgentMark.tsx';
import { KIND_LABEL, actionsFor, type JobAction } from './JobActions.tsx';
import { formatDuration, formatTime } from '../api.ts';
import { ContextBar } from './Agentes.tsx';

export const STATUS_LABEL: Record<Job['status'], string> = {
  queued: 'Na fila',
  approval: 'Aprovar início',
  running: 'Rodando',
  reviewing: 'Em revisão cruzada',
  review: 'Decisão sua',
  done: 'Concluído',
  failed: 'Falhou',
  canceled: 'Cancelado',
};

export const AGENT_LABEL = { claude: 'Claude', codex: 'Codex', openclaw: 'OpenClaw', hermes: 'Hermes' } as const;

export function jobDuration(job: Job, now: number): string | null {
  if (!job.startedAt) return null;
  const end = job.finishedAt && job.status !== 'running' ? Date.parse(job.finishedAt) : now;
  return formatDuration(end - Date.parse(job.startedAt));
}

export function JobCard(props: {
  job: Job;
  project?: Project;
  objectiveTitle?: string;
  events: JobEvent[];
  now: number;
  vaultLink?: string | null;
  onOpen(): void;
  onAction(action: JobAction): void;
}) {
  const { job, project, events, now } = props;
  const duration = jobDuration(job, now);
  const tail = job.status === 'running' ? events.filter((e) => e.kind !== 'status').slice(-3) : [];
  const kind = KIND_LABEL[job.kind];
  const buttons = actionsFor(job);
  return (
    <article className={`job-card status-${job.status}`}>
      <button className="job-card-main" onClick={props.onOpen} aria-label={`Abrir ${job.title}`}>
        <div className="job-card-head">
          <AgentMark id={job.kind === 'plan' ? 'rocky' : job.agent} size={28} />
          <span className="job-agent">{job.kind === 'plan' ? 'Planejador' : AGENT_LABEL[job.agent]}</span>
          <span className="job-project">{project?.name ?? job.projectId}</span>
          {kind && <span className={`kind kind-${job.kind}`}>{kind}</span>}
          {job.risk !== 'verde' && <span className={`risk risk-${job.risk}`}>{job.risk.toUpperCase()}</span>}
        </div>
        <h3 className="job-title">{job.title}</h3>
        {props.objectiveTitle && <div className="job-objective">Objetivo: {props.objectiveTitle}</div>}
        <div className="job-meta">
          <span className={`pill pill-${job.status}`}>{STATUS_LABEL[job.status]}</span>
          <span>{job.startedAt ? `início ${formatTime(job.startedAt)}` : `criado ${formatTime(job.createdAt)}`}</span>
          {duration && <span className="mono">{duration}</span>}
          {job.filesChanged.length > 0 && <span>{job.filesChanged.length} arquivo(s)</span>}
          {job.status === 'running' && <ContextBar u={job.usage} compact />}
          {job.verdict && <span className={`verdict verdict-${job.verdict}`}>{job.verdict.toUpperCase()}</span>}
        </div>
        {job.step && <div className="job-step">{job.step}</div>}
        {job.error && (job.status === 'failed' || job.status === 'review') && <div className="job-error">{job.error}</div>}
        {tail.length > 0 && (
          <ol className="mini-log" aria-label="Log ao vivo">
            {tail.map((e) => (
              <li key={e.id} className={`ev-${e.kind}`}>
                {e.text}
              </li>
            ))}
          </ol>
        )}
      </button>
      {(buttons.length > 0 || props.vaultLink) && (
        <div className="job-actions">
          {buttons.map((a) => (
            <button key={a.action} className={`btn ${a.primary ? 'btn-primary' : ''} ${a.danger ? 'btn-danger' : ''}`} onClick={() => props.onAction(a.action)}>
              {a.label}
            </button>
          ))}
          {props.vaultLink && (
            <a className="btn btn-link" href={props.vaultLink}>
              Abrir nota no vault
            </a>
          )}
        </div>
      )}
    </article>
  );
}
