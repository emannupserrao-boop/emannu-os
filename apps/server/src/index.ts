import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  CLAUDE_PROJECTS_DIR, CODE_EXTRA_DIRS, DB_PATH, HOST, IMMIGRATION_DOCS_DIR, IMMIGRATION_VAULT_FOLDER, LEGACY_COCKPIT_DIR, LEGACY_JOB_OFFERS, LOG_DIR, MUSIC_DIRS, PORT, RESEARCH_EVERY_DAYS, VAR_DIR, VAULT_DIR, WEB_DIST, WORKTREES_DIR,
} from './config.ts';
import { Immigration } from './immigration/index.ts';
import { ProjectHistory } from './history.ts';
import { Market } from './market.ts';
import { Renda } from './renda/index.ts';
import { Rocky } from './rocky.ts';
import { Alerts } from './resumo.ts';
import { probeWindows } from './gamemode.ts';
import { Conselho } from './conselho.ts';
import { Maintenance } from './manutencao.ts';
import { Benchmark } from './benchmark.ts';
import { BenchRunner } from './benchrun.ts';
import { Chats } from './chat.ts';
import { SlackBridge } from './slack.ts';
import { makeOpenclawLocalAdapter } from './runners/open-agents.ts';
import { writeReceitaAgents } from './agents/receita.ts';
import { writeOpenClawConfigs } from './runners/open-agents.ts';
import { CodeSessionIndex } from './codeSessions.ts';
import { Store } from './db.ts';
import { Scheduler } from './scheduler.ts';
import { buildApp } from './app.ts';
import { Auth } from './auth.ts';
import { Push } from './push.ts';
import { wireNotifications } from './notifications.ts';
import { git, isGitRepo } from './worktrees.ts';
import { Vault } from './vault.ts';
import { Library, findFfmpeg } from './arquivos.ts';
import { GitHubStatus } from './github.ts';
import type { LegacyImport } from './legacy.ts';

const INBOX_INTERVAL_MS = 60_000;

// Projeto de teste: um repositório git pequeno para experimentar a fila sem
// tocar nos projetos reais. Não gera notas no vault.
function ensureSandbox(store: Store) {
  const path = join(VAR_DIR, 'projetos', 'sandbox');
  if (!isGitRepo(path)) {
    mkdirSync(path, { recursive: true });
    git(path, 'init', '-b', 'main');
    writeFileSync(join(path, 'README.md'), '# Sandbox do EMANNU OS\n\nRepositório de teste para jobs dos agentes.\n');
    git(path, 'add', '.');
    git(path, '-c', 'user.name=EMANNU OS', '-c', 'user.email=emannu-os@localhost', 'commit', '-m', 'Sandbox inicial');
  }
  store.upsertProject({ id: 'sandbox', name: 'Sandbox (teste)', path, isGit: true, isTest: true });
}

// Atualiza git/pasta no vault dos projetos já cadastrados.
function refreshProjects(store: Store, vault: Vault) {
  for (const p of store.listProjects()) {
    if (p.isTest) continue;
    store.upsertProject({ ...p, isGit: isGitRepo(p.path), vaultFolder: p.vaultFolder ?? vault.findProjectFolder(p.name) });
  }
}

const store = new Store(DB_PATH);
const vault = new Vault(VAULT_DIR);
ensureSandbox(store);
if (vault.exists()) refreshProjects(store, vault);
else console.warn(`Vault não encontrado em ${VAULT_DIR}: notas desativadas.`);

const sched = new Scheduler({ store, logDir: LOG_DIR, worktreesDir: WORKTREES_DIR, vault, gameProbe: process.env.EMANNU_NO_ROUTINES ? undefined : probeWindows });
const immigration = new Immigration(sched, {
  projectPath: join(VAR_DIR, 'imigracao'),
  docsDir: IMMIGRATION_DOCS_DIR,
  vaultFolder: IMMIGRATION_VAULT_FOLDER,
  legacyOffersPath: LEGACY_JOB_OFFERS,
  researchEveryDays: RESEARCH_EVERY_DAYS,
});
immigration.init();
immigration.registerRoutines(sched.routines);
const renda = new Renda(sched, { projectPath: join(VAR_DIR, 'renda') });
renda.registerRoutines(sched.routines);
new Rocky(sched, { projectPath: join(VAR_DIR, 'rocky') }).registerRoutines(sched.routines);
new Conselho(sched, { projectPath: join(VAR_DIR, 'conselho') });
new Maintenance(sched).registerRoutines(sched.routines);
new Chats(sched, { dir: join(VAR_DIR, 'chat') }).bridge = new SlackBridge();
new BenchRunner(sched, new Benchmark(store), { projectPath: join(VAR_DIR, 'benchmark') });
sched.localAdapterFor = makeOpenclawLocalAdapter;
new Market(sched);
writeReceitaAgents();
writeOpenClawConfigs();
const history = new ProjectHistory(sched, new CodeSessionIndex(store, CLAUDE_PROJECTS_DIR), { workDir: join(VAR_DIR, 'historico'), extraDirs: CODE_EXTRA_DIRS });
history.init();
sched.recoverAfterRestart();

