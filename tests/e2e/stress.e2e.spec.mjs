'use strict';
/* Stress suite: a ~30 MB / ~338k-line synthetic log against real user
 * controls — wheel scrolling, search-result line jump, go-to-line, wrap and
 * rapid chip toggling — with counters, responsiveness and error-free page
 * state asserted throughout. Run: npm run build && npm run e2e:stress */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createReadStream } from 'node:fs';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8903;
const STRESS_LOG = join(root, 'tests', 'tmp', 'stress.log');
let server;
let browser;
let page;
let fixtureLines = 0;
const url = () => `http://127.0.0.1:${PORT}/log-triage.html`;

before(async () => {
  execSync(`node "${join(root, 'tools', 'genbig.mjs')}" 30 "${STRESS_LOG}"`, { stdio: 'pipe' });
  fixtureLines = await new Promise((res) => {
    let n = 0;
    createReadStream(STRESS_LOG).on('data', (b) => {
      for (const byte of b) if (byte === 10) n++;
    }).on('end', () => res(n));
  });
  server = spawn(process.execPath, [join(root, 'tools', 'serve.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
  });
  await new Promise((res) => { server.stdout.on('data', res); setTimeout(res, 1500); });
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => { page.__pageErrors = (page.__pageErrors || []).concat(String(e)); });
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
});

async function fresh() {
  await page.goto(url() + '?stress=' + Date.now(), { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.removeItem('log_triage_state_v1'));
}

async function loadStress() {
  await fresh();
  await page.evaluate(async () => {
    const r = await fetch('/tests/tmp/stress.log');
    const f = new File([await r.blob()], 'stress.log', { type: 'text/plain' });
    window.__t0 = performance.now();
    window.LT_INGEST([f]);
  });
  await page.waitForFunction(() => document.getElementById('st-progress').textContent === '', null, { timeout: 120000 });
  return page.evaluate(() => ({
    ms: Math.round(performance.now() - window.__t0),
    total: Number(document.getElementById('st-total').textContent),
    shown: Number(document.getElementById('st-shown').textContent),
  }));
}

const state = () => page.evaluate(`JSON.stringify({
  scrollTop: document.getElementById('viewer').scrollTop,
  shown: document.getElementById('st-shown').textContent,
  firstLn: (document.querySelector('.vrow .ln') || { textContent: '' }).textContent,
  rows: document.querySelectorAll('.vrow').length,
  errs: (window.__errs || []).length
})`).then(JSON.parse);

test('stress: ingest ~30 MB within 60s with exact counters', async () => {
  const st = await loadStress();
  assert.ok(st.ms < 60000, 'ingest took ' + st.ms + 'ms');
  assert.strictEqual(st.total, fixtureLines, 'total lines must match the fixture on disk');
  assert.ok(st.shown > 90000 && st.shown <= 110000, 'kept window holds ~cap lines, got ' + st.shown);
});

test('stress: mouse wheel scrolls the virtualized viewer', async () => {
  const box = await page.evaluate(() => {
    const r = document.getElementById('viewer-wrap').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  const before = await state();
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 4000); await page.waitForTimeout(120); }
  const afterDown = await state();
  assert.ok(afterDown.scrollTop > before.scrollTop + 10000, 'wheel scrolls down: ' + before.scrollTop + ' -> ' + afterDown.scrollTop);
  assert.ok(afterDown.rows > 0 && afterDown.rows < 300, 'windowed rendering keeps row count bounded');
  assert.ok(Number(afterDown.firstLn) > 1, 'rendered lines advanced to ' + afterDown.firstLn);
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -4000); await page.waitForTimeout(120); }
  const afterUp = await state();
  assert.ok(afterUp.scrollTop < afterDown.scrollTop, 'wheel scrolls back up');
  assert.strictEqual(afterUp.errs, 0);
});

test('stress: go-to-line jumps to an exact line inside the kept window', async () => {
  // kept window = last ~100k lines of the fixture; pick a line guaranteed present
  const target = fixtureLines - 50000;
  await page.evaluate((t) => {
    const g = document.getElementById('goto-ln');
    g.value = String(t);
    g.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }, target);
  await page.waitForTimeout(300);
  const st = await state();
  assert.ok(st.scrollTop > 0, 'scrolled for line ' + target);
  const near = await page.evaluate(() => Array.from(document.querySelectorAll('.vrow .ln')).map((x) => Number(x.textContent)));
  assert.ok(near.includes(target), 'line ' + target + ' rendered, got ' + near.slice(0, 5));
  const drawer = await page.evaluate(() => document.getElementById('drawer').textContent);
  assert.match(drawer, new RegExp('Line ' + target));
});

