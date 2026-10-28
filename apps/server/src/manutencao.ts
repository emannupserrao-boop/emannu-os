// Modo manutenção (v3.1, seção 5.4) e relatório de sexta (seção 8).
// - Quarta, 15h: para cada projeto fora do foco, um bloco datado no Current State com as
//   mudanças da semana (git), mesmo que seja "sem mudança". Uma vez por projeto e semana.
// - Sexta, 17h: relatório semanal em 80 - AUTOMATION/Relatórios/AAAA-MM-DD - Semana.md.
// Montados pelo servidor a partir do git e do banco: sem custo de tokens.
import { existsSync } from 'node:fs';
import type { Scheduler } from './scheduler.ts';
import type { Routines } from './routines.ts';
import { git, isGitRepo } from './worktrees.ts';
import { PROJECT_NOTES } from './config.ts';

export interface MaintenanceProject {
  id: string;
  nome: string;
  vaultFolder: string | null;
  path: string | null;
  bloqueio?: string;
}

// Projetos fora do foco nos próximos 30 dias.
export const MAINTENANCE_IDS = ['neon-vanguard', 'estacao-raiz-jogos', 'what-lies-btwn', 'pulse-events', 'mirae'];
export const MAINTENANCE_EXTRA: MaintenanceProject[] = [
  { id: 'serron', nome: 'SerrON', vaultFolder: '20 - PROJECTS\\SerrON', path: null, bloqueio: PROJECT_NOTES.serron ? 'código não localizado' : undefined },
  { id: 'ai-learning-center', nome: 'AI Learning Center', vaultFolder: '30 - AI LEARNING CENTER', path: null },
];

// Commits da última semana pela data de autoria (quando o trabalho foi feito).
export function weekChanges(path: string | null, now = new Date()): string[] {
  if (!path || !existsSync(path) || !isGitRepo(path)) return [];
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  try {
    return git(path, 'log', '--no-merges', '--pretty=format:%ad %s', '--date=short', '-n', '60')
      .split(/\r?\n/)
      .filter((l) => l && l.slice(0, 10) >= since)
      .slice(0, 15);
  } catch {
    return [];
  }
}

export class Maintenance {
  private s: Scheduler;

  constructor(s: Scheduler) {
    this.s = s;
  }

  projects(): MaintenanceProject[] {
    const fromDb = MAINTENANCE_IDS.map((id) => this.s.store.getProject(id)).filter((p): p is NonNullable<typeof p> => !!p).map((p) => ({ id: p.id, nome: p.name, vaultFolder: p.vaultFolder, path: p.path }));
    return [...fromDb, ...MAINTENANCE_EXTRA];
  }

  block(p: MaintenanceProject): string {
    const changes = weekChanges(p.path);
    return [
      p.bloqueio ? `**Bloqueio explícito:** ${p.bloqueio}.` : '',
      changes.length ? `Mudanças na última semana (git):\n${changes.map((c) => `- ${c}`).join('\n')}` : 'Sem mudança na última semana.',
      '',
      'Modo manutenção: sem objetivos novos, renders ou demos especulativas até a revisão de sexta da semana 3.',
    ].filter((x, i) => x || i > 0).join('\n');
  }

  registerRoutines(r: Routines): void {
    r.register({
      id: 'manutencao',
      nome: 'Modo manutenção',
      descricao: 'Bloco semanal no Current State dos projetos fora do foco (mudanças do git ou "sem mudança")',
      agente: 'sistema',
      schedule: '0 15 * * 3',
      fire: (ctx) => {
        const vault = this.s.vault;
        if (!vault?.exists()) throw new Error('vault não encontrado');
        for (const p of this.projects()) {
          if (!p.vaultFolder) continue;
          ctx.claim(p.id, ctx.window, () => {
            // Marcador da janela: se o processo cair depois de gravar e antes de confirmar,
            // a retomada vê o bloco e não repete.
            const mark = `<!-- emannu-os:manutencao:${ctx.window} -->`;
            const cs = vault.findCurrentState(p.vaultFolder!);
            if (!cs || !vault.read(cs).includes(mark)) vault.appendCurrentState(p.vaultFolder!, p.nome, 'Manutenção semanal', `${mark}\n${this.block(p)}`);
            return null;
          });
        }
      },
    });
    r.register({
      id: 'relatorio-sexta',
      nome: 'Relatório de sexta',
      descricao: 'O que avançou, o que travou e o que deu dinheiro; decisões para você (20 min)',
      agente: 'sistema',
      schedule: '0 17 * * 5',
      fire: (ctx) => {
        ctx.claim('relatorio', ctx.window, () => {
          // Sem vault, a execução falha (e é retomada) em vez de ficar "feita" sem relatório.
          if (!this.writeReport(ctx.window)) throw new Error('vault indisponível: relatório não gravado');
          return null;
        });
      },
    });
  }

