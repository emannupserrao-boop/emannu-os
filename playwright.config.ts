import { defineConfig, devices } from '@playwright/test';

// Testes no emulador Android do Playwright (Pixel 7, Chrome). O servidor de teste
// usa dados temporários (scripts/e2e-server.mjs), na porta 8861.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8861',
    ...devices['Pixel 7'],
    viewport: { width: 390, height: 844 },
    locale: 'pt-BR',
  },
  webServer: {
    command: 'node --disable-warning=ExperimentalWarning scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:8861/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
