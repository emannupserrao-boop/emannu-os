# EMANNU OS no celular Android — guia em 5 passos

O PC é o motor; o celular é o controle remoto. O acesso passa pelo **Tailscale**: uma rede privada só entre os seus aparelhos. O EMANNU OS **não fica exposto à internet** (sem porta aberta no roteador, sem "Funnel").

## 1. Tailscale no PC
1. Baixe e instale: https://tailscale.com/download/windows (o Windows vai pedir permissão de administrador).
2. Entre com sua conta (Google ou Microsoft).
3. No painel https://login.tailscale.com/admin/dns: deixe **MagicDNS** ligado e clique em **Enable HTTPS**.

## 2. Tailscale no celular
1. Instale **Tailscale** pela Play Store.
2. Entre com a **mesma conta** do PC e deixe a chave ligada.

## 3. No PC: PIN e acesso pelo celular
1. Dê dois cliques em **Iniciar EMANNU OS.cmd**. Na primeira vez, o app pede para **criar o PIN** (6 a 12 números).
2. Dê dois cliques em **Ativar celular.cmd**. Ele mostra um endereço como `https://meu-pc.SEU-NOME.ts.net/`. Anote.

## 4. No celular: abrir e instalar
1. No **Chrome**, abra o endereço do passo 3.
2. Digite o PIN. O nome do aparelho já vem como "Celular Android".
3. Menu **⋮** → **Instalar app** (ou "Adicionar à tela inicial"). O ícone do EMANNU OS aparece na tela inicial.

## 5. Notificações
1. Abra o app instalado → botão **⚙** (Celular e notificações) → **Ativar notificações** → permita.
2. Toque em **Enviar notificação de teste**. Deve chegar em alguns segundos.

Você recebe aviso de: "Aguardando você" (aprovar plano, merge, decisão após revisão), job concluído ou falhou, entrega pronta e fila pausada por limite de uso.

---

## Segurança
- Sem o PIN, ninguém usa o app, mesmo dentro da sua rede Tailscale. Errou 5 vezes: bloqueio de 15 minutos.
- Cada aparelho fica lembrado. Perdeu o celular? No PC: ⚙ → **Aparelhos com acesso** → **Revogar**.
- O PIN só pode ser criado no próprio PC.

## Quando o PC está desligado ou dormindo
O app abre mesmo assim, mostra os **últimos dados salvos** e um aviso vermelho "Sem conexão com o PC". As ações voltam quando o PC acordar. Para o PC não dormir, ajuste em Configurações do Windows → Sistema → Energia (decisão sua; eu não alterei).

## O que foi testado no emulador e o que só você pode testar no aparelho
**Testado no emulador Android (Playwright, Pixel 7, 390 px):** manifesto e ícones do PWA, service worker, PIN no PC, login do celular pela rede do Tailscale (simulada), bloqueio de PIN, "Aguardando você" no topo, textos ≥ 14 px e botões ≥ 44 px sem rolagem lateral, modo offline com o último retrato, revogação de aparelho.

**Só no aparelho físico:**
1. A instalação de verdade ("Instalar app") e o ícone na tela inicial.
2. **Notificações chegando com o app fechado e a tela bloqueada** (o emulador não tem o serviço de push do Google).
3. O endereço `https://….ts.net` com o Tailscale ligado no 4G/5G (fora do Wi-Fi de casa).
4. O comportamento com o PC dormindo e acordando.
5. Economia de bateria do Android: se as notificações atrasarem, em Configurações → Apps → Chrome → Bateria, escolha "Sem restrições".