const auth = new Auth(store, join(VAR_DIR, 'admin-token'));
const push = new Push(store, join(VAR_DIR, 'vapid.json'));
const sendPush = (p: Parameters<typeof push.notify>[0]) => push.notify(p).catch((e) => console.warn('Notificação:', e.message));
wireNotifications(sched, sendPush);
const alerts = new Alerts(sched, sendPush);
alerts.registerRoutines(sched.routines);
alerts.wire();

// Aba Arquivos: músicas, fotos, vídeos e documentos, só leitura, direto das pastas.
const library = new Library({
  varDir: VAR_DIR,
  varAllow: ['imigracao', 'renda', 'rocky', 'conselho', 'historico', 'benchmark', 'projetos'],
  cacheDir: join(VAR_DIR, 'cache', 'miniaturas'),
  ffmpeg: findFfmpeg(),
  roots: () => [
    ...MUSIC_DIRS.map((path, i) => ({ id: i ? `musicas-${i + 1}` : 'musicas', nome: i ? basename(path) : 'Músicas (WHAT LIES BTWN)', grupo: 'musica' as const, path })),
    ...store.listProjects().filter((p) => !p.isTest).map((p) => ({ id: p.id, nome: p.name, grupo: 'projeto' as const, path: p.path })),
    { id: 'documentos-portugal', nome: 'Documentos para Portugal', grupo: 'documentos' as const, path: IMMIGRATION_DOCS_DIR },
    { id: 'vault', nome: 'Vault (Obsidian)', grupo: 'vault' as const, path: VAULT_DIR },
  ],
  legacy: () => {
    const l = store.kvGet<LegacyImport>('legado');
    const names = new Map(store.listProjects().map((p) => [p.id, p.name]));
    return [...(l?.media ?? []), ...(l?.documents ?? [])].map((f) => ({ id: f.id, project: f.project, projectName: names.get(f.project) ?? f.project, title: f.title, path: f.path }));
  },
});

const app = await buildApp({ sched, auth, push, webDist: WEB_DIST, legacyDir: LEGACY_COCKPIT_DIR, library, github: new GitHubStatus(), logger: true });
await app.listen({ host: HOST, port: PORT });
console.log(`EMANNU OS v3 rodando em http://${HOST}:${PORT}${auth.isConfigured() ? '' : ' — abra no PC para definir o PIN'}`);
sched.refreshAgents().catch((e) => console.error('Falha ao verificar agentes:', e));
sched.tick();

const scanInbox = () => {
  try {
    sched.flow.scanInbox();
  } catch (e) {
    console.error('Falha ao ler o 90 - INBOX:', e);
  }
};
scanInbox();
setInterval(scanInbox, INBOX_INTERVAL_MS);
// Resumo "o que já foi feito no Claude Code" por projeto: rotina diária (13h), no máximo
// 1x por dia por projeto e só se houver sessão nova.
history.cards = async () => {
  const cards = (await app.inject({ url: '/api/projetos', headers: { 'x-emannu-token': auth.adminToken } })).json() as any[];
  return cards.filter((c) => c.codigo?.total).map((c) => ({ id: c.id, nome: c.nome, dirs: history.dirsFor(c.id, c.pasta?.path ?? null), vaultFolder: c.vaultFolder }));
};
// CI dos projetos no GitHub: aviso no celular quando a branch principal falha.
alerts.registerGitHub(sched.routines, async () => (await app.inject({ url: '/api/projetos?github=fresco', headers: { 'x-emannu-token': auth.adminToken } })).json() as any[]);
// Rotinas (v3.1): vagas, leads, propostas, alerta legal e histórico. Única agenda do sistema.
if (!process.env.EMANNU_NO_ROUTINES) {
  sched.routines.start();
  // Modo jogo: confere a cada 60 s se você está jogando (GPU pausada até parar).
  sched.gameMode.start();
}
immigration.syncApplications();

const shutdown = () => {
  for (const [, a] of sched.active) a.proc.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
