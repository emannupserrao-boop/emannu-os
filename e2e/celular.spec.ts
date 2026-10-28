import { test, expect, devices, type Page, type BrowserContext } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// Cabeçalhos que o "tailscale serve" acrescenta: o pedido chega como vindo de fora do PC.
const VIA_TAILSCALE = { 'x-forwarded-for': '100.101.102.103', 'tailscale-user-login': 'emannuel@example.com' };
const PIN = '246810';
const SHOTS = 'docs/capturas';
mkdirSync(SHOTS, { recursive: true });

test.describe.configure({ mode: 'serial' });

let pc: BrowserContext;
let phone: BrowserContext;

test.afterAll(async () => {
  await pc?.close();
  await phone?.close();
});

async function minFontAndTargets(page: Page) {
  return page.evaluate(() => {
    const visible = (e: Element) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const texts = [...document.querySelectorAll('body *')].filter(
      (e) => visible(e) && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()),
    );
    // Ignora texto escondido de propósito (tamanho 0) e marcas decorativas (aria-hidden).
    const small = texts
      .filter((e) => {
        const size = parseFloat(getComputedStyle(e).fontSize);
        return size > 0 && size < 14 && !e.closest('[aria-hidden="true"]');
      })
      .map((e) => `${e.tagName}.${e.className}`);
    const targets = [...document.querySelectorAll('button, select, input:not([type=checkbox]):not([type=radio]), a.btn')].filter(visible);
    const tiny = targets.filter((e) => e.getBoundingClientRect().height < 36).map((e) => `${e.tagName}.${e.className}:${e.textContent?.trim().slice(0, 20)}`);
    return { small, tiny, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  });
}

