// Aba Agentes: os "harnesses" (Claude Code, Codex, Hermes, OpenClaw), os agentes
// que existem em cada um e o estado de instalação. Os jobs em execução (com tokens e
// contexto) a interface tira do stream ao vivo.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentState, HarnessAgent, HarnessView, JobKind, Project } from '../../../../packages/shared/types.ts';
import type { RoutineView } from '../../../../packages/shared/renda.ts';
import { findOpenClawExe, isNodeScript, run, which } from './discover.ts';
import { RECEITA_AGENTS } from './receita.ts';

export interface ExtraProbe {
  installed: boolean;
  exe: string | null;
  version: string | null;
  agents: HarnessAgent[];
}

const first = (paths: string[]) => paths.find((p) => p && existsSync(p)) ?? null;

export function findHermes(): string | null {
  if (process.env.EMANNU_HERMES_EXE) return process.env.EMANNU_HERMES_EXE;
  const local = process.env.LOCALAPPDATA ?? '';
  // Instalação nativa no Windows: %LOCALAPPDATA%\hermes (documentação oficial).
  return which('hermes') ?? first([join(local, 'hermes', 'bin', 'hermes.exe'), join(local, 'hermes', 'venv', 'Scripts', 'hermes.exe'), join(homedir(), '.local', 'bin', 'hermes.exe')]);
}

export function findOpenClaw(): string | null {
  return findOpenClawExe();
}

// Só lê versão e lista de agentes: não inicia gateway, não faz login, não chama modelo.
export async function probeExtra(id: 'hermes' | 'openclaw'): Promise<ExtraProbe> {
  const exe = id === 'hermes' ? findHermes() : findOpenClaw();
  if (!exe) return { installed: false, exe: null, version: null, agents: [] };
  const call = (args: string[]) => (isNodeScript(exe) ? run(process.execPath, [exe, ...args]) : run(exe, args));
  const v = await call(['--version']);
  const version = /(\d{4}\.\d+\.\d+[\w.-]*|\d+\.\d+\.\d+)/.exec(v.out)?.[1] ?? null;
  let agents: HarnessAgent[] = [];
  if (id === 'openclaw') {
    const a = await call(['agents', 'list', '--json']);
    try {
      const list = JSON.parse(a.out.slice(a.out.search(/[[{]/)));
      agents = (Array.isArray(list) ? list : (list.agents ?? [])).map((x: any) => ({
        id: String(x.id ?? x.name), nome: String(x.name ?? x.id), papel: String(x.description ?? x.model ?? 'agente do OpenClaw'), origem: 'harness' as const, kind: null,
      }));
    } catch {}
  }
  return { installed: true, exe, version, agents };
}

// Subagentes do Claude Code: arquivos .md com "name"/"description" no cabeçalho,
// em ~/.claude/agents e em <projeto>/.claude/agents.
export function claudeSubagents(projects: Project[], home = homedir()): HarnessAgent[] {
  const dirs = [join(home, '.claude', 'agents'), ...projects.map((p) => join(p.path, '.claude', 'agents'))];
  const out: HarnessAgent[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      try {
        const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(dir, f), 'utf8'))?.[1] ?? '';
        const get = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(head)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null;
        const nome = get('name') ?? f.replace(/\.md$/, '');
        if (!out.some((a) => a.id === nome)) out.push({ id: nome, nome, papel: (get('description') ?? 'subagente do Claude Code').slice(0, 160), origem: 'harness', kind: null });
      } catch {}
    }
  }
  return out;
}

export function codexModel(home = homedir()): string | null {
  try {
    return /^model\s*=\s*"([^"]+)"/m.exec(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'))?.[1] ?? null;
  } catch {
    return null;
  }
}

const role = (id: string, nome: string, papel: string, kind: JobKind): HarnessAgent => ({ id, nome, papel, origem: 'emannu', kind });

const CLAUDE_ROLES: HarnessAgent[] = [
  role('rocky', 'Planejador (Claude)', 'Coordenador: transforma objetivos em planos', 'plan'),
  role('executor', 'Executor', 'Faz a tarefa num worktree isolado', 'task'),
  role('revisor', 'Revisor', 'Revisão cruzada do trabalho do Codex', 'review'),
  role('corretor', 'Corretor', 'Corrige o que a revisão reprovou', 'fix'),
  role('pesquisador', 'Pesquisador', 'Imigração, vagas e histórico do Claude Code (só leitura)', 'research'),
];
const CODEX_ROLES: HarnessAgent[] = [
  role('executor', 'Executor', 'Implementação e QA num worktree isolado', 'task'),
  role('revisor', 'Revisor', 'Revisão cruzada do trabalho do Claude', 'review'),
  role('corretor', 'Corretor', 'Corrige o que a revisão reprovou', 'fix'),
];
// Subagentes que já vêm no Claude Code.
const CLAUDE_BUILTIN: HarnessAgent[] = [
  { id: 'general-purpose', nome: 'general-purpose', papel: 'Subagente padrão do Claude Code', origem: 'harness', kind: null },
  { id: 'Explore', nome: 'Explore', papel: 'Busca rápida no código (só leitura)', origem: 'harness', kind: null },
  { id: 'Plan', nome: 'Plan', papel: 'Planejamento de implementação (só leitura)', origem: 'harness', kind: null },
];

const NOT_INSTALLED = {
  hermes: 'Não instalado. Agente de código aberto (Nous Research, MIT) com memória e habilidades; roda modelos locais. Integração depende da sua aprovação.',
  openclaw: 'Não instalado. Agente de código aberto com gateway e canais de mensagem; tem modo sem gateway ("agent exec"). Integração depende da sua aprovação.',
};

