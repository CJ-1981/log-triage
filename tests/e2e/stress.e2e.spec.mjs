'use strict';
/* Stress suite: a ~30 MB / ~338k-line synthetic log against real user
 * controls — wheel scrolling, search-result line jump, go-to-line, wrap and
 * rapid chip toggling — with counters, responsiveness and error-free page
 * state asserted throughout. Run: npm run build && npm run e2e:stress */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createReadStream } from 'node:fs';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let PORT = 8903;
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
  // wait until the server reports its bound port
  PORT = await new Promise((res) => {
    server.stdout.on('data', (d) => {
      const m = String(d).match(/SERVER_PORT:(\d+)/);
      if (m) res(Number(m[1]));
    });
    setTimeout(() => res(PORT), 3000);
  });
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => { page.__pageErrors = (page.__pageErrors || []).concat(String(e)); });
});

/** number of deterministic RAREJUMPMARKER lines in the fixture (n % 100000 === 9999) */
function expectedMarkers() {
  let count = 0;
  for (let n = 9999; n < fixtureLines; n += 100000) count++;
  return count;
}

after(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
});

afterEach(async () => {
  const errs = page && page.__pageErrors ? page.__pageErrors.splice(0) : [];
  assert.strictEqual(errs.length, 0, 'uncaught page errors: ' + errs.join(' | '));
});

async function fresh() {
  await page.goto(url() + '?stress=' + Date.now(), { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.deleteDatabase('log-triage-cache');
    r.onsuccess = r.onerror = r.onblocked = () => res();
  }));
  await page.evaluate(() => localStorage.removeItem('log_triage_state_v1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
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
  assert.strictEqual(st.shown, fixtureLines, 'the whole indexed file is the view scope (no kept-window trim)');
});

test('stress: mouse wheel pages across page boundaries in the virtualized viewer', async () => {
  const box = await page.evaluate(() => {
    const r = document.getElementById('viewer-wrap').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  const before = await state();
  // several big wheels cross the 500-row page edge; the app then loads the
  // next page and the rendered line numbers advance past the old page
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 4000); await page.waitForTimeout(150); }
  const afterDown = await state();
  assert.ok(Number(afterDown.firstLn) > Number(before.firstLn), 'rendered lines advanced: ' + before.firstLn + ' -> ' + afterDown.firstLn);
  assert.ok(afterDown.rows > 0 && afterDown.rows < 300, 'windowed rendering keeps row count bounded');
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -4000); await page.waitForTimeout(150); }
  const afterUp = await state();
  assert.ok(Number(afterUp.firstLn) <= Number(afterDown.firstLn), 'wheeling back returns toward earlier lines');
  assert.strictEqual(afterUp.errs, 0);
});

test('stress: go-to-line jumps to an exact line late in the file', async () => {
  // every indexed line is reachable now; pick one well past the old cap
  const target = fixtureLines - 50000;
  await page.evaluate((t) => {
    const g = document.getElementById('goto-ln');
    g.value = String(t);
    g.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }, target);
  // the jump is async (worker locate + page load) — wait for the line
  await page.waitForFunction((t) => Array.from(document.querySelectorAll('.vrow .ln')).map((x) => Number(x.textContent)).includes(t), target, { timeout: 15000 });
  const st = await state();
  assert.ok(st.scrollTop > 0, 'scrolled for line ' + target);
  const drawer = await page.evaluate(() => document.getElementById('drawer').textContent);
  assert.match(drawer, new RegExp('Line ' + target));
});

test('stress: go-to-line reaches early lines that the old cap used to release', async () => {
  // line 150000 used to be outside the 100k kept window; with full-file
  // paging it must load its page and open the detail drawer
  const target = 150000;
  await page.evaluate((t) => {
    const g = document.getElementById('goto-ln');
    g.value = String(t);
    g.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }, target);
  await page.waitForFunction((t) => {
    const lns = Array.from(document.querySelectorAll('.vrow .ln')).map((x) => Number(x.textContent));
    return lns.includes(t);
  }, target, { timeout: 15000 });
  const drawer = await page.evaluate(() => document.getElementById('drawer').textContent);
  assert.match(drawer, new RegExp('Line ' + target));
  assert.strictEqual(await page.evaluate(() => (window.__errs || []).length), 0);
});

test('stress: clicking an instant search result jumps to the line', async () => {
  await fresh();
  const st = await loadStress();
  assert.ok(st.total === fixtureLines, 'fixture loaded: ' + st.total);
  await page.evaluate(() => { document.getElementById('search-progress').textContent = ''; });
  await page.evaluate(() => {
    document.querySelector('#tabs button[data-tab=search]').click();
    const q = document.getElementById('rg-pattern');
    q.value = 'RAREJUMPMARKER';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.getElementById('search-progress').textContent.includes('match'), null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#search-results .sr-row') !== null, null, { timeout: 30000 });
  await page.evaluate(() => document.querySelector('#search-results .sr-row').click());
  await page.waitForTimeout(300);
  const after = await state();
  assert.ok(after.scrollTop > 0, 'viewer scrolled to the match');
  const drawer = await page.evaluate(() => document.getElementById('drawer').textContent);
  assert.match(drawer, /RAREJUMPMARKER/);
  const errs = await page.evaluate(() => (window.__errs || []).length);
  assert.strictEqual(errs, 0);
});

test('stress: deep scan covers the whole file beyond the kept cap', async () => {
  // the rare RAREJUMPMARKER lines sit at fixed positions: deep scan must
  // cover every line on disk and find markers the kept-line cap hides
  const expectMarkers = expectedMarkers();
  assert.ok(expectMarkers >= 2, 'fixture should contain several markers');
  await page.evaluate(() => { document.getElementById('search-progress').textContent = ''; });
  await page.evaluate(() => {
    const q = document.getElementById('rg-pattern');
    q.value = 'RAREJUMPMARKER';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.getElementById('search-progress').textContent.includes('match'), null, { timeout: 30000 });
  const instant = await page.evaluate(() => document.getElementById('search-progress').textContent);
  await page.evaluate(() => document.getElementById('btn-deepscan').click());
  await page.waitForFunction(() => /^deep scan: /.test(document.getElementById('search-progress').textContent), null, { timeout: 120000 });
  const deep = await page.evaluate(() => document.getElementById('search-progress').textContent);
  const deepN = Number(/(\d+) match/.exec(deep)[1]);
  const scanned = Number(/over (\d+) lines/.exec(deep)[1]);
  assert.strictEqual(scanned, fixtureLines, 'deep scan must cover every line on disk');
  assert.ok(!/capped/.test(deep), 'rare pattern must not hit the result cap');
  assert.strictEqual(deepN, expectMarkers, 'deep scan must find every marker');
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
