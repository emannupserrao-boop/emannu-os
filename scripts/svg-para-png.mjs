// Converte um SVG em PNG usando o Chromium do Playwright.
// Uso: node scripts/svg-para-png.mjs entrada.svg saida.png [tamanho]
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const [input, output, sizeArg] = process.argv.slice(2);
const size = Number(sizeArg ?? 256);
const svg = readFileSync(input, 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: size, height: size } });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</body></html>`);
await page.locator('svg').screenshot({ path: output, omitBackground: true });
await browser.close();
console.log(`${output} (${size}x${size})`);
