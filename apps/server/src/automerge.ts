// Auto-merge (v3.1, seção 7): um único caminho de integração com exclusão por repositório.
// Elegível: primeiro o Sandbox. Depois do dia 4 e de 10 integrações seguidas sem regressão,
// todos os projetos (Sprint 3), sempre com revisão cruzada, testes e reversão automática.
// Sempre AMARELO: autenticação/PIN, permissões e migrações destrutivas de banco.
//
//   exclusão por repositório; reconciliar tentativa anterior persistida
//   conferir política, projeto e escopo → sensível: AMARELO
//   destino limpo (inclui não rastreados)
//   congelar base/head; hash completo do diff (inclui binários)
//   exigir PASS da revisão cruzada vinculado a esse hash
//   candidato sobre o HEAD atual → conflito: preservar evidências, AMARELO
//   base ou diff mudou → invalidar revisão, pedir outra
//   testes do projeto no candidato → falha: destino intacto
//   persistir intenção e SHAs; promover exatamente o candidato (conferindo o HEAD esperado)
//   smoke test; persistir conclusão
//   regressão → suspender auto-merge, reversão isolada, testar e integrar em série
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Job, Project } from '../../../packages/shared/types.ts';
import type { Store } from './db.ts';
import { git } from './worktrees.ts';

