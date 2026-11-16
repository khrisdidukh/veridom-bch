// Drives the real app on chipnet with the practice wallet. Used for the smoke test,
// the screenshots and the demo recording (RECORD=1). Needs `npm run build` + `npm run preview`.
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:4319/';
const RECORD = process.env.RECORD === '1';
const MOBILE = process.env.MOBILE === '1';
const profile = process.env.PROFILE ?? '/tmp/veridom-profile';
const out = new URL('./raw/', import.meta.url).pathname;
fs.mkdirSync(out, { recursive: true });
const size = MOBILE ? { width: 390, height: 844 } : { width: 1920, height: 1080 };
const marks = [];
const t0 = Date.now();
const mark = (name) => { marks.push({ name, t: (Date.now() - t0) / 1000 }); console.log(name, marks.at(-1).t.toFixed(1)); };

const context = await chromium.launchPersistentContext(profile, {
  viewport: size,
  deviceScaleFactor: 1,
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined,
  ...(RECORD ? { recordVideo: { dir: out, size } } : {}),
});
const page = context.pages()[0] ?? await context.newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 200)); });
const pause = (ms) => page.waitForTimeout(ms);
const shot = async (name) => { if (!RECORD) await page.screenshot({ path: `${out}${MOBILE ? 'm-' : ''}${name}.png`, fullPage: MOBILE }); };
const click = async (selector, wait = 900) => { const el = page.locator(selector).first(); await el.scrollIntoViewIfNeeded(); await pause(350); await el.click(); await pause(wait); };
const toastGone = () => page.waitForFunction(() => document.getElementById('toast').hidden, null, { timeout: 30000 }).catch(() => {});
const waitStatus = (text, nth = 0) => page.waitForFunction(([t, n]) => {
  const list = [...document.querySelectorAll('.stage .status')].map((e) => e.textContent.trim());
  return list[n] === t;
}, [text, nth], { timeout: 90000 });

await page.goto(`${BASE}?provider=rest`);
await pause(1500);
mark('home');
await shot('01-home');
if (await page.locator('#network').inputValue() !== 'chipnet') await click('[data-action="to-chipnet"]', 1500);
if (!(await page.locator('#wallet-button').textContent()).includes('Practice')) { await click('#wallet-button'); await click('[data-action="practice"]', 1500); }
mark('wallet');
// test coins if the practice wallet is low
const balance = async () => Number((await page.locator('#wallet-button').textContent()).match(/([\d.]+) tBCH/)?.[1] ?? 0);
if (await balance() < 0.00026) {
  await click('#wallet-button');
  await shot('02-wallet');
  await click('[data-action="faucet"]', 500);
  await page.waitForFunction(() => /0\.000[23]/.test(document.getElementById('wallet-button').textContent), null, { timeout: 60000 });
  await toastGone();
}
mark('funded-wallet');
await page.evaluate(() => { location.hash = ''; });
await pause(800);
await page.locator('[data-f="title"]').fill('Garden studio, Vienna');
await click('[data-action="warranty"][data-v="past"]');
await page.locator('#create').scrollIntoViewIfNeeded();
await pause(1200);
await shot('03-form');
mark('form');
await click('[data-action="create"]', 2500);
await page.waitForSelector('[data-action="fund"]', { timeout: 60000 });
await pause(1500);
await shot('04-escrow-new');
mark('escrow');
await click('[data-action="fund"]', 500);
await waitStatus('Locked', 1);
await pause(1500);
await shot('05-locked');
mark('locked');
await toastGone();
await click('[data-action="release"][data-i="0"]', 500);
await waitStatus('Paid', 0);
await pause(2000);
await shot('06-stage1-paid');
mark('paid1');
await toastGone();
await click('[data-action="refund"][data-i="1"]', 500);
await waitStatus('Settled by 2 signatures', 1);
await pause(2000);
await shot('07-stage2-refunded');
mark('refund2');
await toastGone();
await click('[data-action="claim"]', 500);
await waitStatus('Paid to builder', 2);
await pause(2500);
await shot('08-retention-paid');
mark('claimed');
await page.locator('.log').scrollIntoViewIfNeeded().catch(() => {});
await pause(2500);
await shot('09-activity');
mark('end');
fs.writeFileSync(`${out}${MOBILE ? 'm-' : ''}marks.json`, JSON.stringify({ url: page.url(), marks }, null, 2));
await context.close();