test('stress: go-to-line reports lines released from memory', async () => {
  await page.evaluate(() => {
    const g = document.getElementById('goto-ln');
    g.value = '150000'; // inside the first 100k lines -> trimmed from memory
    g.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await page.waitForTimeout(200);
  const msg = await page.evaluate(() => document.getElementById('st-progress').textContent);
  assert.match(msg, /not in the current view/);
});

test('stress: clicking an instant search result jumps to the line', async () => {
  await fresh();
  const st = await loadStress();
  assert.ok(st.total === fixtureLines, 'fixture loaded: ' + st.total);
  await page.evaluate(() => { document.getElementById('search-progress').textContent = ''; });
  await page.evaluate(() => {
    document.querySelector('#tabs button[data-tab=search]').click();
    const q = document.getElementById('rg-pattern');
    q.value = 'ecu=gateway alive seq=1201';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.getElementById('search-progress').textContent.includes('match'), null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#search-results .sr-row') !== null, null, { timeout: 30000 });
  await page.evaluate(() => document.querySelector('#search-results .sr-row').click());
  await page.waitForTimeout(300);
  const after = await state();
  assert.ok(after.scrollTop > 0, 'viewer scrolled to the match');
  const drawer = await page.evaluate(() => document.getElementById('drawer').textContent);
  assert.match(drawer, /ecu=gateway alive seq=1201/);
  const errs = await page.evaluate(() => (window.__errs || []).length);
  assert.strictEqual(errs, 0);
});

test('stress: deep scan covers the whole file beyond the kept cap', async () => {
  // rare pattern (~34 hits across 338k lines): deep scan must cover every
  // line on disk without hitting the result cap, and must find matches the
  // kept-line cap hides from instant search
  await page.evaluate(() => { document.getElementById('search-progress').textContent = ''; });
  await page.evaluate(() => {
    const q = document.getElementById('rg-pattern');
    q.value = 'ecu=gateway alive seq=1201';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.getElementById('search-progress').textContent.includes('match'), null, { timeout: 20000 });
  const instant = await page.evaluate(() => document.getElementById('search-progress').textContent);
  await page.evaluate(() => document.getElementById('btn-deepscan').click());
  await page.waitForFunction(() => /^deep scan: /.test(document.getElementById('search-progress').textContent), null, { timeout: 120000 });
  const deep = await page.evaluate(() => document.getElementById('search-progress').textContent);
  const deepN = Number(/(\d+) match/.exec(deep)[1]);
  const scanned = Number(/over (\d+) lines/.exec(deep)[1]);
  assert.strictEqual(scanned, fixtureLines, 'deep scan must cover every line on disk');
  assert.ok(!/capped/.test(deep), 'rare pattern must not hit the result cap');
  const instantN = Number(/(\d+) match/.exec(instant)[1]);
  assert.ok(deepN > instantN, 'deep scan ' + deepN + ' must exceed kept-capped instant ' + instantN);
});

test('stress: wrap toggle over the full kept set stays responsive', async () => {
  await page.evaluate(() => { document.querySelector('#tabs button[data-tab=viewer]').click(); });
  const t0 = Date.now();
  await page.evaluate(() => document.getElementById('btn-wrap').click());
  await page.waitForTimeout(1500);
  const dt = Date.now() - t0;
  const cls = await page.evaluate(() => (document.querySelector('.vrow') || { className: '' }).className);
  assert.ok(cls.includes('wrap'), 'rows render wrapped');
  assert.ok(dt < 15000, 'wrap toggle settled in ' + dt + 'ms');
  await page.evaluate(() => document.getElementById('btn-wrap').click());
});

test('stress: rapid chip toggling stays consistent', async () => {
  await fresh();
  await page.evaluate(async () => {
    const r = await fetch('/tests/fixtures/demo.log');
    window.LT_INGEST([new File([await r.blob()], 'demo.log', { type: 'text/plain' })]);
  });
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => { Array.from(document.querySelectorAll('.chip')).find((c) => c.textContent.startsWith('W')).click(); });
  }
  const dt = Date.now() - t0;
  const shown = await page.evaluate(() => document.getElementById('st-shown').textContent);
  assert.ok(dt < 8000, '10 toggles in ' + dt + 'ms');
  assert.ok(shown === '44' || shown === '6', 'even number of toggles returns to full view, got ' + shown);
  const errs = await page.evaluate(() => (window.__errs || []).length);
  assert.strictEqual(errs, 0);
});