  report(day: string): string {
    const st = this.s.store;
    const since = new Date(Date.parse(`${day}T00:00:00Z`) - 6 * 86_400_000).toISOString();
    const jobs = st.listJobs(1000).filter((j) => (j.finishedAt ?? j.createdAt) >= since);
    const by = (pred: (j: (typeof jobs)[number]) => boolean) => jobs.filter(pred).length;
    const agents = [...new Set(jobs.map((j) => j.agent))];
    const tokens = (a: string) => jobs.filter((j) => j.agent === a && j.usage).reduce((s, j) => s + j.usage!.input + j.usage!.output + j.usage!.cacheRead + j.usage!.cacheWrite, 0);
    const income = this.s.renda?.store.income();
    const apps = this.s.renda?.store.applications() ?? [];
    const rocky = this.s.rocky?.last();
    const game = this.s.gameMode.state().historico.filter((h) => h.inicio >= since);
    const failedRuns = (st.db.prepare("SELECT routine_id r, count(*) n FROM routine_runs WHERE state = 'failed' AND updated_at >= ? AND scope <> '' GROUP BY routine_id").all(since) as any[]);
    const money = (m: Record<string, number>) => Object.entries(m).map(([c, v]) => `${c} ${(v / 100).toFixed(2)}`).join(' + ') || '0';
    const amarelos = st.jobsByStatus('approval');
    const pedidos = (rocky?.pedidos ?? []).filter((p) => !p.resposta);
    return [
      `# Semana até ${day}`,
      '',
      '> Relatório gerado pelo EMANNU OS. Você decide os ajustes em 20 min (lista no fim).',
      '',
      '## Renda',
      income ? `- Recebido (caixa): ${money(income.recebido)} · previsto em aberto: ${money(income.previsto)}` : '- Módulo de renda desligado.',
      income ? `- Funil: ${income.funil.ready} pronto(s), ${income.funil.sent} enviado(s), ${income.funil.replied} respondeu, ${income.funil.paid} pago(s), ${income.funil.lost} perdido(s)` : '',
      ...(income?.metas ?? []).map((m) => `- Meta "${m.titulo}" (até ${m.prazo}): ${m.atual}/${m.alvo}`),
      ...(income?.motivosPerda.length ? [`- Motivos de perda: ${income.motivosPerda.map((x) => `${x.motivo} (${x.n})`).join('; ')}`] : []),
      '',
      '## Candidaturas',
      `- Enviadas: ${apps.filter((a) => a.state === 'applied').length} · entrevistas: ${apps.filter((a) => a.state === 'interview').length} · pacotes prontos: ${apps.filter((a) => a.state === 'package_ready').length}`,
      '',
      '## Agentes',
      `- Jobs concluídos: ${by((j) => j.status === 'done')} · falharam: ${by((j) => j.status === 'failed')} · aguardando você: ${by((j) => j.status === 'review')}`,
      ...agents.map((a) => `- ${a}: ${by((j) => j.agent === a)} job(s), ${tokens(a).toLocaleString('pt-BR')} tokens (com dados de uso)`),
      ...(failedRuns.length ? [`- Rotinas com falha: ${failedRuns.map((f) => `${f.r} (${f.n})`).join(', ')}`] : ['- Rotinas: nenhuma falha.']),
      `- Modo jogo: ${game.length} pausa(s) da GPU.`,
      `- Auto-merge: ${this.s.autoMerge.state().suspenso ? `suspenso (${this.s.autoMerge.state().suspenso})` : `${this.s.autoMerge.state().limpas} integração(ões) limpa(s)`}`,
      '',
      '## Prioridades do Planejador',
      ...(rocky?.resultados.length ? rocky.resultados.map((r) => `- [${r.tipo}] ${r.titulo}`) : ['- (sem plano registrado)']),
      '',
      '## Decisões para você (20 min)',
      ...(amarelos.length ? amarelos.map((j) => `- [ ] AMARELO: ${j.title}`) : []),
      ...pedidos.map((p) => `- [ ] O Planejador pede ${p.minutos} min: ${p.titulo}`),
      '- [ ] Ajustar uma variável do funil (público, abordagem ou amostra) se não houve conversa',
      '- [ ] Confirmar o foco da próxima semana',
    ].filter((l) => l !== '').join('\n').replace(/\n## /g, '\n\n## ');
  }

  writeReport(day: string): string | null {
    const vault = this.s.vault;
    if (!vault?.exists()) return null;
    return vault.upsertGeneratedNote('80 - AUTOMATION/Relatórios', `${day} - Semana`, { type: 'relatorio-semanal', gerado_por: 'emannu-os', data: day }, this.report(day));
  }
}
