// Decide quais mudanças viram notificação no celular. Avisa só o que importa:
// "Aguardando você", job concluído/falhou, plano/entrega prontos e fila pausada.
import type { Job, Objective } from '../../../packages/shared/types.ts';
import type { Scheduler } from './scheduler.ts';
import type { PushPayload } from './push.ts';

export function jobNotification(job: Job, prev: Job['status'] | undefined): PushPayload | null {
  if (prev === job.status) return null;
  const url = `/?job=${job.id}`;
  const tag = `job-${job.id}`;
  if (job.kind === 'task') {
    if (job.status === 'approval') return { title: 'Aguardando você: aprovar início', body: job.title, url, tag };
    if (job.status === 'review') return { title: 'Aguardando você', body: `${job.title} — ${job.step ?? 'decisão sua'}`, url, tag };
    if (job.status === 'failed') return { title: 'Job falhou', body: `${job.title}${job.error ? ` — ${job.error.slice(0, 120)}` : ''}`, url, tag };
    // Jobs de objetivo concluídos são avisados na entrega do objetivo.
    if (job.status === 'done' && !job.objectiveId && prev && prev !== 'review') return { title: 'Job concluído', body: job.title, url, tag };
  }
  if (job.kind === 'research' && job.status === 'failed') return { title: 'Pesquisa falhou', body: job.title, url, tag };
  return null;
}

const OBJECTIVE_MESSAGES: Partial<Record<Objective['status'], string>> = {
  proposed: 'Novo objetivo do INBOX — começar?',
  plan_ready: 'Plano do Planejador pronto — aprovar?',
  attention: 'Objetivo precisa de você',
  ready: 'Entrega pronta — aprovar o merge final?',
  failed: 'Objetivo falhou',
};

export function objectiveNotification(o: Objective, prev: Objective['status'] | undefined): PushPayload | null {
  if (prev === o.status) return null;
  const title = OBJECTIVE_MESSAGES[o.status];
  return title ? { title, body: o.title, url: `/?objetivo=${o.id}`, tag: `obj-${o.id}` } : null;
}

// Liga os eventos do agendador ao envio. "send" pode ser trocado nos testes.
export function wireNotifications(sched: Scheduler, send: (p: PushPayload) => unknown): void {
  const jobStatus = new Map<string, Job['status']>();
  const objStatus = new Map<string, Objective['status']>();
  for (const j of sched.store.listJobs(1000)) jobStatus.set(j.id, j.status);
  for (const o of sched.store.listObjectives(500)) objStatus.set(o.id, o.status);

  sched.on('job', (job: Job) => {
    const p = jobNotification(job, jobStatus.get(job.id));
    jobStatus.set(job.id, job.status);
    if (p) send(p);
  });
  sched.on('objective', (o: Objective) => {
    const p = objectiveNotification(o, objStatus.get(o.id));
    objStatus.set(o.id, o.status);
    if (p) send(p);
  });
  sched.on('notify', (n: any) => {
    if (n?.kind === 'gpu-cliente') send({ title: 'Posso usar a GPU?', body: n.text, url: `/?job=${n.job.id}`, tag: `gpu-${n.job.id}` });
    if (n?.kind === 'paused') send({ title: `Fila do ${n.agent === 'codex' ? 'Codex' : 'Claude'} pausada`, body: 'Limite de uso atingido. Toque em "Retomar" quando liberar.', url: '/', tag: `paused-${n.agent}` });
  });
}
