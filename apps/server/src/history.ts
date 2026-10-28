// "O que já foi feito no Claude Code" por projeto: lê as sessões do Code ligadas às
// pastas do projeto, gera um resumo com um job do Claude (só leitura), guarda o
// resultado e escreve uma nota no vault.
// v3.1: no máximo 1x por dia por projeto (rotina "historico", uma janela por projeto e
// data no fuso configurado, reservada no banco). O hash das sessões só decide se há o que
// resumir; pedido e entrada ficam presos ao job (sem o antigo arquivo ".pedido" compartilhado).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Job } from '../../../packages/shared/types.ts';
import type { Scheduler } from './scheduler.ts';
import type { Outcome } from './flow.ts';
import type { CodeSession, CodeSessionIndex } from './codeSessions.ts';
import { extractJson } from './immigration/topics.ts';
import { RETRY, localDate, type FireContext } from './routines.ts';

export const HISTORY_PROJECT = 'historico';

export interface CodeHistory {
  geradoEm: string;
  sessoes: number;
  ultimaSessao: string;
  resumo: string;
  feito: string[];
  decisoes: string[];
  entregas: { titulo: string; caminho: string }[];
  pendencias: string[];
  proximos: string[];
  vaultNote: string | null;
  // Hash das sessões resumidas (para saber se há algo novo).
  hash?: string;
}

interface Request {
  cardId: string;
  nome: string;
  vaultFolder: string | null;
  sessoes: number;
  ultimaSessao: string;
  hash: string;
}

export interface HistoryCard {
  id: string;
  nome: string;
  dirs: string[];
  vaultFolder: string | null;
}

export const HISTORY_ROUTINE = 'historico';

// Identidade das sessões: muda quando aparece sessão nova ou uma sessão continua.
export function sessionsHash(sessions: CodeSession[]): string {
  return createHash('sha256').update(sessions.map((x) => `${x.id}@${x.lastAt}`).sort().join('\n')).digest('hex').slice(0, 32);
}

const strs = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : []);
const key = (id: string) => `historico.${id}`;
const requestKey = (jobId: string) => `historico.pedido.${jobId}`;

export class ProjectHistory {
  private s: Scheduler;
  readonly index: CodeSessionIndex;
  private workDir: string;
  // Pastas extras onde o trabalho de um projeto aconteceu no Code (além da pasta do projeto).
  private extraDirs: Record<string, string[]>;

  constructor(s: Scheduler, index: CodeSessionIndex, opts: { workDir: string; extraDirs: Record<string, string[]> }) {
    this.s = s;
    this.index = index;
    this.workDir = opts.workDir;
    this.extraDirs = opts.extraDirs;
    s.history = this;
  }

  // Quem fornece os cards dos projetos (a API de projetos, ligada no index.ts).
  cards: (() => Promise<HistoryCard[]>) | null = null;

  init(): void {
    mkdirSync(this.workDir, { recursive: true });
    this.s.store.upsertProject({ id: HISTORY_PROJECT, name: 'Histórico do Claude Code', path: this.workDir, isGit: false, isTest: true });
    this.s.routines.register({
      id: HISTORY_ROUTINE,
      nome: 'Histórico do Claude Code',
      descricao: 'Resumo do que foi feito no Claude Code por projeto (no máximo 1x por dia, só se houver sessão nova)',
      agente: 'claude',
      schedule: '0 13 * * *',
      fire: async (ctx) => {
        if (this.cards) await this.autoRefresh(await this.cards(), ctx);
      },
    });
  }

  dirsFor(cardId: string, projectPath: string | null): string[] {
    return [...(projectPath ? [projectPath] : []), ...(this.extraDirs[cardId] ?? [])];
  }

  get(cardId: string): CodeHistory | null {
    return this.s.store.kvGet<CodeHistory>(key(cardId));
  }

  // Consulta persistente (no banco, não só nos últimos jobs): há resumo na fila ou rodando?
  pending(cardId: string): boolean {
    return !!this.s.store.db
      .prepare("SELECT 1 FROM routine_runs WHERE routine_id = ? AND scope = ? AND state IN ('pending','running') LIMIT 1")
      .get(HISTORY_ROUTINE, cardId);
  }

