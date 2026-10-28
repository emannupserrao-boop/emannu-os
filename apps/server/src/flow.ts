// Regras de negócio do EMANNU OS:
// objetivo → plano do Rocky → sua aprovação → jobs com dependências →
// revisão cruzada pelo outro agente (até 2 correções) → entrega no vault → merge final (AMARELO).
import { join } from 'node:path';
import type { Job, NewObjectiveInput, Objective, Project, RunnableAgent } from '../../../packages/shared/types.ts';
import { RUNNABLE_AGENTS } from '../../../packages/shared/types.ts';
import type { Scheduler } from './scheduler.ts';
import { buildContextPack } from './context.ts';
import { MAX_FIX_ROUNDS, agentName, fixPrompt, otherAgent, parsePlan, parseVerdict, planPrompt, reviewPrompt, taskPrompt } from './prompts.ts';
import { changedFiles, commitAll, createWorktree, git, mergeBranchInto, mergeWorktree, removeWorktree, resolveBase, worktreeDiff } from './worktrees.ts';
import type { ReviewBinding } from './automerge.ts';

// Revisões por trabalho (contando invalidações por diff alterado) antes de subir para você.
const MAX_REVIEWS = 4;

export interface Outcome {
  ok: boolean;
  code: number | null;
  canceled: boolean;
  timedOut: boolean;
  // Resposta final do agente (resumo, plano ou parecer).
  text: string | null;
  error: string | null;
}

const REVIEW_DIFF_LIMIT = 40_000;
const excerpt = (s: string | null, n = 600) => (!s ? '' : s.length > n ? s.slice(0, n).trimEnd() + ' …' : s);
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

export class Flow {
  private contextCache = new Map<string, { at: number; text: string }>();
  private s: Scheduler;

  constructor(s: Scheduler) {
    this.s = s;
  }

  private get store() {
    return this.s.store;
  }

  private project(id: string): Project {
    const p = this.store.getProject(id);
    if (!p) throw new Error('Projeto não encontrado');
    return p;
  }

  private objectiveOf(job: Job): Objective | null {
    return job.objectiveId ? this.store.getObjective(job.objectiveId) : null;
  }

  // ======================= objetivos =======================

  createObjective(input: NewObjectiveInput): Objective {
    if (!input.title?.trim() || !input.description?.trim()) throw new Error('Título e descrição do objetivo são obrigatórios');
    this.project(input.projectId);
    const obj = this.store.createObjective({ title: input.title.trim(), description: input.description.trim(), projectId: input.projectId, status: 'planning' });
    this.s.emit('objective', obj);
    return this.startPlanning(obj.id);
  }

  // Cria (ou refaz) o job de planejamento do Rocky.
  startPlanning(id: string, opts: { projectId?: string; feedback?: string } = {}): Objective {
    let obj = this.mustObjective(id);
    if (!['proposed', 'plan_ready', 'failed', 'planning'].includes(obj.status)) throw new Error('Este objetivo já está em execução.');
    const projectId = opts.projectId ?? obj.projectId;
    if (!projectId) throw new Error('Escolha o projeto do objetivo.');
    const project = this.project(projectId);
    if (!project.isGit) throw new Error('Objetivos precisam de um projeto com git (para isolar e revisar cada job).');
    const contextPack = buildContextPack(project, this.s.vault);
    const job = this.s.enqueue({
      title: `Plano: ${obj.title}`,
      prompt: obj.description,
      acceptance: opts.feedback?.trim() || null,
      agent: 'claude',
      projectId,
      risk: 'verde',
      timeoutMin: 15,
      kind: 'plan',
      objectiveId: obj.id,
    });
    obj = this.s.setObjective(obj.id, { projectId, contextPack, planJobId: job.id, status: 'planning', plan: null, error: null });
    return obj;
  }

  // AMARELO: você aprova o plano (podendo trocar o agente de cada job).
  approvePlan(id: string, agents: Record<string, RunnableAgent> = {}): Objective {
    const obj = this.mustObjective(id);
    if (obj.status !== 'plan_ready' || !obj.plan) throw new Error('Não há plano pronto para aprovar.');
    const project = this.project(obj.projectId!);
    const wt = createWorktree(project.path, this.s.worktreesDir, project.name, `obj-${obj.id.replace(/^obj-/, '')}`, { branch: `obj/${obj.id.replace(/^obj-/, '')}` });
    const items = obj.plan.items.map((it) => ({ ...it, agent: RUNNABLE_AGENTS.includes(agents[it.key]) ? agents[it.key] : it.agent }));
    const updated = this.s.setObjective(id, {
      plan: { ...obj.plan, items },
      status: 'running',
      approvedAt: new Date().toISOString(),
      branch: wt.branch,
      worktree: wt.path,
      baseCommit: wt.base,
    });
    for (const it of items) {
      this.s.enqueue({
        title: it.title,
        prompt: it.task,
        acceptance: it.acceptance || null,
        agent: it.agent,
        projectId: project.id,
        risk: it.risk,
        timeoutMin: Math.max(15, Math.min(it.risk === 'amarelo' ? 120 : 45, it.minutes * 2)),
        kind: 'task',
        objectiveId: id,
        planKey: it.key,
        dependsOn: it.dependsOn,
      });
    }
    return updated;
  }

