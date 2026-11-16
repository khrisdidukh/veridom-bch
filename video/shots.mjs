// Screenshots of the home page (mainnet) at desktop and phone width. Needs `npm run preview`.
import { chromium } from 'playwright';
const BASE = process.env.BASE ?? 'http://localhost:4319/';
const OUT = process.env.OUT ?? new URL('./raw/', import.meta.url).pathname;
const browser = await chromium.launch({ proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined });
for (const [name, viewport] of [['desk', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.goto(BASE);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/home-${name}.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log(name, 'horizontal overflow:', overflow);
  if (name === 'desk') {
    await page.click('#wallet-button'); await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/wallet-${name}.png` });
  }
  await page.close();
}
await browser.close();
