# EMANNU OS v3

Sistema que coordena o **Claude** e o **Codex** nos seus projetos, com fila, revisão cruzada, notas no vault, a seção **Imigração Portugal** e acesso pelo celular.

## Abrir
- **No PC:** ícone **EMANNU OS** na área de trabalho ou no menu Iniciar (abre numa janela própria). Para fixar na barra de tarefas: abra pelo ícone e, na barra, botão direito → **Fixar na barra de tarefas**. Recriar os ícones: `powershell -ExecutionPolicy Bypass -File scripts\criar-icones.ps1` (remover: `-Remover`).
- Alternativa: `Iniciar EMANNU OS.cmd`. Se já estiver rodando, ele só abre o navegador em http://127.0.0.1:8850.
- **No celular:** app instalado (ícone "EMANNU OS"), pelo Tailscale. Guia: [docs/GUIA-CELULAR.md](docs/GUIA-CELULAR.md).
- **Abre sozinho ao entrar no Windows** (ativado em 27/10/2026), sem janela. Log: `var\logs\servidor.log`.
  Desativar: `powershell -ExecutionPolicy Bypass -File scripts\iniciar-com-windows.ps1 -Remover`.
- **Parar:** dois cliques em `Parar EMANNU OS.cmd` (encerra também os agentes que estiverem rodando). Para religar: `Iniciar EMANNU OS.cmd`.