  cancelObjective(id: string): Objective {
    const obj = this.mustObjective(id);
    if (['done', 'canceled'].includes(obj.status)) return obj;
    const project = obj.projectId ? this.store.getProject(obj.projectId) : null;
    for (const j of this.store.jobsOfObjective(id)) {
      if (this.s.active.has(j.id)) {
        this.s.active.get(j.id)!.canceled = true;
        this.s.active.get(j.id)!.proc.kill();
      } else if (['queued', 'approval', 'reviewing', 'review'].includes(j.status)) {
        if (j.kind === 'task' && j.worktree && project) safe(() => removeWorktree(project.path, j.worktree!, j.branch));
        this.s.finish(j.id, { status: 'canceled', step: 'Objetivo cancelado', worktree: j.kind === 'task' ? null : j.worktree });
      }
    }
    if (obj.worktree && project) safe(() => removeWorktree(project.path, obj.worktree!, obj.branch));
    return this.s.setObjective(id, { status: 'canceled', worktree: null, finishedAt: new Date().toISOString() });
  }

  // AMARELO: merge do branch do objetivo no projeto + bloco datado no Current State.
  approveDelivery(id: string): Objective {
    const obj = this.mustObjective(id);
    if (obj.status !== 'ready') throw new Error('O objetivo ainda não está pronto para o merge final.');
    const project = this.project(obj.projectId!);
    let head = '';
    if (obj.worktree && obj.branch) head = mergeWorktree(project.path, obj.worktree, obj.branch, `Objetivo: ${obj.title}`);
    let currentState: string | null = null;
    if (this.s.vault?.exists() && project.vaultFolder && !project.isTest) {
      const jobs = this.latestTasks(obj);
      currentState = this.s.vault.appendCurrentState(
        project.vaultFolder,
        project.name,
        `Entrega: ${obj.title}`,
        [
          obj.plan?.summary ?? '',
          '',
          ...jobs.map((j) => `- ${j.title} (${agentName(j.agent)}): ${excerpt(j.summary, 200).replace(/\s+/g, ' ')}`),
          '',
          `Merge ${head ? `no commit \`${head}\`` : 'sem mudanças de código'}. Detalhes: [[${obj.vaultNote?.replace(/\.md$/, '') ?? ''}]]`,
        ].join('\n'),
      );
    }
    if (obj.vaultNote && this.s.vault?.exists()) {
      safe(() => this.s.vault!.appendToOwnNote(obj.vaultNote!, `## ${fmtDate(new Date().toISOString())} — Merge aprovado\n\nCommit \`${head || '—'}\` no projeto ${project.name}.${currentState ? ` Current State atualizado: [[${currentState.replace(/\.md$/, '')}]].` : ''}`));
    }
    return this.s.setObjective(id, { status: 'done', worktree: null, finishedAt: new Date().toISOString(), summary: `${obj.summary ?? ''}\n\nMerge: ${head || 'sem mudanças'}`.trim() });
  }

  // Entrega: todos os jobs aprovados → nota no vault → aguarda o merge final.
  private deliver(obj: Objective): void {
    const project = this.project(obj.projectId!);
    const tasks = this.latestTasks(obj);
    let stat = '';
    if (obj.worktree && obj.baseCommit) stat = safe(() => git(obj.worktree!, 'diff', '--stat', obj.baseCommit!, 'HEAD'), '');
    const summary = [
      `Plano: ${obj.plan?.summary ?? ''}`,
      ...tasks.map((j) => `- ${j.title} (${agentName(j.agent)}) — ${j.step ?? j.status}`),
      stat ? `\nMudanças:\n${stat}` : '\nSem mudanças de código.',
    ].join('\n');
    let vaultNote: string | null = null;
    if (this.s.vault?.exists() && !project.isTest) vaultNote = safe(() => this.writeObjectiveNote(obj, project, tasks, stat), null);
    this.s.setObjective(obj.id, { status: 'ready', summary, vaultNote });
    this.s.emit('notify', { kind: 'objective-ready', objective: this.store.getObjective(obj.id) });
  }

  // Situação do objetivo a partir do último job de cada item do plano.
  checkObjective(id: string | null): void {
    if (!id) return;
    const obj = this.store.getObjective(id);
    if (!obj || !['running', 'attention'].includes(obj.status) || !obj.plan) return;
    const tasks = this.latestTasks(obj);
    if (tasks.length === obj.plan.items.length && tasks.every((j) => j.status === 'done')) return this.deliver(obj);
    const needsYou = tasks.some((j) => ['failed', 'canceled', 'review'].includes(j.status));
    const status = needsYou ? 'attention' : 'running';
    if (status !== obj.status) this.s.setObjective(id, { status });
  }

  private latestTasks(obj: Objective): Job[] {
    const byKey = new Map<string, Job>();
    for (const j of this.store.jobsOfObjective(obj.id)) if (j.kind === 'task' && j.planKey) byKey.set(j.planKey, j);
    return (obj.plan?.items ?? []).map((it) => byKey.get(it.key)).filter((j): j is Job => !!j);
  }

  // ======================= ciclo de vida dos jobs =======================

  // Dependências do plano: só começa quando o último job de cada dependência está concluído.
  depsSatisfied(job: Job): boolean {
    if (!job.objectiveId || !job.dependsOn.length) return true;
    const obj = this.store.getObjective(job.objectiveId);
    if (!obj || obj.status === 'canceled') return false;
    const latest = new Map<string, Job>();
    for (const j of this.store.jobsOfObjective(job.objectiveId)) if (j.kind === 'task' && j.planKey) latest.set(j.planKey, j);
    return job.dependsOn.every((k) => latest.get(k)?.status === 'done');
  }

  // Revisões e correções usam o worktree do job revisado: um de cada vez.
  // Pastas sem git usam um lock por caminho.
  lockKey(job: Job): string | null {
    if ((job.kind === 'review' || job.kind === 'fix') && job.worktree) return `wt:${job.worktree.toLowerCase()}`;
    if (job.kind === 'plan' || job.kind === 'research') return null;
    const project = this.store.getProject(job.projectId);
    return project && !project.isGit ? `path:${project.path.toLowerCase()}` : null;
  }

  // Onde o job roda.
  prepare(job: Job): { cwd: string; worktree: string | null; branch: string | null; base: string | null } {
    const project = this.project(job.projectId);
    if (job.kind === 'research' && this.s.renda?.handles(job.planKey ?? '')) {
      return { cwd: this.s.renda.jobPath, worktree: null, branch: null, base: null };
    }
    if (job.kind === 'plan' || job.kind === 'research') return { cwd: project.path, worktree: null, branch: null, base: null };
    if (job.kind === 'review' || job.kind === 'fix') {
      if (!job.worktree) throw new Error('O worktree do trabalho revisado não existe mais.');
      return { cwd: job.worktree, worktree: job.worktree, branch: job.branch, base: job.baseCommit };
    }
    if (!project.isGit) return { cwd: project.path, worktree: null, branch: null, base: null };
    const obj = this.objectiveOf(job);
    const wt = createWorktree(project.path, this.s.worktreesDir, project.name, job.id, obj?.branch ? { startPoint: obj.branch } : {});
    return { cwd: wt.path, worktree: wt.path, branch: wt.branch, base: wt.base };
  }

  contextFor(job: Job): string {
    const obj = this.objectiveOf(job);
    if (obj?.contextPack) return obj.contextPack;
    const cached = this.contextCache.get(job.projectId);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.text;
    const text = buildContextPack(this.project(job.projectId), this.s.vault);
    this.contextCache.set(job.projectId, { at: Date.now(), text });
    return text;
  }

  // Cada pesquisa pertence a um módulo registrado explicitamente; identificador
  // desconhecido é rejeitado (antes caía na Imigração).
  private researchModule(job: Job) {
    const k = job.planKey ?? '';
    if (k.startsWith('historico:')) return this.s.history;
    if (k.startsWith('mercado:') && this.s.market?.handles(k)) return this.s.market;
    if (this.s.renda?.handles(k)) return this.s.renda;
    if (this.s.rocky?.handles(k)) return this.s.rocky;
    if (this.s.conselho?.handles(k)) return this.s.conselho;
    if (this.s.benchRunner?.handles(k)) return this.s.benchRunner;
    if (this.s.immigration?.handles(k)) return this.s.immigration;
    return null;
  }

  // Texto completo enviado ao agente.
  prompt(job: Job): string {
    if (job.kind === 'research') {
      const module = this.researchModule(job);
      if (!module) throw new Error(`Pesquisa desconhecida: "${job.planKey ?? ''}"`);
      return module.prompt(job);
    }
    const ctx = this.contextFor(job);
    if (job.kind === 'plan') return planPrompt(this.objectiveOf(job)!, ctx, job.acceptance ?? undefined);
    if (job.kind === 'task') return taskPrompt(job, ctx, this.objectiveOf(job), this.s.vault);
    const target = this.s.mustGet(job.targetJobId!);
    if (job.kind === 'review') {
      const project = this.project(job.projectId);
      const base = resolveBase(project.path, job.worktree!, job.baseCommit);
      let diff = worktreeDiff(job.worktree!, base).diff;
      if (diff.length > REVIEW_DIFF_LIMIT) diff = diff.slice(0, REVIEW_DIFF_LIMIT) + '\n… (diff cortado; veja o restante com git diff)';
      return reviewPrompt(target, job.agent, diff, base, ctx, this.s.vault);
    }
    const review = this.lastReview(target.id, 'reprovado');
    return fixPrompt(target, review ?? target, ctx, this.s.vault);
  }

  private lastReview(targetId: string, verdict?: string): Job | null {
    const reviews = this.store.jobsTargeting(targetId).filter((j) => j.kind === 'review' && (!verdict || j.verdict === verdict));
    return reviews.at(-1) ?? null;
  }

  // Decide o que acontece quando um job termina (ou é cancelado sem ter rodado).
  afterJob(job: Job, o: Outcome): Job {
    const routines = this.s.routines?.store;
    // Executor obsoleto (a execução da rotina foi retomada por outro job): nada é gravado.
    if (routines && job.routineRunId && !routines.isCurrent(job)) {
      return this.s.finish(job.id, { status: o.canceled ? 'canceled' : 'failed', error: 'Execução substituída por uma retomada: resultado descartado', summary: o.text, step: 'Resultado descartado' });
    }
    const result = this.dispatch(job, o);
    if (routines && job.routineRunId) routines.complete(result, result.status === 'done');
    return result;
  }

  private dispatch(job: Job, o: Outcome): Job {
    switch (job.kind) {
      case 'research': {
        // Pesquisas são de um módulo: "historico:<projeto>", "mercado:<região>" ou os tópicos da Imigração.
        const module = this.researchModule(job);
        if (module) return module.afterResearch(job, o);
        return this.s.finish(job.id, { status: 'failed', error: 'Nenhum módulo recebe esta pesquisa.' });
      }
      case 'plan':
        return this.afterPlan(job, o);
      case 'review':
        return this.afterReview(job, o);
      case 'fix':
        return this.afterFix(job, o);
      default:
        return this.afterTask(job, o);
    }
  }

  private afterPlan(job: Job, o: Outcome): Job {
    const obj = this.objectiveOf(job);
    if (o.canceled) {
      if (obj) this.s.setObjective(obj.id, { status: 'failed', error: 'Planejamento cancelado.' });
      return this.s.finish(job.id, { status: 'canceled', step: 'Cancelado' });
    }
    if (!o.ok) {
      if (obj) this.s.setObjective(obj.id, { status: 'failed', error: o.error ?? 'O planejamento falhou.' });
      return this.s.finish(job.id, { status: 'failed', error: o.error, summary: o.text, step: 'Falhou' });
    }
    try {
      const plan = parsePlan(o.text);
      if (obj) this.s.setObjective(obj.id, { plan, status: 'plan_ready', error: null });
      this.s.addEvent(job.id, 'status', `Plano com ${plan.items.length} job(s) — aguardando sua aprovação`);
      return this.s.finish(job.id, { status: 'done', step: `Plano pronto: ${plan.items.length} job(s)`, summary: o.text, exitCode: o.code });
    } catch (e: any) {
      if (obj) this.s.setObjective(obj.id, { status: 'failed', error: e.message });
      return this.s.finish(job.id, { status: 'failed', error: e.message, summary: o.text, step: 'Plano inválido' });
    }
  }

  private afterTask(job: Job, o: Outcome): Job {
    const project = this.project(job.projectId);
    let result: Job;
    if (o.canceled) {
      if (job.worktree) safe(() => removeWorktree(project.path, job.worktree!, job.branch));
      result = this.s.finish(job.id, { status: 'canceled', exitCode: o.code, step: job.startedAt ? 'Cancelado por você' : 'Cancelado antes de rodar', worktree: null, summary: o.text });
    } else if (!o.ok) {
      const files = job.worktree ? safe(() => changedFiles(job.worktree!, resolveBase(project.path, job.worktree!, job.baseCommit)), []) : [];
      result = this.s.finish(job.id, { status: 'failed', exitCode: o.code, error: o.error, step: o.timedOut ? 'Tempo esgotado' : 'Falhou', filesChanged: files, summary: o.text });
    } else if (!job.worktree) {
      // Pasta sem git: não há diff isolado nem merge.
      result = this.s.finish(job.id, { status: 'done', exitCode: o.code, step: 'Concluído (pasta sem git)', summary: o.text });
    } else {
      const base = resolveBase(project.path, job.worktree, job.baseCommit);
      const files = changedFiles(job.worktree, base);
      if (!files.length) {
        safe(() => removeWorktree(project.path, job.worktree!, job.branch));
        result = this.s.finish(job.id, { status: 'done', exitCode: o.code, step: 'Concluído sem alterar arquivos', worktree: null, summary: o.text });
      } else {
        commitAll(job.worktree, `${job.title} (job ${job.id}, ${job.agent})`);
        if (job.objectiveId || this.s.autoMerge.eligible(project)) {
          // Objetivo, ou projeto com auto-merge: revisão cruzada já; integração só com PASS no mesmo diff.
          this.s.setJob(job.id, { status: 'reviewing', exitCode: o.code, filesChanged: files, summary: o.text, finishedAt: new Date().toISOString() });
          result = this.createReview(this.s.mustGet(job.id));
        } else {
          this.s.addEvent(job.id, 'status', `Concluído com ${files.length} arquivo(s) alterado(s) — aguardando sua revisão do merge`);
          result = this.s.finish(job.id, { status: 'review', exitCode: o.code, step: 'Aguardando revisão do merge', filesChanged: files, summary: o.text });
        }
      }
    }
    if (!job.objectiveId && ['review', 'done'].includes(result.status)) this.writeJobNote(result);
    this.checkObjective(job.objectiveId);
    return this.s.mustGet(job.id);
  }

  private afterFix(fix: Job, o: Outcome): Job {
    const target = this.s.mustGet(fix.targetJobId!);
    if (!o.ok) {
      this.s.finish(fix.id, { status: o.canceled ? 'canceled' : 'failed', error: o.error, step: o.canceled ? 'Cancelado' : 'Falhou', summary: o.text });
      this.escalate(target, o.canceled ? 'Correção cancelada — decida' : `Correção falhou: ${o.error ?? ''}`);
      return this.s.mustGet(fix.id);
    }
    const project = this.project(target.projectId);
    commitAll(target.worktree!, `Correção ${target.attempt}: ${target.title} (job ${fix.id}, ${fix.agent})`);
    const files = changedFiles(target.worktree!, resolveBase(project.path, target.worktree!, target.baseCommit));
    this.s.finish(fix.id, { status: 'done', exitCode: o.code, step: 'Correção concluída — nova revisão', summary: o.text, filesChanged: files });
    this.s.setJob(target.id, { filesChanged: files, summary: o.text ?? target.summary });
    this.createReview(this.s.mustGet(target.id));
    return this.s.mustGet(fix.id);
  }

  private afterReview(review: Job, o: Outcome): Job {
    const target = this.s.mustGet(review.targetJobId!);
    if (!o.ok) {
      this.s.finish(review.id, { status: o.canceled ? 'canceled' : 'failed', error: o.error, step: o.canceled ? 'Cancelada' : 'Falhou', summary: o.text });
      this.escalate(target, o.canceled ? 'Revisão cancelada — decida' : `Revisão não terminou: ${o.error ?? ''}`);
      return this.s.mustGet(review.id);
    }
    const verdict = parseVerdict(o.text);
    const reviewer = agentName(review.agent);
    this.s.finish(review.id, { status: 'done', verdict, exitCode: o.code, step: `Veredito: ${verdict.toUpperCase()}`, summary: o.text });
    this.s.addEvent(target.id, 'status', `Revisão do ${reviewer}: ${verdict.toUpperCase()}`);

    if (verdict === 'aprovado') {
      // A aprovação vale só para o diff revisado (base, head e hash).
      const binding = this.s.store.kvGet<ReviewBinding>(`revisao.${review.id}`);
      const current = this.bindingOf(target);
      const bound = !!binding && !!current && binding.base === current.base && binding.head === current.head && binding.diffHash === current.diffHash;
      if (!bound) {
        this.s.addEvent(target.id, 'status', 'O diff mudou depois da revisão: aprovação invalidada, nova revisão pedida');
        if (this.store.jobsTargeting(target.id).filter((j) => j.kind === 'review').length >= MAX_REVIEWS) this.escalate(target, 'Diff mudou várias vezes depois da revisão — decida');
        else this.createReview(target);
      } else if (target.objectiveId) this.integrate(target, `Aprovado pelo ${reviewer} e integrado`);
      else if (this.s.autoMerge.eligible(this.project(target.projectId))) this.autoIntegrate(target, binding, reviewer);
      else this.s.finish(target.id, { status: 'review', step: `Aprovado na revisão cruzada (${reviewer}) — aguardando seu merge` }, { keepFinishedAt: true });
    } else if (verdict === 'reprovado' && target.attempt < MAX_FIX_ROUNDS) {
      const attempt = target.attempt + 1;
      this.s.setJob(target.id, { attempt, step: `Reprovado pelo ${reviewer} — correção ${attempt}/${MAX_FIX_ROUNDS}` });
      this.createFix(this.s.mustGet(target.id), review);
    } else if (verdict === 'reprovado') {
      this.escalate(target, `Reprovado ${MAX_FIX_ROUNDS + 1}x na revisão — decida`, excerpt(o.text, 800));
    } else {
      this.escalate(target, 'Revisão sem veredito claro — decida');
    }
    return this.s.mustGet(review.id);
  }

  // Sobe a decisão para você: o job fica em "Aguardando você".
  private escalate(target: Job, step: string, error: string | null = null): void {
    if (this.objectiveOf(target)?.status === 'canceled') {
      const project = this.project(target.projectId);
      if (target.worktree) safe(() => removeWorktree(project.path, target.worktree!, target.branch));
      this.s.finish(target.id, { status: 'canceled', step: 'Objetivo cancelado', worktree: null }, { keepFinishedAt: true });
      return;
    }
    this.s.finish(target.id, { status: 'review', step, error }, { keepFinishedAt: true });
    this.checkObjective(target.objectiveId);
  }

  // Integra um job aprovado no branch do objetivo (VERDE: não toca no branch principal).
  private integrate(job: Job, step: string): Job {
    const obj = this.objectiveOf(job)!;
    const project = this.project(job.projectId);
    try {
      const sha = mergeBranchInto(obj.worktree!, job.branch!, `${job.title} (job ${job.id})`);
      safe(() => removeWorktree(project.path, job.worktree!, job.branch));
      const done = this.s.finish(job.id, { status: 'done', step: `${step} (${sha})`, worktree: null, error: null }, { keepFinishedAt: true });
      this.checkObjective(obj.id);
      this.s.tick();
      return done;
    } catch (e: any) {
      this.escalate(job, 'Conflito ao integrar no objetivo — decida', e.message);
      return this.s.mustGet(job.id);
    }
  }

  // Base, head e hash completo do diff do trabalho (no worktree dele).
  private bindingOf(target: Job): ReviewBinding | null {
    if (!target.worktree || !target.branch) return null;
    try {
      const project = this.project(target.projectId);
      const base = resolveBase(project.path, target.worktree, target.baseCommit);
      return this.s.autoMerge.bind(target.worktree, base, git(target.worktree, 'rev-parse', 'HEAD'));
    } catch {
      return null;
    }
  }

  // Auto-merge (projeto elegível): o pipeline da seção 7; qualquer recusa sobe para você.
  private autoIntegrate(target: Job, binding: ReviewBinding | null, reviewer: string): void {
    const project = this.project(target.projectId);
    const r = this.s.autoMerge.integrate(project, target, binding, `${target.title} (job ${target.id}, ${target.agent})`);
    if (r.ok) {
      safe(() => removeWorktree(project.path, target.worktree!, target.branch));
      this.s.addEvent(target.id, 'status', `Integrado automaticamente (PASS do ${reviewer}, testes no candidato) — commit ${r.sha.slice(0, 10)}`);
      this.s.finish(target.id, { status: 'done', step: `Auto-merge (${r.sha.slice(0, 10)})`, worktree: null }, { keepFinishedAt: true });
      return;
    }
    if (r.newReview && this.store.jobsTargeting(target.id).filter((j) => j.kind === 'review').length < MAX_REVIEWS) {
      this.s.addEvent(target.id, 'status', r.reason);
      this.createReview(target);
      return;
    }
    this.escalate(target, r.amarelo ? `AMARELO: ${r.reason}` : `Auto-merge não concluído: ${r.reason}`);
  }

  // Jobs do Rocky ligados a um objetivo: revisões e correções herdam a ligação (orçamento)
  // e contam no teto de descendentes.
  private linked(target: Job): { planKey: string | null; blocked: boolean } {
    const planKey = target.planKey?.startsWith('rocky-obj:') ? target.planKey : null;
    return { planKey, blocked: !!planKey && !!this.s.rocky?.overLimit(planKey) };
  }

  private createReview(target: Job): Job {
    const reviewer = otherAgent(target.agent);
    const link = this.linked(target);
    if (link.blocked) {
      this.escalate(target, 'Objetivo chegou ao limite de 10 jobs (contando revisões) — decida');
      return this.s.mustGet(target.id);
    }
    this.s.setJob(target.id, { status: 'reviewing', step: `Em revisão cruzada pelo ${agentName(reviewer)}` });
    this.s.addEvent(target.id, 'status', `Revisão cruzada pedida ao ${agentName(reviewer)}`);
    const binding = this.bindingOf(target);
    const review = this.s.enqueue({
      title: `Revisão: ${target.title}`,
      prompt: `Revisar o trabalho do ${agentName(target.agent)}: ${target.title}`,
      acceptance: target.acceptance,
      agent: reviewer,
      projectId: target.projectId,
      risk: 'verde',
      timeoutMin: 20,
      kind: 'review',
      objectiveId: target.objectiveId,
      planKey: link.planKey,
      targetJobId: target.id,
      worktree: target.worktree,
      branch: target.branch,
      baseCommit: target.baseCommit,
    });
    if (binding) this.store.kvSet(`revisao.${review.id}`, binding);
    return review;
  }

  private createFix(target: Job, review: Job): Job {
    const link = this.linked(target);
    if (link.blocked) {
      this.escalate(target, 'Objetivo chegou ao limite de 10 jobs (contando correções) — decida');
      return this.s.mustGet(target.id);
    }
    return this.s.enqueue({
      title: `Correção ${target.attempt}: ${target.title}`,
      prompt: `Corrigir conforme a revisão do ${agentName(review.agent)}`,
      acceptance: target.acceptance,
      agent: target.agent,
      projectId: target.projectId,
      risk: 'verde',
      timeoutMin: target.timeoutMin,
      kind: 'fix',
      objectiveId: target.objectiveId,
      planKey: link.planKey,
      gpuRequired: target.gpuRequired,
      targetJobId: target.id,
      worktree: target.worktree,
      branch: target.branch,
      baseCommit: target.baseCommit,
    });
  }

  // ======================= ações suas =======================

  // "Aprovar" num job em "Aguardando você".
  approveReview(job: Job): Job {
    if (job.kind !== 'task') throw new Error('Só jobs de trabalho podem ser aprovados para merge.');
    if (!job.worktree || !job.branch) throw new Error('Job sem worktree para merge');
    if (job.objectiveId) return this.integrate(job, 'Aprovado por você e integrado');
    const project = this.project(job.projectId);
    const head = mergeWorktree(project.path, job.worktree, job.branch, `${job.title} (job ${job.id}, ${job.agent})`);
    this.s.addEvent(job.id, 'status', `Merge aprovado por você — commit ${head} em ${project.name}`);
    if (this.s.vault?.exists() && project.vaultFolder && !project.isTest) {
      safe(() =>
        this.s.vault!.appendCurrentState(project.vaultFolder!, project.name, `Job: ${job.title}`, `${excerpt(job.summary, 500)}\n\nMerge no commit \`${head}\` (${agentName(job.agent)}).${job.vaultNote ? ` Nota: [[${job.vaultNote.replace(/\.md$/, '')}]]` : ''}`),
      );
    }
    // Mantém a hora em que o agente terminou (a duração não inclui sua revisão).
    return this.s.finish(job.id, { status: 'done', step: `Merge feito (${head})`, worktree: null }, { keepFinishedAt: true });
  }

  discard(job: Job): Job {
    if (job.kind !== 'task') throw new Error('Só dá para descartar jobs de trabalho.');
    if (!['review', 'failed', 'canceled'].includes(job.status)) throw new Error('Só dá para descartar jobs em revisão, que falharam ou cancelados');
    const project = this.project(job.projectId);
    if (job.worktree) removeWorktree(project.path, job.worktree, job.branch);
    this.s.addEvent(job.id, 'status', 'Mudanças descartadas e worktree removido');
    const status = job.status === 'review' ? (job.objectiveId ? 'canceled' : 'done') : job.status;
    const j = this.s.finish(job.id, { status, step: 'Mudanças descartadas', worktree: null }, { keepFinishedAt: true });
    this.checkObjective(job.objectiveId);
    return j;
  }

  retry(job: Job): Job {
    if (job.kind === 'plan') {
      this.startPlanning(job.objectiveId!);
      return this.store.getJob(this.store.getObjective(job.objectiveId!)!.planJobId!)!;
    }
    if (job.kind === 'review' || job.kind === 'fix') {
      const target = this.s.mustGet(job.targetJobId!);
      if (target.status !== 'review' || !target.worktree) throw new Error('O trabalho revisado não está esperando decisão.');
      return job.kind === 'review' ? this.createReview(target) : this.createFix(target, this.lastReview(target.id) ?? job);
    }
    const j = this.s.enqueue({
      title: job.title,
      prompt: job.prompt,
      acceptance: job.acceptance,
      agent: job.agent,
      projectId: job.projectId,
      risk: job.risk,
      timeoutMin: job.timeoutMin,
      kind: 'task',
      objectiveId: job.objectiveId,
      planKey: job.planKey,
      dependsOn: job.dependsOn,
      gpuRequired: job.gpuRequired,
      parentJobId: job.parentJobId,
      depth: job.depth,
    });
    this.checkObjective(job.objectiveId);
    return j;
  }

  // "Pedir revisão cruzada" num job em "Aguardando você".
  requestReview(job: Job): Job {
    if (job.kind !== 'task' || job.status !== 'review' || !job.worktree) throw new Error('Só dá para pedir revisão de um job com mudanças aguardando você.');
    commitAll(job.worktree, `${job.title} (job ${job.id}, ${job.agent})`);
    const review = this.createReview(job);
    this.checkObjective(job.objectiveId);
    return review;
  }

  // ======================= vault =======================

  private writeJobNote(job: Job): void {
    const project = this.project(job.projectId);
    if (!this.s.vault?.exists() || project.isTest || job.vaultNote) return;
    const dur = job.startedAt && job.finishedAt ? Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000) : null;
    const body = [
      `# ${job.title}`,
      '',
      `**Projeto:** ${project.name} · **Agente:** ${agentName(job.agent)} · **Status:** ${job.status === 'review' ? 'aguardando seu merge' : 'concluído'}${dur !== null ? ` · **Duração:** ${dur}s` : ''}`,
      '',
      '## Tarefa',
      job.prompt,
      '',
      '## Resumo do agente',
      job.summary ?? '(sem resumo)',
      '',
      '## Arquivos alterados',
      job.filesChanged.length ? job.filesChanged.map((f) => `- \`${f}\``).join('\n') : 'Nenhum.',
      '',
      '## Evidência',
      `- Log: \`${join(this.s.logDir, `${job.id}.jsonl`)}\``,
      job.branch ? `- Branch: \`${job.branch}\`` : '',
    ].join('\n');
    const rel = safe(
      () => this.s.vault!.writeJobNote(project.name, job.title, { type: 'job', projeto: project.name, agente: job.agent, job: job.id, status: job.status, criado: job.createdAt }, body),
      null,
    );
    if (rel) this.s.setJob(job.id, { vaultNote: rel });
  }

