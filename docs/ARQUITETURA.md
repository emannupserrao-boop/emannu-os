# EMANNU OS v3 — Arquitetura (proposta, 2026-10-27)

1. Monorepo `D:\Claude Code\emannu-os` com git, TypeScript e Node 24 (já instalado). npm workspaces: `apps/server`, `apps/web`, `packages/shared`.
2. Servidor Fastify em `127.0.0.1:8850` (porta nova; a 8847 fica com o legado). Escuta só em localhost; o `tailscale serve` leva o HTTPS para a tailnet.
3. Banco SQLite embutido do Node (`node:sqlite`), sem compilação nativa no Windows. Se der problema, troco por better-sqlite3. Tabelas: objectives, jobs, job_events, approvals, locks, agents.
4. Tempo real: SSE em `/api/stream` (eventos de job, log ao vivo, estado dos agentes).
5. Runners como processos filhos, com executáveis descobertos sozinhos (PATH → `~\.local\bin\claude.exe` → `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`):
   - Claude: `claude -p --output-format stream-json --verbose --permission-mode dontAsk --allowedTools <lista VERDE>`, guardando o session_id para `--resume`.
   - Codex: `codex exec --json -C <worktree> -s workspace-write`, guardando o thread_id para `exec resume`.
   - Ambiente limpo (sem variáveis da sessão que chamou), timeout por job, cancelamento com `taskkill /T /F`, detecção de "limite de uso" que pausa a fila do agente.
6. Worktrees fora dos repositórios: `D:\Claude Code\emannu-os-worktrees\<projeto>\<job>`. Lock por projeto/caminho no SQLite. Pastas sem git (vault, mídias): lock por arquivo e escrita só em arquivos novos.
7. Governança VERDE/AMARELO/VERMELHO como dado do job; AMARELO vira um card em "Aguardando você"; VERMELHO o sistema só prepara.
8. Front: PWA com Vite + React, mobile-first, dark. Service worker próprio com o último snapshot para uso offline.
9. Notificações: Web Push (biblioteca `web-push`, chaves VAPID locais). Não depende de servidor de terceiros para guardar conteúdo e funciona com o PWA instalado.
10. Acesso: PIN → token de dispositivo (cookie httpOnly). Ações AMARELAS/VERMELHAS pedem confirmação no app.
11. Vault: adaptador que lê frontmatter e só acrescenta blocos datados ou cria notas novas. Nunca reescreve nota escrita à mão.
12. Inicialização: `Iniciar EMANNU OS.cmd`; a tarefa no Agendador do Windows é opcional (AMARELO).
13. Testes: vitest (servidor e runners) e Playwright (capturas em 390px e 1440px, emulador Android).
