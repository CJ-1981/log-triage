'use strict';
/* E2E suite: Playwright Chromium against the built single-file HTML.
 * Run: npm run build && npm run e2e  (CI installs playwright + chromium first). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8901;
let server;
let browser;
let page;
const url = () => `http://127.0.0.1:${PORT}/log-triage.html`;

before(async () => {
  server = spawn(process.execPath, [join(root, 'tools', 'serve.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
  });
  await new Promise((res) => { server.stdout.on('data', res); setTimeout(res, 1500); });
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  page = await ctx.newPage();
  page.on('pageerror', (e) => { page.__pageErrors = (page.__pageErrors || []).concat(String(e)); });
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
});

async function fresh(hash) {
  await page.goto(url() + (hash || ''), { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.removeItem('log_triage_state_v1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
}

async function click(id) {
  await page.evaluate((i) => document.getElementById(i).click(), id);
}

const status = () => page.evaluate(`JSON.stringify({
  total: document.getElementById('st-total').textContent,
  shown: document.getElementById('st-shown').textContent,
  chips: Array.from(document.querySelectorAll('.chip')).map(c => c.textContent),
  fmt: (document.querySelector('.badge.fmt') || {}).textContent,
  errs: window.__errs || []
})`).then(JSON.parse);

test('selftest page passes the full shared suite', async () => {
  await page.goto(url() + '?selftest', { waitUntil: 'domcontentloaded' });
  const text = await page.evaluate(() => document.getElementById('st-body').querySelector('p').textContent);
  assert.match(text, /passed/);
  assert.match(text, /, 0 failed/);
});

test('demo log: detection badge, chips, viewer rows, masking', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent !== '0', null, { timeout: 8000 });
  const st = await status();
  assert.strictEqual(st.fmt, 'logcat');
  assert.ok(st.chips.length >= 4, 'dynamic level chips rendered: ' + st.chips.join(' '));
  assert.ok(st.shown === '44');

  // mask ON by default: raw VIN hidden, masked token visible
  const masked = await page.evaluate(() => document.body.innerText.includes('YV4**********4567'));
  assert.ok(masked, 'masked VIN token shown');

  await click('btn-mask');
  const raw = await page.evaluate(() => document.body.innerText.includes('YV4AB9CD12EF34567'));
  assert.ok(raw, 'raw VIN visible after mask OFF');
  await click('btn-mask');
});

test('quick filter narrows view and highlights matches', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '44');
  await page.evaluate(() => {
    const q = document.getElementById('quick');
    q.value = 'heartbeat';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '4');
  const marks = await page.evaluate(() => document.querySelectorAll('mark').length);
  assert.strictEqual(marks, 4);
});

test('multi-file load keeps per-file counters and merged view', async () => {
  await fresh();
  await page.setInputFiles('#file-input', [
    join(root, 'tests', 'fixtures', 'demo.log'),
    join(root, 'tests', 'fixtures', 'syslog.log'),
    join(root, 'tests', 'fixtures', 'apache.log'),
  ]);
  await page.waitForFunction(() => document.querySelectorAll('.file-item').length === 3, null, { timeout: 8000 });
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '61', null, { timeout: 8000 });
  const badges = await page.evaluate(() => Array.from(document.querySelectorAll('.file-item .badge.fmt')).map((b) => b.textContent));
  assert.deepStrictEqual(badges.sort(), ['apache', 'logcat', 'syslog']);
  // merged timeline: rows carry a file column
  const fileCells = await page.evaluate(() => document.querySelectorAll('.vrow .fl').length);
  assert.ok(fileCells > 0, 'merged view shows file column');
});

test('ripgrep search: instant results and deep scan agree on small files', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '44');
  await page.evaluate(() => {
    const q = document.getElementById('rg-pattern');
    q.value = 'heartbeat ecu=tcam';
    q.dispatchEvent(new Event('input'));
  });
  const instant = await page.evaluate(() => document.getElementById('search-progress').textContent);
  assert.match(instant, /3 match/);
  await click('btn-deepscan');
  await page.waitForFunction(() => document.getElementById('search-progress').textContent.includes('deep scan'));
  const deep = await page.evaluate(() => document.getElementById('search-progress').textContent);
  assert.match(deep, /3 match/);
  // grouped results with rg-style prefix
  const first = await page.evaluate(() => (document.querySelector('#search-results .sr-row .ln') || { textContent: '' }).textContent);
  assert.match(first, /demo\.log:\d+:/);
});

test('theme switch persists across reload', async () => {
  await fresh();
  await page.evaluate(() => {
    const s = document.getElementById('theme-sel');
    s.value = 'paper';
    s.dispatchEvent(new Event('change'));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const theme = await page.evaluate(() => document.body.dataset.theme);
  assert.strictEqual(theme, 'paper');
});

test('bookmark survives reload via file-identity persistence', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  await page.evaluate(() => document.querySelector('.vrow .bm').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  const marked = await page.evaluate(() => document.querySelector('.vrow .bm').classList.contains('marked'));
  assert.ok(marked);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  const markedAfter = await page.evaluate(() => document.querySelector('.vrow .bm').classList.contains('marked'));
  assert.ok(markedAfter, 'bookmark restored after reload');
});

test('export produces a downloadable txt with masked content', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=export]').click());
  const downloadPromise = page.waitForEvent('download', { timeout: 8000 });
  await click('exp-txt');
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /log-triage-extract\.log$/);
  const path = await download.path();
  const fs = await import('node:fs');
  const content = fs.readFileSync(path, 'utf8');
  assert.ok(content.includes('YV4**********4567'), 'exported text is masked');
  assert.ok(!content.includes('YV4AB9CD12EF34567'), 'exported text contains no raw VIN');
});
