import type { Job } from '../../../../packages/shared/types.ts';

export type JobAction = 'approve' | 'cancel' | 'retry' | 'discard' | 'requestReview';

type ActionButton = { action: JobAction; label: string; primary?: boolean; danger?: boolean };

export function actionsFor(job: Job): ActionButton[] {
  const isTask = job.kind === 'task';
  switch (job.status) {
    case 'approval':
      return [{ action: 'approve', label: 'Aprovar e rodar', primary: true }, { action: 'cancel', label: 'Cancelar' }];
    case 'queued':
      return [{ action: 'cancel', label: 'Cancelar' }];
    case 'running':
      return [{ action: 'cancel', label: 'Cancelar', danger: true }];
    case 'reviewing':
      return [];
    case 'review': {
      const buttons: ActionButton[] = [{ action: 'approve', label: job.objectiveId ? 'Aprovar e integrar' : 'Aprovar merge', primary: true }];
      if (job.worktree) buttons.push({ action: 'requestReview', label: 'Pedir revisão cruzada' });
      buttons.push({ action: 'discard', label: 'Descartar', danger: true });
      return buttons;
    }
    case 'done':
      return isTask && !job.objectiveId ? [{ action: 'retry', label: 'Reexecutar' }] : [];
    case 'failed':
    case 'canceled':
      return [{ action: 'retry', label: 'Reexecutar', primary: true }, ...(isTask && job.worktree ? [{ action: 'discard' as const, label: 'Limpar worktree' }] : [])];
  }
}

// Ações AMARELAS (ou destrutivas) pedem confirmação no app.
export function confirmationFor(job: Job, action: JobAction): string | null {
  if (action === 'approve' && job.status === 'review' && job.objectiveId) return `Integrar "${job.title}" no branch do objetivo? O merge no projeto ainda vai pedir sua aprovação no fim.`;
  if (action === 'approve' && job.status === 'review') return `Fazer merge das mudanças de "${job.title}" no projeto? (${job.filesChanged.length} arquivo(s))`;
  if (action === 'approve' && job.status === 'approval') return `Aprovar "${job.title}" para rodar? É um job AMARELO.`;
  if (action === 'discard') return `Descartar as mudanças de "${job.title}"? O worktree será apagado.`;
  if (action === 'cancel' && job.status === 'running') return `Cancelar "${job.title}"? O processo do agente será encerrado.`;
  return null;
}

export const KIND_LABEL: Record<Job['kind'], string | null> = { task: null, plan: 'Plano', review: 'Revisão', fix: 'Correção', research: 'Pesquisa' };