// Caminhos sensíveis: sempre AMARELO (um erro pode trancar o Emannuel fora ou perder histórico).
export const SENSITIVE = [/(^|\/)(auth|app|human)\.ts$/i, /(^|\/)renda\/api\.ts$/i, /(^|\/)(pin|permiss|acl|security|seguranca)[\w.-]*/i, /(^|\/)migrations?\//i, /(^|\/)\.env/i];
// Trechos de diff que mexem em acesso, confirmação humana ou tokens.
const SENSITIVE_DIFF = /(human\.verify|req\.device|onRequest|adminToken|checkPin|setPin|x-emannu-confirm|X-Emannu-Token|PUBLIC_API)/;
const DESTRUCTIVE_SQL = /\b(DROP\s+(TABLE|COLUMN)|ALTER\s+TABLE\s+\w+\s+(RENAME|DROP)|DELETE\s+FROM)\b/i;

export interface ReviewBinding {
  base: string;
  head: string;
  diffHash: string;
}

export interface MergeAttempt {
  jobId: string;
  project: string;
  state: 'preparing' | 'promoting' | 'done' | 'failed' | 'reverted';
  base: string;
  head: string;
  diffHash: string;
  expectedTarget: string;
  candidate: string | null;
  at: string;
  error?: string;
  // Integração feita, mas a contagem/conclusão do job ainda não foi confirmada.
  pendentes?: boolean;
}

export interface AutoMergeState {
  limpas: number;
  desde: string | null;
  suspenso: string | null;
  todos: boolean;
}

export type MergeResult =
  | { ok: true; sha: string }
  | { ok: false; amarelo: boolean; reason: string; newReview?: boolean };

export const MILESTONE_CLEAN = 10;
// "A partir do dia 4": 3 dias completos depois da primeira integração limpa.
export const MILESTONE_DAYS = 3;

export const diffHash = (repo: string, base: string, head: string) =>
  createHash('sha256').update(execFileSync('git', ['diff', '--binary', '--full-index', base, head], { cwd: repo, maxBuffer: 200 * 1024 * 1024, windowsHide: true })).digest('hex');

export class AutoMerge {
  private store: Store;
  private wtDir: string;
  // Comando de teste por projeto (null = sem testes; o Sandbox não tem).
  testCommand: (p: Project, cwd: string) => string[] | null = (_p, cwd) => (existsSync(join(cwd, 'package.json')) && /"test"\s*:/.test(readFileSync(join(cwd, 'package.json'), 'utf8')) ? ['npm', 'test'] : null);

  constructor(store: Store, worktreesDir: string) {
    this.store = store;
    this.wtDir = join(worktreesDir, '_integracao');
  }

  state(): AutoMergeState {
    return this.store.kvGet<AutoMergeState>('automerge.estado') ?? { limpas: 0, desde: null, suspenso: null, todos: false };
  }

  private setState(s: AutoMergeState) {
    this.store.kvSet('automerge.estado', s);
  }

  // Sandbox sempre; os outros só depois do marco (dia ≥ 4 e 10 integrações limpas) — Sprint 3.
  eligible(p: Project): boolean {
    const s = this.state();
    if (s.suspenso) return false;
    return p.id === 'sandbox' || (p.isGit && (s.todos || this.milestone(s)));
  }

  // Marco: 10 integrações limpas seguidas e o 4º dia desde a primeira.
  milestone(s: AutoMergeState = this.state()): boolean {
    return s.limpas >= MILESTONE_CLEAN && !!s.desde && Date.now() - Date.parse(s.desde) >= MILESTONE_DAYS * 86_400_000;
  }

  sensitive(files: string[], diff: string): string | null {
    const f = files.find((x) => SENSITIVE.some((r) => r.test(x.replace(/\\/g, '/'))));
    if (f) return `arquivo sensível (${f})`;
    if (DESTRUCTIVE_SQL.test(diff)) return 'migração destrutiva de banco';
    if (SENSITIVE_DIFF.test(diff)) return 'mudança em acesso, PIN ou confirmação humana';
    return null;
  }

  bind(repo: string, base: string, head: string): ReviewBinding {
    return { base, head, diffHash: diffHash(repo, base, head) };
  }

  private attemptKey(project: string) {
    return `automerge.tentativa.${project}`;
  }

  // Tentativa anterior que ficou pela metade (ex.: queda no meio da promoção).
  reconcile(p: Project): MergeAttempt | null {
    const a = this.store.kvGet<MergeAttempt>(this.attemptKey(p.id));
    if (a?.state === 'done' && a.pendentes) {
      this.finishEffects(p, a);
      return this.store.kvGet<MergeAttempt>(this.attemptKey(p.id));
    }
    if (!a || a.state === 'done' || a.state === 'failed' || a.state === 'reverted') return a;
    const head = git(p.path, 'rev-parse', 'HEAD');
    this.removeCandidate(p, a.jobId);
    if (!a.candidate || head !== a.candidate) {
      const fixed: MergeAttempt = { ...a, state: 'failed', error: 'tentativa interrompida antes da promoção; destino intacto' };
      this.store.kvSet(this.attemptKey(p.id), fixed);
      return fixed;
    }
    // Promovido, mas a queda foi antes do smoke: confere agora.
    const smoke = this.runTests(p, p.path);
    if (!smoke) {
      this.finishEffects(p, { ...a, state: 'done', pendentes: true });
      return this.store.kvGet<MergeAttempt>(this.attemptKey(p.id));
    }
    return this.regression(p, a, a.candidate, smoke, `Reversão automática (retomada): job ${a.jobId}`);
  }

  private removeCandidate(p: Project, jobId: string) {
    const dir = join(this.wtDir, `${p.id}-${jobId}`);
    try {
      git(p.path, 'worktree', 'remove', '--force', dir);
    } catch {}
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
    try {
      git(p.path, 'branch', '-D', `integracao/${jobId}`);
    } catch {}
  }

  private runTests(p: Project, cwd: string): string | null {
    const cmd = this.testCommand(p, cwd);
    if (!cmd) return null;
    // O candidato é um worktree sem node_modules: aponta para o do projeto (junção, sem copiar).
    const nm = join(p.path, 'node_modules');
    if (cwd !== p.path && existsSync(nm) && !existsSync(join(cwd, 'node_modules'))) {
      try {
        symlinkSync(nm, join(cwd, 'node_modules'), 'junction');
      } catch {}
    }
    try {
      execFileSync(cmd[0], cmd.slice(1), { cwd, stdio: 'pipe', timeout: 20 * 60_000, windowsHide: true, shell: process.platform === 'win32' });
      return null;
    } catch (e: any) {
      return `testes falharam: ${String(e.stdout ?? e.message).slice(-400)}`;
    }
  }

  // Integra o branch do job no branch atual do projeto. Síncrono = em série por natureza;
  // a trava por repositório protege contra reentrada (ex.: dois eventos no mesmo tick).
  integrate(p: Project, job: Job, binding: ReviewBinding | null, message: string): MergeResult {
    const lockKey = `merge:${p.id}`;
    if (!this.store.acquireLock(lockKey, job.id)) return { ok: false, amarelo: false, reason: 'outra integração em andamento neste repositório' };
    try {
      this.reconcile(p);
      // A reconciliação pode ter achado uma regressão e suspendido o auto-merge.
      if (this.state().suspenso) return { ok: false, amarelo: true, reason: `auto-merge suspenso: ${this.state().suspenso}` };
      if (!job.branch) return { ok: false, amarelo: true, reason: 'job sem branch' };
      if (git(p.path, 'status', '--porcelain', '--untracked-files=all')) return { ok: false, amarelo: true, reason: 'destino com mudanças não salvas (inclui arquivos não rastreados)' };
      const target = git(p.path, 'rev-parse', 'HEAD');
      const head = git(p.path, 'rev-parse', job.branch);
      const base = git(p.path, 'merge-base', target, head);
      const hash = diffHash(p.path, base, head);
      const files = git(p.path, 'diff', '--name-only', base, head).split(/\r?\n/).filter(Boolean);
      const sens = this.sensitive(files, execFileSync('git', ['diff', base, head], { cwd: p.path, encoding: 'utf8', maxBuffer: 200 * 1024 * 1024, windowsHide: true }));
      if (sens) return { ok: false, amarelo: true, reason: `${sens}: precisa do seu OK` };
      // A revisão vale só para exatamente este diff.
      if (!binding || binding.base !== base || binding.head !== head || binding.diffHash !== hash) return { ok: false, amarelo: false, reason: 'o diff mudou depois da revisão: revisão invalidada', newReview: true };
      const attempt: MergeAttempt = { jobId: job.id, project: p.id, state: 'preparing', base, head, diffHash: hash, expectedTarget: target, candidate: null, at: new Date().toISOString() };
      this.store.kvSet(this.attemptKey(p.id), attempt);
      // Candidato isolado sobre o HEAD atual.
      mkdirSync(this.wtDir, { recursive: true });
      const dir = join(this.wtDir, `${p.id}-${job.id}`);
      this.removeCandidate(p, job.id);
      git(p.path, 'worktree', 'add', '-b', `integracao/${job.id}`, dir, target);
      try {
        git(dir, '-c', 'user.name=EMANNU OS', '-c', 'user.email=emannu-os@localhost', 'merge', '--no-ff', '-m', message, head);
      } catch (e: any) {
        try {
          git(dir, 'merge', '--abort');
        } catch {}
        this.store.kvSet(this.attemptKey(p.id), { ...attempt, state: 'failed', error: 'conflito' });
        this.removeCandidate(p, job.id);
        return { ok: false, amarelo: true, reason: `conflito ao integrar (branch ${job.branch} preservado como evidência)` };
      }
      const candidate = git(dir, 'rev-parse', 'HEAD');
      const failed = this.runTests(p, dir);
      if (failed) {
        this.store.kvSet(this.attemptKey(p.id), { ...attempt, candidate, state: 'failed', error: failed });
        this.removeCandidate(p, job.id);
        return { ok: false, amarelo: true, reason: `${failed} (destino intacto)` };
      }
      // Promoção: exatamente o candidato, e só se o destino ainda está onde estava.
      this.store.kvSet(this.attemptKey(p.id), { ...attempt, candidate, state: 'promoting' });
      if (git(p.path, 'rev-parse', 'HEAD') !== target) {
        this.store.kvSet(this.attemptKey(p.id), { ...attempt, candidate, state: 'failed', error: 'o destino andou durante a integração' });
        this.removeCandidate(p, job.id);
        return { ok: false, amarelo: false, reason: 'o destino andou durante a integração: tente de novo', newReview: true };
      }
      git(p.path, 'merge', '--ff-only', candidate);
      this.removeCandidate(p, job.id);
      // Smoke: o destino é o candidato e os testes continuam passando.
      const smoke = git(p.path, 'rev-parse', 'HEAD') === candidate ? this.runTests(p, p.path) : 'HEAD diferente do candidato';
      if (smoke) {
        const r = this.regression(p, attempt, candidate, smoke, `Reversão automática: ${message}`);
        return { ok: false, amarelo: true, reason: `regressão: auto-merge suspenso${r.state === 'reverted' ? ' e mudança revertida' : '; a reversão automática falhou — decida'}` };
      }
      this.store.kvSet(this.attemptKey(p.id), { ...attempt, candidate, state: 'done', pendentes: true });
      this.countClean();
      this.store.kvSet(this.attemptKey(p.id), { ...attempt, candidate, state: 'done' });
      return { ok: true, sha: candidate };
    } finally {
      this.store.releaseLocks(job.id);
    }
  }

  // Reversão isolada: num worktree próprio, testada antes de integrar.
  private revert(p: Project, sha: string, message: string): string | null {
    const dir = join(this.wtDir, `${p.id}-revert-${sha.slice(0, 8)}`);
    try {
      try {
        git(p.path, 'worktree', 'remove', '--force', dir);
      } catch {}
      git(p.path, 'worktree', 'add', '--detach', dir, 'HEAD');
      git(dir, '-c', 'user.name=EMANNU OS', '-c', 'user.email=emannu-os@localhost', 'revert', '--no-edit', '-m', '1', sha);
      const r = git(dir, 'rev-parse', 'HEAD');
      if (this.runTests(p, dir) && this.testCommand(p, dir)) {
        // Mesmo a reversão quebra: deixa para o Emannuel (AMARELO), sem mexer no destino.
        return null;
      }
      git(p.path, 'merge', '--ff-only', r);
      return r;
    } catch {
      return null;
    } finally {
      try {
        git(p.path, 'worktree', 'remove', '--force', dir);
      } catch {}
    }
  }

  // Conta a integração e fecha o job; só depois limpa a marca de pendente.
  private finishEffects(p: Project, a: MergeAttempt): void {
    this.store.kvSet(this.attemptKey(p.id), a);
    this.countClean();
    if (a.candidate) this.onRecovered(a.jobId, a.candidate);
    this.store.kvSet(this.attemptKey(p.id), { ...a, pendentes: false });
  }

  // Integração limpa. Marco do Sandbox (decisão do Emannuel): dia ≥ 4 e 10 integrações
  // seguidas sem regressão → auto-merge em todos os projetos integrados, inclusive o EMANNU OS.
  private countClean(): void {
    const st = this.state();
    const next = { ...st, limpas: st.limpas + 1, desde: st.desde ?? new Date().toISOString() };
    this.setState({ ...next, todos: st.todos || this.milestone(next) });
  }

  // Avisado quando uma integração interrompida é concluída na recuperação (o Scheduler fecha o job).
  onRecovered: (jobId: string, sha: string) => void = () => {};

  // Regressão: suspende o auto-merge e tenta a reversão isolada. Só grava "reverted" se reverteu.
  private regression(p: Project, attempt: MergeAttempt, candidate: string, smoke: string, message: string): MergeAttempt {
    const reverted = this.revert(p, candidate, message);
    const fixed: MergeAttempt = { ...attempt, candidate, state: reverted ? 'reverted' : 'failed', error: reverted ? smoke : `${smoke} — reversão automática falhou; destino ainda no candidato` };
    this.store.kvSet(this.attemptKey(p.id), fixed);
    const st = this.state();
    this.setState({ ...st, limpas: 0, suspenso: `Regressão depois de integrar o job ${attempt.jobId}: ${smoke}${reverted ? ` — revertido em ${reverted}` : ' — reversão falhou, decida'}` });
    return fixed;
  }

  // Depois de um reinício: reconcilia tentativas pela metade e solta as travas de merge.
  recover(projects: Project[]): void {
    for (const p of projects) {
      if (!this.store.kvGet<MergeAttempt>(this.attemptKey(p.id))) continue;
      try {
        this.reconcile(p);
      } catch {}
    }
    this.store.db.prepare("DELETE FROM locks WHERE key LIKE 'merge:%'").run();
  }

  resume(): AutoMergeState {
    const s = { ...this.state(), suspenso: null };
    this.setState(s);
    return s;
  }
}