test('PWA instalável: manifesto, ícones e service worker', async ({ request, browser }) => {
  const m = await (await request.get('/manifest.webmanifest')).json();
  expect(m).toMatchObject({ name: 'EMANNU OS', display: 'standalone', start_url: '/' });
  for (const icon of m.icons) {
    const r = await request.get(icon.src);
    expect(r.ok()).toBe(true);
    expect(r.headers()['content-type']).toContain('image/png');
  }
  expect(m.icons.map((i: any) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
  expect(m.icons.some((i: any) => i.purpose === 'maskable')).toBe(true);

  // O contexto herda o Pixel 7 do projeto; o PC precisa de identidade de desktop explícita.
  pc = await browser.newContext({
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:8861',
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    hasTouch: false,
  });
  const page = await pc.newPage();
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
});

test('no PC: primeiro acesso define o PIN e entra', async () => {
  const page = await pc.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Crie o PIN de acesso' })).toBeVisible();
  await page.getByLabel('PIN', { exact: true }).fill(PIN);
  await page.getByLabel('Repita o PIN').fill(PIN);
  await expect(page.getByLabel('Nome deste aparelho')).toHaveValue('PC');
  await page.getByRole('button', { name: 'Criar PIN e entrar' }).click();
  await expect(page.getByRole('tab', { name: /Atividades/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tab', { name: /Atividades/ })).toBeVisible(); // continua lembrado
});

test('no PC (1440px): aba Projetos com dados do cockpit antigo', async () => {
  const page = pc.pages().at(-1)!;
  await page.getByRole('tab', { name: 'Projetos' }).click();
  await expect(page.locator('.pcard').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.waitForTimeout(1500); // miniaturas
  await page.screenshot({ path: `${SHOTS}/fase5-pc-projetos.png` });
  await page.screenshot({ path: `${SHOTS}/visual-depois-pc.png` });
  await page.getByRole('tab', { name: /Atividades/ }).click();
  await page.waitForTimeout(900); // fim das animações de entrada
  await page.screenshot({ path: `${SHOTS}/visual-depois-pc-atividades.png` });
});

test('no PC: aba Agentes mostra os 4 harnesses, papéis e o estado de Hermes/OpenClaw', async () => {
  const page = pc.pages().at(-1)!;
  await page.getByRole('tab', { name: /^Agentes/ }).click();
  for (const h of ['Claude Code', 'Codex', 'Hermes Agent', 'OpenClaw']) await expect(page.getByRole('heading', { name: h })).toBeVisible();
  await expect(page.locator('#harness-claude').getByText('Planejador (Claude)', { exact: true })).toBeVisible();
  await expect(page.getByText('Não instalado').first()).toBeVisible();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/agentes-pc.png`, fullPage: true });
  await page.getByRole('tab', { name: /Atividades/ }).click();
});

test('no PC: abas em outra ordem (salva no PC), projeto e agente clicáveis', async () => {
  const page = pc.pages().at(-1)!;
  const tabNames = () => page.getByRole('tablist', { name: 'Visão' }).getByRole('tab').allInnerTexts();
  await page.getByRole('button', { name: 'Personalizar a ordem das abas' }).click();
  await page.getByRole('button', { name: 'Mover Projetos para a esquerda' }).click();
  await page.getByRole('button', { name: 'Mover Projetos para a esquerda' }).click();
  await page.getByRole('button', { name: 'Pronto' }).click();
  // Renda, Chat e Hoje (v3.1) vêm primeiro na ordem padrão.
  expect((await tabNames()).map((t) => t.replace(/\d+/g, '').trim()).slice(0, 6)).toEqual(['Renda', 'Chat', 'Hoje', 'Atividades', 'Projetos', 'Objetivos']);
  await page.reload();
  expect((await tabNames()).map((t) => t.replace(/\d+/g, '').trim())[4]).toBe('Projetos'); // continua depois de recarregar

  // Projeto: o nome abre o painel com as atividades do projeto.
  await page.getByRole('tab', { name: 'Projetos' }).click();
  await page.locator('.ptitle-link').filter({ hasText: 'MIRAE' }).click();
  await expect(page.getByRole('dialog', { name: 'MIRAE' }).getByText('Atividades deste projeto')).toBeVisible();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/projeto-painel-pc.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/projetos-pc.png` });

  // Agente: clicar no Codex da barra abre a aba Agentes no card dele.
  await page.getByRole('button', { name: 'Ver Codex na aba Agentes' }).click();
  await expect(page.getByRole('tab', { name: 'Agentes' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#harness-codex')).toBeInViewport();

  // Volta para a ordem padrão.
  await page.getByRole('button', { name: 'Personalizar a ordem das abas' }).click();
  await page.getByRole('button', { name: 'Ordem padrão' }).click();
  await page.getByRole('button', { name: 'Pronto' }).click();
  await page.getByRole('tab', { name: /Atividades/ }).click();
});

// income_ui (v3.1): metas, funil e o botão humano com confirmação.
test('no PC: aba Renda com metas e funil; "Marquei como enviado" pede confirmação; aba Hoje', async () => {
  const page = pc.pages().at(-1)!;
  await page.getByRole('tab', { name: /^Hoje/ }).click();
  await expect(page.getByText('Enviar proposta para Agência Exemplo')).toBeVisible();
  await expect(page.getByText('5 de 45 min')).toBeVisible(); // proposta (3) + objetivo do INBOX (2)
  await expect(page.getByText('Começar objetivo do INBOX: Objetivo de teste do celular')).toBeVisible();
  await page.waitForTimeout(700); // fim da transição entre abas
  await page.screenshot({ path: `${SHOTS}/hoje-pc.png` });

  await page.getByRole('tab', { name: /^Renda/ }).click();
  await expect(page.getByRole('progressbar', { name: '1º pagamento recebido' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: '3 pilotos pagos' })).toBeVisible();
  const ready = page.locator('.col-ready .pcard-renda').filter({ hasText: 'Agência Exemplo' });
  await expect(ready).toContainText('R$ 290,00');
  await page.waitForTimeout(700); // fim da transição entre abas
  await page.screenshot({ path: `${SHOTS}/renda-pc.png` });
  await ready.getByRole('button', { name: 'Marquei como enviado' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Você enviou esta proposta?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.locator('.col-sent .pcard-renda').filter({ hasText: 'Agência Exemplo' })).toBeVisible();
  await expect(page.locator('.col-ready .pcard-renda')).toHaveCount(0);
  // "Perdido" exige o motivo antes de confirmar.
  await page.locator('.col-sent .pcard-renda').getByRole('button', { name: 'Perdido (motivo)' }).click();
  const lost = page.getByRole('alertdialog', { name: 'Marcar como perdido' });
  await expect(lost.getByRole('button', { name: 'Confirmar' })).toBeDisabled();
  await lost.getByRole('button', { name: 'Voltar' }).click();
  await page.getByRole('tab', { name: /Atividades/ }).click();
});

test('no PC: seção IA separada (vagas de IA) e Imigração só com vagas em Portugal', async () => {
  const page = pc.pages().at(-1)!;
  await page.getByRole('tab', { name: /^IA/ }).click();
  await expect(page.getByRole('tab', { name: /Vagas de IA/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Panorama' })).toBeVisible();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/visual-depois-pc-ia.png` });
  await page.getByRole('tab', { name: /^Imigração/ }).click();
  await page.getByRole('tab', { name: 'Vagas em Portugal' }).click();
  // Filtros: Leiria primeiro em destaque; salário do maior para o menor.
  const titles = () => page.locator('.offer .ititle').allInnerTexts();
  await expect(page.locator('.offer.destaque').first()).toContainText('SMARTIDIOM');
  await page.getByLabel('Ordenar').selectOption('salario-desc');
  expect((await titles())[0]).toContain('SMARTIDIOM');
  await page.getByLabel('Ordenar').selectOption('salario-asc');
  expect((await titles())[0]).toContain('The Bridge'); // € 1.000 < Nortempo ≈ € 1.036 < Foundever ≈ € 1.082 < SMARTIDIOM; sem salário no fim
  expect((await titles()).at(-1)).toContain('Valérius');
  await page.getByLabel('Ordenar').selectOption('importancia');
  await page.getByRole('button', { name: /Região de Leiria/ }).click();
  expect((await titles()).every((t) => /SMARTIDIOM|Nortempo|The Bridge/.test(t))).toBe(true);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/vagas-filtros-pc.png` });
  await page.getByRole('button', { name: 'Todas', exact: true }).click();
  await page.getByRole('tab', { name: 'Apartamentos' }).click();
  await expect(page.locator('.offer.destaque').first()).toContainText('T2 renovado');
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/apartamentos-pc.png` });
  await page.getByRole('tab', { name: 'Documentos' }).click();
  await page.getByRole('tab', { name: /Atividades/ }).click();
});

test('celular pelo Tailscale: não pode criar PIN; entra com PIN; "Aguardando você" no topo', async ({ browser }) => {
  phone = await browser.newContext({ ...(test.info().project.use as object), baseURL: 'http://127.0.0.1:8861', extraHTTPHeaders: VIA_TAILSCALE });
  const page = await phone.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/fase4-celular-login.png` });

  await page.getByLabel('PIN', { exact: true }).fill('111111');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByText(/PIN errado. Restam 4/)).toBeVisible();

  await page.getByLabel('PIN', { exact: true }).fill(PIN);
  await expect(page.getByLabel('Nome deste aparelho')).toHaveValue('Celular Android');
  await page.getByRole('button', { name: 'Entrar' }).click();

  const waiting = page.getByRole('region', { name: 'Aguardando você' });
  await expect(waiting).toBeVisible();
  await expect(waiting.getByText('Objetivo de teste do celular')).toBeVisible();
  const box = await waiting.boundingBox();
  expect(box!.y).toBeLessThan(500); // logo no topo, sem precisar rolar
  await page.screenshot({ path: `${SHOTS}/fase4-celular-painel.png` });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/visual-depois-celular.png` });

  const check = await minFontAndTargets(page);
  expect(check.overflow).toBe(false);
  expect(check.small).toEqual([]);
  expect(check.tiny).toEqual([]);
});

// chat_mobile_voice_input (v3.1, seção 13): microfone do celular preenche a mensagem.
test('celular: aba Chat com seletor de agente e microfone (voz vira texto)', async () => {
  const page = phone.pages()[0];
  // Reconhecimento de voz simulado (o do Android não existe no emulador).
  await page.addInitScript(() => {
    (window as any).SpeechRecognition = (window as any).webkitSpeechRecognition = class {
      lang = '';
      interimResults = false;
      onresult: any = null;
      onend: any = null;
      onerror: any = null;
      start() {
        setTimeout(() => {
          this.onresult?.({ results: [[{ transcript: 'quero uma proposta para a agência exemplo' }]] });
          this.onend?.();
        }, 150);
      }
      stop() {
        this.onend?.();
      }
    };
  });
  await page.reload();
  await page.getByRole('tab', { name: /^Chat/ }).click();
  await expect(page.getByRole('combobox', { name: 'Agente' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Conversar' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Falar (microfone)' }).click();
  await expect(page.getByRole('textbox', { name: 'Mensagem' })).toHaveValue('quero uma proposta para a agência exemplo');
  // Claude Code só executa (vira job na fila).
  await page.getByRole('combobox', { name: 'Agente' }).selectOption('claude-code');
  await expect(page.getByRole('radio', { name: 'Executar' })).toHaveAttribute('aria-checked', 'true');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/chat-celular.png` });
});

// Aba Arquivos: ouvir as músicas (o player continua em outra aba), ver fotos e ler documentos.
test('celular: aba Arquivos toca música, segue tocando em outra aba, abre foto e documento', async () => {
  const page = phone.pages()[0];
  await page.getByRole('tab', { name: /^Arquivos/ }).click();
  await page.getByRole('button', { name: /^WAV/ }).click();
  await page.getByRole('button', { name: 'Tocar tudo' }).click();
  const bar = page.getByRole('region', { name: 'Player de música' });
  await expect(bar).toContainText('Ashes in my veins');
  await expect(bar.getByRole('button', { name: 'Pausar' })).toBeVisible();
  // Trocar de aba não para a música.
  await page.getByRole('tab', { name: /^Hoje/ }).click();
  await expect(bar.getByRole('button', { name: 'Pausar' })).toBeVisible();
  await bar.getByRole('button', { name: 'Próxima música' }).click();
  await expect(bar).toContainText('Bitter End');
  await page.getByRole('tab', { name: /^Arquivos/ }).click();
  await page.waitForTimeout(700);
  expect(await minFontAndTargets(page)).toEqual({ small: [], tiny: [], overflow: false });
  await page.screenshot({ path: `${SHOTS}/arquivos-celular-musicas.png` });

  await page.getByRole('tab', { name: /^Fotos/ }).click();
  await page.getByRole('button', { name: /^Visual content/ }).click();
  await page.getByRole('button', { name: 'Capa.png' }).click();
  const foto = page.getByRole('dialog', { name: 'Capa.png' });
  await expect(foto.locator('img')).toBeVisible();
  await expect(foto.getByRole('link', { name: 'Baixar' })).toHaveAttribute('href', /baixar=1$/);
  await foto.getByRole('button', { name: 'Fechar' }).click();

  await page.getByRole('tab', { name: /^Documentos/ }).click();
  await page.getByRole('searchbox', { name: 'Buscar' }).fill('letras');
  await page.getByRole('button', { name: /^Letras\.md/ }).click();
  const doc = page.getByRole('dialog', { name: 'Letras.md' });
  await expect(doc).toContainText('Ashes in my veins, ao vivo.');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/arquivos-celular-documento.png` });
  await doc.getByRole('button', { name: 'Fechar' }).click();
  await bar.getByRole('button', { name: 'Fechar o player' }).click();
  await expect(bar).toBeHidden();
});

test('todas as abas no celular: sem rolagem lateral, texto ≥ 14px, toques ≥ 44px', async () => {
  const page = phone.pages()[0];
  for (const tab of ['Renda', 'Chat', 'Hoje', 'Rotinas', 'Objetivos', 'Agentes', 'Projetos', 'Arquivos', 'Imigração', 'IA', 'Atividades']) {
    await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
    await page.waitForTimeout(800);
    const check = await minFontAndTargets(page);
    expect({ tab, ...check }).toEqual({ tab, small: [], tiny: [], overflow: false });
    if (tab === 'Projetos') {
      await expect(page.locator('.pcard').first()).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/fase5-celular-projetos.png` });
    }
  }
});

test('PC desligado: o app abre com o último retrato e avisa', async () => {
  const page = phone.pages()[0];
  await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true));
  await page.waitForTimeout(3000); // tempo para salvar o retrato dos dados
  await page.reload();
  await expect(page.getByRole('tab', { name: /Atividades/ })).toBeVisible();

  await phone.setOffline(true);
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: 'Sem conexão com o PC' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Objetivo de teste do celular')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/fase4-celular-offline.png` });
  await phone.setOffline(false);
  await expect(page.getByText('ao vivo').or(page.locator('.conn.on'))).toBeVisible({ timeout: 20_000 });
});

test('Celular e notificações: aparelhos, notificações e revogação', async () => {
  const page = phone.pages()[0];
  const names = await page.evaluate(() => fetch('/api/auth/devices').then((r) => r.json()).then((l) => l.map((d: any) => d.name).sort()));
  expect(names).toEqual(['Celular Android', 'PC']);
  await page.getByRole('button', { name: 'Celular e notificações' }).click();
  const drawer = page.getByRole('dialog', { name: 'Celular e notificações' });
  await expect(drawer.getByText('Celular Android')).toBeVisible();
  await expect(drawer.getByText('(este)')).toBeVisible();
  // Via http://127.0.0.1 o navegador considera o endereço seguro, então o botão aparece.
  await expect(drawer.getByRole('button', { name: 'Ativar notificações' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/fase4-celular-aparelhos.png` });

  // O PC revoga o celular: o celular volta para a tela de PIN.
  const pcPage = pc.pages()[0] ?? (await pc.newPage());
  const list = await pcPage.evaluate(() => fetch('/api/auth/devices').then((r) => r.json()));
  const android = list.find((d: any) => d.name === 'Celular Android');
  await pcPage.evaluate((id) => fetch(`/api/auth/devices/${id}`, { method: 'DELETE' }), android.id);
  await drawer.getByRole('button', { name: 'Fechar' }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
});
