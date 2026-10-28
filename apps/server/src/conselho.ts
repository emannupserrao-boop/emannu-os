// Conselho (v3.1, seção 3): decisões caras ou irreversíveis. A mesma pergunta vai ao Claude
// e ao Hermes (ChatGPT) EM PARALELO e de forma independente (nenhum vê a resposta do
// outro); quando os dois terminam, o Claude faz a síntese com as divergências.
// Resultado: guardado no banco e numa nota em 80 - AUTOMATION/Conselho.
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Job, RunnableAgent } from '../../../packages/shared/types.ts';
import type { Scheduler } from './scheduler.ts';
import type { Outcome } from './flow.ts';
import { loadPrompt } from './prompts/load.ts';
import { localDate } from './routines.ts';

export const CONSELHO_PROJECT = 'conselho';

export interface ConselhoCase {
  id: string;
  pergunta: string;
  criadoEm: string;
  jobs: { claude: string; hermes: string; sintese: string | null };
  respostas: { claude: string | null; hermes: string | null };
  sintese: string | null;
  estado: 'pesquisando' | 'sintetizando' | 'pronto' | 'falhou';
  vaultNote: string | null;
}

const key = (id: string) => `conselho.${id}`;

export class Conselho {
  private s: Scheduler;

  constructor(s: Scheduler, opts: { projectPath: string }) {
    this.s = s;
    s.conselho = this;
    mkdirSync(opts.projectPath, { recursive: true });
    s.store.upsertProject({ id: CONSELHO_PROJECT, name: 'Conselho', path: opts.projectPath, isGit: false, isTest: true });
  }

  handles(planKey: string): boolean {
    return /^conselho:cons-[0-9a-f]{8}:(claude|hermes|sintese)$/.test(planKey);
  }

  get(id: string): ConselhoCase | null {
    return this.s.store.kvGet<ConselhoCase>(key(id));
  }

  list(): ConselhoCase[] {
    return (this.s.store.db.prepare("SELECT value FROM kv WHERE key LIKE 'conselho.cons-%' ORDER BY updated_at DESC LIMIT 30").all() as any[]).map((r) => JSON.parse(r.value));
  }

  private second(): RunnableAgent {
    const p = this.s.probes.hermes;
    return p?.installed && p.authenticated !== false && this.s.resolveExe('hermes') ? 'hermes' : 'codex';
  }

  ask(pergunta: string): ConselhoCase {
    const q = pergunta.trim();
    if (q.length < 10) throw new Error('Escreva a pergunta do Conselho (pelo menos uma frase).');
    const id = `cons-${randomBytes(4).toString('hex')}`;
    const mk = (agent: RunnableAgent, who: 'claude' | 'hermes') =>
      this.s.enqueue({ title: `Conselho (${who === 'claude' ? 'Claude' : 'ChatGPT'}): ${q.slice(0, 60)}`, prompt: q, agent, projectId: CONSELHO_PROJECT, risk: 'verde', timeoutMin: 30, kind: 'research', planKey: `conselho:${id}:${who}` });
    const c: ConselhoCase = { id, pergunta: q, criadoEm: new Date().toISOString(), jobs: { claude: '', hermes: '', sintese: null }, respostas: { claude: null, hermes: null }, sintese: null, estado: 'pesquisando', vaultNote: null };
    this.s.store.kvSet(key(id), c);
    c.jobs.claude = mk('claude', 'claude').id;
    c.jobs.hermes = mk(this.second(), 'hermes').id;
    this.s.store.kvSet(key(id), c);
    return c;
  }

  prompt(job: Job): string {
    const [, id, who] = job.planKey!.split(':');
    const c = this.get(id)!;
    const base = { hoje: localDate(new Date()), pergunta: c.pergunta };
    if (who !== 'sintese') {
      // Independência: este prompt não tem a resposta do outro conselheiro.
      return loadPrompt('conselho', { ...base, papel: 'conselheiro independente', instrucao: 'Responda sozinho, com sua própria análise. Outro conselheiro responde em paralelo, e você não verá a resposta dele.', respostas: '', extra: '' });
    }
    return loadPrompt('conselho', {
      ...base,
      papel: 'síntese',
      instrucao: 'Dois conselheiros responderam de forma independente. Faça a síntese: onde concordam, onde divergem (e por quê) e qual a recomendação final com o grau de confiança.',
      respostas: `\n## Conselheiro A (Claude)\n<resposta_a>\n${c.respostas.claude ?? ''}\n</resposta_a>\n\n## Conselheiro B (ChatGPT)\n<resposta_b>\n${c.respostas.hermes ?? ''}\n</resposta_b>\n`,
      extra: ' Comece por uma seção **Divergências** (lista).',
    });
  }

  afterResearch(job: Job, o: Outcome): Job {
    const [, id, who] = job.planKey!.split(':') as [string, string, 'claude' | 'hermes' | 'sintese'];
    const c = this.get(id);
    if (!c) return this.s.finish(job.id, { status: 'failed', error: 'Caso do Conselho não encontrado' });
    if (!o.ok || !o.text?.trim()) {
      this.s.store.kvSet(key(id), { ...c, estado: 'falhou' });
      return this.s.finish(job.id, { status: o.canceled ? 'canceled' : 'failed', error: o.error ?? 'sem resposta', summary: o.text, step: 'Falhou' });
    }
    if (who === 'sintese') {
      const vaultNote = this.writeNote({ ...c, sintese: o.text });
      this.s.store.kvSet(key(id), { ...c, sintese: o.text, estado: 'pronto', vaultNote });
      this.s.emit('notify', { kind: 'conselho', id, text: c.pergunta });
      return this.s.finish(job.id, { status: 'done', exitCode: o.code, step: 'Síntese pronta', summary: o.text, vaultNote });
    }
    const next = { ...c, respostas: { ...c.respostas, [who]: o.text } };
    const done = this.s.finish(job.id, { status: 'done', exitCode: o.code, step: 'Resposta independente salva', summary: o.text });
    // Os dois responderam: síntese pelo Claude.
    if (next.respostas.claude && next.respostas.hermes && !next.jobs.sintese) {
      next.estado = 'sintetizando';
      this.s.store.kvSet(key(id), next);
      next.jobs.sintese = this.s.enqueue({ title: `Conselho (síntese): ${c.pergunta.slice(0, 60)}`, prompt: c.pergunta, agent: 'claude', projectId: CONSELHO_PROJECT, risk: 'verde', timeoutMin: 20, kind: 'research', planKey: `conselho:${id}:sintese` }).id;
    }
    this.s.store.kvSet(key(id), next);
    return done;
  }

  private writeNote(c: ConselhoCase): string | null {
    const vault = this.s.vault;
    if (!vault?.exists()) return null;
    try {
      return vault.upsertGeneratedNote('80 - AUTOMATION/Conselho', `${c.criadoEm.slice(0, 10)} - ${c.pergunta.slice(0, 60).replace(/[\\/:*?"<>|#^[\]]/g, '')}`, { type: 'conselho', gerado_por: 'emannu-os', criado: c.criadoEm.slice(0, 10) }, [
        `# Conselho — ${c.pergunta}`,
        '',
        '## Síntese (Claude)',
        c.sintese ?? '',
        '',
        '## Resposta A — Claude (independente)',
        c.respostas.claude ?? '',
        '',
        '## Resposta B — ChatGPT/Hermes (independente)',
        c.respostas.hermes ?? '',
      ].join('\n'));
    } catch {
      return null;
    }
  }
}