  private writeObjectiveNote(obj: Objective, project: Project, tasks: Job[], stat: string): string {
    const all = this.store.jobsOfObjective(obj.id);
    const reviewsOf = (t: Job) => all.filter((j) => j.kind === 'review' && j.targetJobId === t.id);
    const fixesOf = (t: Job) => all.filter((j) => j.kind === 'fix' && j.targetJobId === t.id);
    const lines = [
      `# ${obj.title}`,
      '',
      `> Entregue pelo EMANNU OS em ${fmtDate(new Date().toISOString())}. **Merge final: aguardando sua aprovação** no app.`,
      '',
      '## Objetivo',
      obj.description,
      '',
      '## Plano do Planejador',
      obj.plan?.summary ?? '—',
      '',
      '| Job | Agente | Revisões | Correções | Resultado |',
      '|---|---|---|---|---|',
      ...tasks.map((t) => {
        const rv = reviewsOf(t).map((r) => `${agentName(r.agent)}: ${r.verdict ?? '—'}`).join('; ') || '—';
        return `| ${t.title} | ${agentName(t.agent)} | ${rv} | ${fixesOf(t).length} | ${t.step ?? t.status} |`;
      }),
      '',
    ];
    for (const t of tasks) {
      lines.push(`### ${t.title} — ${agentName(t.agent)}`, '', `**Tarefa:** ${t.prompt}`, '', `**Critério de aceite:** ${t.acceptance ?? '—'}`, '', `**Resumo do autor:**`, '', t.summary ?? '(sem resumo)', '');
      for (const r of reviewsOf(t)) lines.push(`**Revisão (${agentName(r.agent)}) — ${(r.verdict ?? '—').toUpperCase()}:**`, '', excerpt(r.summary, 1200), '');
    }
    lines.push('## Mudanças', '```', stat || 'Sem mudanças de código.', '```', '');
    if (obj.plan?.manual.length) lines.push('## Ações manuais suas (VERMELHO)', ...obj.plan.manual.map((m) => `- [ ] ${m}`), '');
    lines.push('## Evidência', `- Branch do objetivo: \`${obj.branch ?? '—'}\``, `- Worktree: \`${obj.worktree ?? '—'}\``, ...all.map((j) => `- Log ${j.kind} ${j.id}: \`${join(this.s.logDir, `${j.id}.jsonl`)}\``));
    return this.s.vault!.writeJobNote(
      project.name,
      obj.title,
      { type: 'entrega', projeto: project.name, objetivo: obj.id, status: 'aguardando-merge', criado: obj.createdAt, agentes: [...new Set(tasks.map((t) => t.agent))].join(', ') },
      lines.join('\n'),
    );
  }

  // 90 - INBOX: notas com #objetivo viram objetivos propostos (você aprova o início).
  scanInbox(): Objective[] {
    const vault = this.s.vault;
    if (!vault?.exists()) return [];
    const created: Objective[] = [];
    const projects = this.store.listProjects();
    for (const n of vault.inboxObjectives()) {
      if (this.store.inboxSeen(n.rel)) continue;
      const project = n.project ? projects.find((p) => p.name.toLowerCase() === n.project!.toLowerCase() || p.id === n.project!.toLowerCase()) : undefined;
      const obj = this.store.createObjective({ title: n.title, description: n.body || n.title, projectId: project?.id ?? null, status: 'proposed', source: 'inbox', sourcePath: n.rel });
      this.store.markInboxSeen(n.rel, obj.id);
      this.s.emit('objective', obj);
      this.s.emit('notify', { kind: 'objective-proposed', objective: obj });
      created.push(obj);
    }
    return created;
  }

  mustObjective(id: string): Objective {
    const o = this.store.getObjective(id);
    if (!o) throw new Error('Objetivo não encontrado');
    return o;
  }
}

function safe<T>(fn: () => T, fallback?: T): T {
  try {
    return fn();
  } catch {
    return fallback as T;
  }
}