  // Cria o job e grava o pedido e a entrada presos ao id dele (mesma transação da reserva).
  private enqueue(card: HistoryCard, sessions: CodeSession[], digest: string, routineRunId: string): Job {
    const job = this.s.enqueue({
      title: `Histórico do Claude Code: ${card.nome}`,
      prompt: `Resumir o que já foi feito em ${sessions.length} sessão(ões) do Claude Code sobre ${card.nome}.`,
      agent: 'claude',
      projectId: HISTORY_PROJECT,
      risk: 'verde',
      timeoutMin: 20,
      kind: 'research',
      planKey: `historico:${card.id}`,
      routineRunId,
    });
    writeFileSync(join(this.workDir, `${job.id}.md`), `# Sessões do Claude Code — ${card.nome}\n\n${digest}\n`, 'utf8');
    this.s.store.kvSet(requestKey(job.id), {
      cardId: card.id, nome: card.nome, vaultFolder: card.vaultFolder, sessoes: sessions.length, ultimaSessao: sessions[0].lastAt, hash: sessionsHash(sessions),
    } satisfies Request);
    return job;
  }

  // Pedido manual (botão no card): no máximo um extra por dia, além da rotina.
  async summarize(cardId: string, nome: string, dirs: string[], vaultFolder: string | null): Promise<Job> {
    if (this.pending(cardId)) throw new Error('O resumo deste projeto já está sendo gerado.');
    const sessions = await this.index.sessionsFor(dirs);
    if (!sessions.length) throw new Error('Nenhuma sessão do Claude Code encontrada para as pastas deste projeto.');
    const digest = await this.index.digest(sessions);
    const r = this.s.routines.store.claim(HISTORY_ROUTINE, cardId, `manual:${localDate(new Date())}`, (runId) => this.enqueue({ id: cardId, nome, dirs, vaultFolder }, sessions, digest, runId));
    if (!r.created) throw new Error('Você já pediu um resumo extra deste projeto hoje. O próximo sai amanhã.');
    return r.job!;
  }

  // Rotina diária: uma janela por projeto e data; só cria o job se houver sessão nova.
  async autoRefresh(cards: HistoryCard[], ctx?: Pick<FireContext, 'window' | 'claim'>): Promise<string[]> {
    const window = ctx?.window ?? localDate(new Date());
    const claim = ctx?.claim ?? ((scope: string, k: string, create: (runId: string) => Job | null) => this.s.routines.store.claim(HISTORY_ROUTINE, scope, k, create, RETRY));
    const started: string[] = [];
    for (const c of cards) {
      const existing = this.s.routines.store.getRun(HISTORY_ROUTINE, c.id, window);
      // Já resumido (ou em andamento) nesta janela: não refaz. Se falhou, a reserva decide a retomada.
      if (this.pending(c.id) || (existing && existing.state !== 'failed')) continue;
      const sessions = await this.index.sessionsFor(c.dirs);
      if (!sessions.length) continue;
      const h = this.get(c.id);
      const hash = sessionsHash(sessions);
      if (h && (h.hash ? h.hash === hash : h.ultimaSessao >= sessions[0].lastAt)) continue;
      const digest = await this.index.digest(sessions);
      if (claim(c.id, window, (runId) => this.enqueue(c, sessions, digest, runId)).created) started.push(c.id);
    }
    return started;
  }

  private request(job: Job): Request | null {
    return this.s.store.kvGet<Request>(requestKey(job.id));
  }