## Abas
| Aba | Para quê |
|---|---|
| **Renda** | Criativos Motion (R$ 290 / US$ 79, 5 motions de até 15 s, 50% de entrada): metas de 08/11 e 27/11, funil Pronto → Enviado → Respondeu → Pago → Perdido, recebido (caixa) separado do previsto, conversão, seu tempo por pacote e motivos de perda. "Marquei como enviado", "Respondeu", "Recebi R$…" e "Perdido" só valem com **um aparelho seu + confirmação na tela** (agentes nunca confirmam envio nem recebimento). |
| **Chat** | Uma caixa única para falar com **Claude**, **Claude Code**, **GPT** (Hermes), **Codex**, **Conselho** e, se a ponte do Slack estiver ativa, o **Rocky** (seu dot do ChatGPT). **Conversar** só responde, sem ferramentas de escrita, e continua a mesma sessão do agente. **Executar** vira um job na fila, com worktree e revisão. Tem microfone no celular, anexos de até 2 MB, histórico por conversa e "Transformar em objetivo". A ponte do Rocky é configurada em ⚙ → Integrações: o token fica só neste PC, e se o Rocky não responder ao teste a ponte é abandonada. |
| **Hoje** | Seu bloco de 45 min: as ações do dia em ordem, com o tempo de cada uma e um botão por ação (copiar texto, abrir link, marcar enviado, registrar pagamento, enviar candidatura, decisões). No topo, as 3 prioridades do Planejador; pedidos de tempo extra dele aparecem com "Sim/Não". |
| **Rotinas** | A única agenda do sistema (horário de Bucareste): próxima e última execução, resultado e liga/desliga de cada rotina; pausas do modo jogo; memória do Hermes; e o **Conselho** (a mesma pergunta para Claude e ChatGPT, independentes, com síntese das divergências). |
| **Atividades** | Jobs em 5 colunas. "Aguardando você" reúne o que precisa da sua decisão. |
| **Objetivos** | Você escreve o que quer → o Planejador (Claude) faz o plano → você aprova → os agentes executam e revisam um ao outro → merge final com você. |
| **Agentes** | Cada programa que roda agentes (Claude Code, Codex, OpenClaw, Hermes): os agentes que existem nele, quem está trabalhando agora e, em cada execução, **contexto usado** (barra) e **tokens** (entrada, saída, cache e o valor equivalente na API — na assinatura não é cobrado por token). Clicar num agente da barra do topo abre o card dele aqui. **OpenClaw** já roda jobs (escolha em "+ Job"): sem gateway e sem canais de mensagem, com o Claude Code como motor (sua assinatura, sem chave paga), revisado pelo Codex. **Hermes** também roda jobs: sem gateway e sem serviço, com o ChatGPT pela sua assinatura (login próprio do Hermes) e só com ferramentas de arquivos, terminal, web e tarefas; revisado pelo Claude. Os dois ficam em `var\ferramentas` (o app do Claude virtualiza o AppData). No Claude Code também aparecem os agentes de busca da **Operação Receita** (pesquisador e analista), usados nas pesquisas. Análise no vault: `80 - AUTOMATION\Análise - Hermes e OpenClaw no EMANNU OS`. |
| **Projetos** | Cards compactos em colunas: estado atual (vault), **GitHub** (repositório, último CI da branch principal, PRs abertos e a branch/alterações da pasta no PC; só leitura pelo `gh`, com aviso no celular quando o CI da branch principal falha), **o que já foi feito no Claude Code**, entregas, mídias e documentos. Clique no **ícone ou no nome** para abrir o painel do projeto, com todas as atividades dele e tudo expandido. |
| **Arquivos** | Suas mídias e documentos direto das pastas do PC, **só leitura** (nada é copiado nem alterado): **Músicas** (os discos de `D:\Musicas` primeiro; o player fica no rodapé, continua tocando ao trocar de aba e tem controles na tela de bloqueio do celular), **Fotos** (álbuns por pasta, miniaturas feitas pelo ffmpeg em `var\cache\miniaturas`), **Vídeos**, **Documentos** (Markdown e texto abrem na tela; PDF abre no PC e, no celular, pelo leitor do aparelho; Word/Excel pelo Baixar) e **Pastas** (navegar como no Explorador). Fontes: Músicas, as pastas de cada projeto, Documentos para Portugal, o vault e o que o cockpit antigo listava fora delas. Pastas técnicas, arquivos de senha/token/chave e os dados internos em `var\` nunca aparecem. Na aba Hoje, arquivo de tarefa que está nessas pastas ganha "Abrir aqui". |
| **Imigração Portugal** | Espaço próprio: rotas, documentos (com os arquivos da sua pasta de referência), prazos, orçamento, **vagas em Portugal**, **apartamentos**, escola e fontes. Vagas e apartamentos têm filtros (busca, região, tipologia, renda máxima, só com visto) e ordenação (mais importantes, salário/renda maior↔menor, mais novas↔antigas); as mais importantes ganham **destaque** (borda com brilho e os motivos: perto de Leiria, serve para visto, salário, preço). O **caçador diário** refaz vagas (Portugal e IA) e apartamentos 1x ao dia; rotas, documentos e custo de vida, 1x por semana. |
| **IA** | Carreira e trabalho com IA: **Vagas de IA** (remotas, plataformas de treinamento de modelos; usam o `Resume Emannuel AI.pdf`) e **Panorama** (notas Current State de carreira e aprendizado de IA). |
| **⚙** | Instalar app, notificações, aparelhos com acesso, trocar o PIN. |

**Mudar a ordem das abas:** clique no lápis ao lado das abas, arraste (PC) ou use as setas (celular) e clique em "Pronto". A ordem fica salva no PC e vale para todos os aparelhos; "Ordem padrão" desfaz.

**Pesquisa de mercado (Operação Receita):** `POST /api/mercado/portugal/pesquisar` (ou peça ao Claude aqui) roda o pesquisador e o analista da Receita sobre sites e presença online em Portugal (prioridade Leiria). O resultado vai para `80 - AUTOMATION\Projetos\Operação Receita - Mercado Portugal`. Só leitura: contato com empresas é sempre você.

Pasta de referência dos documentos (CVs, plano migratório, certidões): `C:\Users\you\Documents\Documentos para portugal e vagas`. O app lista só nome, tamanho e data e sugere a qual item do checklist cada arquivo corresponde; os agentes só leem essa pasta.

Visual: tema escuro "clean" (fonte Inter, bordas finas) com animações curtas — troca de aba, painéis que deslizam, cards que entram em cascata. Quem ativa "reduzir movimento" no Windows/Android não vê animações.

## Rotinas (v3.1)
| Quando | Quem | O quê |
|---|---|---|
| 06h30 (dias úteis) | Hermes | Leads Motion (3 qualificados/dia; sem completar a cota com contatos fracos) |
| 06h30 (todo dia) | Hermes | Vagas (Portugal e IA) e apartamentos |
| 06h30 (segunda) | Hermes | Alerta legal, documentos e custo de vida |
| 07h00 e 17h30 (dias úteis) | Planejador (Claude) | Plano do dia e fechamento (+ replanejamento depois de conclusões, até 6/dia) |
| 07h15 (dias úteis) | Claude | Propostas para os leads qualificados |
| 08h00 | Sistema | Resumo no celular: prioridades, ações do dia, prazos e AMARELOS |
| 13h00 | Claude | Histórico do Claude Code (no máximo 1x por dia por projeto) |
| Quarta 15h00 | Sistema | Modo manutenção: bloco semanal no Current State dos projetos fora do foco |
| Sexta 17h00 | Sistema | Relatório da semana em `80 - AUTOMATION\Relatórios` |

**Capacidade:** grupos Claude (Claude, Rocky, OpenClaw), ChatGPT (Codex, Hermes) e local; 30% dos minutos do dia ficam para entregas de cliente; limite de uso pausa o grupo inteiro e mostra quando volta. **GPU:** um job por vez, clientes primeiro. **Modo jogo:** jogo aberto (Dota, Steam), app em tela cheia ou GPU ocupada por outro programa pausam só a fila de GPU; volta 10 min depois. "Pausar tudo durante o jogo" fica no ⚙. **Jobs:** até 120 min, com checkpoint a cada 15; dois checkpoints sem progresso encerram a tentativa (log e arquivos ficam). **Auto-merge:** no Sandbox, depois de PASS da revisão cruzada no mesmo diff e testes num candidato isolado; vale para todos os projetos depois de 10 integrações limpas e do 4º dia; autenticação/PIN, permissões e migrações destrutivas são sempre AMARELO; regressão suspende e reverte.

## Regras (o que roda sozinho)
- **Verde (automático):** ler, pesquisar, editar no worktree, testar, notas do job, jobs de até 120 min, pacotes de registro oficial com lockfile e versões fixadas, auto-merge nos projetos elegíveis, atualizar o bloco gerado dos Current State.
- **Amarelo (um toque seu):** pacote fora do critério, programas no Windows (o LM Studio já está autorizado), merge em autenticação/PIN, permissões ou migração destrutiva, mudar estes limites, canal novo (Telegram, gateway).
- **Vermelho (sempre você):** enviar mensagens ou candidaturas, publicar, gastar, credenciais, apagar fora do projeto. O sistema só prepara.

## Onde ficam as coisas
| O quê | Onde |
|---|---|
| Banco (jobs, objetivos, imigração, aparelhos) | `var\emannu.db` |
| Log de cada job (o "recibo") | `var\logs\<job>.jsonl` |
| Cópias de trabalho dos jobs | `D:\Claude Code\emannu-os-worktrees\` |
| Notas | vault: `80 - AUTOMATION\Jobs\`, `40 - PERSONAL\Imigração Portugal\`, Current State de cada projeto |
| Documentos pessoais da imigração | `D:\Imigracao Portugal - documentos (local)` (fora do vault e do git) |
| Cockpit antigo | só leitura; importado sozinho quando muda |

## Manutenção
- **Depois de atualizar o código:** `Parar EMANNU OS.cmd` e depois `Iniciar EMANNU OS.cmd` (ele refaz a interface).
- **Backup:** pare o EMANNU OS e copie a pasta `var\` (principalmente `emannu.db`, `vapid.json` e `admin-token`).
- **Esqueceu o PIN:** pare o EMANNU OS e rode `node --disable-warning=ExperimentalWarning scripts\redefinir-pin.mjs`. Depois crie um PIN novo no PC; os celulares entram de novo.
- **Testes:** `npm test` (servidor) e `npm run test:e2e` (celular no emulador Android).
- **Histórico do Claude Code:** cada projeto lê as sessões do Code da sua pasta (e de pastas extras em `apps\server\src\config.ts` → `CODE_EXTRA_DIRS`, ex.: WHAT LIES BTWN também lê `D:\Musicas`). Execuções automáticas do EMANNU OS não entram.
- **Atualizar o Claude/Codex:** pelos próprios apps. O EMANNU OS encontra os executáveis sozinho.
- **Desligar o acesso pelo celular:** `tailscale serve --https=443 off` (religar: `Ativar celular.cmd`).

## Problemas comuns
| Sintoma | O que fazer |
|---|---|
| Celular diz "Sem conexão com o PC" | O PC está desligado/dormindo, o EMANNU OS está fechado ou o Tailscale está desligado em algum dos dois. |
| Fila do Claude/Codex "pausada" | Limite de uso da assinatura. Quando liberar, toque em **Retomar** na barra de agentes. |
| Job falhou | Abra o job: o log mostra o motivo. **Reexecutar** cria um novo. |
| Notificação não chega | No celular: ⚙ → Enviar teste. Se não chegar, libere a bateria do Chrome ("Sem restrições"). |

Arquitetura: [docs/ARQUITETURA.md](docs/ARQUITETURA.md) · Progresso fase a fase: vault `80 - AUTOMATION/Emannu OS v3 - Progresso.md`.
