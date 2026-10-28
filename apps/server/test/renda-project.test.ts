import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Scheduler } from '../src/scheduler.ts';
import { CRIATIVOS_PROJECT, RENDA_PROJECT, Renda } from '../src/renda/index.ts';
import { LEAD_CRITERIA, type LeadCriterion } from '../../../packages/shared/renda.ts';

let dir: string;
let store: Store;
let sched: Scheduler;
let renda: Renda;
const window = '2026-10-28';
const scoreDetail = Object.fromEntries(Object.keys(LEAD_CRITERIA).map((key) => [key, 'integral'])) as Record<LeadCriterion, 'integral'>;
const response = (data: unknown) => ({ ok: true, code: 0, canceled: false, timedOut: false, text: JSON.stringify(data), error: null });

function registerCreative() {
  return store.upsertProject({ id: CRIATIVOS_PROJECT, name: 'Criativos Motion', path: join(dir, 'projeto-real'), isGit: true, vaultFolder: '20 - PROJECTS\\Criativos Motion' });
}

function lead(projectId: string, suffix: string) {
  return renda.store.addLead({ projectId, sourceUrl: `https://example.test/${suffix}`, postedAt: null, company: suffix, channel: 'site', need: 'Preciso de cinco motions', evidence: 'Pedido público de cinco vídeos curtos', scoreDetail }).lead;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'emannu-renda-project-'));
  store = new Store(':memory:');
  sched = new Scheduler({ store, logDir: join(dir, 'logs'), worktreesDir: join(dir, 'wt'), resolveExe: () => null });
  // Valida fila, prompts e resultados sem iniciar processos de agentes.
  vi.spyOn(sched, 'tick').mockImplementation(() => {});
  renda = new Renda(sched, { projectPath: join(dir, 'isolado') });
});

afterEach(() => {
  vi.restoreAllMocks();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('projeto do funil e pasta dos jobs', () => {
  it.each([false, true])('atribui as duas rotinas e seus resultados ao projeto correto (criativo cadastrado: %s)', async (creative) => {
    if (creative) registerCreative();
    const projectId = creative ? CRIATIVOS_PROJECT : RENDA_PROJECT;
    renda.registerRoutines(sched.routines);
    await sched.routines.tick(new Date('2026-10-28T04:30:00Z')); // 06h30 em Bucareste
    const research = store.listJobs().find((j) => j.planKey === `comercial:leads:${window}`)!;
    expect(research).toMatchObject({ projectId, kind: 'research' });
    expect(sched.flow.prepare(research)).toEqual({ cwd: renda.jobPath, worktree: null, branch: null, base: null });
    expect(renda.afterResearch(research, response({ leads: [{ source_url: 'https://example.test/novo', company: 'Novo', need: 'Preciso de cinco motions', evidence: 'Pedido público de cinco vídeos curtos', score_json: scoreDetail }] })).status).toBe('done');
    const collected = renda.store.leads()[0];
    expect(collected).toMatchObject({ projectId, status: 'qualified' });
    await sched.routines.tick(new Date('2026-10-28T05:15:00Z')); // 07h15
    const proposalJob = store.listJobs().find((j) => j.planKey === `comercial:propostas:${window}`)!;
    expect(proposalJob).toMatchObject({ projectId });
    expect(sched.flow.prepare(proposalJob).cwd).toBe(renda.jobPath);
    expect(renda.prompt(proposalJob)).toContain(collected.id);
    renda.afterResearch(proposalJob, response({ propostas: [{ lead_id: collected.id, moeda: 'BRL', texto: 'Posso entregar cinco motions curtos com uma rodada de ajustes.', escopo: 'Cinco motions' }] }));
    const proposal = renda.store.proposals()[0];
    expect(proposal).toMatchObject({ leadId: collected.id, state: 'ready' });
    expect(renda.store.lead(proposal.leadId)!.projectId).toBe(projectId);
  });

  it('resolve o cadastro ao enfileirar e mantém a atribuição de um job antigo ao concluir', () => {
    const queued = renda.enqueueLeads(window);
    registerCreative();
    expect(renda.enqueueLeads(window).projectId).toBe(CRIATIVOS_PROJECT);
    renda.afterResearch(queued, response({ leads: [{ source_url: 'https://example.test/antigo', need: 'Preciso de cinco motions', evidence: 'Pedido público de vídeos curtos', score_json: scoreDetail }] }));
    expect(renda.store.leads()[0].projectId).toBe(RENDA_PROJECT);
    expect(sched.flow.prepare(queued).cwd).toBe(renda.jobPath);
  });

  it('preserva leads e propostas antigos na renda e separa a produção do novo projeto', () => {
    const old = lead(RENDA_PROJECT, 'antigo-com-proposta');
    const oldProposal = renda.store.createProposal({ leadId: old.id, body: 'Proposta antiga', scope: 'Cinco motions', currency: 'BRL' });
    const pendingOld = lead(RENDA_PROJECT, 'antigo-pendente');
    registerCreative();
    const current = lead(CRIATIVOS_PROJECT, 'novo');
    const job = renda.enqueueProposals(window);
    expect(renda.prompt(job)).toContain(current.id);
    expect(renda.prompt(job)).not.toContain(pendingOld.id);
    renda.afterResearch(job, response({ propostas: [{ lead_id: pendingOld.id, moeda: 'BRL', texto: 'Posso entregar cinco motions curtos com uma rodada de ajustes.' }] }));
    const income = renda.store.income();
    expect(income.leadsRecentes.map((l) => l.id)).toEqual(expect.arrayContaining([old.id, pendingOld.id, current.id]));
    expect(income.propostas).toHaveLength(1);
    expect(income.propostas[0].id).toBe(oldProposal.id);
    expect(renda.store.lead(old.id)!.projectId).toBe(RENDA_PROJECT);
  });

  it('não muda a pasta de pesquisas de outros módulos', () => {
    const project = registerCreative();
    const job = store.createJob({ title: 'Outra pesquisa', prompt: 'x', agent: 'claude', projectId: project.id, risk: 'verde', status: 'queued', timeoutMin: 10, kind: 'research', planKey: 'outro' });
    expect(sched.flow.prepare(job).cwd).toBe(project.path);
  });
});