  prompt(job: Job): string {
    const id = job.planKey!.slice('historico:'.length);
    const req = this.request(job);
    return `Você vai organizar a memória do projeto "${req?.nome ?? id}" do Emannuel.
O arquivo ${job.id}.md, neste diretório, tem as sessões do Claude Code sobre esse projeto: os pedidos dele ("Você") e as respostas do Claude, em ordem. Leia o arquivo inteiro (use Read em partes, se for grande).

Responda em português do Brasil, com um resumo curto e, no FINAL, um único bloco \`\`\`json neste formato:
{
  "resumo": "3 a 5 frases: o que é o projeto e onde ele está hoje",
  "feito": ["o que foi efetivamente produzido ou decidido nas sessões, um item por entrega"],
  "decisoes": ["decisões importantes e por quê"],
  "entregas": [{ "titulo": "nome do arquivo/artefato", "caminho": "caminho no disco, se aparecer" }],
  "pendencias": ["o que ficou aberto, bloqueado ou dependendo do Emannuel"],
  "proximos": ["próximos passos sugeridos nas sessões"]
}
Regras: use só o que está nas sessões; não invente arquivos, números ou resultados. Se algo foi só planejado e não feito, ponha em "pendencias", não em "feito". Não edite nenhum arquivo.`;
  }

  afterResearch(job: Job, o: Outcome): Job {
    const id = job.planKey!.slice('historico:'.length);
    const req = this.request(job);
    if (!o.ok) return this.s.finish(job.id, { status: o.canceled ? 'canceled' : 'failed', error: o.error, summary: o.text, step: 'Falhou' });
    try {
      const raw = extractJson(o.text);
      const h: CodeHistory = {
        geradoEm: new Date().toISOString(),
        sessoes: req?.sessoes ?? 0,
        ultimaSessao: req?.ultimaSessao ?? '',
        resumo: String(raw.resumo ?? '').trim(),
        feito: strs(raw.feito),
        decisoes: strs(raw.decisoes),
        entregas: (Array.isArray(raw.entregas) ? raw.entregas : []).map((e: any) => ({ titulo: String(e?.titulo ?? '').trim(), caminho: String(e?.caminho ?? '').trim() })).filter((e: any) => e.titulo),
        pendencias: strs(raw.pendencias),
        proximos: strs(raw.proximos),
        vaultNote: null,
        hash: req?.hash,
      };
      if (!h.resumo) throw new Error('Resumo vazio.');
      h.vaultNote = this.writeNote(req?.nome ?? id, req?.vaultFolder ?? null, h);
      this.s.store.kvSet(key(id), h);
      return this.s.finish(job.id, { status: 'done', exitCode: o.code, step: 'Histórico salvo no projeto', summary: o.text });
    } catch (e: any) {
      return this.s.finish(job.id, { status: 'failed', error: e.message, summary: o.text, step: 'Resposta inválida' });
    }
  }

  private writeNote(nome: string, vaultFolder: string | null, h: CodeHistory): string | null {
    const vault = this.s.vault;
    if (!vault?.exists()) return null;
    const list = (t: string, xs: string[]) => (xs.length ? [`## ${t}`, ...xs.map((x) => `- ${x}`), ''] : []);
    const body = [
      `# ${nome} — Histórico do Claude Code`,
      '',
      `> Resumo de ${h.sessoes} sessão(ões) do Claude Code, gerado pelo EMANNU OS em ${h.geradoEm.slice(0, 10)}. Atualiza sozinho quando há sessões novas.`,
      '',
      h.resumo,
      '',
      ...list('Feito', h.feito),
      ...list('Decisões', h.decisoes),
      ...(h.entregas.length ? ['## Entregas', ...h.entregas.map((e) => `- ${e.titulo}${e.caminho ? ` — \`${e.caminho}\`` : ''}`), ''] : []),
      ...list('Pendências', h.pendencias),
      ...list('Próximos passos', h.proximos),
    ].join('\n');
    try {
      return vault.upsertGeneratedNote(vaultFolder ?? join('80 - AUTOMATION', 'Projetos'), `${nome} - Histórico do Claude Code`, { type: 'historico-code', projeto: nome, atualizado: h.geradoEm.slice(0, 10) }, body);
    } catch {
      return null;
    }
  }
}

export function sessionSummary(s: CodeSession) {
  return { id: s.id, title: s.title, firstAt: s.firstAt, lastAt: s.lastAt, prompts: s.prompts, cwd: s.cwd };
}