// Frequência legível de um horário cron simples ("30 6 * * 1-5" → "dias úteis, 06:30").
export function describeSchedule(cron: string): string {
  const [mi, h, , , dow] = cron.split(/\s+/);
  const at = /^\d+$/.test(h) && /^\d+$/.test(mi) ? `${h.padStart(2, '0')}:${mi.padStart(2, '0')}` : cron;
  const days: Record<string, string> = { '*': 'todo dia', '1-5': 'dias úteis', '1': 'segundas', '3': 'quartas', '5': 'sextas' };
  return `${days[dow] ?? `dias ${dow}`}, ${at}`;
}

// Rotinas viram agentes agendados no harness de quem as executa.
function routineAgents(routines: RoutineView[], agent: string): HarnessAgent[] {
  return routines
    .filter((r) => r.agente === agent)
    .map((r) => ({
      id: r.id,
      nome: r.nome,
      papel: r.descricao,
      origem: 'emannu',
      kind: null,
      agenda: { ultima: r.ultima?.em ?? null, proxima: r.proxima, rodando: r.ultima?.estado === 'pending' || r.ultima?.estado === 'running', frequencia: r.enabled ? describeSchedule(r.schedule) : 'desligada' },
    }));
}

export function buildHarnesses(input: {
  agents: AgentState[];
  projects: Project[];
  extras: Partial<Record<'hermes' | 'openclaw', ExtraProbe>>;
  lastModel: Partial<Record<string, string | null>>;
  routines?: RoutineView[];
}): HarnessView[] {
  const routines = input.routines ?? [];
  const byId = Object.fromEntries(input.agents.map((a) => [a.id, a]));
  const main = (id: 'claude' | 'codex'): Pick<HarnessView, 'estado' | 'versao' | 'limites'> => {
    const a = byId[id];
    return {
      estado: !a?.installed ? 'nao_instalado' : a.authenticated === false ? 'sem_login' : a.paused ? 'pausado' : 'ativo',
      versao: a?.version ?? null,
      limites: a?.paused ? a.pausedReason : (a?.note ?? null),
    };
  };
  // Agentes abertos: rodam jobs do EMANNU OS quando instalados (OpenClaw usa o Claude Code como motor).
  const OPEN_ROLES: HarnessAgent[] = [
    role('executor', 'Executor', 'Tarefas num worktree isolado (revisado pelo Codex)', 'task'),
    role('revisor', 'Revisor', 'Revisão cruzada (só leitura)', 'review'),
    role('pesquisador', 'Pesquisador', 'Pesquisas só de leitura', 'research'),
  ];
  const extra = (id: 'hermes' | 'openclaw', nome: string): HarnessView => {
    const p = input.extras[id];
    const a = byId[id];
    const installed = !!(a?.installed || p?.installed);
    return {
      id, nome, agentId: id,
      estado: !installed ? 'nao_instalado' : a?.paused ? 'pausado' : 'ativo',
      versao: a?.version ?? p?.version ?? null,
      modelo: !installed ? null : id === 'openclaw' ? 'anthropic/claude-sonnet-5-5 via Claude Code' : 'gpt-6.1-sol via ChatGPT (assinatura)',
      limites: a?.paused ? a.pausedReason : null,
      caminho: p?.exe ?? null,
      agentes: installed ? [...routineAgents(routines, id), ...OPEN_ROLES, ...(p?.agents ?? [])] : [],
      nota: !installed
        ? NOT_INSTALLED[id]
        : id === 'openclaw'
          ? 'Roda sem gateway e sem canais de mensagem ("agent exec"), com o Claude Code como motor: usa sua assinatura, sem chave paga. Configuração própria do EMANNU OS em var\openclaw.'
          : 'Sem gateway e sem serviço: roda só quando o EMANNU OS chama ("chat --format stream-json"), com o ChatGPT pela sua assinatura (login próprio do Hermes). Ferramentas liberadas: arquivos, terminal, web e lista de tarefas — sem controle da tela, agendamentos ou navegador. Instalado em var\ferramentas\hermes.',
    };
  };
  return [
    {
      id: 'claude-code', nome: 'Claude Code', agentId: 'claude', ...main('claude'),
      modelo: input.lastModel.claude ?? null, caminho: null,
      agentes: [
        ...routineAgents(routines, 'claude'),
        ...CLAUDE_ROLES,
        // Subagentes da Operação Receita, usados pelas pesquisas (ex.: mercado em Portugal).
        ...Object.entries(RECEITA_AGENTS).map(([id, a]): HarnessAgent => ({ id, nome: id, papel: a.description.split('.')[0], origem: 'emannu', kind: null })),
        ...CLAUDE_BUILTIN,
        ...claudeSubagents(input.projects),
      ],
      nota: 'Assinatura Claude: tokens aparecem com o valor equivalente na API, mas não são cobrados por token.',
    },
    {
      id: 'codex', nome: 'Codex', agentId: 'codex', ...main('codex'),
      modelo: input.lastModel.codex ?? codexModel(), caminho: null,
      agentes: [...routineAgents(routines, 'codex'), ...CODEX_ROLES],
      nota: 'Assinatura ChatGPT: o uso ao vivo vem do arquivo de sessão do Codex.',
    },
    extra('hermes', 'Hermes Agent'),
    extra('openclaw', 'OpenClaw'),
  ];
}
