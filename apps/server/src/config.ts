import { resolve, join } from 'node:path';
import type { RunnableAgent } from '../../../packages/shared/types.ts';

export const ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const VAR_DIR = process.env.EMANNU_VAR_DIR ?? join(ROOT, 'var');
export const DB_PATH = join(VAR_DIR, 'emannu.db');
export const LOG_DIR = join(VAR_DIR, 'logs');
export const WORKTREES_DIR = process.env.EMANNU_WORKTREES_DIR ?? resolve(ROOT, '..', 'emannu-os-worktrees');
export const WEB_DIST = join(ROOT, 'apps', 'web', 'dist');

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.EMANNU_PORT ?? 8850);

export const AGENT_LIMITS: Record<RunnableAgent, number> = { claude: 1, codex: 1, openclaw: 1, hermes: 1 };

export const DEFAULT_TIMEOUT_MIN = 30;
// v3.1: jobs de até 120 min são VERDES (com checkpoint a cada 15); acima disso são recusados.
export const LONG_JOB_MIN = 120;
export const CHECKPOINT_MIN = 15;
// Modo jogo: processos que contam como jogo (além de executáveis em pastas steamapps\common).
export const GAME_PROCESSES = (process.env.EMANNU_GAME_PROCESSES ?? 'dota2.exe').split(',').map((s) => s.trim()).filter(Boolean);
// Limite de uso detectado: o grupo inteiro pausa por este tempo (ou até você retomar).
export const USAGE_PAUSE_MIN = 60;

// Fuso das rotinas e do painel Hoje (v3.1). Dias úteis: segunda a sexta.
export const TIMEZONE = process.env.EMANNU_TZ ?? 'Europe/Bucharest';
// Clientes brasileiros: o que for para eles sai até 14h de Brasília.
export const BR_CUTOFF = { timezone: 'America/Sao_Paulo', hour: 14 };

export const VAULT_DIR = process.env.EMANNU_VAULT_DIR ?? 'C:\\Users\\you\\Documents\\EMANNU-OS-Migration\\STAGING-EMANNU-OS';
// Pasta de referência da Imigração (currículos, plano migratório e, depois, os documentos
// pessoais): fora do vault (que sincroniza) e fora do git. Os agentes só leem.
export const IMMIGRATION_DOCS_DIR = process.env.EMANNU_IMMIGRATION_DOCS_DIR ?? 'C:\\Users\\you\\Documents\\Documentos para portugal e vagas';
export const IMMIGRATION_VAULT_FOLDER = '40 - PERSONAL\\Imigração Portugal';
// Seção IA: vagas de IA e panorama de carreira/aprendizado.
export const AI_VAULT_FOLDER = '50 - CAREER & AI WORK';
export const AI_LEARNING_VAULT_FOLDER = '30 - AI LEARNING CENTER';
export const RESEARCH_EVERY_DAYS = 7;
// Histórico das sessões do Claude Code (um .jsonl por sessão, por pasta de trabalho).
export const CLAUDE_PROJECTS_DIR = process.env.EMANNU_CLAUDE_PROJECTS_DIR ?? `${process.env.USERPROFILE ?? ''}\\.claude\\projects`;
// Pastas onde o trabalho de cada projeto aconteceu no Code, além da pasta do projeto.
export const CODE_EXTRA_DIRS: Record<string, string[]> = {
  'what-lies-btwn': ['D:\\Musicas', 'D:\\What Lies Btwn'],
  'operacao-receita': ['D:\\Claude Code\\landing-video-produto'],
  mirae: ['C:\\Users\\you\\Documents\\Dota AI Coach Project', 'D:\\MIRAE', 'C:\\Users\\you\\MIRAE-Research'],
  'emannu-os': ['C:\\Windows\\System32'],
};

// Avisos fixos sobre a pasta de um projeto (mostrados no card).
export const PROJECT_NOTES: Record<string, string> = {
  serron:
    'Código não localizado. A única pasta encontrada é D:\\OBS\\Lives_Serron, que é o perfil de streaming do OBS (configurações, não código) e por isso não foi vinculada. A nota Current State no vault também registra a origem como pendente.',
};

// Cockpit antigo (LEGADO, somente leitura).
// Operação Receita: a equipe de especialistas (só leitura para o EMANNU OS).
export const RECEITA_DIR = process.env.EMANNU_RECEITA_DIR ?? 'C:\\Users\\you\\Documents\\Operacao-Receita-2026';
export const LEGACY_COCKPIT_DIR = process.env.EMANNU_LEGACY_DIR ?? 'C:\\Users\\you\\Documents\\Codex\\2026-10-17\\task-2\\cockpit-emannu-os';
// Aba Arquivos: pastas de música (WHAT LIES BTWN), além das pastas dos projetos, do vault e dos documentos.
export const MUSIC_DIRS = (process.env.EMANNU_MUSIC_DIRS ?? 'D:\\Musicas;D:\\What Lies Btwn').split(';').map((s) => s.trim()).filter(Boolean);
export const LEGACY_JOB_OFFERS = `${LEGACY_COCKPIT_DIR}\\JOB-OFFERS-20261021.json`;

// Ferramentas que o Claude pode usar sem pedir (nível VERDE), por tipo de job.
// Planos e revisões só leem; trabalho e correção editam dentro do worktree.
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
// Comandos compostos (cd x && node y; echo z) são checados parte por parte:
// cada parte precisa estar liberada, por isso os utilitários de leitura entram aqui.
const SAFE_BASH = [
  'Bash(npm test*)', 'Bash(npm run *)', 'Bash(npx *)', 'Bash(node *)', 'Bash(git status*)', 'Bash(git diff*)',
  'Bash(git log*)', 'Bash(git show*)', 'Bash(ls*)', 'Bash(pwd)', 'Bash(date*)', 'Bash(python *)', 'Bash(godot *)',
  'Bash(cd *)', 'Bash(echo *)', 'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(wc *)', 'Bash(grep *)',
  'Bash(sort *)', 'Bash(diff *)',
];
export const CLAUDE_TOOLS = {
  plan: { tools: READ_TOOLS, allowed: READ_TOOLS },
  // Pesquisas podem chamar subagentes (Task), como os da Operação Receita, também só leitura.
  research: { tools: [...READ_TOOLS, 'Task'], allowed: [...READ_TOOLS, 'Task'] },
  review: { tools: [...READ_TOOLS, 'Bash'], allowed: [...READ_TOOLS, ...SAFE_BASH] },
  task: { tools: [...READ_TOOLS, 'Write', 'Edit', 'Bash'], allowed: [...READ_TOOLS, 'Write', 'Edit', 'Bash(npm *)', ...SAFE_BASH] },
};

export const GOVERNANCE_PROMPT = `Você é um executor do EMANNU OS v3.
- Trabalhe apenas dentro do diretório atual (um git worktree isolado deste job). Ele já é o diretório de trabalho: rode comandos direto, sem "cd" para outro lugar.
- Não faça commit, push nem merge: o sistema cuida disso depois da aprovação do Emannuel.
- Nunca envie mensagens, publique, gaste dinheiro, use API paga, mexa em credenciais ou segurança, nem apague nada fora deste diretório. Se a tarefa exigir isso, pare e explique o que seria necessário.
- Ao terminar, responda com um resumo curto em português do Brasil: o que mudou, como testar e o que ficou pendente.`;

export const USAGE_LIMIT_RE = /usage limit|rate[ _-]?limit|limit reached|hit your limit|quota exceeded|too many requests|\b429\b/i;
