'use strict';
/* E2E suite: Playwright Chromium against the built single-file HTML.
 * Run: npm run build && npm run e2e  (CI installs playwright + chromium first). */
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let PORT = 0; let basePort = PORT; // OS-assigned free port
let server;
let browser;
let page;
const url = () => `http://127.0.0.1:${PORT}/log-triage.html`;

before(async () => {
  server = spawn(process.execPath, [join(root, 'tools', 'serve.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
  });
  // wait until the server reports its bound port (works for OS-assigned ports too)
  await new Promise((res, rej) => {
    const onData = (d) => {
      const m = String(d).match(/SERVER_PORT:(\d+)/);
      if (m) res(Number(m[1]));
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
    setTimeout(() => rej(new Error('static server did not report SERVER_PORT within 3s')), 3000);
  }).then((p) => { PORT = p; });
  await new Promise((res) => { server.stdout.on('data', () => res()); setTimeout(res, 300); });
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  page = await ctx.newPage();
  // force the bounded download-fallback sink in all tests; the picker path is
  // exercised separately with a stub
  await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
  page.on('pageerror', (e) => { page.__pageErrors = (page.__pageErrors || []).concat(String(e)); });
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
});

// TDD enhancement (retrospective R1): every test must end with zero uncaught
// page errors — UI handlers that throw (e.g. undefined functions) fail here
afterEach(async () => {
  const errs = page && page.__pageErrors ? page.__pageErrors.splice(0) : [];
  assert.strictEqual(errs.length, 0, 'uncaught page errors: ' + errs.join(' | '));
});

// all specs share one page: a test that fails mid-run must not leak its
// phone-width viewport into the next spec (review 2026-09)
afterEach(async () => {
  if (page) await page.setViewportSize({ width: 1440, height: 900 });
});

async function fresh(hash) {
  await page.goto(url() + (hash || ''), { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.deleteDatabase('log-triage-cache');
    r.onsuccess = r.onerror = r.onblocked = () => res();
  }));
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
  filtered: (function () { const e = document.getElementById('st-filtered'); return !!e && !e.classList.contains('hidden'); })(),
  filterBtn: (document.getElementById('btn-filter') || {}).textContent || null,
  errs: window.__errs || []
})`).then(JSON.parse);

/* SPEC-VIEWER-002 helpers: master Filter toggle + FILTERED badge state */
const fstate = () => page.evaluate(`JSON.stringify({
  total: document.getElementById('st-total').textContent,
  shown: document.getElementById('st-shown').textContent,
  badgeHidden: (function () { const e = document.getElementById('st-filtered'); return !e || e.classList.contains('hidden'); })(),
  badgeTitle: (document.getElementById('st-filtered') || {}).title || '',
  btnLabel: (document.getElementById('btn-filter') || {}).textContent || null,
  btnOn: (function () { const b = document.getElementById('btn-filter'); return !!b && b.classList.contains('on'); })(),
  btnTitle: (document.getElementById('btn-filter') || {}).title || '',
  hud: (document.getElementById('zen-hud') || {}).textContent || ''
})`).then(JSON.parse);

// add a filter rule through the Filters tab (each edit re-renders the table,
// so the row is re-queried after every step); back to the viewer afterwards
async function addRule(pattern, action) {
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=filters]').click());
  await click('btn-add-rule');
  const patternLoc = page.locator('#rule-rows tr:last-child [data-k=pattern]');
  await patternLoc.fill(pattern);
  await patternLoc.press('Tab');
  if (action) {
    await page.evaluate((a) => {
      const sel = document.querySelector('#rule-rows tr:last-child [data-k=action]');
      sel.value = a;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, action);
  }
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
}

async function setQuick(text) {
  await page.evaluate((t) => {
    const q = document.getElementById('quick');
    q.value = t;
    q.dispatchEvent(new Event('input'));
  }, text);
}

async function setTimeRange(from, to) {
  await page.evaluate((v) => {
    const t = document.getElementById('time-from');
    t.value = v[0];
    t.dispatchEvent(new Event('change', { bubbles: true }));
  }, [from, to]);
  if (to) {
    await page.evaluate((v) => {
      const t = document.getElementById('time-to');
      t.value = v;
      t.dispatchEvent(new Event('change', { bubbles: true }));
    }, to);
  }
}

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

test('demo log button ignores repeat presses (no duplicate entries)', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent !== '0', null, { timeout: 8000 });
  const totalBefore = await page.textContent('#st-total');
  await click('btn-demo');
  await page.waitForTimeout(300);
  const demoItems = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.file-item')).filter((n) => n.textContent.includes('demo.log')).length);
  assert.strictEqual(demoItems, 1, 'repeat press must not add a second demo.log entry');
  assert.strictEqual(await page.textContent('#st-total'), totalBefore, 'row total unchanged by repeat press');
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

test('color highlighter paints matching text and rows without filtering', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '44');
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=filters]').click());
  await click('btn-add-highlight');
  assert.equal(await page.locator('#rule-rows .rule-swatch').count(), 8, 'simple color palette is visible');
  await page.locator('#rule-rows .rule-swatch[data-color="#60a5fa"]').click();
  assert.equal(await page.locator('#rule-rows .rule-swatch[data-color="#60a5fa"]').getAttribute('aria-pressed'), 'true', 'chosen palette color is marked');
  const pattern = page.locator('#rule-rows tr [data-k=pattern]');
  await pattern.click();
  const focusState = await pattern.evaluate((el) => ({
    focused: document.activeElement === el,
    active: document.activeElement && (document.activeElement.id || document.activeElement.dataset.k || document.activeElement.tagName),
  }));
  assert.equal(focusState.focused, true, 'pattern field keeps focus after click; active element: ' + focusState.active);
  await pattern.fill('ActivityManager');
  assert.equal(await pattern.inputValue(), 'ActivityManager', 'pattern text is enterable');
  await pattern.press('Tab');
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await page.waitForFunction(() => document.querySelectorAll('.rule-highlight-text').length > 0);
  assert.strictEqual(await page.textContent('#st-shown'), '44', 'highlight rules do not filter lines');
  // rows re-render on rAF/scroll; poll until an attached span reports the
  // palette color instead of sampling once mid-swap
  await page.waitForFunction(() => {
    const el = document.querySelector('.rule-highlight-text');
    return !!el && getComputedStyle(el).backgroundColor === 'rgb(96, 165, 250)';
  }, null, { timeout: 5000 });

  await page.evaluate(() => document.querySelector('#tabs button[data-tab=filters]').click());
  await page.evaluate(() => {
    const target = document.querySelector('#rule-rows [data-k=target]');
    target.value = 'row';
    target.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await page.waitForFunction(() => document.querySelector('.vrow.rule-highlight-row'));
  assert.strictEqual(await page.textContent('#st-shown'), '44');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  await page.waitForFunction(() => document.querySelector('.vrow.rule-highlight-row'));
  assert.equal(await page.$eval('#rule-rows [data-k=color]', (el) => el.value), '#60a5fa', 'highlight color persists');
  assert.equal(await page.getAttribute('#rule-rows .rule-swatch[data-color="#60a5fa"]', 'aria-pressed'), 'true', 'saved palette color remains selected');
});

test('viewer fills its viewport after a rule is disabled from the Filters tab', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '44');
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=filters]').click());
  await click('btn-add-rule');
  await page.locator('#rule-rows [data-k=enabled]').uncheck();
  await page.waitForFunction(() => document.getElementById('viewer').getAttribute('aria-busy') === 'false');
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await page.waitForTimeout(50);
  const visibleRows = await page.locator('#viewer .vrow').count();
  assert.ok(visibleRows > 5, 'visible viewer renders more than the five hidden-tab overscan rows; got ' + visibleRows);
  assert.strictEqual(await page.textContent('#st-shown'), '44', 'disabling the rule restores the complete result count');
});

test('multi-file load keeps per-file counters and merged view', async () => {
  await fresh();
  await page.setInputFiles('#file-input', [
    join(root, 'tests', 'fixtures', 'demo.log'),
    join(root, 'tests', 'fixtures', 'syslog.log'),
    join(root, 'tests', 'fixtures', 'apache.log'),
  ]);
  await page.waitForFunction(() => document.querySelectorAll('.file-item').length === 3, null, { timeout: 8000 });
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '57', null, { timeout: 8000 });
  const badges = await page.evaluate(() => Array.from(document.querySelectorAll('.file-item .badge.fmt')).map((b) => b.textContent));
  assert.deepStrictEqual(badges.sort(), ['clf', 'logcat', 'syslog']);
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
    q.value = 'heartbeat ecu=engine';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.getElementById('search-progress').textContent.includes('match'), null, { timeout: 10000 });
  const instant = await page.evaluate(() => document.getElementById('search-progress').textContent);
  assert.match(instant, /3 match/);
  await page.evaluate(() => document.getElementById('search-progress').textContent = '');
  await click('btn-deepscan');
  await page.waitForFunction(() => /^deep scan: /.test(document.getElementById('search-progress').textContent));
  const deep = await page.evaluate(() => document.getElementById('search-progress').textContent);
  assert.match(deep, /3 match/);
  // grouped results with file name, line number and timestamp columns
  const first = await page.evaluate(`JSON.stringify((() => {
    const r = document.querySelector('#search-results .sr-row');
    return { file: r.querySelector('.srf').textContent, ln: r.querySelector('.srl').textContent };
  })())`).then(JSON.parse);
  assert.strictEqual(first.file, 'demo.log');
  assert.match(first.ln, /^\d+$/);
});

test('theme icon opens the dropdown, switches persist across reload', async () => {
  await fresh();
  // icon button opens the dropdown list
  await page.evaluate(() => document.getElementById('theme-btn').click());
  assert.ok(
    await page.evaluate(() => !document.getElementById('theme-menu').classList.contains('hidden')),
    'theme menu opens from the icon button');
  // pick paper from the dropdown: applied, menu closes
  await page.evaluate(() => {
    const opt = Array.from(document.querySelectorAll('#theme-menu .theme-opt')).find((o) => o.dataset.value === 'paper');
    opt.click();
  });
  assert.strictEqual(await page.evaluate(() => document.body.dataset.theme), 'paper');
  assert.ok(
    await page.evaluate(() => document.getElementById('theme-menu').classList.contains('hidden')),
    'menu closes after picking a theme');
  assert.ok(
    await page.evaluate(() => Array.from(document.querySelectorAll('#theme-menu .theme-opt')).every((o) => o.dataset.value)),
    'all six themes listed');
  // persists across reload
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.strictEqual(await page.evaluate(() => document.body.dataset.theme), 'paper');
  // outside click closes the menu without changing the theme
  await page.evaluate(() => document.getElementById('theme-btn').click());
  await page.evaluate(() => document.getElementById('viewer').click());
  assert.ok(
    await page.evaluate(() => document.getElementById('theme-menu').classList.contains('hidden')),
    'outside click closes the menu');
  assert.strictEqual(await page.evaluate(() => document.body.dataset.theme), 'paper');
});

test('theme icon keeps the mobile header on a single line', async () => {
  await fresh();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    const geo = await page.evaluate(() => {
      const btn = document.getElementById('theme-btn').getBoundingClientRect();
      const side = document.getElementById('btn-side').getBoundingClientRect();
      const hdrRight = document.getElementById('hdr-right').getBoundingClientRect();
      const center = (r) => (r.top + r.bottom) / 2;
      return {
        btnVisible: btn.width > 0 && btn.right <= window.innerWidth + 1,
        oneLine: Math.abs(center(hdrRight) - center(side)) < 6,
        noOverlap: hdrRight.left >= side.right - 1,
      };
    });
    assert.ok(geo.btnVisible, 'theme icon visible within the viewport');
    assert.ok(geo.oneLine, 'hdr-right shares the first header line with the files button');
    assert.ok(geo.noOverlap, 'theme icon does not overlap the files button');
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

test('bookmark survives reload via file-identity persistence', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  await page.evaluate(() => document.querySelector('.vrow .bm').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  const marked = await page.evaluate(() => document.querySelector('.vrow .bm').classList.contains('marked'));
  assert.ok(marked);
  // sidebar bookmarks panel lists the entry
  const listed = await page.evaluate(() => ({
    count: document.getElementById('bm-count').textContent,
    entries: document.querySelectorAll('#bookmark-list .bm-entry').length
  }));
  assert.strictEqual(listed.count, '1');
  assert.strictEqual(listed.entries, 1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  const markedAfter = await page.evaluate(() => document.querySelector('.vrow .bm').classList.contains('marked'));
  assert.ok(markedAfter, 'bookmark restored after reload');
  // clicking the sidebar entry jumps to the bookmarked line
  await page.evaluate(() => document.querySelector('#bookmark-list .bm-entry').click());
  await page.waitForTimeout(250);
  const drawer = await page.evaluate(() => document.getElementById('drawer').textContent);
  assert.ok(drawer.length > 10, 'sidebar bookmark click jumps (drawer opened)');
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

test('selection-only export exports exactly the selected rows and guards empty selection', async () => {
  await fresh();
  // multi-page load (3 pages of 500) so pagination is exercisable
  const big = join(os.tmpdir(), 'lt-selonly-' + Date.now() + '.log');
  const lines = [];
  for (let i = 1; i <= 1200; i++) lines.push('09-11 22:14:01.' + String(i % 1000).padStart(3, '0') + '  1000  2000 I VHal: line ' + i);
  fs.writeFileSync(big, lines.join('\n') + '\n');
  await page.setInputFiles('#file-input', [big]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '1200', null, { timeout: 15000 });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=export]').click());
  await page.check('#exp-selection');
  // selection-only with zero rows: export entry points are disabled
  await page.waitForFunction(() => document.getElementById('exp-txt').disabled, null, { timeout: 5000 });
  // select two rows in the viewer (click anchor + shift-click extend)
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await page.waitForSelector('.vrow .txt');
  await page.evaluate(() => document.querySelector('.vrow .txt').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  await page.evaluate(() => {
    const rows = document.querySelectorAll('.vrow');
    rows[1].querySelector('.txt').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, shiftKey: true }));
  });
  await page.waitForFunction(() => document.getElementById('st-sel').textContent === '2', null, { timeout: 5000 });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=export]').click());
  await page.waitForFunction(() => !document.getElementById('exp-txt').disabled, null, { timeout: 5000 });
  const downloadPromise = page.waitForEvent('download', { timeout: 8000 });
  await click('exp-txt');
  const download = await downloadPromise;
  const fsmod = await import('node:fs');
  const content = fsmod.readFileSync(await download.path(), 'utf8');
  assert.strictEqual(content.trim().split('\n').length, 2, 'exactly the two selected rows exported');
  // selection is keyed by global seq — paging away keeps it stored (inert
  // while off-window: no highlight, no count, selection-only export blocked)
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await page.waitForSelector('#pager', { state: 'visible', timeout: 5000 });
  await page.evaluate(() => document.getElementById('page-next').click());
  await page.waitForFunction(() => document.getElementById('page-number').value === '2', null, { timeout: 5000 });
  await page.waitForFunction(() => document.getElementById('st-sel').textContent === '0', null, { timeout: 5000 });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=export]').click());
  await page.waitForFunction(() => document.getElementById('exp-txt').disabled, null, { timeout: 5000 });
  // paging back restores the stored selection without re-clicking
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await page.evaluate(() => document.getElementById('page-prev').click());
  await page.waitForFunction(() => document.getElementById('st-sel').textContent === '2', null, { timeout: 5000 });
  const restored = await page.evaluate(() => document.querySelectorAll('.vrow.sel').length);
  assert.ok(restored >= 2, 'both selected rows re-highlight when they re-enter the window');
  fs.rmSync(big, { force: true });
});

test('drawer toggle gates the line-click detail drawer', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  const clickLine = () => page.evaluate(() => {
    document.querySelector('.vrow .txt').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  // default ON: clicking a line opens the drawer
  await clickLine();
  await page.waitForFunction(() => document.getElementById('drawer').classList.contains('open'), null, { timeout: 5000 });
  // toggle OFF: drawer closes and stays closed on further line clicks
  await page.click('#btn-drawer');
  await page.waitForFunction(() => !document.getElementById('drawer').classList.contains('open'), null, { timeout: 5000 });
  await clickLine();
  await page.waitForTimeout(300);
  assert.ok(!(await page.evaluate(() => document.getElementById('drawer').classList.contains('open'))),
    'drawer stays closed while the drawer toggle is off');
  assert.strictEqual(await page.textContent('#btn-drawer'), 'Drawer: OFF', 'toggle label synced');
  // toggle back ON: drawer opens again on line click
  await page.click('#btn-drawer');
  await clickLine();
  await page.waitForFunction(() => document.getElementById('drawer').classList.contains('open'), null, { timeout: 5000 });
});

test('bookmark export is sanitized (privacy)', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  // mask OFF, bookmark the raw VIN line so the snippet holds the raw VIN
  await page.click('#btn-mask');
  await page.evaluate(() => {
    for (const row of document.querySelectorAll('.vrow')) {
      if (row.textContent.includes('YV4AB9CD12EF34567')) { row.querySelector('.bm').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return; }
    }
  });
  await page.waitForFunction(() => document.getElementById('bm-count').textContent === '1', null, { timeout: 5000 });
  await page.click('#btn-mask'); // Mask back ON
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=export]').click());
  const downloadPromise = page.waitForEvent('download', { timeout: 8000 });
  await click('exp-bookmarks');
  const download = await downloadPromise;
  const fsmod = await import('node:fs');
  const content = fsmod.readFileSync(await download.path(), 'utf8');
  assert.ok(content.includes('YV4**********4567'), 'bookmark export has the masked VIN');
  assert.ok(!content.includes('YV4AB9CD12EF34567'), 'bookmark export has no raw VIN');
  // the stored bookmark is untouched: after reload it is still listed
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('bm-count') && document.getElementById('bm-count').textContent === '1', null, { timeout: 8000 });
});

test('CSV and JSON exports honor masking too (privacy)', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=export]').click());
  for (const [btn, label] of [['exp-csv', 'csv'], ['exp-json', 'json']]) {
    const downloadPromise = page.waitForEvent('download', { timeout: 8000 });
    await click(btn);
    const download = await downloadPromise;
    const fs = await import('node:fs');
    const content = fs.readFileSync(await download.path(), 'utf8');
    assert.ok(content.includes('YV4**********4567'), label + ' exported masked VIN');
    assert.ok(!content.includes('YV4AB9CD12EF34567'), label + ' contains no raw VIN');
  }
});

test('files panel is collapsible and state persists', async () => {
  await fresh();
  const visible = () => page.evaluate(() => document.getElementById('sidebar').offsetWidth > 0);
  assert.ok(await visible(), 'sidebar starts visible');
  await click('btn-side');
  assert.ok(!(await visible()), 'sidebar hidden after toggle');
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.ok(!(await visible()), 'collapsed state persists across reload');
  await click('btn-side');
  assert.ok(await visible(), 'sidebar expands again');
});

test('a newly loaded file is visible in the viewer even in per-file mode', async () => {
  await fresh();
  await page.setInputFiles('#file-input', [join(root, 'tests', 'fixtures', 'demo.log')]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  // select per-file view bound to demo.log
  await page.evaluate(() => {
    document.querySelector('.file-item').click();
    const sel = document.getElementById('view-mode');
    sel.value = 'file';
    sel.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(200);
  // load a second file while per-file mode points at demo.log
  await page.setInputFiles('#file-input', [join(root, 'tests', 'fixtures', 'syslog.log')]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '52', null, { timeout: 8000 });
  await page.evaluate(() => {
    const q = document.getElementById('quick');
    q.value = 'sshd';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForTimeout(250);
  const shown = await page.evaluate(() => Number(document.getElementById('st-shown').textContent));
  assert.ok(shown > 0, 'new file lines are visible after load, got ' + shown);
});

test('wrap mode renders scrolled pages at their true position', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  // bring long stack-trace lines into the window
  await page.evaluate(() => {
    const q = document.getElementById('quick');
    q.value = 'AndroidRuntime';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForTimeout(250);
  await click('btn-wrap');
  await page.waitForTimeout(300); // wrap heights re-measured, spacer resized
  const geom = await page.evaluate(`JSON.stringify((() => {
    const el = document.getElementById('viewer');
    const rows = Array.from(document.querySelectorAll('.vrow'));
    return {
      hScroll: el.scrollWidth > el.clientWidth + 1,
      spacerW: document.getElementById('vspacer').offsetWidth,
      viewW: el.clientWidth,
      tallRow: rows.some((r) => r.offsetHeight > 22),
      totalH: document.getElementById('vspacer').offsetHeight
    };
  })())`).then(JSON.parse);
  assert.ok(!geom.hScroll, 'wrap mode must not overflow horizontally');
  assert.ok(Math.abs(geom.spacerW - geom.viewW) <= 1, 'spacer width equals viewer width in wrap mode');
  assert.ok(geom.tallRow, 'long lines actually wrap into multiple visual lines');
  // clear the filter: with all 44 lines the wrapped content is scrollable
  await page.evaluate(() => {
    const q = document.getElementById('quick');
    q.value = '';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForTimeout(250);
  // scrolling to the bottom must render the last lines at the bottom, not the top
  const scrolled = await page.evaluate(() => {
    const el = document.getElementById('viewer');
    el.scrollTop = el.scrollHeight; // jump to the bottom (scroll event re-renders)
    return el.scrollTop;
  });
  await page.waitForTimeout(300);
  assert.ok(scrolled > 0, 'wrap mode is scrollable');
  const rowInfo = await page.evaluate(`JSON.stringify((() => {
    const el = document.getElementById('viewer');
    const vr = el.getBoundingClientRect();
    const cy = vr.top + vr.height / 2;
    let centerLn = null;
    document.querySelectorAll('.vrow').forEach((row) => {
      const r = row.getBoundingClientRect();
      if (r.top <= cy && r.bottom >= cy) centerLn = Number(row.querySelector('.ln').textContent);
    });
    return { centerLn, count: document.querySelectorAll('.vrow').length };
  })())`).then(JSON.parse);
  assert.ok(rowInfo.centerLn && rowInfo.centerLn > 20, 'the viewport center shows a line near the end of the file, got ' + JSON.stringify(rowInfo));
  await click('btn-wrap');
});

test('level chips rescope to the selected file in per-file view', async () => {
  await fresh();
  await page.setInputFiles('#file-input', [
    join(root, 'tests', 'fixtures', 'demo.log'),
    join(root, 'tests', 'fixtures', 'syslog.log'),
  ]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '52', null, { timeout: 8000 });
  const chipsText = () => page.evaluate(() => Array.from(document.querySelectorAll('.chip')).map((c) => c.textContent).join(' '));
  // merged mode: chips sum severities of all files
  const mergedChips = await chipsText();
  assert.match(mergedChips, /E14/, 'merged chips sum: ' + mergedChips);
  // select syslog in per-file mode: chips rescope to syslog only (I7 E1)
  await page.evaluate(() => document.querySelectorAll('.file-item')[1].click());
  await page.waitForFunction(() => document.getElementById('view-mode').value === 'file', null, { timeout: 5000 });
  await page.waitForFunction(() => !/D\d/.test(Array.from(document.querySelectorAll('.chip')).map((c) => c.textContent).join(' ')), null, { timeout: 5000 });
  const fileChips = await chipsText();
  assert.match(fileChips, /I7/);
  assert.match(fileChips, /E1\b/);
  assert.ok(!/D\d/.test(fileChips), 'levels from other files disappear: ' + fileChips);
  // back to merged: chips sum again
  await page.evaluate(() => {
    document.querySelectorAll('.file-item')[1].click();
  });
  await page.waitForFunction(() => /E14/.test(Array.from(document.querySelectorAll('.chip')).map((c) => c.textContent).join(' ')), null, { timeout: 5000 });
});

test('file list click switches the viewer between loaded files (regression: undefined handler)', async () => {
  await fresh();
  await page.setInputFiles('#file-input', [
    join(root, 'tests', 'fixtures', 'demo.log'),
    join(root, 'tests', 'fixtures', 'syslog.log'),
  ]);
  await page.waitForFunction(() => document.querySelectorAll('.file-item').length === 2, null, { timeout: 8000 });
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '52', null, { timeout: 8000 });
  // click the first file item: viewer switches to per-file mode for demo.log
  await page.evaluate(() => document.querySelectorAll('.file-item')[0].click());
  await page.waitForFunction(() => document.getElementById('view-mode').value === 'file', null, { timeout: 5000 });
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '44', null, { timeout: 5000 });
  // demo.log has no sshd lines
  await page.evaluate(() => {
    const q = document.getElementById('quick');
    q.value = 'sshd';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '0', null, { timeout: 5000 });
  // click the second file item: viewer switches to syslog.log
  // (the quick filter 'sshd' is still active — clear it to see all syslog lines)
  await page.evaluate(() => document.querySelectorAll('.file-item')[1].click());
  await page.evaluate(() => {
    const q = document.getElementById('quick');
    q.value = '';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '8', null, { timeout: 5000 });
  // clicking the active item again deselects and returns to the merged view
  await page.evaluate(() => document.querySelectorAll('.file-item')[1].click());
  await page.waitForFunction(() => document.getElementById('view-mode').value === 'merged', null, { timeout: 5000 });
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '52', null, { timeout: 5000 });
});

test('search result from another file auto-switches the per-file selection', async () => {
  await fresh();
  await page.setInputFiles('#file-input', [
    join(root, 'tests', 'fixtures', 'demo.log'),
    join(root, 'tests', 'fixtures', 'syslog.log'),
  ]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '52', null, { timeout: 8000 });
  // per-file view bound to demo.log
  await page.evaluate(() => document.querySelectorAll('.file-item')[0].click());
  try {
    await page.waitForFunction(() => document.getElementById('view-mode').value === 'file', null, { timeout: 5000 });
  } catch (e) {
    const diag = await page.evaluate(() => JSON.stringify({
      viewMode: document.getElementById('view-mode').value,
      items: document.querySelectorAll('.file-item').length,
      filesPending: document.getElementById('st-progress').textContent,
      errs: window.__errs || []
    }));
    throw new Error('state after click0: ' + diag);
  }
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '44', null, { timeout: 5000 });
  // search for a syslog-only line while demo is selected
  await page.evaluate(() => {
    document.querySelector('#tabs button[data-tab=search]').click();
    const q = document.getElementById('rg-pattern');
    q.value = 'Failed password for admin';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.getElementById('search-progress').textContent.includes('match'), null, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('#search-results .sr-row') !== null, null, { timeout: 5000 });
  await page.evaluate(() => document.querySelector('#search-results .sr-row').click());
  await page.waitForTimeout(300);
  // the viewer must switch to syslog.log and show the matched line
  const st = await page.evaluate(`JSON.stringify((() => {
    return {
      viewMode: document.getElementById('view-mode').value,
      shown: document.getElementById('st-shown').textContent,
      active: (document.querySelector('.file-item.active .fname') || { textContent: '' }).textContent,
      drawer: document.getElementById('drawer').textContent,
      errs: window.__errs || []
    };
  })())`).then(JSON.parse);
  assert.strictEqual(st.viewMode, 'file');
  assert.strictEqual(st.active, 'syslog.log', 'viewer switched to the matched file');
  assert.match(st.drawer, /Failed password for admin/);
  assert.strictEqual(st.errs.length, 0);
});

test('selection drag does not stick: plain hovering never changes the selection', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  await page.evaluate(() => document.querySelector('.vrow').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  const afterClick = await page.evaluate(() => document.getElementById('st-sel').textContent);
  assert.strictEqual(afterClick, '1');
  // simulate a stuck-drag bug: mouseover events with no button held
  await page.evaluate(() => {
    const rows = document.querySelectorAll('.vrow');
    rows[2] && rows[2].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    rows[3] && rows[3].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
  await page.waitForTimeout(150);
  const afterHover = await page.evaluate(() => document.getElementById('st-sel').textContent);
  assert.strictEqual(afterHover, '1', 'hover without button must not change selection');
});

test('search results use separate file, line and timestamp columns', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  await page.evaluate(() => {
    document.querySelector('#tabs button[data-tab=search]').click();
    const q = document.getElementById('rg-pattern');
    q.value = 'ecu=gateway';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.getElementById('search-progress').textContent.includes('match'), null, { timeout: 10000 });
  const row = await page.evaluate(`JSON.stringify((() => {
    const r = document.querySelector('#search-results .sr-row');
    return { file: r.querySelector('.srf').textContent, ln: r.querySelector('.srl').textContent, ts: r.querySelector('.srt').textContent, text: r.querySelector('.srx').textContent };
  })())`).then(JSON.parse);
  assert.strictEqual(row.file, 'demo.log');
  assert.match(row.ln, /^\d+$/);
  assert.match(row.ts, /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  assert.match(row.text, /ecu=gateway/);
});

test('search matches wrap on narrow viewports (no truncation, no overflow)', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  await page.setViewportSize({ width: 420, height: 800 }); // phone-ish width
  await page.evaluate(() => {
    document.querySelector('#tabs button[data-tab=search]').click();
    const q = document.getElementById('rg-pattern');
    q.value = 'AndroidRuntime';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.getElementById('search-progress').textContent.includes('match'), null, { timeout: 10000 });
  const geo = await page.evaluate(`JSON.stringify((() => {
    const el = document.getElementById('search-results');
    const row = document.querySelector('#search-results .sr-row');
    return {
      hScroll: el.scrollWidth > el.clientWidth + 1,
      rowW: row.offsetWidth,
      cellW: row.querySelector('.srx').offsetWidth,
      textLen: row.querySelector('.srx').textContent.length
    };
  })())`).then(JSON.parse);
  assert.ok(!geo.hScroll, 'rows wrap instead of gaining a horizontal overflow on narrow screens');
  assert.ok(geo.cellW > 100, 'match text cell is not squeezed to nothing: ' + geo.cellW);
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('files panel filter narrows by name and sort reorders the list', async () => {
  await fresh();
  await page.setInputFiles('#file-input', [
    join(root, 'tests', 'fixtures', 'demo.log'),
    join(root, 'tests', 'fixtures', 'syslog.log'),
    join(root, 'tests', 'fixtures', 'apache.log'),
  ]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '57', null, { timeout: 8000 });
  const names = () => page.evaluate(() => Array.from(document.querySelectorAll('.file-item .fname')).map((e) => e.textContent));

  // filter by name
  await page.fill('#file-filter', 'sys');
  await page.waitForFunction(() => document.querySelectorAll('.file-item').length === 1, null, { timeout: 5000 });
  assert.strictEqual((await names())[0], 'syslog.log', 'filter narrows to syslog.log');
  await page.fill('#file-filter', 'zzz-no-match');
  await page.waitForFunction(() => /no files match the filter/.test(document.getElementById('file-list').textContent), null, { timeout: 5000 });
  await page.fill('#file-filter', '');

  // sort by name A→Z: apache.log, demo.log, syslog.log
  await page.selectOption('#file-sort', 'name');
  await page.waitForFunction(() => {
    const n = Array.from(document.querySelectorAll('.file-item .fname')).map((e) => e.textContent);
    return n.length === 3 && n[0] === 'apache.log';
  }, null, { timeout: 5000 });
  assert.deepStrictEqual(await names(), ['apache.log', 'demo.log', 'syslog.log'], 'name A→Z order');

  // sort by lines ↓: demo.log (44) first
  await page.selectOption('#file-sort', 'lines-desc');
  await page.waitForFunction(() => {
    const n = Array.from(document.querySelectorAll('.file-item .fname')).map((e) => e.textContent);
    return n.length === 3 && n[0] === 'demo.log';
  }, null, { timeout: 5000 });
  assert.deepStrictEqual(await names(), ['demo.log', 'syslog.log', 'apache.log'], 'lines ↓ order');

  // back to load order
  await page.selectOption('#file-sort', 'default');
  await page.waitForFunction(() => {
    const n = Array.from(document.querySelectorAll('.file-item .fname')).map((e) => e.textContent);
    return n.length === 3 && n[0] === 'demo.log';
  }, null, { timeout: 5000 });
  assert.deepStrictEqual(await names(), ['demo.log', 'syslog.log', 'apache.log'], 'load order restored');
});

test('files panel highlights all loaded files in merged mode, only the shown file per-file', async () => {
  await fresh();
  await page.setInputFiles('#file-input', [
    join(root, 'tests', 'fixtures', 'demo.log'),
    join(root, 'tests', 'fixtures', 'syslog.log'),
  ]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '52', null, { timeout: 8000 });
  const activeNames = () => page.evaluate(() => Array.from(document.querySelectorAll('.file-item.active .fname')).map((e) => e.textContent));
  assert.deepStrictEqual((await activeNames()).sort(), ['demo.log', 'syslog.log'], 'merged highlights every loaded file');
  await page.selectOption('#view-mode', 'file');
  await page.waitForFunction(() => document.querySelectorAll('.file-item.active').length === 1, null, { timeout: 5000 });
  assert.deepStrictEqual(await activeNames(), ['demo.log'], 'per-file highlights only the shown file');
  await page.evaluate(() => Array.from(document.querySelectorAll('.file-item')).find((e) => e.textContent.includes('syslog.log')).click());
  await page.waitForFunction(() => document.getElementById('view-mode').value === 'file', null, { timeout: 5000 });
  assert.deepStrictEqual(await activeNames(), ['syslog.log'], 'clicking a file moves the highlight in per-file mode');
  await page.selectOption('#view-mode', 'merged');
  await page.waitForFunction(() => document.querySelectorAll('.file-item.active').length === 2, null, { timeout: 5000 });
  assert.deepStrictEqual((await activeNames()).sort(), ['demo.log', 'syslog.log'], 'merged highlights all again');
});

test('zen mode hides all chrome, exits via Esc and via the floating button', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  await page.click('#btn-zen');
  await page.waitForFunction(() => document.body.classList.contains('zen'), null, { timeout: 5000 });
  const zen = await page.evaluate(() => {
    const vis = (el) => el && getComputedStyle(el).display !== 'none';
    const vw = document.getElementById('viewer-wrap').getBoundingClientRect();
    return {
      headerHidden: !vis(document.querySelector('header')),
      sidebarHidden: !vis(document.getElementById('sidebar')),
      statusHidden: !vis(document.getElementById('statusbar')),
      pagerHidden: !vis(document.getElementById('pager')),
      toolbarHidden: !vis(document.getElementById('vtools')),
      viewerFull: Math.abs(vw.height - window.innerHeight) <= 2 && Math.abs(vw.width - window.innerWidth) <= 2,
      rows: document.querySelectorAll('.vrow').length,
      fabVisible: vis(document.getElementById('zen-fab')),
      hintShown: document.getElementById('zen-hint').classList.contains('show'),
    };
  });
  assert.ok(zen.headerHidden && zen.sidebarHidden && zen.statusHidden && zen.pagerHidden && zen.toolbarHidden, 'all chrome hidden in zen mode');
  assert.ok(zen.viewerFull, 'viewer fills the window');
  assert.ok(zen.rows > 0, 'log rows still rendered in zen mode');
  assert.ok(zen.fabVisible, 'floating exit button visible');
  assert.ok(zen.hintShown, 'exit hint shown on entry');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.body.classList.contains('zen'), null, { timeout: 5000 });
  assert.ok(await page.evaluate(() => getComputedStyle(document.querySelector('header')).display !== 'none'), 'header visible again after Esc');
  // re-enter, then exit via the floating ✕ Zen button
  await page.click('#btn-zen');
  await page.waitForFunction(() => document.body.classList.contains('zen'), null, { timeout: 5000 });
  await page.click('#zen-fab');
  await page.waitForFunction(() => !document.body.classList.contains('zen'), null, { timeout: 5000 });
  // zen is session-only: a reload never starts hidden
  await page.click('#btn-zen');
  await page.waitForFunction(() => document.body.classList.contains('zen'), null, { timeout: 5000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.body.classList.contains('zen'), null, { timeout: 5000 });
});

test('viewer shows start and end of log bands on first and last pages only', async () => {
  await fresh();
  const big = join(os.tmpdir(), 'lt-marks-' + Date.now() + '.log');
  const lines = [];
  // long lines: in nowrap mode the spacer is max-content wide, so the band
  // labels must stay pinned into the visible viewport (sticky-left)
  const pad = 'payload '.repeat(40);
  for (let i = 1; i <= 1200; i++) lines.push('09-11 22:14:01.' + String(i % 1000).padStart(3, '0') + '  1000  2000 I VHal: line ' + i + ' ' + pad);
  fs.writeFileSync(big, lines.join('\n') + '\n');
  await page.setInputFiles('#file-input', [big]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '1200', null, { timeout: 15000 });
  const marks = () => page.evaluate(() => {
    const viewer = document.getElementById('viewer');
    const vr = viewer.getBoundingClientRect();
    const label = (sel) => {
      const el = document.querySelector(sel + ' > span');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { text: el.textContent, left: r.left, right: r.right, visible: r.left >= vr.left - 1 && r.left < vr.right - 10 };
    };
    return { start: label('.vmark.start'), end: label('.vmark.end') };
  });
  let m = await marks();
  assert.ok(m.start && !m.end, 'first page shows the start band only');
  assert.match(m.start.text, /start of/i);
  assert.ok(m.start.visible, 'start label is inside the visible viewport at scrollLeft 0 (left=' + m.start.left + ')');
  await page.click('#page-next');
  await page.waitForFunction(() => document.getElementById('page-number').value === '2', null, { timeout: 5000 });
  m = await marks();
  assert.ok(!m.start && !m.end, 'middle page shows no bands');
  await page.click('#page-last');
  await page.waitForFunction(() => document.getElementById('page-number').value === '3', null, { timeout: 5000 });
  m = await marks();
  assert.ok(!m.start && m.end, 'last page shows the end band only');
  assert.match(m.end.text, /end of/i);
  // scroll to the very bottom: the end band must be in view
  await page.evaluate(() => { const v = document.getElementById('viewer'); v.scrollTop = v.scrollHeight; });
  await page.waitForTimeout(200);
  const endInView = await page.evaluate(() => {
    const el = document.querySelector('.vmark.end');
    const vr = document.getElementById('viewer').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return r.bottom <= vr.bottom + 1 && r.top >= vr.top - 1;
  });
  assert.ok(endInView, 'end band sits inside the viewer at full scroll-down');
  fs.rmSync(big, { force: true });
});

test('per-file mode displays the newly loaded file, not the previous one (review P1)', async () => {
  await fresh();
  await page.setInputFiles('#file-input', [join(root, 'tests', 'fixtures', 'demo.log')]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  await page.evaluate(() => document.querySelector('.file-item').click());
  await page.waitForFunction(() => document.getElementById('view-mode').value === 'file', null, { timeout: 5000 });
  await page.setInputFiles('#file-input', [join(root, 'tests', 'fixtures', 'syslog.log')]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '52', null, { timeout: 8000 });
  // the rebuild must run with the NEW file selected: shown count and rows
  // belong to syslog.log (8 lines), and the highlight agrees
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '8', null, { timeout: 8000 });
  const info = await page.evaluate(() => ({
    active: (document.querySelector('.file-item.active .fname') || { textContent: '' }).textContent,
    firstRow: (document.querySelector('.vrow .txt') || { textContent: '' }).textContent,
  }));
  assert.strictEqual(info.active, 'syslog.log', 'newly loaded file is highlighted');
  assert.match(info.firstRow, /sshd/, 'viewer rows are from the newly loaded file: ' + info.firstRow.slice(0, 60));
});

test('boundary bands describe matches, not the physical file, when filtered (review P2)', async () => {
  await fresh();
  const big = join(os.tmpdir(), 'lt-marks-filt-' + Date.now() + '.log');
  const lines = [];
  for (let i = 1; i <= 1200; i++) lines.push('09-11 22:14:01.' + String(i % 1000).padStart(3, '0') + '  1000  2000 I VHal: line ' + i);
  fs.writeFileSync(big, lines.join('\n') + '\n');
  await page.setInputFiles('#file-input', [big]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '1200', null, { timeout: 15000 });
  await page.evaluate(() => document.querySelector('.file-item').click());
  await page.waitForFunction(() => document.getElementById('view-mode').value === 'file', null, { timeout: 5000 });
  await page.fill('#quick', 'line 55');
  await page.waitForFunction(() => {
    const n = Number(document.getElementById('st-shown').textContent);
    return n > 0 && n < 1200;
  }, null, { timeout: 8000 });
  const labels = await page.evaluate(() => ({
    start: (document.querySelector('.vmark.start > span') || { textContent: '' }).textContent,
    end: (document.querySelector('.vmark.end > span') || { textContent: '' }).textContent,
  }));
  assert.match(labels.start, /first match/i, 'filtered start band says first match: ' + labels.start);
  assert.doesNotMatch(labels.start, /start of/i, 'filtered start band must not claim the physical start');
  assert.match(labels.end, /last match/i, 'filtered end band says last match: ' + labels.end);
  assert.doesNotMatch(labels.end, /end of/i, 'filtered end band must not claim the physical end');
  await page.fill('#quick', '');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '1200', null, { timeout: 8000 });
  const plainStart = await page.evaluate(() => (document.querySelector('.vmark.start > span') || { textContent: '' }).textContent);
  assert.match(plainStart, /start of/i, 'unfiltered start band uses physical wording');
  await page.click('#page-last');
  await page.waitForFunction(() => document.getElementById('page-number').value === '3', null, { timeout: 5000 });
  const plainEnd = await page.evaluate(() => (document.querySelector('.vmark.end > span') || { textContent: '' }).textContent);
  assert.match(plainEnd, /end of/i, 'unfiltered end band uses physical wording');
  fs.rmSync(big, { force: true });
});

test('per-file ✕ removes that file only (lines, counters, chips)', async () => {
  await fresh();
  await page.setInputFiles('#file-input', [
    join(root, 'tests', 'fixtures', 'demo.log'),
    join(root, 'tests', 'fixtures', 'syslog.log'),
  ]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '52', null, { timeout: 8000 });
  // per-file view of demo.log, then bookmark a demo line (rows[0] is demo here)
  await page.evaluate(() => document.querySelectorAll('.file-item')[0].click());
  await page.waitForFunction(() => document.getElementById('view-mode').value === 'file', null, { timeout: 5000 });
  await page.evaluate(() => {
    const rows = document.querySelectorAll('.vrow');
    rows[0].querySelector('.bm').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await page.waitForFunction(() => document.getElementById('bm-count').textContent === '1', null, { timeout: 5000 });
  // remove the syslog file via its ✕ button
  await page.evaluate(() => document.querySelectorAll('.file-item .fx')[1].click());
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  const st = await page.evaluate(`JSON.stringify((() => {
    return {
      items: document.querySelectorAll('.file-item').length,
      names: Array.from(document.querySelectorAll('.file-item .fname')).map((n) => n.textContent),
      kept: document.getElementById('st-kept').textContent,
      bm: document.getElementById('bm-count').textContent,
      errs: window.__errs || []
    };
  })())`).then(JSON.parse);
  assert.strictEqual(st.items, 1);
  assert.deepStrictEqual(st.names, ['demo.log']);
  assert.strictEqual(st.kept, '44', 'demo kept lines remain');
  assert.strictEqual(st.bm, '1', 'demo bookmark survives removing the other file');
  assert.strictEqual(st.errs.length, 0);
  // remove the last file: viewer empties cleanly and bookmarks are cleared
  await page.evaluate(() => document.querySelectorAll('.file-item .fx')[0].click());
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '0', null, { timeout: 8000 });
  const empty = await page.evaluate(`JSON.stringify({
    chips: document.getElementById('chips-row').textContent,
    files: document.querySelectorAll('.file-item').length,
    bm: document.getElementById('bm-count').textContent
  })`).then(JSON.parse);
  assert.strictEqual(empty.files, 0);
  assert.match(empty.chips, /appear after loading/);
  assert.strictEqual(empty.bm, '0', 'bookmarks cleared with their file');
});

test('drag handle resizes the bookmarks panel', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  const handlePos = () => page.evaluate(() => {
    const r = document.getElementById('side-drag').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  const before = await page.evaluate(() => document.getElementById('bm-section').offsetHeight);
  // drag the handle up: bookmarks panel grows
  let pos = await handlePos();
  await page.mouse.move(pos.x, pos.y);
  await page.mouse.down();
  await page.mouse.move(pos.x, pos.y - 120, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const grown = await page.evaluate(() => document.getElementById('bm-section').offsetHeight);
  assert.ok(grown > before + 60, 'dragging up grows the bookmarks panel: ' + before + ' -> ' + grown);
  const viewerRows = await page.evaluate(() => document.querySelectorAll('.vrow').length);
  assert.ok(viewerRows > 0, 'viewer rows still render after resize');
  // drag the handle back down: bookmarks panel shrinks (re-query the moved handle)
  pos = await handlePos();
  await page.mouse.move(pos.x, pos.y);
  await page.mouse.down();
  await page.mouse.move(pos.x, pos.y + 140, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const shrunk = await page.evaluate(() => document.getElementById('bm-section').offsetHeight);
  assert.ok(shrunk < grown, 'dragging down shrinks the bookmarks panel: ' + grown + ' -> ' + shrunk);
});

test('config tab exports and imports filters, highlighters, masks and issue-scan configuration', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  // Add a highlighter with non-default options so every exported field is covered.
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=filters]').click());
  await click('btn-add-highlight');
  await page.evaluate(() => {
    const set = (key, value) => {
      const el = document.querySelector('#rule-rows [data-k="' + key + '"]');
      if (el.type === 'checkbox') el.checked = value;
      else el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('name', 'exported highlighter');
    set('pattern', 'ActivityManager');
    set('caseSensitive', true);
    set('matchMode', 'regex');
    set('target', 'row');
    set('color', '#12ab34');
    set('enabled', false);
  });
  // change config: disable the VIN mask rule
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=masks]').click());
  await page.evaluate(() => document.querySelector('[data-mask="vin"]').click());
  await page.waitForTimeout(150);
  // export the configuration and inspect the downloaded file
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=config]').click());
  const downloadPromise = page.waitForEvent('download', { timeout: 8000 });
  await click('btn-config-export');
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /log-triage-config\.json$/);
  const path = await download.path();
  const fs = await import('node:fs');
  const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
  assert.strictEqual(cfg.masks.enabled.vin, false, 'exported config carries the disabled vin rule');
  assert.strictEqual(cfg.issueGroups.length, 14, 'all fourteen issue-scan groups exported');
  assert.deepStrictEqual(cfg.filters.rules[0], {
    name: 'exported highlighter', pattern: 'ActivityManager', caseSensitive: true,
    action: 'highlight', enabled: false, matchMode: 'regex', target: 'row', color: '#12ab34',
  }, 'exported config carries every highlighter field');
  // re-enable vin, then import the config: it must be disabled again
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=masks]').click());
  await page.evaluate(() => document.querySelector('[data-mask="vin"]').click());
  const enabledAgain = await page.evaluate(() => document.body.innerText.includes('YV4**********4567'));
  assert.ok(enabledAgain, 'vin masked again after re-enable');
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=config]').click());
  await page.setInputFiles('#config-file', [path]);
  await page.waitForFunction(() => document.getElementById('config-status').textContent.includes('imported'), null, { timeout: 8000 });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=masks]').click());
  const vinCheckbox = await page.evaluate(() => document.querySelector('[data-mask="vin"]').checked);
  assert.strictEqual(vinCheckbox, false, 'import re-applied the disabled vin rule');
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=filters]').click());
  const importedHighlighter = await page.evaluate(() => {
    const value = (key) => {
      const el = document.querySelector('#rule-rows [data-k="' + key + '"]');
      return el.type === 'checkbox' ? el.checked : el.value;
    };
    return {
      name: value('name'), pattern: value('pattern'), caseSensitive: value('caseSensitive'),
      action: value('action'), enabled: value('enabled'), matchMode: value('matchMode'),
      target: value('target'), color: value('color'),
    };
  });
  assert.deepStrictEqual(importedHighlighter, cfg.filters.rules[0], 'import restored every highlighter field');
});

test('mobile layout: page fits width, files panel is an overlay drawer, mask cards stack', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  const pageFits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  assert.ok(await pageFits(), 'no page-level horizontal overflow at 390px');
  const hidden = await page.evaluate(() => document.getElementById('sidebar').offsetWidth === 0);
  assert.ok(hidden, 'files panel starts collapsed on narrow screens');
  await click('btn-side');
  const open = await page.evaluate(`JSON.stringify((() => {
    const sb = document.getElementById('sidebar');
    return { visible: sb.offsetWidth > 0, pageFits: document.documentElement.scrollWidth <= window.innerWidth + 1 };
  })())`).then(JSON.parse);
  assert.ok(open.visible && open.pageFits, 'drawer overlays content without page overflow');
  await click('btn-side');
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=masks]').click());
  const cards = await page.evaluate(`JSON.stringify((() => {
    const cards = Array.from(document.querySelectorAll('.mask-card'));
    const vw = window.innerWidth;
    return { count: cards.length, stacked: cards.every((c) => c.offsetWidth <= vw), pageFits: document.documentElement.scrollWidth <= window.innerWidth + 1 };
  })())`).then(JSON.parse);
  assert.ok(cards.count > 0 && cards.stacked && cards.pageFits, 'mask cards fit the narrow viewport');
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('horizontal scrolling works in nowrap mode (long lines widen the scroll area)', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  const geo = await page.evaluate(`JSON.stringify((() => {
    const el = document.getElementById('viewer');
    return { sw: el.scrollWidth, cw: el.clientWidth };
  })())`).then(JSON.parse);
  assert.ok(geo.sw > geo.cw, 'long lines widen the scroll area: ' + geo.sw + ' vs ' + geo.cw);
  await page.evaluate(() => { document.getElementById('viewer').scrollLeft = 400; });
  await page.waitForTimeout(150);
  const sl = await page.evaluate(() => document.getElementById('viewer').scrollLeft);
  assert.ok(sl > 100, 'viewer scrolls horizontally, scrollLeft=' + sl);
  // rows keep their full single-line text in nowrap mode (no clipping to the column)
  const wide = await page.evaluate(`JSON.stringify((() => {
    const row = document.querySelector('.vrow .txt');
    return { rowW: row.offsetWidth, textW: row.scrollWidth };
  })())`).then(JSON.parse);
  assert.ok(wide.textW >= wide.rowW || wide.rowW > 500, 'text cell holds the full line');
});

test('★ only-bookmarks toggle filters the viewer to bookmarked lines', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  // with no bookmarks the star chip does not appear at all
  const starAbsent = await page.evaluate(() => !document.querySelector('.chip'));
  const starChip = () => page.evaluate(`JSON.stringify((() => {
    const chips = Array.from(document.querySelectorAll('.chip'));
    const star = chips.find((c) => c.textContent.startsWith('\u2605'));
    return star ? { text: star.textContent, sel: star.classList.contains('sel') } : null;
  })())`).then(JSON.parse);
  // bookmark lines 2 and 4 via the gutter (re-query rows: render replaces DOM)
  await page.evaluate(() => {
    const rows = document.querySelectorAll('.vrow');
    rows[1].querySelector('.bm').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await page.evaluate(() => {
    const rows = document.querySelectorAll('.vrow');
    rows[3].querySelector('.bm').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  const star = await starChip();
  assert.match(star.text, /\u2605\s*2/, 'star chip shows bookmark count: ' + JSON.stringify(star));
  // toggle on: only bookmarked lines remain
  await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll('.chip'));
    chips.find((c) => c.textContent.startsWith('\u2605')).click();
  });
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '2', null, { timeout: 5000 });
  const lns = await page.evaluate(() => Array.from(document.querySelectorAll('.vrow .ln')).map((x) => Number(x.textContent)));
  assert.deepStrictEqual(lns, [2, 4], 'only the bookmarked lines remain, got ' + JSON.stringify(lns));
  // unbookmarking the only visible bookmark while ON re-filters the view
  await page.evaluate(() => document.querySelector('.vrow .bm').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '1', null, { timeout: 5000 });
  const lnAfter = await page.evaluate(() => Number(document.querySelector('.vrow .ln').textContent));
  assert.strictEqual(lnAfter, 4, 'remaining bookmarked line is line 4');
});

test('file cache: previous session is listed after reload, cached file reloads, missing content shows as file not found', async () => {
  await fresh();
  await page.setInputFiles('#file-input', [join(root, 'tests', 'fixtures', 'demo.log')]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  // the UI updates before the async IDB cache write completes — await the
  // entry itself (durable: cachePut resolves on transaction commit), or the
  // reload below races the put and the cached listing never appears (CI #53)
  await page.waitForFunction(() => LT.cacheGetAll().then((es) => es.some((e) => e.name === 'demo.log' && e.data)), null, { timeout: 8000 });
  // reopen the app: the cache lists the previous file as restorable
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.file-item').length === 1, null, { timeout: 20000 });
  const listed = await page.evaluate(`JSON.stringify((() => {
    const el = document.querySelector('.file-item');
    return { name: el.querySelector('.fname').textContent, cached: el.className.includes('cached'), missing: el.className.includes('missing') };
  })())`).then(JSON.parse);
  assert.strictEqual(listed.name, 'demo.log');
  assert.ok(listed.cached && !listed.missing, 'cached entry is restorable');
  // clicking it re-ingests from the local cache
  await page.evaluate(() => document.querySelector('.file-item').click());
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 20000 });
  // an entry without cached content is listed greyed out as file not found
  await page.evaluate(() => LT.cachePut({ id: 'cache_gone', name: 'gone.log', size: 12, format: '—', ts: 1 }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.file-item').length === 2, null, { timeout: 8000 });
  const missing = await page.evaluate(`JSON.stringify((() => {
    const el = Array.from(document.querySelectorAll('.file-item')).find((x) => x.className.includes('missing'));
    return { found: !!el, badge: el ? el.querySelector('.badge.miss').textContent : '' };
  })())`).then(JSON.parse);
  assert.ok(missing.found && /file not found/.test(missing.badge), 'missing entry greyed with file not found');
  // ✕ on the missing entry removes it from the cache list
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.file-item')).find((x) => x.className.includes('missing'));
    el.querySelector('.fx').click();
  });
  try {
    await page.waitForFunction(() => document.querySelectorAll('.file-item').length === 1, null, { timeout: 8000 });
  } catch (e) {
    const diag = await page.evaluate(() => JSON.stringify({
      items: Array.from(document.querySelectorAll('.file-item')).map((x) => x.className),
      errs: window.__errs || []
    }));
    throw new Error('state after X: ' + diag);
  }
});

test('reload-all button restores every cached file in one click', async () => {
  await fresh();
  await page.setInputFiles('#file-input', [
    join(root, 'tests', 'fixtures', 'demo.log'),
    join(root, 'tests', 'fixtures', 'syslog.log'),
  ]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '52', null, { timeout: 8000 });
  // no pending cache while everything is loaded
  assert.ok(await page.evaluate(() => document.getElementById('reload-cached').classList.contains('hidden')),
    'reload hidden while all cached files are loaded');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.file-item.cached').length === 2, null, { timeout: 8000 });
  assert.ok(await page.evaluate(() => !document.getElementById('reload-cached').classList.contains('hidden')),
    'reload appears when cached files are pending');
  await page.click('#reload-cached');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '52', null, { timeout: 20000 });
  const after = await page.evaluate(() => ({
    cachedLeft: document.querySelectorAll('.file-item.cached').length,
    hidden: document.getElementById('reload-cached').classList.contains('hidden'),
    names: Array.from(document.querySelectorAll('.file-item .fname')).map((e) => e.textContent).sort(),
  }));
  assert.strictEqual(after.cachedLeft, 0, 'no cached entries left after reload-all');
  assert.ok(after.hidden, 'reload hides again once nothing is pending');
  assert.deepStrictEqual(after.names, ['demo.log', 'syslog.log'], 'both files restored');
});

test('analysis file selector scopes every section to one file', async () => {
  await fresh();
  await page.setInputFiles('#file-input', [
    join(root, 'tests', 'fixtures', 'demo.log'),
    join(root, 'tests', 'fixtures', 'syslog.log'),
  ]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '52', null, { timeout: 8000 });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=analysis]').click());
  try {
    await page.waitForFunction(() => document.querySelectorAll('#analysis-panel .stat-card').length > 0, null, { timeout: 5000 });
  } catch (e) {
    const diag = await page.evaluate(() => JSON.stringify({
      panelHtml: document.getElementById('analysis-panel').innerHTML.slice(0, 300),
      active: document.querySelector('#tabs button.active') ? document.querySelector('#tabs button.active').textContent : 'none',
      errs: window.__errs || []
    }));
    throw new Error('analysis panel never rendered: ' + diag);
  }
  const opts = await page.evaluate(() => Array.from(document.querySelectorAll('#analysis-file option')).map((o) => o.textContent));
  assert.deepStrictEqual(opts, ['All files (2)', 'demo.log', 'syslog.log']);
  // pick syslog: overview lines drop to 8 and issue scan only cites syslog
  await page.evaluate(() => {
    const s = document.getElementById('analysis-file');
    const opt = Array.from(s.options).find((o) => o.textContent === 'syslog.log');
    s.value = opt.value;
    s.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => {
    const cards = Array.from(document.querySelectorAll('#analysis-panel .stat-card'));
    const lines = cards.find((c) => c.querySelector('.k').textContent === 'Lines');
    return lines && lines.querySelector('.v').textContent === '8';
  }, null, { timeout: 5000 });
  const issues = await page.evaluate(() => Array.from(document.querySelectorAll('#analysis-panel .issue .muted')).map((x) => x.textContent));
  const diag = await page.evaluate(() => JSON.stringify({
    selValue: document.getElementById('analysis-file') ? document.getElementById('analysis-file').value : 'gone',
    issues: Array.from(document.querySelectorAll('#analysis-panel .issue .muted')).map((x) => x.textContent).slice(0, 5),
    linesCard: (Array.from(document.querySelectorAll('#analysis-panel .stat-card')).find((c) => c.querySelector('.k').textContent === 'Lines') || { querySelector: () => ({ textContent: '?' }) }).querySelector('.v').textContent
  }));
  assert.ok(issues.length > 0 && issues.every((t) => t.startsWith('syslog.log')), 'issue scan scoped to syslog: ' + diag);
  // back to all files: totals return
  await page.evaluate(() => {
    const s = document.getElementById('analysis-file');
    s.value = '';
    s.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => {
    const cards = Array.from(document.querySelectorAll('#analysis-panel .stat-card'));
    const lines = cards.find((c) => c.querySelector('.k').textContent === 'Lines');
    return lines && lines.querySelector('.v').textContent === '52';
  }, null, { timeout: 5000 });
});

test('search results panel scrolls when content exceeds the viewport', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  await page.evaluate(() => {
    document.querySelector('#tabs button[data-tab=search]').click();
    const q = document.getElementById('rg-pattern');
    q.value = '.'; // matches nearly every line
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.getElementById('search-progress').textContent.includes('match'), null, { timeout: 10000 });
  const geo = await page.evaluate(`JSON.stringify((() => {
    const el = document.getElementById('search-results');
    return { scrollH: el.scrollHeight, clientH: el.clientHeight };
  })())`).then(JSON.parse);
  assert.ok(geo.scrollH > geo.clientH, 'content overflows the results panel');
  const top = await page.evaluate(() => { document.getElementById('search-results').scrollTop = 400; return document.getElementById('search-results').scrollTop; });
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => document.getElementById('search-results').scrollTop);
  assert.ok(top > 0, 'panel accepts vertical scroll');
  assert.strictEqual(after, top, 'scroll position holds (panel is the scroll container)');
});

test('search result file groups are collapsible (multi-file)', async () => {
  await fresh();
  await page.setInputFiles('#file-input', [
    join(root, 'tests', 'fixtures', 'demo.log'),
    join(root, 'tests', 'fixtures', 'syslog.log'),
  ]);
  await page.waitForFunction(() => document.querySelectorAll('.file-item').length === 2, null, { timeout: 8000 });
  await page.evaluate(() => {
    document.querySelector('#tabs button[data-tab=search]').click();
    const q = document.getElementById('rg-pattern');
    q.value = '.';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.querySelectorAll('#search-results details.sr-group').length === 2, null, { timeout: 10000 });
  const groups = () => page.evaluate(`JSON.stringify((() => {
    const ds = Array.from(document.querySelectorAll('#search-results details.sr-group'));
    return { open: ds.map((d) => d.open), files: ds.map((d) => d.querySelector('.srf').textContent) };
  })())`).then(JSON.parse);
  let g = await groups();
  assert.deepStrictEqual(g.open, [true, true], 'groups start open');
  assert.deepStrictEqual(g.files, ['demo.log', 'syslog.log']);
  await page.evaluate(() => document.querySelector('#search-results details.sr-group > summary').click());
  await page.waitForTimeout(100);
  g = await groups();
  assert.deepStrictEqual(g.open, [false, true], 'first group collapsed, second untouched');
  await click('btn-rg-collapse');
  await page.waitForTimeout(100);
  const allClosed = await page.evaluate(() => Array.from(document.querySelectorAll('#search-results details.sr-group')).every((d) => !d.open));
  assert.ok(allClosed, 'collapse-all closes every group');
  await click('btn-rg-expand');
  await page.waitForTimeout(100);
  const allOpen = await page.evaluate(() => Array.from(document.querySelectorAll('#search-results details.sr-group')).every((d) => d.open));
  assert.ok(allOpen, 'expand-all opens every group');
  // rows inside an open group still jump to the line
  await page.evaluate(() => document.querySelector('#search-results details.sr-group[open] .sr-row').click());
  await page.waitForTimeout(250);
  const drawer = await page.evaluate(() => document.getElementById('drawer').textContent);
  assert.ok(drawer.length > 10, 'clicking a row inside a group jumps to the line (drawer opened)');
  await click('btn-rg-collapse');
  await click('btn-rg-expand');
});

// --- archive support: .7z ingest + archive export (skips without 7-Zip CLI) ---

let sevenZipBin;
function find7z() {
  if (sevenZipBin !== undefined) return sevenZipBin;
  for (const c of [process.env.SEVENZIP_BIN, '7z', '7za', 'C:\\Program Files\\7-Zip\\7z.exe']) {
    if (!c) continue;
    try {
      const r = spawnSync(c, ['i'], { encoding: 'utf8' });
      if (r.status === 0) { sevenZipBin = c; return c; }
    } catch { /* not present */ }
  }
  sevenZipBin = '';
  return null;
}

let sevenZipFixture;
function sevenZipBundle() {
  if (sevenZipFixture !== undefined) return sevenZipFixture;
  const bin = find7z();
  if (!bin) return null;
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'lt-e2e-7z-'));
  const sample = [
    '09-11 10:10:22.100  1234  5678 D WifiHal: associated rssi=-50',
    '09-11 10:10:22.200  1234  5678 I WifiHal: scan complete',
    '09-11 10:10:22.300  1234  5678 W WifiHal: beacon miss 1',
    '09-11 10:10:22.400  1234  5678 E WifiHal: timeout waiting for driver',
  ].join('\n') + '\n';
  fs.writeFileSync(join(dir, 'a.log'), sample);
  fs.mkdirSync(join(dir, 'sub'));
  fs.writeFileSync(join(dir, 'sub', 'b.log'), sample.replace(/WifiHal/g, 'SensorHub'));
  const r = spawnSync(bin, ['a', '-t7z', '-y', 'bundle.7z', 'a.log', 'sub', 'sub/b.log'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) { sevenZipFixture = null; return null; }
  sevenZipFixture = join(dir, 'bundle.7z');
  return sevenZipFixture;
}

test('bookmarks panel Clear button removes all bookmarks at once', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  // bookmark one demo line via the gutter
  await page.evaluate(() => document.querySelector('.vrow .bm').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  // seed another bookmark from an unloaded file via the persisted-state format
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('log_triage_state_v1') || '{}');
    s.bookmarks = s.bookmarks || {};
    s.bookmarks['ghost.log|999|deadbeef'] = [{ lineNo: 3, meta: { snippet: 'stale ghost entry' }, note: '' }];
    localStorage.setItem('log_triage_state_v1', JSON.stringify(s));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  const entries = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('#bookmark-list .bm-entry')).map((e) => e.textContent));
  let listed = await entries();
  assert.strictEqual(listed.length, 2, 'live + stale entries listed: ' + listed.join(' | '));
  // Clear wipes everything — including the loaded file's valid bookmarks
  await click('clear-bookmarks');
  listed = await entries();
  assert.strictEqual(listed.length, 0, 'all bookmarks removed: ' + listed.join(' | '));
  const count = await page.evaluate(() => ({
    pill: document.getElementById('bm-count').textContent,
    status: document.getElementById('st-bm').textContent,
    chipGone: !Array.from(document.querySelectorAll('.chip')).some((c) => c.textContent.includes('\u2605')),
  }));
  assert.strictEqual(count.pill, '0', 'panel count pill reset');
  assert.strictEqual(count.status, '0', 'status-bar bookmark counter reset');
  assert.ok(count.chipGone, '\u2605 only-bookmarked chip disappears when no bookmarks remain');
  const flashText = await page.evaluate(() => document.getElementById('st-progress').textContent);
  assert.match(flashText, /cleared 2 bookmarks?/, 'status line confirms: ' + flashText);
  // clearing again is a clean no-op
  await click('clear-bookmarks');
  assert.match(
    await page.evaluate(() => document.getElementById('st-progress').textContent),
    /no bookmarks/,
    'second clear reports nothing to do');
});

test('bookmarks panel entries have an ✕ to remove individually', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  // bookmark the first two visible lines via the gutter (re-query rows between clicks)
  await page.evaluate(() => document.querySelector('.vrow .bm').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  await page.evaluate(() => document.querySelectorAll('.vrow')[1].querySelector('.bm').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  await page.waitForTimeout(150);
  const entries = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('#bookmark-list .bm-entry')).map((e) => e.dataset.ln));
  let listed = await entries();
  assert.deepStrictEqual(listed, ['1', '2'], 'two bookmarked entries listed, got ' + JSON.stringify(listed));
  // ✕ on the first entry removes just that bookmark
  await page.evaluate(() => document.querySelector('#bookmark-list .bm-entry .fx').click());
  listed = await entries();
  assert.deepStrictEqual(listed, ['2'], 'only the second bookmark remains, got ' + JSON.stringify(listed));
  const counts = await page.evaluate(() => ({
    pill: document.getElementById('bm-count').textContent,
    status: document.getElementById('st-bm').textContent,
    drawerClosed: document.getElementById('drawer').className !== 'open',
  }));
  assert.strictEqual(counts.pill, '1', 'panel count pill updated');
  assert.strictEqual(counts.status, '1', 'status-bar bookmark counter updated');
  assert.ok(counts.drawerClosed, '✕ does not trigger the jump/drawer');
  // ✕ on the last entry empties the panel and drops the ★ chip
  await page.evaluate(() => document.querySelector('#bookmark-list .bm-entry .fx').click());
  listed = await entries();
  assert.strictEqual(listed.length, 0, 'panel empty after last ✕');
  const chipGone = await page.evaluate(() =>
    !Array.from(document.querySelectorAll('.chip')).some((c) => c.textContent.includes('\u2605')));
  assert.ok(chipGone, '\u2605 chip disappears when the last bookmark is removed');
});

test('★ filter releases when bookmarks are cleared so logs show again', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  // bookmark line 1 via the gutter, then press the ★ chip
  await page.evaluate(() => document.querySelector('.vrow .bm').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  await page.evaluate(() => {
    const star = Array.from(document.querySelectorAll('.chip')).find((c) => c.textContent.includes('\u2605'));
    star.click();
  });
  await page.waitForTimeout(150);
  assert.strictEqual(await page.evaluate(() => document.getElementById('st-shown').textContent), '1', '★ filter shows only the bookmarked line');
  // Clear all bookmarks from the panel
  await click('clear-bookmarks');
  await page.waitForTimeout(150);
  assert.strictEqual(await page.evaluate(() => document.getElementById('st-shown').textContent), '44', 'all lines visible again after Clear');
  const starSel = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.chip')).some((c) => c.textContent.includes('\u2605') && c.classList.contains('sel')));
  assert.ok(!starSel, '★ chip not left in selected state');
  // loading the same file again keeps the viewer fully usable (the file list
  // renders at ingest start; wait for the worker index + query to commit)
  await page.setInputFiles('#file-input', [join(root, 'tests', 'fixtures', 'demo.log')]);
  await page.waitForFunction(() => document.querySelectorAll('.file-item').length === 2, null, { timeout: 8000 });
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '88', null, { timeout: 8000 });
  assert.strictEqual(await page.evaluate(() => document.getElementById('st-shown').textContent), '88', 'both copies fully visible after re-load');
});

test('★ filter releases when the last bookmark is removed individually', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  await page.evaluate(() => document.querySelector('.vrow .bm').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  await page.evaluate(() => {
    const star = Array.from(document.querySelectorAll('.chip')).find((c) => c.textContent.includes('\u2605'));
    star.click();
  });
  await page.waitForTimeout(150);
  assert.strictEqual(await page.evaluate(() => document.getElementById('st-shown').textContent), '1');
  // remove the only bookmark via its ✕ in the panel
  await page.evaluate(() => document.querySelector('#bookmark-list .bm-entry .fx').click());
  await page.waitForTimeout(150);
  assert.strictEqual(await page.evaluate(() => document.getElementById('st-shown').textContent), '44', 'all lines visible after removing the last bookmark');
  const starSel = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.chip')).some((c) => c.textContent.includes('\u2605') && c.classList.contains('sel')));
  assert.ok(!starSel, '★ chip not left in selected state');
});

test('Providers tab: local default, remote banner, readable connection error', async () => {
  await fresh();
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=pii]').click());
  // local regex engine is the default and shows no remote warning
  assert.strictEqual(await page.evaluate(() => document.getElementById('pii-provider').value), 'local');
  assert.ok(await page.evaluate(() => document.getElementById('pii-remote-warn').classList.contains('hidden')));
  // switching to the Presidio sidecar shows the warning banner + its settings
  await page.evaluate(() => {
    const s = document.getElementById('pii-provider');
    s.value = 'presidio';
    s.dispatchEvent(new Event('change'));
  });
  assert.ok(await page.evaluate(() => !document.getElementById('pii-remote-warn').classList.contains('hidden')), 'remote warning visible');
  assert.ok(await page.evaluate(() => !document.getElementById('pii-presidio-box').classList.contains('hidden')), 'presidio settings visible');
  // Test connection against an unroutable port surfaces a readable status
  // (and must not throw — the pageerror guard in afterEach enforces that,
  // which is what would have caught the unbundled pii-remote.js module)
  await page.evaluate(() => { document.getElementById('pii-presidio-url').value = 'http://127.0.0.1:1'; });
  await click('btn-pii-test');
  await page.waitForFunction(() => document.getElementById('pii-test-status').textContent.length > 3, null, { timeout: 15000 });
  const status = await page.evaluate(() => document.getElementById('pii-test-status').textContent);
  assert.doesNotMatch(status, /^testing/, 'test-connection finished with a status: ' + status);
  // back to local: banner hides again
  await page.evaluate(() => {
    const s = document.getElementById('pii-provider');
    s.value = 'local';
    s.dispatchEvent(new Event('change'));
  });
  assert.ok(await page.evaluate(() => document.getElementById('pii-remote-warn').classList.contains('hidden')), 'warning hidden again for local');
});

test('issue scan flags suspend-to-RAM transitions with the built-in suspend group', async () => {
  await fresh();
  await page.setInputFiles('#file-input', [join(root, 'tests', 'fixtures', 'suspend.log')]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent !== '0', null, { timeout: 8000 });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=analysis]').click());
  await page.waitForFunction(() => document.querySelectorAll('#analysis-panel .issue').length > 0, null, { timeout: 8000 });
  const issues = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#analysis-panel .issue')).map((e) => e.textContent));
  // 12 of the 14 lines are suspend events; "SleepScheduled" and the filesystem
  // sync line are intentionally neutral
  assert.strictEqual(issues.length, 12, 'suspend/resume lines listed as issues, got ' + issues.length);
  assert.ok(issues.every((t) => t.toLowerCase().includes('suspend')), 'all attributed to the suspend group: ' + issues[0]);
});

test('issueGroups migration appends the suspend rule to older persisted sessions', async () => {
  await fresh();
  // a session persisted before the suspend group existed: five legacy groups
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('log_triage_state_v1') || '{}');
    s.issueGroups = [
      { kind: 'crash', pattern: 'fatal exception|tombstone|beginning of crash', on: true },
      { kind: 'anr', pattern: '\\banr in |input dispatching timed out', on: true },
      { kind: 'proc-death', pattern: 'has died|am_proc_died|force stopping', on: true },
      { kind: 'connectivity', pattern: 'connectivityservice|networkmonitor|data_disconnected|wifiservice|deactivatedatacall', on: true },
      { kind: 'auth', pattern: 'auth error|auth blocked|authentication failed|token refresh|credential|failed password|password check failed', on: true },
    ];
    localStorage.setItem('log_triage_state_v1', JSON.stringify(s));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=analysis]').click());
  await page.waitForFunction(() => document.querySelectorAll('#analysis-panel input[data-ig-k=kind]').length > 0, null, { timeout: 8000 });
  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#analysis-panel input[data-ig-k="kind"]')).map((i) => i.value));
  assert.ok(rows.includes('suspend'), 'suspend rule appended by migration, got: ' + rows.join(', '));
  assert.strictEqual(rows.length, 14, 'legacy groups preserved alongside the new rules');
});

test('ingest falls back to FileReader when File.stream is broken', async () => {
  await fresh();
  // simulate the Chromium quirk seen with real Downloads paths: stream read throws
  await page.evaluate(() => { File.prototype.stream = function () { throw new TypeError('network error'); }; });
  await page.setInputFiles('#file-input', [join(root, 'tests', 'fixtures', 'demo.log')]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 15000 });
  const fmt = await page.evaluate(() => (document.querySelector('.file-item .badge.fmt') || { textContent: '' }).textContent);
  assert.strictEqual(fmt, 'logcat', 'full pipeline ran over the fallback path');
});

test('search status discloses the analysis-sample scope and full-file filtering', async () => {
  await fresh();
  const big = join(os.tmpdir(), 'lt-scope-' + Date.now() + '.log');
  const lines = [];
  for (let i = 0; i < 120000; i++) lines.push('09-11 10:10:22.123  1234  5678 D Tag' + (i % 50) + ': fill line ' + i + ' payload');
  fs.writeFileSync(big, lines.join('\n') + '\n');
  await page.setInputFiles('#file-input', [big]);
  await page.waitForFunction(() => Number(document.getElementById('st-total').textContent) >= 120000, null, { timeout: 60000 });
  fs.rmSync(big, { force: true });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=search]').click());
  await page.fill('#rg-pattern', 'fill line');
  await page.waitForFunction(() => document.getElementById('search-progress').textContent.includes('match'), null, { timeout: 30000 });
  const status = await page.evaluate(() => document.getElementById('search-progress').textContent);
  assert.match(status, /in analysis sample/, 'sample scope disclosed: ' + status);
  assert.match(status, /viewer filtering searches complete indexed files/, 'full-file scope disclosed: ' + status);
});

test('search history dropdown persists across reload and re-runs picked terms', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  // record a quick-filter term and an rg search term
  await page.fill('#quick', 'heartbeat');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '4', null, { timeout: 8000 });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=search]').click());
  await page.fill('#rg-pattern', 'VHal');
  await page.waitForFunction(() => document.getElementById('search-progress').textContent.includes('match'), null, { timeout: 15000 });

  // reload: histories persist (the filters themselves stay transient)
  await page.reload({ waitUntil: 'domcontentloaded' });
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 15000 });

  // quick history dropdown: focus lists the recorded term; picking re-runs it
  await page.evaluate(() => document.getElementById('quick').focus());
  await page.waitForFunction(() => document.querySelectorAll('.history-dd .history-item').length > 0, null, { timeout: 8000 });
  const quickItems = await page.evaluate(() => Array.from(document.querySelectorAll('.history-dd .history-item')).map((e) => e.textContent));
  assert.ok(quickItems.includes('heartbeat'), 'quick history lists heartbeat, got: ' + quickItems.join(', '));
  await page.click('.history-dd .history-item');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '4', null, { timeout: 8000 });
  assert.strictEqual(await page.inputValue('#quick'), 'heartbeat', 'picked term filled the input');

  // rg history dropdown as well
  await page.evaluate(() => {
    document.querySelector('#tabs button[data-tab=search]').click();
    document.getElementById('rg-pattern').focus();
  });
  await page.waitForFunction(() => document.querySelectorAll('.history-dd .history-item').length > 0, null, { timeout: 8000 });
  const rgItems = await page.evaluate(() => Array.from(document.querySelectorAll('.history-dd .history-item')).map((e) => e.textContent));
  assert.ok(rgItems.includes('VHal'), 'rg history lists VHal, got: ' + rgItems.join(', '));
});

test('drag-and-drop loads the file exactly once', async () => {
  await fresh();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['dropped line 1\ndropped line 2\n'], 'dropped.log', { type: 'text/plain' }));
    const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    document.getElementById('dropzone').dispatchEvent(ev);
  });
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '2', null, { timeout: 8000 });
  const files = await page.evaluate(() => ({
    items: document.querySelectorAll('.file-item').length,
    names: Array.from(document.querySelectorAll('.file-item .fname')).map((e) => e.textContent),
  }));
  assert.strictEqual(files.items, 1, 'exactly one file entry, got: ' + files.names.join(', '));
});

test('folder drop ingests the contained files recursively', async () => {
  await fresh();
  await page.evaluate(() => {
    // mock the FileSystemEntry tree Explorer exposes for a dropped folder
    const fileEntry = (name, content) => ({
      isFile: true, isDirectory: false,
      file: (res) => res(new File([content], name, { type: 'text/plain' })),
    });
    const dirEntry = (name, children) => {
      // readEntries returns <=100 per call and must be drained until empty
      const batches = [children.slice(0, 2), children.slice(2), []];
      return {
        isFile: false, isDirectory: true, name,
        createReader: () => ({ readEntries: (res) => res(batches.shift() || []) }),
      };
    };
    const folder = dirEntry('logs', [
      fileEntry('a.log', 'alpha 1\nalpha 2\n'),
      fileEntry('b.log', 'beta 1\n'),
      dirEntry('sub', [fileEntry('c.log', 'gamma 1\ngamma 2\ngamma 3\n')]),
    ]);
    const dt = { items: [{ kind: 'file', webkitGetAsEntry: () => folder }], files: [] };
    const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    document.getElementById('dropzone').dispatchEvent(ev);
  });
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '6', null, { timeout: 8000 });
  const files = await page.evaluate(() => ({
    items: document.querySelectorAll('.file-item').length,
    names: Array.from(document.querySelectorAll('.file-item .fname')).map((e) => e.textContent),
  }));
  assert.deepStrictEqual(files.names.sort(), ['logs/a.log', 'logs/b.log', 'logs/sub/c.log'], 'folder-relative names kept');
  assert.strictEqual(files.items, 3, 'three files, not the folder pseudo-entry');
});

test('dropping MULTIPLE folders plus a loose file in one drop ingests everything', async () => {
  await fresh();
  await page.evaluate(() => {
    const fileEntry = (name, content) => ({
      isFile: true, isDirectory: false,
      file: (res) => res(new File([content], name, { type: 'text/plain' })),
    });
    const dirEntry = (name, children) => {
      const batches = [children, []];
      return {
        isFile: false, isDirectory: true, name,
        createReader: () => ({ readEntries: (res) => res(batches.shift() || []) }),
      };
    };
    const folderA = dirEntry('folderA', [
      fileEntry('a1.log', 'alpha one\n'),
      fileEntry('a2.log', 'alpha two\n'),
    ]);
    const folderB = dirEntry('folderB', [
      fileEntry('b1.log', 'beta one\n'),
      dirEntry('sub', [fileEntry('b2.log', 'beta two\n')]),
    ]);
    const dt = {
      items: [
        { kind: 'file', webkitGetAsEntry: () => folderA },
        { kind: 'file', webkitGetAsEntry: () => folderB },
        { kind: 'file', webkitGetAsEntry: () => fileEntry('top.log', 'loose line\n') },
      ],
      files: [],
    };
    const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    document.getElementById('dropzone').dispatchEvent(ev);
  });
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '5', null, { timeout: 8000 });
  const files = await page.evaluate(() => Array.from(document.querySelectorAll('.file-item .fname')).map((e) => e.textContent).sort());
  assert.deepStrictEqual(files, ['folderA/a1.log', 'folderA/a2.log', 'folderB/b1.log', 'folderB/sub/b2.log', 'top.log'],
    'both folders and the loose file ingested with folder-relative names');
});

test('REAL Chromium drop of two folders ingests everything (CDP-dispatched)', async () => {
  await fresh();
  // build real folders on disk and drop them through the browser's own drag
  // machinery (Input.dispatchDragEvent with DragData.files) — no mocks
  const base = join(root, 'tests', 'tmp', 'real-drop-' + Date.now());
  fs.mkdirSync(join(base, 'dropA'), { recursive: true });
  fs.mkdirSync(join(base, 'dropB', 'sub'), { recursive: true });
  fs.writeFileSync(join(base, 'dropA', 'a1.log'), 'alpha one\n');
  fs.writeFileSync(join(base, 'dropA', 'a2.log'), 'alpha two\n');
  fs.writeFileSync(join(base, 'dropB', 'b1.log'), 'beta one\n');
  fs.writeFileSync(join(base, 'dropB', 'sub', 'b2.log'), 'beta two\n');
  try {
    const box = await page.evaluate(() => {
      const r = document.getElementById('dropzone').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    const cdp = await page.context().newCDPSession(page);
    const dragData = { items: [], files: [join(base, 'dropA'), join(base, 'dropB')], dragOperationsMask: 1 };
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: box.x, y: box.y, data: dragData });
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: box.x, y: box.y, data: dragData });
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: box.x, y: box.y, data: dragData });
    await page.waitForFunction(() => document.getElementById('st-total').textContent === '4', null, { timeout: 15000 });
    const names = await page.evaluate(() => Array.from(document.querySelectorAll('.file-item .fname')).map((e) => e.textContent).sort());
    assert.deepStrictEqual(names, ['dropA/a1.log', 'dropA/a2.log', 'dropB/b1.log', 'dropB/sub/b2.log'],
      'real drop ingests both folders with folder-relative names');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('REAL drop of two plain FILES via CDP loads both', async () => {
  await fresh();
  const base = join(root, 'tests', 'tmp', 'real-files-' + Date.now());
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(join(base, 'one.log'), 'file one line\n');
  fs.writeFileSync(join(base, 'two.log'), 'file two line\n');
  try {
    const box = await page.evaluate(() => {
      const r = document.getElementById('dropzone').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    const cdp = await page.context().newCDPSession(page);
    const dragData = { items: [], files: [join(base, 'one.log'), join(base, 'two.log')], dragOperationsMask: 1 };
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: box.x, y: box.y, data: dragData });
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: box.x, y: box.y, data: dragData });
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: box.x, y: box.y, data: dragData });
    await page.waitForFunction(() => document.getElementById('st-total').textContent === '2', null, { timeout: 15000 });
    const names = await page.evaluate(() => Array.from(document.querySelectorAll('.file-item .fname')).map((e) => e.textContent).sort());
    assert.deepStrictEqual(names, ['one.log', 'two.log'], 'both plain files ingested');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('REAL drop of plain FILES via CDP loads them; deep paths degrade gracefully', async () => {
  await fresh();
  // regression guard for the plain-file drop path: the app must use the
  // dataTransfer.files File objects (readable at >260-char paths in real
  // Explorer drops; the entries API's entry.file() throws NotFoundError
  // there). Under CDP dispatch, deep paths may be unreadable in Chromium
  // itself — the app must then show the long-path guidance instead of
  // loading nothing silently.
  const base = join(root, 'tests', 'tmp', 'deep-files-' + Date.now());
  let deep = join(base, 'R V D C (Size-17.4 MB)');
  for (let i = 0; i < 6; i++) { deep = join(deep, 'level-with-a-fairly-long-name-0123456789-' + i); fs.mkdirSync(deep, { recursive: true }); }
  const f1 = join(deep, 'logcat@20260911_16-12-29-119-Batch_2873_merged.log');
  const f2 = join(deep, 'second@20260911_(Size-17.4 MB).log');
  fs.writeFileSync(f1, 'deep file one\n');
  fs.writeFileSync(f2, 'deep file two\n');
  if (f1.length <= 260) console.log('  note: test path is not actually long (' + f1.length + ')');
  try {
    const box = await page.evaluate(() => {
      const r = document.getElementById('dropzone').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    const cdp = await page.context().newCDPSession(page);
    const dragData = { items: [], files: [f1, f2], dragOperationsMask: 1 };
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: box.x, y: box.y, data: dragData });
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: box.x, y: box.y, data: dragData });
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: box.x, y: box.y, data: dragData });
    await page.waitForFunction(() => {
      const total = document.getElementById('st-total').textContent;
      const msg = document.getElementById('st-progress').textContent;
      return msg.includes('0 lines') || msg.includes('could not be read') || total === '2';
    }, null, { timeout: 15000 });
    const outcome = await page.evaluate(() => ({
      total: document.getElementById('st-total').textContent,
      message: document.getElementById('st-progress').textContent,
      names: Array.from(document.querySelectorAll('.file-item .fname')).map((e) => e.textContent).sort(),
    }));
    if (outcome.total === '2' && !outcome.message.includes('0 lines')) {
      assert.deepStrictEqual(outcome.names, ['logcat@20260911_16-12-29-119-Batch_2873_merged.log', 'second@20260911_(Size-17.4 MB).log'],
        'deep files loaded via the dataTransfer.files path');
      console.log('  environment: deep dt.files readable — files loaded');
    } else {
      assert.match(outcome.message, /0 lines|could not be read/, 'graceful report shown: ' + outcome.message);
      assert.match(outcome.message, /260-character/, 'actionable hint shown');
      console.log('  environment: deep dt.files unreadable under CDP — graceful report shown');
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('search results wrap long matched lines instead of overflowing', async () => {
  await fresh();
  const big = join(os.tmpdir(), 'lt-srwrap-' + Date.now() + '.log');
  const lines = [
    '09-11 22:14:01.100  1000  2000 I VHal: short normal line',
    '09-11 22:14:02.100  1000  2000 I VHal: RARETERM payload ' + 'x'.repeat(3000) + ' END',
    '09-11 22:14:03.100  1000  2000 I VHal: another short line',
  ];
  fs.writeFileSync(big, lines.join('\n') + '\n');
  await page.setInputFiles('#file-input', [big]);
  await page.waitForFunction(() => Number(document.getElementById('st-total').textContent) >= 3, null, { timeout: 15000 });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=search]').click());
  await page.fill('#rg-pattern', 'RARETERM');
  await page.waitForFunction(() => document.getElementById('search-progress').textContent.includes('match'), null, { timeout: 15000 });
  await page.waitForSelector('.sr-row.hit');
  const m = await page.evaluate(() => {
    const box = document.getElementById('search-results');
    const row = document.querySelector('.sr-row.hit');
    return {
      containerW: box.clientWidth,
      rowW: row.scrollWidth,
      rowBg: getComputedStyle(row).backgroundColor,
      pageBg: getComputedStyle(document.body).backgroundColor,
    };
  });
  assert.ok(m.rowW <= m.containerW + 2, 'wrapped row fits the container: row=' + m.rowW + ' container=' + m.containerW);
  assert.notStrictEqual(m.rowBg, m.pageBg, 'hit row has a visible highlight background');

  // the Search tab has its own wrap toggle: OFF = one scrollable line per match
  assert.strictEqual(await page.textContent('#btn-sr-wrap'), 'Wrap: ON');
  await page.click('#btn-sr-wrap');
  await page.waitForFunction(() => document.getElementById('search-results').classList.contains('nowrap'), null, { timeout: 5000 });
  const off = await page.evaluate(() => {
    const box = document.getElementById('search-results');
    const row = document.querySelector('.sr-row.hit');
    return { boxW: box.clientWidth, rowW: row.scrollWidth, btn: document.getElementById('btn-sr-wrap').textContent };
  });
  assert.ok(off.rowW > off.boxW + 2, 'nowrap mode overflows horizontally again: row=' + off.rowW + ' box=' + off.boxW);
  assert.strictEqual(off.btn, 'Wrap: OFF');

  // the preference survives a reload
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('btn-sr-wrap') && document.getElementById('btn-sr-wrap').textContent === 'Wrap: OFF', null, { timeout: 8000 });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=search]').click());
  await page.click('#btn-sr-wrap'); // back to ON for other tests
  fs.rmSync(big, { force: true });
});

test('search tab rg options have explanatory tooltips', async () => {
  await fresh();
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=search]').click());
  const titles = await page.evaluate(() => ({
    fixed: document.getElementById('rg-fixed').closest('label').title,
    word: document.getElementById('rg-word').closest('label').title,
    invert: document.getElementById('rg-invert').closest('label').title,
    cs: document.getElementById('rg-case').title,
    mode: document.getElementById('rg-mode').title,
    before: document.getElementById('rg-before').closest('label').title,
    after: document.getElementById('rg-after').closest('label').title,
    scan: document.getElementById('btn-deepscan').title,
  }));
  for (const [k, v] of Object.entries(titles)) assert.ok(v && v.length > 15, k + ' needs an explanatory tooltip');
  assert.match(titles.fixed, /-F/);
  assert.match(titles.word, /-w/);
  assert.match(titles.invert, /-v/);
  assert.match(titles.mode, /-c/);
  assert.match(titles.before, /[Bb]efore/);
  assert.match(titles.after, /[Aa]fter/);
});

test('analysis tab shows an analyzing placeholder; deep scan has a cancel control', async () => {
  await fresh();
  await page.evaluate(() => {
    window.__sawAnalyzing = false;
    const p = document.getElementById('analysis-panel');
    new MutationObserver(() => { if (p.textContent.includes('analyzing')) window.__sawAnalyzing = true; })
      .observe(p, { childList: true, subtree: true, characterData: true });
  });
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  // first analysis open shows the placeholder, then the panel renders
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=analysis]').click());
  await page.waitForFunction(() => document.querySelectorAll('#analysis-panel .stat-card').length > 0, null, { timeout: 8000 });
  assert.ok(await page.evaluate(() => window.__sawAnalyzing), 'analyzing placeholder painted at least once');
  // deep scan wiring: cancel control exists, hidden while idle
  const cancel = await page.evaluate(() => {
    const b = document.getElementById('btn-deep-cancel');
    return { exists: !!b, hidden: b.classList.contains('hidden') };
  });
  assert.ok(cancel.exists && cancel.hidden, 'cancel button present but hidden while idle');
});
test('drawer: pid/tid on one line, masked label with chevron-gated raw', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  // row 2 is the VIN line: masked and raw differ there.
  // the viewer opens the drawer on mousedown (delegated at #vspacer)
  await page.evaluate(() => {
    document.querySelectorAll('.vrow')[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const d = document.getElementById('drawer');
    return d.classList.contains('open') && d.querySelector('.chev-toggle');
  }, null, { timeout: 5000 });
  const html = await page.evaluate(() => document.getElementById('drawer').innerHTML);
  assert.ok(html.includes('pid / tid'), 'pid and tid share one line');
  assert.ok(html.includes('>masked<'), 'label says masked when masking changed the line');
  assert.ok(html.includes('1234') && html.includes('5678'), 'pid/tid values shown');
  // default collapsed: the raw VIN is not in the drawer DOM at all
  let text = await page.evaluate(() => document.getElementById('drawer').textContent);
  assert.ok(!text.includes('YV4AB9CD12EF34567'), 'raw collapsed by default: raw VIN not shown');
  assert.ok(text.includes('YV4**********4567'), 'masked text is the default body');
  // chevron expands: raw line appears
  await page.evaluate(() => document.querySelector('#drawer .chev-toggle').click());
  await page.waitForTimeout(150);
  text = await page.evaluate(() => document.getElementById('drawer').textContent);
  assert.ok(text.includes('YV4AB9CD12EF34567'), 'raw VIN visible after expand');
  const chip = await page.evaluate(() => { const c = document.querySelector('#drawer .raw-chip'); return c ? c.textContent : null; });
  assert.ok(chip && /raw/i.test(chip), 'expanded raw block carries a RAW warning chip: ' + chip);
  // chevron collapses again: raw line leaves the DOM
  await page.evaluate(() => document.querySelector('#drawer .chev-toggle').click());
  await page.waitForTimeout(150);
  text = await page.evaluate(() => document.getElementById('drawer').textContent);
  assert.ok(!text.includes('YV4AB9CD12EF34567'), 'raw VIN hidden again after collapse');
  // PII-free line: label flips to raw, no chevron
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.vrow'));
    const target = rows.find((r) => r.textContent.includes('ActivityManager'));
    if (target) target.querySelector('.txt').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const d = document.getElementById('drawer');
    return d.classList.contains('open') && !d.querySelector('.chev-toggle');
  }, null, { timeout: 5000 });
  const html2 = await page.evaluate(() => document.getElementById('drawer').innerHTML);
  assert.ok(!html2.includes('masked'), 'no masked label when masking changed nothing');
  assert.ok(html2.includes('>raw<'), 'label says raw when masking changed nothing');
});

test('text inputs get an inline ✕ clear button that empties and re-fires', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  await page.fill('#quick', 'AudioService');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent !== '44');
  const state = () => page.evaluate(() => {
    const wrap = document.getElementById('quick').closest('.clr-wrap');
    const btn = wrap && wrap.querySelector('.clr-btn');
    return { wrapped: !!wrap, hidden: !btn || btn.classList.contains('hidden'), val: document.getElementById('quick').value };
  });
  let s = await state();
  assert.ok(s.wrapped && !s.hidden, 'clear button visible while text is entered: ' + JSON.stringify(s));
  await page.evaluate(() => document.getElementById('quick').closest('.clr-wrap').querySelector('.clr-btn').click());
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '44', null, { timeout: 5000 });
  s = await state();
  assert.strictEqual(s.val, '', 'input emptied by ✕');
  assert.ok(s.hidden, 'clear button hidden once empty');
  // Dense rule-table inputs stay plain: wrapping them changes the automatic
  // column width after every edit/rerender cycle.
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=filters]').click());
  await page.evaluate(() => document.getElementById('btn-add-rule').click());
  const pattern = () => page.locator('#rule-rows [data-k=pattern]');
  const before = await pattern().evaluate((el) => el.getBoundingClientRect().width);
  await pattern().click();
  const firstFocus = await pattern().evaluate((el) => ({ width: el.getBoundingClientRect().width, wrapped: !!el.closest('.clr-wrap') }));
  await pattern().fill('ActivityManager');
  await pattern().press('Tab');
  await page.waitForFunction(() => document.getElementById('viewer').getAttribute('aria-busy') === 'false');
  const beforeSecondFocus = await pattern().evaluate((el) => el.getBoundingClientRect().width);
  await pattern().click();
  const secondFocus = await pattern().evaluate((el) => ({ width: el.getBoundingClientRect().width, wrapped: !!el.closest('.clr-wrap') }));
  assert.ok(!firstFocus.wrapped && !secondFocus.wrapped, 'rule inputs are not wrapped by the standalone-field clear control');
  assert.ok(Math.abs(firstFocus.width - before) <= 1, 'first focus keeps rule input width');
  assert.ok(Math.abs(secondFocus.width - beforeSecondFocus) <= 1, 'focus after rerender keeps rule input width');
  assert.ok(Math.abs(secondFocus.width - before) <= 1, 'repeated edits do not grow the rule column');
});

test('issue scan groups by kind with severity color coding', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=analysis]').click());
  await page.waitForFunction(() => document.querySelectorAll('#analysis-panel details.iss-group').length > 0, null, { timeout: 8000 });
  const groups = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#analysis-panel details.iss-group')).map((d) => ({
      kind: d.querySelector('.iss-kind').textContent,
      sev: d.className.includes('iss-crit') ? 'crit' : d.className.includes('iss-high') ? 'high'
        : d.className.includes('iss-med') ? 'med' : 'low',
      count: Number(d.querySelector('summary .count-pill').textContent),
      open: d.open,
      leaves: d.querySelectorAll('.issue').length,
    })));
  const totalLeaves = groups.reduce((s, g) => s + g.leaves, 0);
  assert.ok(groups.length >= 4, 'multiple kinds grouped, got ' + groups.length);
  assert.ok(totalLeaves > 0, 'leaf issues present inside groups');
  // severity ordering: the first group must be a critical one
  assert.strictEqual(groups[0].sev, 'crit', 'critical group sorted first: ' + JSON.stringify(groups.map((g) => [g.kind, g.sev])));
  assert.strictEqual(groups[0].kind, 'crash', 'demo crash group present and first');
  // every leaf belongs to its group and the counts match
  for (const g of groups) assert.strictEqual(g.count, g.leaves, 'summary count matches children for ' + g.kind);
  // highest-severity group starts open; the rest stay collapsed
  assert.strictEqual(groups[0].open, true, 'first group auto-open');
  assert.ok(groups.slice(1).every((g) => !g.open), 'remaining groups collapsed to save space');
  // severity tiers only from the documented set
  assert.ok(groups.every((g) => ['crit', 'high', 'med', 'low'].includes(g.sev)));
  // clicking a leaf still jumps to the line (drawer opens)
  await page.evaluate(() => document.querySelector('#analysis-panel details.iss-group[open] .issue').click());
  await page.waitForTimeout(250);
  const drawer = await page.evaluate(() => document.getElementById('drawer').textContent);
  assert.ok(drawer.length > 10, 'leaf click jumps to the line');
});

test('loads a .7z archive: extracted files appear in the file list', { skip: !find7z() }, async () => {
  await fresh();
  await page.setInputFiles('#file-input', [sevenZipBundle()]);
  await page.waitForFunction(() => document.querySelectorAll('.file-item .fname').length === 2, null, { timeout: 15000 });
  const names = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.file-item .fname')).map((e) => e.textContent));
  assert.ok(names.includes('bundle/a.log'), 'bundle/a.log listed, got: ' + names.join(', '));
  assert.ok(names.includes('bundle/sub/b.log'), 'bundle/sub/b.log listed, got: ' + names.join(', '));
  // the count commits after the worker index + query — wait for it
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '8', null, { timeout: 8000 });
  const st = await status();
  assert.strictEqual(st.fmt, 'logcat', 'inner log detected as logcat');
  assert.strictEqual(st.total, '8', '4 lines per inner log');
});

test('archive export re-packs the extract (.7z stored) as a download', { skip: !find7z() }, async () => {
  await fresh();
  await page.setInputFiles('#file-input', [sevenZipBundle()]);
  await page.waitForFunction(() => document.querySelectorAll('.file-item .fname').length === 2, null, { timeout: 15000 });
  // .7z keeps the bounded buffered writer, which is selection-scoped: select all rows first
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await page.keyboard.press('Control+a');
  await page.waitForFunction(() => document.getElementById('st-sel') && Number(document.getElementById('st-sel').textContent.replace(/\D/g, '')) > 0, null, { timeout: 5000 });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=export]').click());
  await page.evaluate(() => { document.getElementById('exp-selection').checked = true; });
  await page.evaluate(() => {
    const sel = document.getElementById('exp-archive-format');
    sel.value = '7z';
    sel.dispatchEvent(new Event('change'));
  });
  const downloadPromise = page.waitForEvent('download', { timeout: 8000 });
  await click('exp-archive');
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /\.7z$/);
  const p = await download.path();
  const magic = fs.readFileSync(p).subarray(0, 6);
  assert.deepStrictEqual([...magic], [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], 'download is a real 7z');
  const note = await page.evaluate(() => document.getElementById('exp-archive-note').textContent);
  assert.match(note, /exported/);
});

test('.7z full-scope export explains the buffered limit and streams zip instead', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=export]').click());
  await page.evaluate(() => {
    const sel = document.getElementById('exp-archive-format');
    sel.value = '7z';
    sel.dispatchEvent(new Event('change'));
  });
  await click('exp-archive');
  await page.waitForFunction(() => /bounded buffer/.test(document.getElementById('exp-archive-note').textContent), null, { timeout: 5000 });
  // streaming zip works from the current view
  await page.evaluate(() => {
    const sel = document.getElementById('exp-archive-format');
    sel.value = 'zip';
    sel.dispatchEvent(new Event('change'));
  });
  // mock the direct-save picker with an in-memory writable so the streamed
  // bytes can be verified without touching the real file system
  await page.evaluate(() => {
    window.__sink = [];
    window.__sinkClosed = false;
    window.showSaveFilePicker = async () => ({
      createWritable: async () => ({
        async write(b) { window.__sink.push(b); return window.__sink.reduce((s, c) => s + c.byteLength, 0); },
        async close() { window.__sinkClosed = true; },
        async abort() { window.__sinkAborted = true; },
      }),
    });
  });
  await click('exp-archive');
  await page.waitForFunction(() => window.__sinkClosed === true, null, { timeout: 15000 });
  const size = await page.evaluate(() => window.__sink.reduce((s, c) => s + c.byteLength, 0));
  assert.ok(size > 0, 'zip streamed bytes: ' + size);
  const magic = await page.evaluate(() => [window.__sink[0][0], window.__sink[0][1], window.__sink[0][2], window.__sink[0][3]].join(','));
  assert.strictEqual(magic, '80,75,3,4', 'PK\\x03\\x04 local header');
  const eocd = await page.evaluate(() => {
    const all = window.__sink.reduce((acc, b) => { const o = new Uint8Array(acc.length + b.length); o.set(acc); o.set(b, acc.length); return o; }, new Uint8Array(0));
    return [all[all.length - 22], all[all.length - 21], all[all.length - 20], all[all.length - 19]].join(',');
  });
  assert.strictEqual(eocd, '80,75,5,6', 'PK\\x05\\x06 end of central directory');
  const note = await page.evaluate(() => document.getElementById('exp-archive-note').textContent);
  assert.match(note, /streamed/);
});

test('archive export honors per-file view scope', async () => {
  await fresh();
  await page.setInputFiles('#file-input', [
    join(root, 'tests', 'fixtures', 'demo.log'),
    join(root, 'tests', 'fixtures', 'syslog.log'),
  ]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '52', null, { timeout: 8000 });
  // switch to per-file view (clicking a file item selects it)
  await page.evaluate(() => document.querySelectorAll('.file-item')[1].click());
  await page.waitForFunction(() => document.getElementById('view-mode').value === 'file', null, { timeout: 5000 });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=export]').click());
  await page.evaluate(() => {
    const sel = document.getElementById('exp-archive-format');
    sel.value = 'zip';
    sel.dispatchEvent(new Event('change'));
    window.__sink = [];
    window.__sinkClosed = false;
    window.showSaveFilePicker = async () => ({
      createWritable: async () => ({
        async write(b) { window.__sink.push(b); },
        async close() { window.__sinkClosed = true; },
        async abort() {},
      }),
    });
  });
  await click('exp-archive');
  await page.waitForFunction(() => window.__sinkClosed === true, null, { timeout: 15000 });
  const note = await page.evaluate(() => document.getElementById('exp-archive-note').textContent);
  assert.match(note, /exported 1 file\(s\)/, 'per-file view exports one archive entry: ' + note);
  // the zip central directory must list exactly one entry
  const entryCount = await page.evaluate(() => {
    const all = window.__sink.reduce((acc, b) => { const o = new Uint8Array(acc.length + b.length); o.set(acc); o.set(b, acc.length); return o; }, new Uint8Array(0));
    return all[all.length - 12] | (all[all.length - 11] << 8);
  });
  assert.strictEqual(entryCount, 1, 'zip holds exactly one entry');
});

test('archive export ignores a second click while one is running', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=export]').click());
  await page.evaluate(() => {
    const sel = document.getElementById('exp-archive-format');
    sel.value = 'zip';
    sel.dispatchEvent(new Event('change'));
    window.__pickerCalls = 0;
    window.__sinkClosed = false;
    // the picker blocks until the test releases it, keeping the export in flight
    window.showSaveFilePicker = async () => {
      window.__pickerCalls++;
      await new Promise((res) => { window.__release = res; });
      return {
        createWritable: async () => ({
          async write() {},
          async close() { window.__sinkClosed = true; },
          async abort() {},
        }),
      };
    };
  });
  await click('exp-archive');
  await page.waitForFunction(() => window.__pickerCalls === 1, null, { timeout: 8000 });
  await click('exp-archive'); // second click while the first is awaiting the picker
  await page.waitForTimeout(300);
  assert.strictEqual(await page.evaluate(() => window.__pickerCalls), 1, 'second click did not start another export');
  await page.evaluate(() => window.__release());
  await page.waitForFunction(() => window.__sinkClosed === true, null, { timeout: 15000 });
  const note = await page.evaluate(() => document.getElementById('exp-archive-note').textContent);
  assert.match(note, /streamed/, 'first export completed normally: ' + note);
});

test('archive export streams a >32 MiB extract straight to the sink (uncapped zip)', async () => {
  await fresh();
  const osmod = await import('node:os');
  const tmp = join(osmod.tmpdir(), 'lt-big-archive.log');
  const filler = 'x'.repeat(170);
  const lines = [];
  for (let i = 0; i < 190000; i++) lines.push('08-24 15:37:01.123  1234  5678 I BigFeed : ' + filler + ' seq=' + i);
  fs.writeFileSync(tmp, lines.join('\n') + '\n');
  await page.setInputFiles('#file-input', [tmp]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '190000', null, { timeout: 120000 });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=export]').click());
  await page.evaluate(() => {
    const sel = document.getElementById('exp-archive-format');
    sel.value = 'zip';
    sel.dispatchEvent(new Event('change'));
    window.__sink = [];
    window.__sinkClosed = false;
    window.showSaveFilePicker = async () => ({
      createWritable: async () => ({
        async write(b) { window.__sink.push(b); return window.__sink.reduce((s, c) => s + c.byteLength, 0); },
        async close() { window.__sinkClosed = true; },
        async abort() { window.__sinkAborted = true; },
      }),
    });
  });
  await click('exp-archive');
  await page.waitForFunction(() => window.__sinkClosed === true, null, { timeout: 120000 });
  const size = await page.evaluate(() => window.__sink.reduce((s, c) => s + c.byteLength, 0));
  assert.ok(size > 32 * 1024 * 1024, 'streamed beyond the old buffered limit: ' + (size / 1048576).toFixed(1) + ' MB');
  const magic = await page.evaluate(() => [window.__sink[0][0], window.__sink[0][1], window.__sink[0][2], window.__sink[0][3]].join(','));
  assert.strictEqual(magic, '80,75,3,4', 'zip magic');
  const note = await page.evaluate(() => document.getElementById('exp-archive-note').textContent);
  assert.match(note, /streamed/);
});

test('dlt-viewer text export: badge, chips, drawer fields, masking, quick filter, masked export', async () => {
  await fresh();
  await page.setInputFiles('#file-input', [join(root, 'tests', 'fixtures', 'dlt-viewer-sample.txt')]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '42', null, { timeout: 8000 });
  const st = await status();
  assert.strictEqual(st.fmt, 'dlt', 'format badge is dlt');
  const chipText = st.chips.join(' ');
  assert.match(chipText, /F1/, 'fatal chip counted: ' + chipText);
  assert.match(chipText, /V4/, 'verbose chip counted: ' + chipText);
  // drawer on the VIN line (masked in the viewer): tag is appid:ctid, pid is sessionid
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.vrow'));
    const target = rows.find((r) => r.textContent.includes('VIN read'));
    if (target) target.querySelector('.txt').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await page.waitForFunction(() => document.getElementById('drawer').classList.contains('open'), null, { timeout: 5000 });
  const drawerText = await page.evaluate(() => document.getElementById('drawer').textContent);
  assert.ok(drawerText.includes('YV4**********4567'), 'masked VIN shown in drawer');
  assert.ok(drawerText.includes('HMI:CAN'), 'tag is appid:ctid');
  assert.ok(drawerText.includes('310'), 'pid holds the session id');
  // sanitized .log export
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=export]').click());
  const downloadPromise = page.waitForEvent('download', { timeout: 8000 });
  await click('exp-txt');
  const download = await downloadPromise;
  const fsmod = await import('node:fs');
  const content = fsmod.readFileSync(await download.path(), 'utf8');
  assert.ok(content.includes('YV4**********4567'), 'export carries masked VIN');
  assert.ok(!content.includes('YV4AB9CD12EF34567'), 'export leaks no raw VIN');
  // quick filter narrows to the bridge11 lines
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await page.fill('#quick', 'bridge11');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '2', null, { timeout: 5000 });
  await page.fill('#quick', '');
});

test('binary .dlt drop: dlt-binary badge, level chips, hex-dump rows, drawer fields (AC-E.1, AC-E.4, AC-E.5)', async () => {
  await fresh();
  // the pinned hex fixture becomes a real binary .dlt file on disk
  const bin = join(os.tmpdir(), 'lt-binary-sample-' + Date.now() + '.dlt');
  fs.writeFileSync(bin, Buffer.from(fs.readFileSync(join(root, 'tests', 'fixtures', 'dlt-binary-sample.hex'), 'utf8').trim(), 'hex'));
  await page.setInputFiles('#file-input', [bin]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '5', null, { timeout: 8000 });
  const st = await status();
  assert.strictEqual(st.fmt, 'dlt-binary', 'format badge is dlt-binary');
  const chipText = st.chips.join(' ');
  assert.match(chipText, /I2/, 'level chips counted from decoded records: ' + chipText);
  assert.match(chipText, /E1/, 'error chip counted: ' + chipText);
  assert.match(chipText, /W1/, 'warn chip counted: ' + chipText);
  assert.match(chipText, /D1/, 'debug chip counted: ' + chipText);
  // hex-dump rows are visible in the viewer (AC-E.4/AC-E.5)
  const rowsText = await page.evaluate(() => Array.from(document.querySelectorAll('.vrow .txt')).map((n) => n.textContent).join('\n'));
  assert.match(rowsText, /log warn hex 01ff10/, 'non-verbose hex-dump row visible');
  assert.match(rowsText, /control request hex dead/, 'control keyword row visible');
  assert.match(rowsText, /app_trace variable 00ff10/, 'app_trace keyword row visible');
  // drawer fields decode from the binary record: tag is appid:ctid, pid is the
  // session id, ts the storage-header timestamp
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.vrow'));
    const target = rows.find((r) => r.textContent.includes('hello world'));
    if (target) target.querySelector('.txt').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await page.waitForFunction(() => document.getElementById('drawer').classList.contains('open'), null, { timeout: 5000 });
  const drawerText = await page.evaluate(() => document.getElementById('drawer').textContent);
  assert.ok(drawerText.includes('APP1:CTX1'), 'tag is appid:ctid');
  assert.ok(drawerText.includes('1234'), 'pid holds the session id');
  assert.ok(drawerText.includes('01-01 00:00:00.000'), 'drawer carries the storage-header timestamp');
});

test('binary .dlt drop: lossy capture surfaces warnings and flows chips, full-file search, mask, export (AC-E.2, AC-5.5, AC-E.8)', async () => {
  await fresh();
  // byte-built lossy capture: a valid verbose info line with a VIN, implausible
  // framing (resync), a non-verbose hex row, and a truncated tail -> 3 records,
  // exactly 2 warnings, levels I1/E2
  const enc = (s) => new TextEncoder().encode(s);
  const bcat = (...xs) => { const n = xs.reduce((s, a) => s + a.length, 0); const out = new Uint8Array(n); let p = 0; for (const a of xs) { out.set(a, p); p += a.length; } return out; };
  const bb = (a) => new Uint8Array(a);
  const ba4 = (s) => { const out = new Uint8Array(4); out.set(enc(s).slice(0, 4)); return out; };
  const bu16 = (v) => bb([v & 255, (v >> 8) & 255]);
  const bu32 = (v) => bb([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]);
  const bmsg = (o) => {
    const payload = o.str != null ? bcat(bu32(0x200 | 0x8000), bu16(o.str.length + 1), enc(o.str), bb([0])) : bb(o.payload || []);
    const body = bcat(bb([0x21, o.mcnt]), bu16(4 + 10 + payload.length), bb([o.msin, o.str != null ? 1 : 0]), ba4('APP1'), ba4('CTX1'), payload);
    return o.storage === undefined ? body : bcat(bb([0x44, 0x4c, 0x54, 0x01]), ba4('ECU1'), bu32(o.storage), bu32(0), body);
  };
  const good = bmsg({ storage: 0, mcnt: 1, msin: 0x41, str: 'VIN read: YV4AB9CD12EF34567 ok' });
  const bad = bcat(bb([0x20, 9, 0, 0]), bb(new Array(40).fill(0xaa))); // declared length below minLen
  const hexRow = bmsg({ mcnt: 2, msin: 0x20, payload: [0xde, 0xad, 0xbe, 0xef] });
  const tail = bmsg({ mcnt: 3, msin: 0x20, payload: [1, 2, 3, 4, 5, 6] }).slice(0, -2); // truncated at EOF
  const lossy = join(os.tmpdir(), 'lt-binary-lossy-' + Date.now() + '.dlt');
  fs.writeFileSync(lossy, Buffer.from(bcat(good, bad, hexRow, tail)));
  await page.setInputFiles('#file-input', [lossy]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '3', null, { timeout: 8000 });
  const st = await status();
  assert.strictEqual(st.fmt, 'dlt-binary');
  const warn = await page.evaluate(() => { const b = document.querySelector('.file-item .badge.enc'); return b ? b.textContent : ''; });
  assert.strictEqual(warn, '2 warn', 'lossy decode warning badge shown on the file entry: ' + JSON.stringify(warn));
  // level chip filters the decoded records: E narrows to the two error rows
  const chipE = () => page.evaluate(() => {
    const c = Array.from(document.querySelectorAll('.chip')).find((n) => n.textContent.startsWith('E'));
    if (c) c.click();
    return !!c;
  });
  assert.ok(await chipE(), 'E chip present');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '2', null, { timeout: 5000 });
  assert.ok(await chipE());
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '3', null, { timeout: 5000 });
  // full-file search runs over the decoded record space and resolves the
  // rendered-only hex row (R3-2)
  await page.evaluate(() => {
    const q = document.getElementById('quick');
    q.value = 'deadbeef';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '1', null, { timeout: 5000 });
  await click('btn-sall');
  await page.waitForFunction(() => /1 match\(es\) for \/deadbeef\/ in all files/.test(document.getElementById('sall-note').textContent), null, { timeout: 8000 });
  const sallText = await page.evaluate(() => document.getElementById('sall-rows').textContent);
  assert.ok(sallText.includes('hex deadbeef'), 'search-all resolves the rendered hex-dump row');
  // masking applies to the rendered binary line in the viewer
  await page.fill('#quick', '');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '3', null, { timeout: 5000 });
  const viewerText = await page.evaluate(() => document.querySelectorAll('.vrow .txt')[0].textContent);
  assert.ok(viewerText.includes('YV4**********4567'), 'VIN masked in the binary viewer row');
  assert.ok(!viewerText.includes('YV4AB9CD12EF34567'), 'no raw VIN in the viewer');
  // sanitized export equals the rendered binary lines, masked
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=export]').click());
  await page.selectOption('#exp-prefix', 'none'); // plain lines, no file:line prefix
  const downloadPromise = page.waitForEvent('download', { timeout: 8000 });
  await click('exp-txt');
  const download = await downloadPromise;
  const content = fs.readFileSync(await download.path(), 'utf8');
  assert.deepStrictEqual(
    content.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n'),
    [
      '01-01 00:00:00.000 1 ECU1 APP1:CTX1 - log info VIN read: YV4**********4567 ok',
      '2 - APP1:CTX1 - log error hex deadbeef',
      '3 - APP1:CTX1 - log error hex 01020304',
    ],
    'export carries exactly the rendered binary lines, masked',
  );
});

test('analysis PII census: card buttons open masked sample panels, one at a time, jump to line', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=analysis]').click());
  await page.waitForFunction(() => document.querySelector('#tab-analysis .census-card'), null, { timeout: 10000 });
  // cards are real buttons with aria-expanded; empty categories never render
  const kinds = await page.evaluate(() => Array.from(document.querySelectorAll('#tab-analysis .census-card')).map((b) => b.dataset.census));
  assert.ok(kinds.includes('vin') && kinds.includes('email'), 'vin and email cards present: ' + kinds.join(','));
  assert.strictEqual(await page.evaluate(() => document.querySelector('#tab-analysis .census-card[data-census=vin]').getAttribute('aria-expanded')), 'false');
  // open VIN: the panel holds masked previews only
  await page.click('#tab-analysis .census-card[data-census=vin]');
  await page.waitForFunction(() => document.querySelector('#census-panel .census-head'), null, { timeout: 5000 });
  assert.strictEqual(await page.evaluate(() => document.querySelector('#tab-analysis .census-card[data-census=vin]').getAttribute('aria-expanded')), 'true');
  let panel = await page.evaluate(() => document.getElementById('census-panel').textContent);
  assert.match(panel, /VIN · 2 matches · showing 2 example lines/);
  assert.ok(panel.includes('YV4**********4567'), 'masked VIN in panel');
  assert.ok(!panel.includes('YV4AB9CD12EF34567'), 'no raw VIN in panel');
  // previews stay masked even with the viewer mask toggle off (category stays open)
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await page.click('#btn-mask'); // mask OFF
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=analysis]').click());
  await page.waitForFunction(() => document.querySelector('#census-panel .census-head'), null, { timeout: 10000 });
  panel = await page.evaluate(() => document.getElementById('census-panel').textContent);
  assert.ok(!panel.includes('YV4AB9CD12EF34567'), 'preview masked while viewer mask is off');
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await page.click('#btn-mask'); // mask back ON
  // opening a card scrolls the sample panel so the SAMPLE ROWS are visible
  // (cards sit low on the page; the head alone at the viewport bottom is not enough)
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=analysis]').click());
  await page.waitForFunction(() => document.querySelector('#census-panel .census-head'), null, { timeout: 10000 });
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.evaluate(() => document.querySelector('#tab-analysis .census-card[data-census=email]').click());
  await page.waitForFunction(() => {
    const head = document.querySelector('#census-panel .census-head');
    const row = document.querySelector('#census-panel .census-row');
    if (!head || !row) return false;
    const hr = head.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    return hr.bottom > hr.top && hr.top >= 0 && rr.bottom <= window.innerHeight && rr.bottom > rr.top;
  }, null, { timeout: 5000 });
  // restore the pre-block state (vin open) for the following one-at-a-time section
  await page.evaluate(() => document.querySelector('#tab-analysis .census-card[data-census=vin]').click());
  await page.waitForTimeout(150);
  await page.setViewportSize({ width: 1440, height: 900 });
  // one category at a time: opening email closes vin
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=analysis]').click());
  await page.waitForFunction(() => document.querySelector('#census-panel .census-head'), null, { timeout: 10000 });
  await page.click('#tab-analysis .census-card[data-census=email]');
  await page.waitForTimeout(150);
  const cardState = await page.evaluate(() => ({
    vin: document.querySelector('#tab-analysis .census-card[data-census=vin]').getAttribute('aria-expanded'),
    email: document.querySelector('#tab-analysis .census-card[data-census=email]').getAttribute('aria-expanded'),
    head: document.querySelector('#census-panel .census-head').textContent,
  }));
  assert.strictEqual(cardState.vin, 'false', 'vin card closed when email opened');
  assert.strictEqual(cardState.email, 'true', 'email card open');
  assert.match(cardState.head, /Email ·/);
  // keyboard support: Enter toggles the focused card
  await page.focus('#tab-analysis .census-card[data-census=email]');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  assert.strictEqual(await page.evaluate(() => document.querySelector('#tab-analysis .census-card[data-census=email]').getAttribute('aria-expanded')), 'false', 'Enter closes the card');
  // a sample row jumps to the line in the viewer (selection + drawer)
  await page.click('#tab-analysis .census-card[data-census=vin]');
  await page.waitForFunction(() => document.querySelector('#census-panel .census-jump'), null, { timeout: 5000 });
  await page.click('#census-panel .census-jump');
  await page.waitForFunction(() => document.querySelector('#tabs button[data-tab=viewer]').classList.contains('active'), null, { timeout: 5000 });
  await page.waitForFunction(() => document.querySelector('.vrow.sel'), null, { timeout: 5000 });
  await page.waitForFunction(() => document.getElementById('drawer').classList.contains('open'), null, { timeout: 5000 });
});

test('analysis census: scope change keeps the open category; samples cap at 25', async () => {
  await fresh();
  const osmod = await import('node:os');
  const tmp = join(osmod.tmpdir(), 'lt-census-cap.log');
  fs.writeFileSync(tmp, Array.from({ length: 27 }, (_, i) =>
    '08-24 15:37:01.' + String(100 + i).padStart(3, '0') + '  1234  5678 I VinSvc : vin YV4AB9CD12EF34' + String(500 + i)).join('\n') + '\n');
  await page.setInputFiles('#file-input', [join(root, 'tests', 'fixtures', 'demo.log'), tmp]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '71', null, { timeout: 15000 });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=analysis]').click());
  await page.waitForFunction(() => document.querySelector('#tab-analysis .census-card'), null, { timeout: 10000 });
  // All files: 2 demo VINs + 27 synthetic = 29 matches, 25 example lines capped
  await page.click('#tab-analysis .census-card[data-census=vin]');
  await page.waitForFunction(() => { const h = document.querySelector('#census-panel .census-head'); return h && h.textContent.length > 1; }, null, { timeout: 5000 });
  const head = await page.evaluate(() => document.querySelector('#census-panel .census-head').textContent);
  assert.match(head, /VIN · 29 matches · showing 25 example lines \(capped at 25\)/, 'capped head: ' + head);
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('#census-panel .census-row').length), 25);
  // scope to demo.log: the open category survives, count and samples rescope
  await page.selectOption('#analysis-file', { label: 'demo.log' });
  await page.waitForFunction(() => { const h = document.querySelector('#census-panel .census-head'); return h && /VIN · 2 matches/.test(h.textContent); }, null, { timeout: 8000 });
  const locs = await page.evaluate(() => Array.from(document.querySelectorAll('#census-panel .census-loc')).map((e) => e.textContent));
  assert.ok(locs.length === 2 && locs.every((l) => l.startsWith('demo.log')), 'samples rescope to demo: ' + locs.join(';'));
  // scope to the synthetic file: category still open, and empty categories vanish
  await page.selectOption('#analysis-file', { label: 'lt-census-cap.log' });
  await page.waitForFunction(() => { const h = document.querySelector('#census-panel .census-head'); return h && /VIN · 27 matches/.test(h.textContent); }, null, { timeout: 8000 });
  const kinds2 = await page.evaluate(() => Array.from(document.querySelectorAll('#tab-analysis .census-card')).map((b) => b.dataset.census));
  assert.deepStrictEqual(kinds2, ['vin'], 'VIN-only file renders exactly one card');
});

test('non-UTF-8 file gets an encoding warning badge in the files panel', async () => {
  await fresh();
  const osmod = await import('node:os');
  const tmp = join(osmod.tmpdir(), 'lt-latin1-enc.log');
  const line = '08-24 15:37:01.123  1234  5678 I Tag: caf\xe9 latin1 line\n';
  fs.writeFileSync(tmp, Buffer.from(line.repeat(3), 'latin1'));
  await page.setInputFiles('#file-input', [tmp]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '3', null, { timeout: 8000 });
  const badge = await page.evaluate(() => {
    const b = document.querySelector('.file-item .badge.enc');
    return b ? b.title : null;
  });
  assert.ok(badge && /utf-8/i.test(badge), 'enc badge carries an explanatory title: ' + badge);
  // a clean UTF-8 file added alongside shows no badge
  await page.setInputFiles('#file-input', [join(root, 'tests', 'fixtures', 'demo.log')]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '47', null, { timeout: 8000 });
  const badges = await page.evaluate(() => document.querySelectorAll('.file-item .badge.enc').length);
  assert.strictEqual(badges, 1, 'only the latin-1 file is badged');
});

test('analysis surfaces respect the mask toggle (issue snippets + top message shapes)', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=analysis]').click());
  await page.waitForFunction(() => {
    const t = document.getElementById('tab-analysis').textContent;
    return t.includes('Top message shapes') && (t.includes('d***@***.example') || t.includes('driver@'));
  }, null, { timeout: 10000 });
  let text = await page.evaluate(() => document.getElementById('tab-analysis').textContent);
  assert.ok(!text.includes('driver@corp.example'), 'mask ON: no raw email anywhere in analysis');
  assert.ok(text.includes('d***@***.example'), 'mask ON: masked email shown in issue snippet / message shapes');
  // toggle mask OFF (via viewer toolbar) → analysis re-render shows the raw text
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await page.click('#btn-mask');
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=analysis]').click());
  await page.waitForFunction(() => document.getElementById('tab-analysis').textContent.includes('driver@corp.example'), null, { timeout: 10000 });
  // restore mask ON
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await page.click('#btn-mask');
});

test('search rows mark matches inline; UI token pass (hit tint, disabled pager, checkboxes, inputs)', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=search]').click());
  await page.fill('#rg-pattern', 'heartbeat');
  // inline <mark> around the exact matched term inside hit rows
  await page.waitForFunction(() => document.querySelector('.sr-row.hit .srx mark'), null, { timeout: 5000 });
  const markText = await page.evaluate(() => document.querySelector('.sr-row.hit .srx mark').textContent);
  assert.strictEqual(markText, 'heartbeat', 'mark wraps exactly the matched term');
  const markCount = await page.evaluate(() => document.querySelectorAll('.sr-row.hit .srx mark').length);
  assert.ok(markCount >= 4, 'every hit row marks its match: ' + markCount);
  // hit tint is its own token, distinct from the viewer selection green
  const tokens = await page.evaluate(() => {
    const cs = getComputedStyle(document.body);
    return { hit: cs.getPropertyValue('--hit').trim(), sel: cs.getPropertyValue('--selection').trim() };
  });
  assert.ok(tokens.hit.length > 0, '--hit token defined');
  assert.notStrictEqual(tokens.hit, tokens.sel, '--hit differs from --selection');
  const hitBg = await page.evaluate(() => getComputedStyle(document.querySelector('.sr-row.hit')).backgroundColor);
  const selToken = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--selection').trim());
  assert.ok(!hitBg.includes('19, 78, 47'), 'hit row no longer paints the selection green: ' + hitBg + ' vs ' + selToken);
  // checkboxes: custom themed control at >= 17px (measured while the search tab is visible)
  const cb = await page.evaluate(() => {
    const el = document.getElementById('rg-fixed');
    const cs = getComputedStyle(el);
    return { w: el.getBoundingClientRect().width, appearance: cs.appearance || cs.webkitAppearance };
  });
  assert.ok(cb.w >= 17, 'checkbox target >= 17px: ' + cb.w);
  assert.strictEqual(cb.appearance, 'none', 'checkbox uses the custom appearance');
  // sidebar text input is themed, not browser-default white
  const ffBg = await page.evaluate(() => getComputedStyle(document.getElementById('file-filter')).backgroundColor);
  assert.notStrictEqual(ffBg, 'rgb(255, 255, 255)', 'sidebar input themed: ' + ffBg);
  // disabled pager buttons are visibly dimmed (demo = single page)
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await page.waitForFunction(() => document.getElementById('page-first').disabled, null, { timeout: 5000 });
  const op = await page.evaluate(() => getComputedStyle(document.getElementById('page-first')).opacity);
  assert.ok(parseFloat(op) < 1, 'disabled pager button dimmed: ' + op);
});

test('mobile pass: compact chrome, toolbar overflow, wrap default, files scrim', async () => {
  await fresh();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => localStorage.removeItem('log_triage_state_v1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('#file-input', [join(root, 'tests', 'fixtures', 'demo.log')]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 15000 });
  // compact chrome: the first log line lands high in the viewport (was ~350px of chrome)
  const rowTop = await page.evaluate(() => { const r = document.querySelector('.vrow'); return r ? Math.round(r.getBoundingClientRect().top) : 9999; });
  assert.ok(rowTop < 300, 'first log row within the top 300px at 390x844: ' + rowTop);
  // the version tag stays visible even at phone width (user preference wins over compaction)
  const verVisible = await page.evaluate(() => {
    const el = document.getElementById('ver');
    return getComputedStyle(el).display !== 'none' && el.textContent.trim().length > 0;
  });
  assert.ok(verVisible, 'version tag visible next to the title at 390px');
  // fresh narrow boot defaults wrap ON
  assert.ok(await page.evaluate(() => !!document.querySelector('.vrow.wrap')), 'wrap ON by default on a fresh narrow boot');
  // toolbar collapses: ⋯ visible, secondary controls hidden until ⋯ is clicked
  const tb = await page.evaluate(() => ({
    more: getComputedStyle(document.getElementById('vtools-more')).display !== 'none',
    wrap: getComputedStyle(document.getElementById('btn-wrap')).display !== 'none',
  }));
  assert.ok(tb.more, '⋯ overflow button visible at 390px');
  assert.ok(!tb.wrap, 'Wrap control hidden behind ⋯');
  await page.evaluate(() => document.getElementById('vtools-more').click());
  assert.ok(await page.evaluate(() => getComputedStyle(document.getElementById('btn-wrap')).display !== 'none'), '⋯ reveals the secondary controls');
  assert.strictEqual(await page.evaluate(() => document.getElementById('vtools-more').getAttribute('aria-expanded')), 'true', 'aria-expanded synced');
  // files overlay: open → scrim visible → tap scrim closes
  await page.evaluate(() => document.getElementById('btn-side').click());
  await page.waitForFunction(() => getComputedStyle(document.getElementById('side-scrim')).display !== 'none', null, { timeout: 3000 });
  await page.evaluate(() => document.getElementById('side-scrim').click());
  await page.waitForFunction(() => document.getElementById('main').classList.contains('side-hidden'), null, { timeout: 3000 });
  // ✕ close button in the panel header also closes
  await page.evaluate(() => document.getElementById('btn-side').click());
  await page.waitForFunction(() => !document.getElementById('main').classList.contains('side-hidden'), null, { timeout: 3000 });
  await page.evaluate(() => document.getElementById('side-close').click());
  await page.waitForFunction(() => document.getElementById('main').classList.contains('side-hidden'), null, { timeout: 3000 });
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('polish sweep: empty state, level-bar colors, count adjacency, cm labels, preset verbs, zen HUD, selection ink', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  // #7 filters empty state on a fresh boot (no rules)
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=filters]').click());
  await page.waitForTimeout(200);
  const emptyState = await page.evaluate(() => {
    const es = document.getElementById('rules-empty');
    return !!(es && getComputedStyle(es).display !== 'none' && es.textContent.length > 10);
  });
  assert.ok(emptyState, 'filters shows a real empty state when there are no rules');
  // #17 preset verbs say what they carry
  const presetLabel = await page.evaluate(() => document.getElementById('btn-preset-export').textContent);
  assert.match(presetLabel, /presets/i, 'Filters preset export is labeled presets: ' + presetLabel);
  // #11 analysis level bars carry per-level color tokens
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=analysis]').click());
  await page.waitForFunction(() => document.querySelector('#tab-analysis .hbar .bar'), null, { timeout: 10000 });
  const bars = await page.evaluate(() => Array.from(document.querySelectorAll('#tab-analysis .hbar .bar')).map((b) => b.getAttribute('style') || ''));
  assert.ok(bars.filter((s) => s.includes('--lvl-')).length >= 3, 'level bars use per-level color tokens: ' + JSON.stringify(bars.slice(0, 4)));
  // #18 top-message counts sit right after the shape text
  const shape = await page.evaluate(() => {
    const h2s = Array.from(document.querySelectorAll('#tab-analysis h2'));
    const h = h2s.find((x) => x.textContent.includes('Top message shapes'));
    const row = h && h.nextElementSibling;
    if (!row || !row.querySelector('b')) return null;
    const span = row.querySelector('span');
    const b = row.querySelector('b');
    return { grow: getComputedStyle(span).flexGrow, gap: Math.round(b.getBoundingClientRect().left - span.getBoundingClientRect().right) };
  });
  assert.ok(shape, 'top message shape row found');
  assert.strictEqual(shape.grow, '0', 'shape span no longer stretches the full width');
  assert.ok(shape.gap < 40, 'count sits next to the shape text: gap=' + shape.gap);
  // #10 persistent labels on the custom-rule inputs
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=masks]').click());
  await page.waitForTimeout(200);
  const cmLabels = await page.evaluate(() => document.querySelectorAll('.cm-field > span').length);
  assert.ok(cmLabels >= 3, 'custom-rule inputs have persistent labels: ' + cmLabels);
  // #9 bookmark gutter hit area widened
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await page.waitForTimeout(200);
  const bmW = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.vcell.bm')).minWidth));
  assert.ok(bmW >= 26, 'bookmark gutter hit area >= 26px: ' + bmW);
  // #16 zen HUD reports the mask state while zen is active
  await page.click('#btn-zen');
  await page.waitForFunction(() => {
    const hud = document.getElementById('zen-hud');
    return hud && getComputedStyle(hud).display !== 'none' && /Mask: (ON|OFF)/.test(hud.textContent);
  }, null, { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  // #4 Paper theme: the selected row's level ink is the fg color, not level-green on green
  await page.evaluate(() => {
    document.getElementById('theme-btn').click();
    const opt = Array.from(document.querySelectorAll('#theme-menu *')).find((e) => e.textContent.includes('Paper'));
    if (opt) opt.click();
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const row = document.querySelector('.vrow');
    if (row) row.querySelector('.txt').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector('.vrow.sel .vcell.lv'), null, { timeout: 5000 });
  const ink = await page.evaluate(() => getComputedStyle(document.querySelector('.vrow.sel .vcell.lv')).color);
  assert.ok(!ink.includes('30, 127'), 'selected-row level ink is not paper level-green (' + ink + ')');
  await page.evaluate(() => {
    document.getElementById('theme-btn').click();
    const opt = Array.from(document.querySelectorAll('#theme-menu *')).find((e) => e.textContent.includes('Midnight'));
    if (opt) opt.click();
  });
});

test('quick filter: Enter commits the typed term, history dropdown has no default focus', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  // seed the history with 'Process' (Enter commits the term — v1.50.1 semantics)
  await page.fill('#quick', 'Process');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent !== '44', null, { timeout: 5000 });
  await page.keyboard.press('Enter');
  await page.fill('#quick', '');
  await page.waitForTimeout(350);
  // a new typed prefix lists the history match — but nothing may be pre-focused
  await page.fill('#quick', 'Proc');
  await page.waitForFunction(() => document.querySelector('.history-dd .history-item'), null, { timeout: 5000 });
  assert.ok(await page.evaluate(() => !document.querySelector('.history-item.active')), 'no history item is focused by default');
  // Enter commits the typed term and closes the dropdown
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  assert.strictEqual(await page.evaluate(() => document.getElementById('quick').value), 'Proc', 'Enter keeps the typed term');
  assert.ok(await page.evaluate(() => !document.querySelector('.history-dd')), 'dropdown closed after Enter');
  // explicit arrow navigation still picks the highlighted entry
  await page.fill('#quick', '');
  await page.fill('#quick', 'Proce');
  await page.waitForFunction(() => document.querySelector('.history-dd .history-item'), null, { timeout: 5000 });
  await page.keyboard.press('ArrowDown');
  assert.ok(await page.evaluate(() => document.querySelector('.history-item.active')), 'ArrowDown activates the first item');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  assert.strictEqual(await page.evaluate(() => document.getElementById('quick').value), 'Process', 'Enter after explicit navigation picks the item');
  // ArrowUp from the first item exits back to the typed text
  await page.fill('#quick', '');
  await page.fill('#quick', 'Proce');
  await page.waitForFunction(() => document.querySelector('.history-dd .history-item'), null, { timeout: 5000 });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  assert.ok(await page.evaluate(() => !document.querySelector('.history-item.active')), 'ArrowUp past the first item clears the highlight');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  assert.strictEqual(await page.evaluate(() => document.getElementById('quick').value), 'Proce', 'Enter after exiting the list keeps the typed term');
});

test('quick filter auto-expands while typing; line-number field stays compact', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  const w = (id) => page.evaluate((i) => document.getElementById(i).getBoundingClientRect().width, id);
  const w0 = await w('quick');
  // a medium pattern grows the field beyond its empty baseline
  await page.fill('#quick', 'x'.repeat(35));
  await page.waitForTimeout(100);
  const w1 = await w('quick');
  assert.ok(w1 > w0 + 20, 'field grows as the user types: ' + w0 + ' -> ' + w1);
  // a long pattern keeps growing but stays capped
  await page.fill('#quick', 'y'.repeat(120));
  await page.waitForTimeout(100);
  const w2 = await w('quick');
  assert.ok(w2 > w1, 'keeps growing for long patterns: ' + w1 + ' -> ' + w2);
  assert.ok(w2 < 900, 'growth is capped: ' + w2);
  // clearing shrinks it back to the baseline
  await page.fill('#quick', '');
  await page.waitForTimeout(100);
  const w3 = await w('quick');
  assert.ok(w3 <= w0 + 2, 'shrinks back when cleared: ' + w0 + ' -> ' + w3);
  // the line-number field is compact
  const gl = await w('goto-ln');
  assert.ok(gl <= 70, 'line-number field is compact: ' + gl);
});

test('viewer Search all: scoped match list in a bottom panel; Search tab renamed to Multifile search', async () => {
  await fresh();
  // the search tab is renamed (multifile = every loaded file; the viewer's
  // Search all is the scoped counterpart)
  const label = await page.evaluate(() => document.querySelector('#tabs button[data-tab=search]').textContent.trim());
  // SPEC-TABS-001: the digit badge is part of the label text
  assert.strictEqual(label, 'Multifile search 2');

  await page.setInputFiles('#file-input', [
    join(root, 'tests', 'fixtures', 'demo.log'),
    join(root, 'tests', 'fixtures', 'syslog.log'),
  ]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '52');

  // empty quick filter: the button explains itself and the panel stays closed
  await click('btn-sall');
  assert.ok(await page.evaluate(() => document.getElementById('sall').classList.contains('hidden')), 'panel closed without a pattern');

  // merged scope: 'fail' matches 2 demo + 2 syslog lines
  await page.evaluate(() => {
    const q = document.getElementById('quick');
    q.value = 'fail';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '4');
  await click('btn-sall');
  await page.waitForFunction(() => /4 match\(es\) for \/fail\/ in all files/.test(document.getElementById('sall-note').textContent));
  const open = await page.evaluate(() => ({
    hidden: document.getElementById('sall').classList.contains('hidden'),
    expanded: document.getElementById('btn-sall').getAttribute('aria-expanded'),
    rows: Array.from(document.querySelectorAll('#sall-rows .sr-row')).map((r) => ({ file: r.dataset.file, ln: r.dataset.ln })),
    marks: document.querySelectorAll('#sall-rows mark').length,
  }));
  assert.ok(!open.hidden, 'panel visible');
  assert.strictEqual(open.expanded, 'true');
  assert.strictEqual(open.rows.length, 4, 'every match listed: ' + JSON.stringify(open.rows));
  assert.strictEqual(new Set(open.rows.map((r) => r.file)).size, 2, 'rows carry both files');
  assert.ok(open.marks >= 4, 'match terms marked: ' + open.marks);

  // clicking a row jumps the viewer to that line
  await page.evaluate(() => document.querySelector('#sall-rows .sr-row').click());
  await page.waitForFunction(() => document.getElementById('st-sel').textContent === '1');
  const jumped = await page.evaluate(() => {
    const row = document.querySelector('#sall-rows .sr-row');
    return document.getElementById('drawer').textContent.includes(row.dataset.ln);
  });
  assert.ok(jumped, 'drawer shows the jumped line');

  // per-file scope narrows to the displayed file (demo.log first loaded)
  await page.selectOption('#view-mode', 'file');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '2');
  await click('btn-sall'); // re-runs scoped while open — refresh, not a toggle
  await page.waitForFunction(() => /2 match\(es\) for \/fail\/ in demo\.log/.test(document.getElementById('sall-note').textContent));
  const scopedRows = await page.evaluate(() => Array.from(document.querySelectorAll('#sall-rows .sr-row')).map((r) => r.dataset.file));
  assert.strictEqual(scopedRows.length, 2);
  assert.ok(scopedRows.every((f) => f === 'demo.log'), 'only the displayed file listed');

  // Esc closes the panel
  await page.keyboard.press('Escape');
  assert.ok(await page.evaluate(() => document.getElementById('sall').classList.contains('hidden')), 'Esc closes');
  assert.strictEqual(await page.evaluate(() => document.getElementById('btn-sall').getAttribute('aria-expanded')), 'false');
});

test('search-all rows follow the viewer Wrap toggle; mobile keeps the viewer visible', async () => {
  await fresh();
  await page.setInputFiles('#file-input', [join(root, 'tests', 'fixtures', 'demo.log')]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');
  await page.evaluate(() => {
    const q = document.getElementById('quick');
    q.value = 'heartbeat';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '4');
  await click('btn-sall');
  await page.waitForFunction(() => document.querySelectorAll('#sall-rows .sr-row').length === 4);
  // desktop default Wrap: OFF — panel rows are one scrollable line per match
  let ws = await page.evaluate(() => getComputedStyle(document.querySelector('#sall-rows .sr-row')).whiteSpace);
  assert.strictEqual(ws, 'pre', 'viewer Wrap OFF -> panel rows nowrap: ' + ws);
  // the VIEWER's toggle drives the panel (the panel has no control of its own)
  await click('btn-wrap');
  ws = await page.evaluate(() => getComputedStyle(document.querySelector('#sall-rows .sr-row')).whiteSpace);
  assert.strictEqual(ws, 'pre-wrap', 'viewer Wrap ON -> panel rows wrap: ' + ws);
  await click('btn-wrap');

  // mobile 390x844: the panel takes a bounded share and the viewer stays usable
  await page.setViewportSize({ width: 390, height: 844 });
  await click('vtools-more'); // reveal the secondary toolbar (worst-case height)
  await click('btn-sall'); // re-runs on mobile (the panel stays open — no toggle)
  await page.waitForFunction(() => !document.getElementById('sall').classList.contains('hidden'));
  const geo = await page.evaluate(() => {
    const h = (id) => Math.round(document.getElementById(id).getBoundingClientRect().height);
    return { viewer: h('viewer'), sall: h('sall'), vh: window.innerHeight, scrollH: document.documentElement.scrollHeight };
  });
  assert.ok(geo.sall <= 310, 'panel capped on mobile: ' + JSON.stringify(geo));
  assert.ok(geo.viewer >= 160, 'viewer keeps a usable floor: ' + JSON.stringify(geo));
  assert.ok(geo.scrollH <= geo.vh + 1, 'no page overflow with the panel open: ' + JSON.stringify(geo));
});

test('Ctrl+F in the viewer focuses the quick filter and explains the page-only browser find', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  // Ctrl+F with nothing focused: the native find is replaced by the app's find
  await page.keyboard.press('Control+f');
  const st = await page.evaluate(() => ({
    focused: document.activeElement ? document.activeElement.id : '',
    hintVisible: !document.getElementById('find-hint').classList.contains('hidden'),
    text: document.getElementById('find-hint').textContent,
  }));
  assert.strictEqual(st.focused, 'quick', 'quick filter focused');
  assert.ok(st.hintVisible, 'floating hint visible');
  assert.match(st.text, /current page/);
  assert.match(st.text, /Search all/);
  // typing goes straight into the live full-scope filter
  await page.keyboard.type('heartbeat');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '4');
  // the hint's Search all button runs the scoped search-all panel
  await page.evaluate(() => document.getElementById('find-hint-all').click());
  await page.waitForFunction(() => !document.getElementById('sall').classList.contains('hidden'));
  await page.waitForFunction(() => /4 match/.test(document.getElementById('sall-note').textContent));
  // ✕ dismisses the hint
  await page.evaluate(() => document.getElementById('find-hint-close').click());
  assert.ok(await page.evaluate(() => document.getElementById('find-hint').classList.contains('hidden')), '✕ dismisses');
  // outside the viewer tab the native browser find is left alone (no hint)
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=masks]').click());
  await page.keyboard.press('Control+f');
  assert.ok(await page.evaluate(() => document.getElementById('find-hint').classList.contains('hidden')), 'no interception off the viewer tab');
});

test('Ctrl+F on the Multifile search tab focuses the search pattern with its text selected', async () => {
  await loadDemo();
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=search]').click());
  // pre-fill the pattern, then move focus away so the shortcut must do the work
  await page.evaluate(() => { document.getElementById('rg-pattern').value = 'error.timeout'; });
  await page.evaluate(() => document.getElementById('btn-sr-wrap').focus());
  await page.keyboard.press('Control+f');
  assert.strictEqual(await page.evaluate(() => document.activeElement && document.activeElement.id),
    'rg-pattern', 'pattern field focused');
  const sel = await page.evaluate(() => {
    const p = document.getElementById('rg-pattern');
    return { len: p.selectionEnd - p.selectionStart, val: p.value };
  });
  assert.strictEqual(sel.len, sel.val.length, 'the whole existing pattern is selected');
  assert.ok(await page.evaluate(() => document.getElementById('find-hint').classList.contains('hidden')),
    'no viewer find hint on the search tab');
  // platform equivalent: Meta+F does the same
  await page.evaluate(() => document.getElementById('btn-sr-wrap').focus());
  await page.keyboard.press('Meta+f');
  assert.strictEqual(await page.evaluate(() => document.activeElement && document.activeElement.id),
    'rg-pattern', 'Meta+F focuses the pattern field too');
  // the field advertises the shortcut, platform-aware
  assert.match(await page.evaluate(() => document.getElementById('rg-pattern').title), /(Ctrl\+F|⌘F)/,
    'title hints the shortcut');
});

test('Ctrl+F outside the viewer and search tabs stays with the browser', async () => {
  await loadDemo();
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=filters]').click());
  await page.evaluate(() => document.getElementById('time-from').focus());
  await page.keyboard.press('Control+f');
  assert.strictEqual(await page.evaluate(() => document.activeElement && document.activeElement.id),
    'time-from', 'no focus steal on the filters tab');
  assert.ok(await page.evaluate(() => document.getElementById('find-hint').classList.contains('hidden')),
    'no hint outside viewer/search tabs');
});

test('regressions: Ctrl+F always select-alls, search-all re-runs and Esc works from fields; panel resizes via grip', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });

  // Ctrl+F while focus is ALREADY in the quick field must still select-all:
  // typing used to append to the stale pattern (heartbeat+fail -> 0 matches)
  // and the filter appeared to "stop filtering" (v1.52.0 regression)
  await page.keyboard.press('Control+f');
  await page.keyboard.type('heartbeat');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '4');
  await page.keyboard.press('Control+f'); // second press — focus is in the field
  await page.keyboard.type('fail');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '2');
  const fieldVal = await page.evaluate(() => document.getElementById('quick').value);
  assert.strictEqual(fieldVal, 'fail', 'Ctrl+F select-all replaced the pattern: ' + fieldVal);

  // search-all: a click while the panel is open RE-RUNS (refresh), not toggles
  await click('btn-sall');
  await page.waitForFunction(() => /2 match\(es\)/.test(document.getElementById('sall-note').textContent));
  await page.evaluate(() => {
    const q = document.getElementById('quick');
    q.value = 'heartbeat';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '4');
  await click('btn-sall'); // panel open -> must refresh to the new pattern
  await page.waitForFunction(() => /4 match\(es\) for \/heartbeat\//.test(document.getElementById('sall-note').textContent));
  assert.ok(!(await page.evaluate(() => document.getElementById('sall').classList.contains('hidden'))), 're-run keeps the panel open');

  // Esc layering: with the quick field focused the history dropdown opens —
  // the first Esc closes ONLY the dropdown, the second closes the panel
  await page.waitForTimeout(1100); // let the typing dwell-commit record a history term
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); }); // refocus must re-fire focus
  await page.click('#quick');
  const ddOpen = await page.evaluate(() => !!document.querySelector('.history-dd'));
  assert.ok(ddOpen, 'history dropdown open on field focus');
  await page.keyboard.press('Escape');
  assert.ok(await page.evaluate(() => !document.querySelector('.history-dd')), 'Esc #1 closes the dropdown only');
  assert.ok(!(await page.evaluate(() => document.getElementById('sall').classList.contains('hidden'))), 'panel survives Esc #1');
  await page.keyboard.press('Escape');
  assert.ok(await page.evaluate(() => document.getElementById('sall').classList.contains('hidden')), 'Esc #2 closes the panel from field focus');

  // resize: dragging the grip up grows the panel (clamped to the space left
  // beside the other chrome while the viewer keeps its 160px floor); the
  // height persists across close/reopen, and a double-click resets it
  await click('btn-sall');
  await page.waitForFunction(() => document.querySelectorAll('#sall-rows .sr-row').length === 4);
  const h = () => page.evaluate(() => Math.round(document.getElementById('sall').getBoundingClientRect().height));
  const h0 = await h();
  const grip = await page.locator('#sall-grip').boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 4);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y - 76, { steps: 8 });
  await page.mouse.up();
  const h1 = await h();
  assert.ok(h1 >= h0 + 70, 'drag grows the panel: ' + h0 + ' -> ' + h1);
  const styleH = await page.evaluate(() => parseInt(document.getElementById('sall').style.height, 10));
  assert.ok(Math.abs(styleH - h1) <= 1, 'style height matches layout (no silent flex shrink): ' + styleH + ' vs ' + h1);
  await page.keyboard.press('Escape');
  await click('btn-sall');
  await page.waitForFunction(() => document.querySelectorAll('#sall-rows .sr-row').length === 4);
  const h2 = await h();
  assert.ok(Math.abs(h2 - h1) <= 2, 'resized height persists across close/reopen: ' + h1 + ' -> ' + h2);
  await page.locator('#sall-grip').dblclick();
  const h3 = await h();
  assert.ok(Math.abs(h3 - h0) <= 2, 'double-click resets to the default: ' + h1 + ' -> ' + h3);
});

test('history dropdown: internal scrolling stays open, arrows reopen it, ✕ clear never reopens', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  // seed 14 committed terms (Enter commits; the list renders at most 12 -> scrollbar)
  for (let i = 0; i < 14; i++) {
    await page.fill('#quick', 'term' + i);
    await page.keyboard.press('Enter');
  }
  await page.waitForFunction(() => {
    const h = (JSON.parse(localStorage.getItem('log_triage_state_v1') || '{}')).quickHistory || [];
    return h.length >= 12;
  });
  // focus with an empty field lists the full (capped) history with a scrollbar
  await page.fill('#quick', '');
  await page.click('#quick');
  await page.waitForFunction(() => document.querySelectorAll('.history-dd .history-item').length === 12);
  const geom = await page.evaluate(() => {
    const dd = document.querySelector('.history-dd');
    return { scrollable: dd.scrollHeight > dd.clientHeight + 1 };
  });
  assert.ok(geom.scrollable, 'capped list overflows (scrollbar present)');
  // scrolling INSIDE the dropdown must not close it (the capture-phase
  // page-scroll closer used to kill the list on its own scroll)
  const scrolled = await page.evaluate(() => {
    const dd = document.querySelector('.history-dd');
    dd.scrollTop = 80;
    dd.dispatchEvent(new Event('scroll'));
    return { open: !!document.querySelector('.history-dd'), top: dd.scrollTop };
  });
  assert.ok(scrolled.open, 'dropdown survives its own scroll');
  assert.ok(scrolled.top > 0, 'list actually scrolled: ' + scrolled.top);
  // a scroll of the PAGE behind it still closes
  await page.evaluate(() => document.getElementById('viewer').dispatchEvent(new Event('scroll')));
  await page.waitForFunction(() => !document.querySelector('.history-dd'));
  // a closed dropdown reopens from the field: ↓ = fresh open (nothing active)
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => !!document.querySelector('.history-dd'));
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.history-dd .history-item.active').length), 0, '↓ reopens with nothing highlighted');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.history-dd'));
  // ↑ reopens with the LAST entry pre-highlighted
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => !!document.querySelector('.history-dd'));
  const upState = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.history-dd .history-item'));
    const activeIdx = items.findIndex((el) => el.classList.contains('active'));
    return { count: items.length, activeIdx, isLast: activeIdx === items.length - 1 };
  });
  assert.ok(upState.activeIdx >= 0 && upState.isLast, '↑ reopens with the last entry highlighted: ' + JSON.stringify(upState));
  // the keyboard-highlighted entry must be scrolled INTO VIEW: reopening with
  // ↑ lands on the (below-fold) last entry, so the list must have scrolled
  const upVis = await page.evaluate(() => {
    const dd = document.querySelector('.history-dd');
    const el = dd.querySelector('.history-item.active');
    return {
      top: dd.scrollTop,
      visible: !!el && el.offsetTop >= dd.scrollTop - 1 && el.offsetTop + el.offsetHeight <= dd.scrollTop + dd.clientHeight + 1,
    };
  });
  assert.ok(upVis.top > 0 && upVis.visible, '↑-highlighted last entry scrolled into view: ' + JSON.stringify(upVis));
  // walking ↓ through the whole list keeps the highlight visible at the bottom
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.history-dd'));
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => !!document.querySelector('.history-dd'));
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown');
  const walkVis = await page.evaluate(() => {
    const dd = document.querySelector('.history-dd');
    const el = dd.querySelector('.history-item.active');
    return {
      idx: Array.from(dd.children).indexOf(el),
      top: dd.scrollTop,
      visible: !!el && el.offsetTop >= dd.scrollTop - 1 && el.offsetTop + el.offsetHeight <= dd.scrollTop + dd.clientHeight + 1,
    };
  });
  assert.strictEqual(walkVis.idx, 11, '11x ↓ lands on the last entry');
  assert.ok(walkVis.top > 0 && walkVis.visible, 'walking ↓ keeps the highlight scrolled into view: ' + JSON.stringify(walkVis));
  // the inline ✕ clears the field WITHOUT reopening the list, and focus leaves
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.history-dd'));
  await page.fill('#quick', 'term1');
  await page.locator('.clr-wrap:has(#quick) .clr-btn').click();
  const after = await page.evaluate(() => ({
    val: document.getElementById('quick').value,
    dd: !!document.querySelector('.history-dd'),
    focused: document.activeElement ? document.activeElement.id || document.activeElement.tagName : '',
    shown: document.getElementById('st-shown').textContent,
  }));
  assert.strictEqual(after.val, '', 'field cleared');
  assert.ok(!after.dd, 'no dropdown after ✕ clear');
  assert.notStrictEqual(after.focused, 'quick', 'focus left the field: ' + after.focused);
  assert.strictEqual(after.shown, '44', 'view reset to all lines');
});

test('Ctrl+Enter runs Search all — from the quick filter and from body focus', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  // the natural flow: type a pattern, press Ctrl+Enter with the cursor still
  // in the quick filter (the shortcut must fire despite the INPUT focus)
  await page.fill('#quick', 'heartbeat');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '4');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => !document.getElementById('sall').classList.contains('hidden'));
  await page.waitForFunction(() => /4 match\(es\) for \/heartbeat\//.test(document.getElementById('sall-note').textContent));
  // from body focus it RE-RUNS with the current pattern (refresh semantics)
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  await page.evaluate(() => {
    const q = document.getElementById('quick');
    q.value = 'fail';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '2');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => /2 match\(es\) for \/fail\//.test(document.getElementById('sall-note').textContent));
  // the button tooltip advertises the shortcut
  const title = await page.evaluate(() => document.getElementById('btn-sall').title);
  assert.match(title, /Ctrl\+Enter/);
  // an empty pattern keeps the panel closed with the explanatory flash
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('sall').classList.contains('hidden'));
  await page.fill('#quick', '');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '44');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => /Type a pattern/.test(document.getElementById('st-progress').textContent));
  assert.ok(await page.evaluate(() => document.getElementById('sall').classList.contains('hidden')), 'no panel without a pattern');
  // off the viewer tab the shortcut does nothing (no re-run of a stale scope)
  await page.fill('#quick', 'heartbeat');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '4');
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=masks]').click());
  await page.keyboard.press('Control+Enter');
  const note = await page.evaluate(() => document.getElementById('sall-note').textContent);
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  assert.strictEqual(await page.evaluate(() => document.getElementById('sall-note').textContent), note, 'no re-run off the viewer tab');
});

test('light themes render match marks with dark ink (readable on the yellow highlight)', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  await page.fill('#quick', 'heartbeat'); // quick-filter marks in the viewer rows
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '4');
  await page.waitForFunction(() => !!document.querySelector('#viewer mark'));
  const markInk = () => page.evaluate(() => {
    const m = document.querySelector('#viewer mark');
    const cs = getComputedStyle(m);
    const rgb = (cs.color.match(/\d+/g) || []).map(Number);
    return { color: cs.color, avg: Math.round((rgb[0] + rgb[1] + rgb[2]) / 3), bg: cs.backgroundColor };
  });
  const setTheme = (name) => page.evaluate((n) => {
    document.getElementById('theme-btn').click();
    const opt = Array.from(document.querySelectorAll('#theme-menu .theme-opt')).find((o) => o.dataset.value === n);
    opt.click();
  }, name);
  // the light themes used to paint the page background (near-white) as ink on
  // the yellow highlight — the regression this spec pins
  for (const t of ['paper', 'solarized-light']) {
    await setTheme(t);
    const ink = await markInk();
    assert.ok(ink.avg < 96, t + ': mark ink is dark on the highlight: ' + JSON.stringify(ink));
  }
  // a dark theme keeps the same dark-ink rendering as before
  await setTheme('midnight');
  const dark = await markInk();
  assert.ok(dark.avg < 96, 'midnight: mark ink stays dark: ' + JSON.stringify(dark));
});

test('history records committed terms, not per-character prefixes', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  const hist = (key) => page.evaluate((k) => JSON.parse(localStorage.getItem('log_triage_state_v1') || '{}')[k] || [], key);
  // type slowly — every inter-key gap exceeds the 200ms filter debounce, the
  // old trigger that recorded each intermediate prefix as its own entry
  await page.click('#quick');
  await page.keyboard.type('heartbeat', { delay: 250 });
  await page.waitForTimeout(400);
  // Enter commits the typed term immediately — exactly one entry
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  assert.deepStrictEqual(await hist('quickHistory'), ['heartbeat'], 'Enter records exactly the full term, no prefixes');
  // rg field: slow typing then blur — one entry, not four prefixes
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=search]').click());
  await page.click('#rg-pattern');
  await page.keyboard.type('VHal', { delay: 300 });
  await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById('rg-pattern').blur()); // blur commits
  await page.waitForTimeout(150);
  assert.deepStrictEqual(await hist('searchHistory'), ['VHal'], 'blur records exactly the full term, no prefixes');
});

/* ---------- SPEC-VIEWER-001: continuous scroll window, selection
   persistence, shortcut hint (wheel-driven scenarios) ---------- */

// loads an n-line fixture whose lines read "line <i> of <n>" so quick
// filters can target exactly one line ("line 2 of" cannot match "line 20 of").
// Timestamps strictly increase with i so the merged timeline order equals the
// line order (paging windows then hold the expected line ranges).
async function loadLineFixture(n) {
  // pin the desktop viewport: a fresh context starts at Playwright's 1280x720
  // default when the file is run with a name filter (do not rely on the
  // afterEach reset of a previous test)
  await page.setViewportSize({ width: 1440, height: 900 });
  await fresh();
  // short file name: a long name wraps in the file-name cell under wrap mode,
  // doubling row heights against the wrap height estimates (see R2 note)
  const big = join(os.tmpdir(), 'lt.log');
  const out = [];
  for (let i = 1; i <= n; i++) {
    const ts = '09-11 22:' + String(14 + Math.floor((i - 1) / 6000)).padStart(2, '0') + ':' +
      String(Math.floor(((i - 1) % 6000) / 1000)).padStart(2, '0') + '.' + String((i - 1) % 1000).padStart(3, '0');
    out.push(ts + '  1000  2000 I VHal: line ' + i + ' of ' + n);
  }
  fs.writeFileSync(big, out.join('\n') + '\n');
  await page.setInputFiles('#file-input', [big]);
  await page.waitForFunction((x) => document.getElementById('st-total').textContent === String(x), n, { timeout: 15000 });
}

const vw = () => page.evaluate(`JSON.stringify({
  scrollTop: document.getElementById('viewer').scrollTop,
  spacerRows: Math.round(parseFloat(document.getElementById('vspacer').style.height || '0') / 22),
  firstLn: Number((document.querySelector('.vrow .ln') || { textContent: 0 }).textContent),
  rows: document.querySelectorAll('.vrow').length,
  selRows: document.querySelectorAll('.vrow.sel').length,
  selCount: document.getElementById('st-sel').textContent,
  pageNo: document.getElementById('page-number').value,
  startMark: !!document.querySelector('.vmark.start'),
  endMark: !!document.querySelector('.vmark.end')
})`).then(JSON.parse);

async function jumpToPage(n) {
  await page.evaluate((p) => {
    const el = document.getElementById('page-number');
    el.value = String(p);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }, n);
  // wait for the LOAD to complete, not the injected input value: the first
  // rendered line of page n is (n-1)*500+1 with the ordered fixture
  await page.waitForFunction((p) => Number((document.querySelector('.vrow .ln') || { textContent: 0 }).textContent) === (p - 1) * 500 + 1,
    n, { timeout: 8000 });
}

// first row at/below the viewport top (the drawn slice includes a 5-row
// overscan above the visible area, so the first .vrow is not "first visible")
const firstVisibleLn = () => page.evaluate(() => {
  const vr = document.getElementById('viewer').getBoundingClientRect();
  for (const row of document.querySelectorAll('.vrow')) {
    if (row.getBoundingClientRect().bottom >= vr.top + 2) return Number(row.querySelector('.ln').textContent);
  }
  return 0;
});

// wheels over the viewer until the predicate holds, checking BEFORE each
// wheel; each step waits past the 150ms paging cooldown
async function wheelUntil(dirY, predicate, max = 40) {
  const box = await page.evaluate(() => {
    const r = document.getElementById('viewer-wrap').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  for (let i = 0; i < max; i++) {
    if (await predicate()) return i;
    await page.mouse.wheel(0, dirY);
    await page.waitForTimeout(170);
  }
  assert.ok(await predicate(), 'condition not reached after ' + max + ' wheel steps');
  return max;
}

async function mousedownRow(selector, opts) {
  await page.evaluate(({ sel, o }) => {
    const el = document.querySelector(sel);
    el.dispatchEvent(new MouseEvent('mousedown', Object.assign({ bubbles: true }, o)));
  }, { sel: selector, o: opts || {} });
}

test('continuous scroll: wheel appends the next page without scroll reset or pager move', async () => {
  await loadLineFixture(3000);
  await mousedownRow('.vrow .txt'); // select the first row
  await page.waitForFunction(() => document.getElementById('st-sel').textContent === '1', null, { timeout: 5000 });
  await wheelUntil(4000, async () => (await vw()).spacerRows >= 990, 20); // at least one append
  const s = await vw();
  assert.ok(s.scrollTop > 0, 'scroll position was not reset by the append');
  assert.strictEqual(s.pageNo, '1', 'pager keeps the anchor page');
  assert.ok(s.startMark && !s.endMark, 'window still begins at global line 1 and does not end at the last line');
  assert.strictEqual(s.selCount, '1', 'selection survives the append');
  // scroll back to the anchor row: the highlight re-renders from the stored seq
  await page.evaluate(() => { document.getElementById('viewer').scrollTop = 0; });
  await page.waitForTimeout(200);
  const sel = await page.evaluate(() => Array.from(document.querySelectorAll('.vrow.sel .ln')).map((x) => Number(x.textContent)));
  assert.deepStrictEqual(sel, [1], 'selected row stays highlighted at its remapped position');
});

test('continuous scroll: prepend keeps the first visible line anchored (nowrap and wrap)', async () => {
  await loadLineFixture(3000);
  await jumpToPage(2);
  const before = await firstVisibleLn();
  await wheelUntil(-4000, async () => (await vw()).startMark, 10); // prepend reaches global line 1
  const after = await vw();
  assert.strictEqual(await firstVisibleLn(), before, 'nowrap: first visible line unchanged by the prepend');
  assert.strictEqual(after.pageNo, '2', 'pager anchor unchanged');
  assert.ok(after.spacerRows >= 990, 'window now spans two pages');
  // wrap mode: heights are re-measured (prefix sums) BEFORE compensation
  await page.evaluate(() => document.getElementById('btn-wrap').click());
  await page.waitForTimeout(300);
  await jumpToPage(2);
  const beforeWrap = await firstVisibleLn();
  await wheelUntil(-4000, async () => (await vw()).startMark, 10);
  await page.waitForTimeout(200);
  const afterWrap = await vw();
  assert.strictEqual(await firstVisibleLn(), beforeWrap, 'wrap: first visible line unchanged by the prepend');
  assert.ok(afterWrap.startMark, 'wrap prepend also reached global line 1');
  await page.evaluate(() => document.getElementById('btn-wrap').click());
});

test('continuous scroll: eviction caps the window at 5 pages and marks track global bounds', async () => {
  await loadLineFixture(4000);
  await jumpToPage(3); // 3000 remaining lines: the cap must force an eviction
  const box = await page.evaluate(() => {
    const r = document.getElementById('viewer-wrap').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  let maxRows = 0, prevFirst = 0, ok = true;
  for (let i = 0; i < 40; i++) {
    const s = await vw();
    maxRows = Math.max(maxRows, s.spacerRows);
    if (s.firstLn < prevFirst) ok = false;
    prevFirst = s.firstLn;
    if (s.endMark) break;
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(170);
  }
  const s = await vw();
  assert.ok(s.endMark, 'reached the global end of the view');
  assert.ok(ok, 'first visible line never moves backward across appends/evictions');
  assert.ok(maxRows <= 2503, 'window never exceeds 5 pages (max sampled ' + maxRows + ' rows)');
  assert.strictEqual(s.pageNo, '3', 'pager stays on the anchor page');
  assert.ok(!s.startMark, 'start mark absent mid-window (evicted past global line 1)');
});

test('extended window collapses via loadPage on filter change and pagination jump', async () => {
  await loadLineFixture(3000);
  await wheelUntil(4000, async () => (await vw()).spacerRows >= 990, 20); // extend the window
  await page.evaluate(() => {
    const q = document.getElementById('quick');
    q.value = 'line 7 of';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '1', null, { timeout: 8000 });
  let s = await vw();
  assert.ok(s.spacerRows < 100, 'filter change collapses the window to the anchor page (got ' + s.spacerRows + ' rows)');
  assert.ok(s.startMark && s.endMark, 'single match shows both global boundary marks');
  // clear the filter, then jump: exactly the requested page, no bands
  await page.evaluate(() => {
    const q = document.getElementById('quick');
    q.value = '';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '3000', null, { timeout: 8000 });
  await jumpToPage(3);
  s = await vw();
  assert.ok(s.spacerRows <= 505, 'pagination jump loads exactly one page');
  assert.ok(!s.startMark && !s.endMark, 'middle page shows no boundary marks');
  await page.evaluate(() => document.getElementById('page-last').click());
  await page.waitForFunction(() => document.querySelector('.vmark.end') !== null, null, { timeout: 5000 });
});

test('off-window selection goes inert, restores on re-entry, and Esc clears everything', async () => {
  await loadLineFixture(3000);
  await mousedownRow('.vrow .txt');
  await mousedownRow('.vrow:nth-child(2) .txt', { shiftKey: true });
  await page.waitForFunction(() => document.getElementById('st-sel').textContent === '2', null, { timeout: 5000 });
  await jumpToPage(3); // selected rows are now off-window
  let s = await vw();
  assert.strictEqual(s.selCount, '0', 'off-window selection is excluded from the status count');
  assert.strictEqual(s.selRows, 0, 'off-window rows show no highlight');
  await jumpToPage(1); // page back: rows re-enter the window
  await page.waitForFunction(() => document.getElementById('st-sel').textContent === '2', null, { timeout: 8000 });
  s = await vw();
  assert.strictEqual(s.selRows, 2, 'highlights restored automatically from the stored global ids');
  // Esc clears the entire selection including any off-window entries
  await jumpToPage(2);
  await page.evaluate(() => document.getElementById('viewer').focus());
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('st-sel').textContent === '0', null, { timeout: 5000 });
  await jumpToPage(1);
  await page.waitForTimeout(400);
  s = await vw();
  assert.strictEqual(s.selCount, '0', 'Esc removed even the entries that were off-window');
  assert.strictEqual(s.selRows, 0, 'no stale highlights remain');
});

test('copy and selection export exclude off-window rows without error', async () => {
  await loadLineFixture(3000);
  // the Ctrl+C path awaits navigator.clipboard.writeText, whose promise never
  // settles in headless chromium — stub it: the behavior under test is the
  // app's windowing/status logic, not the browser clipboard
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async () => {} },
      configurable: true,
    });
  });
  await mousedownRow('.vrow .txt');
  await mousedownRow('.vrow:nth-child(2) .txt', { shiftKey: true });
  await page.waitForFunction(() => document.getElementById('st-sel').textContent === '2', null, { timeout: 5000 });
  await jumpToPage(3); // both selected rows off-window
  await page.evaluate(() => document.getElementById('viewer').focus());
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(300);
  assert.strictEqual(await page.evaluate(() => document.getElementById('st-progress').textContent), '',
    'copy with only off-window rows selected copies nothing');
  await jumpToPage(1); // both rows back in-window
  await page.waitForFunction(() => document.getElementById('st-sel').textContent === '2', null, { timeout: 8000 });
  await page.evaluate(() => document.getElementById('viewer').focus());
  await page.evaluate(() => {
    window.__keys = [];
    document.addEventListener('keydown', (e) => window.__keys.push({ key: e.key, ctrl: e.ctrlKey, target: e.target.tagName }), true);
  });
  await page.keyboard.press('Control+c');
  await page.waitForFunction(() => document.getElementById('st-progress').textContent === 'copied 2 line(s)', null, { timeout: 5000 });
});

test('selection persists across a pagination round-trip; shift and ctrl store global ids', async () => {
  await loadLineFixture(3000);
  // shift range: rows 1..10 selected by window indices, stored as global ids
  await mousedownRow('.vrow .txt');
  await page.evaluate(() => {
    const rows = document.querySelectorAll('.vrow');
    rows[9].querySelector('.txt').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, shiftKey: true }));
  });
  await page.waitForFunction(() => document.getElementById('st-sel').textContent === '10', null, { timeout: 5000 });
  await jumpToPage(2);
  await page.waitForFunction(() => document.getElementById('st-sel').textContent === '0', null, { timeout: 5000 });
  await jumpToPage(1);
  await page.waitForFunction(() => document.getElementById('st-sel').textContent === '10', null, { timeout: 5000 });
  const lns = await page.evaluate(() => Array.from(document.querySelectorAll('.vrow.sel .ln')).map((x) => Number(x.textContent)));
  assert.deepStrictEqual(lns, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'the same global lines re-highlight after the round-trip');
  // ctrl-click toggles single global ids
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('st-sel').textContent === '0', null, { timeout: 5000 });
  await mousedownRow('.vrow .txt', { ctrlKey: true });
  await page.evaluate(() => {
    const rows = document.querySelectorAll('.vrow');
    rows[9].querySelector('.txt').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey: true }));
  });
  await page.waitForFunction(() => document.getElementById('st-sel').textContent === '2', null, { timeout: 5000 });
  const picked = await page.evaluate(() => Array.from(document.querySelectorAll('.vrow.sel .ln')).map((x) => Number(x.textContent)));
  assert.deepStrictEqual(picked, [1, 10], 'ctrl-click selects exactly the two toggled rows');
});

test('filter change keeps matching selections highlighted and restores the rest on clear', async () => {
  await loadLineFixture(3000);
  await mousedownRow('.vrow .txt');
  await mousedownRow('.vrow:nth-child(2) .txt', { shiftKey: true });
  await page.waitForFunction(() => document.getElementById('st-sel').textContent === '2', null, { timeout: 5000 });
  await page.evaluate(() => {
    const q = document.getElementById('quick');
    q.value = 'line 2 of';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '1', null, { timeout: 8000 });
  let s = await vw();
  assert.strictEqual(s.selCount, '1', 'only the matching selected line is counted');
  assert.deepStrictEqual(await page.evaluate(() => Array.from(document.querySelectorAll('.vrow.sel .ln')).map((x) => Number(x.textContent))), [2],
    'the matching selected line keeps its highlight');
  await page.evaluate(() => {
    const q = document.getElementById('quick');
    q.value = '';
    q.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '3000', null, { timeout: 8000 });
  s = await vw();
  assert.strictEqual(s.selCount, '2', 'clearing the filter restores the inert selection');
  assert.strictEqual(s.selRows, 2, 'both highlights return');
});

test('selected page evicted by prepending is restored when scrolling back down', async () => {
  await loadLineFixture(4000);
  await jumpToPage(6); // 1500 remaining below, 2500 above: prepends must evict
  await wheelUntil(-4000, async () => (await vw()).spacerRows >= 2490, 20); // window at cap
  // park the viewport at the window bottom and select the last row: it sits
  // in the page that the next prepend (at cap) evicts from the bottom
  await page.evaluate(() => { document.getElementById('viewer').scrollTop = document.getElementById('viewer').scrollHeight; });
  await page.waitForTimeout(200);
  const selLn = await page.evaluate(() => {
    const lns = document.querySelectorAll('.vrow .ln');
    return Number(lns[lns.length - 1].textContent);
  });
  await page.evaluate(() => {
    const rows = document.querySelectorAll('.vrow');
    rows[rows.length - 1].querySelector('.txt').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await page.waitForFunction(() => document.getElementById('st-sel').textContent === '1', null, { timeout: 5000 });
  // wheel up: the native scroll reaches the top edge, the prepend pushes the
  // window start to the global head and the bottom page (with the selection)
  // is evicted
  await wheelUntil(-4000, () => page.evaluate(() => document.getElementById('st-sel').textContent === '0'), 25);
  let s = await vw();
  assert.ok(s.startMark && !s.endMark, 'window now starts at the global head and no longer ends at the selection page');
  assert.ok(s.spacerRows <= 2503, 'cap still holds after prepend eviction');
  // scroll back down: the append re-fetches the page (selection in-window
  // again), then keep scrolling to the window bottom so the row is drawn
  // and the highlight re-renders from the stored global id
  await wheelUntil(4000, () => page.evaluate(() => document.getElementById('st-sel').textContent === '1'), 30);
  await wheelUntil(4000, async () => {
    const cur = await page.evaluate(() => Array.from(document.querySelectorAll('.vrow.sel .ln')).map((x) => Number(x.textContent)));
    return cur.includes(selLn);
  }, 12);
  const restored = await page.evaluate(() => Array.from(document.querySelectorAll('.vrow.sel .ln')).map((x) => Number(x.textContent)));
  assert.ok(restored.includes(selLn), 'highlight restored on line ' + selLn + ' after eviction and re-fetch');
});

/* ---------- SPEC-VIEWER-001: Search all shortcut hint (M5) ---------- */

test('Search all hint matches the detected platform, keeps the tooltip, hides on narrow viewports', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  const expected = await page.evaluate(() => {
    const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    return /mac|ipad/i.test(p) ? '⌘Enter' : 'Ctrl+Enter';
  });
  assert.strictEqual(await page.evaluate(() => document.getElementById('sall-kbd').textContent), expected,
    'hint text matches one-time platform detection');
  assert.match(await page.evaluate(() => document.getElementById('btn-sall').title), /Ctrl\+Enter/, 'title tooltip unchanged');
  // 560px and narrower: the button (hint inside it) hides; ⋯ brings both back
  await page.setViewportSize({ width: 480, height: 800 });
  assert.strictEqual(await page.evaluate(() => getComputedStyle(document.getElementById('btn-sall')).display), 'none');
  await page.evaluate(() => document.getElementById('vtools-more').click());
  assert.notStrictEqual(await page.evaluate(() => getComputedStyle(document.getElementById('btn-sall')).display), 'none',
    'expanding vtools shows the button again');
  assert.strictEqual(await page.evaluate(() => getComputedStyle(document.getElementById('sall-kbd')).display), 'inline');
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('Search all hint shows the Mac glyph when the platform resolves to macOS', async () => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgentData', { get: () => undefined });
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(url() + '?svw-mac-hint', { waitUntil: 'domcontentloaded' });
  assert.strictEqual(await p.evaluate(() => document.getElementById('sall-kbd').textContent), '⌘Enter');
  assert.deepStrictEqual(errs, [], 'no errors during platform detection');
  await ctx.close();
});

test('Meta+Enter runs Search all while the hint is visible', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  assert.match(await page.evaluate(() => document.getElementById('sall-kbd').textContent), /Enter$/);
  await page.click('#quick');
  await page.keyboard.type('VHal');
  await page.keyboard.press('Meta+Enter');
  await page.waitForFunction(() => document.getElementById('btn-sall').getAttribute('aria-expanded') === 'true', null, { timeout: 5000 });
});

/* ---------------- SPEC-VIEWER-002: master Filter toggle, FILTERED badge, tooltip, zen HUD ---------------- */

const DEMO_WAIT = { timeout: 8000 };

async function loadDemo() {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '44', null, DEMO_WAIT);
}

test('Filter toggle OFF bypasses narrowing and ON restores the exact filtered view', async () => {
  await loadDemo();
  await setQuick('heartbeat');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '4', null, DEMO_WAIT);
  await addRule('WifiService', 'exclude');
  await setTimeRange('08-24 15:38');
  // a level chip: pick the first dynamic (non-star) chip
  await page.evaluate(() => {
    const chip = Array.from(document.querySelectorAll('.chip')).find((c) => !c.textContent.includes('★'));
    chip.click();
  });
  // snapshot only after every mutation's rebuild has settled (the time range
  // zeroes the demo view, so shown !== '44' is true while rebuilds are still
  // in flight — the baseline must be the fully settled filtered view)
  await page.waitForFunction(() => document.getElementById('viewer').getAttribute('aria-busy') === 'false', null, DEMO_WAIT);
  await page.waitForTimeout(150);
  const before = await status();
  assert.notStrictEqual(before.shown, '44', 'filters narrow the view before the round-trip');
  const quickBefore = await page.evaluate(() => document.getElementById('quick').value);
  const rulesBefore = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#rule-rows tr')).map((tr) => ({
      pattern: tr.querySelector('[data-k=pattern]').value,
      action: tr.querySelector('[data-k=action]').value,
      enabled: tr.querySelector('[data-k=enabled]').checked,
    })));

  // OFF: the bypassable inputs (rule, time range, level chip) are suspended —
  // the quick scan is NOT: it keeps narrowing the view on its own
  await click('btn-filter');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '4', null, DEMO_WAIT);
  let st = await fstate();
  assert.strictEqual(st.btnLabel, 'Filter: OFF');
  assert.strictEqual(st.btnOn, false, 'OFF removes the on class');
  assert.strictEqual(st.shown, '4', 'the quick scan still narrows while the toggle is OFF');
  assert.strictEqual(st.badgeHidden, false, 'badge stays: the quick scan keeps the view narrowed');
  assert.match(st.badgeTitle, /quick scan/, 'badge names the only active category');
  // filters tab keeps every setting verbatim
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=filters]').click());
  assert.strictEqual(await page.evaluate(() => document.getElementById('quick').value), quickBefore, 'quick filter text kept');
  assert.strictEqual(await page.evaluate(() => document.getElementById('time-from').value), '08-24 15:38', 'time range kept');
  const rulesKept = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#rule-rows tr')).map((tr) => ({
      pattern: tr.querySelector('[data-k=pattern]').value,
      action: tr.querySelector('[data-k=action]').value,
      enabled: tr.querySelector('[data-k=enabled]').checked,
    })));
  assert.deepStrictEqual(rulesKept, rulesBefore, 'rules kept in order with enabled state');
  const chipStillSel = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.chip')).some((c) => c.className.includes('sel')));
  assert.ok(chipStillSel, 'level chip stays selected while bypassed');

  // ON: identical filtered result set restored
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await click('btn-filter');
  await page.waitForFunction((shown) => document.getElementById('st-shown').textContent === shown,
    before.shown, DEMO_WAIT);
  st = await fstate();
  assert.strictEqual(st.btnLabel, 'Filter: ON');
  assert.strictEqual(st.btnOn, true, 'ON restores the on class');
  assert.strictEqual(await page.evaluate(() => document.getElementById('quick').value), quickBefore);
});

test('FILTERED badge visibility matrix (filtered/unfiltered x ON/OFF, quick scan decoupled)', async () => {
  await loadDemo();
  // unfiltered + ON
  let st = await fstate();
  assert.strictEqual(st.btnLabel, 'Filter: ON');
  assert.strictEqual(st.badgeHidden, true, 'unfiltered + ON hides the badge');
  // filtered + ON (quick scan)
  await setQuick('heartbeat');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '4', null, DEMO_WAIT);
  st = await fstate();
  assert.strictEqual(st.badgeHidden, false, 'filtered + ON shows the badge');
  // filtered + OFF: the quick scan still narrows, so the badge stays
  await click('btn-filter');
  await page.waitForFunction(() => document.getElementById('viewer').getAttribute('aria-busy') === 'false' &&
    document.getElementById('st-shown').textContent === '4', null, DEMO_WAIT);
  st = await fstate();
  assert.strictEqual(st.badgeHidden, false, 'quick scan + OFF keeps the badge (view still narrowed)');
  assert.match(st.badgeTitle, /quick scan/);
  // bypassable-only + OFF: replace the quick scan with a rule — nothing narrows
  await setQuick('');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '44', null, DEMO_WAIT);
  await addRule('WifiService', 'exclude');
  await page.waitForTimeout(400);
  st = await fstate();
  assert.strictEqual(st.shown, st.total, 'the rule is suspended while OFF');
  assert.strictEqual(st.badgeHidden, true, 'nothing narrowing + OFF hides the badge');
  // rule-only + ON: the suspended rule applies and the badge returns
  await click('btn-filter');
  await page.waitForFunction(() => Number(document.getElementById('st-shown').textContent) <
    Number(document.getElementById('st-total').textContent), null, DEMO_WAIT);
  st = await fstate();
  assert.strictEqual(st.badgeHidden, false, 'rule-only + ON shows the badge');
});

test('badge refreshes on filter mutations from the Filters tab; disabled rules never trigger it', async () => {
  await loadDemo();
  let st = await fstate();
  assert.strictEqual(st.badgeHidden, true, 'no badge without filters');
  await addRule('WifiService', 'exclude');
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await page.waitForFunction(() => document.getElementById('st-filtered') &&
    !document.getElementById('st-filtered').classList.contains('hidden'), null, DEMO_WAIT);
  st = await fstate();
  assert.strictEqual(st.badgeHidden, false, 'adding a rule from the Filters tab shows the badge');
  // disabling the only rule removes the narrowing — badge must disappear
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=filters]').click());
  await page.locator('#rule-rows tr:last-child [data-k=enabled]').uncheck();
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '44', null, DEMO_WAIT);
  st = await fstate();
  assert.strictEqual(st.badgeHidden, true, 'disabled rules are not active filters');
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=filters]').click());
  await page.locator('#rule-rows tr:last-child [data-k=enabled]').check();
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await page.waitForFunction(() => document.getElementById('st-filtered') &&
    !document.getElementById('st-filtered').classList.contains('hidden'), null, DEMO_WAIT);
});

test('badge and toggle tooltips list active categories in plain language only', async () => {
  await loadDemo();
  let st = await fstate();
  assert.match(st.btnTitle, /OFF suspends/i, 'toggle title explains the OFF state');
  assert.match(st.btnTitle, /Filters tab/i, 'toggle title points to the Filters tab');
  assert.match(st.btnTitle, /no filters active/i, 'toggle title states the unfiltered case plainly');
  st = await fstate();
  assert.match(st.badgeTitle, /no filters active/i, 'hidden badge still carries the plain unfiltered title');

  await setQuick('heartbeat');
  await addRule('WifiService', 'exclude');
  await page.evaluate(() => {
    const chip = Array.from(document.querySelectorAll('.chip')).find((c) => !c.textContent.includes('★'));
    chip.click();
  });
  await page.waitForFunction(() => document.getElementById('st-filtered') &&
    !document.getElementById('st-filtered').classList.contains('hidden'), null, DEMO_WAIT);
  st = await fstate();
  assert.match(st.badgeTitle, /quick scan/);
  assert.match(st.badgeTitle, /1 exclude rule/);
  assert.match(st.badgeTitle, /levels /, 'level chips listed');
  assert.ok(!/r\d+\b/.test(st.badgeTitle), 'no raw rule ids in the tooltip: ' + st.badgeTitle);
  assert.ok(!st.badgeTitle.includes('WifiService'), 'no raw patterns in the tooltip');
  assert.match(st.btnTitle, /1 exclude rule/, 'toggle tooltip carries the same summary');

  // while OFF the badge lists only what ACTUALLY narrows (the quick scan);
  // the toggle tooltip still lists everything configured
  await click('btn-filter');
  await page.waitForFunction(() => document.getElementById('viewer').getAttribute('aria-busy') === 'false' &&
    document.getElementById('st-shown').textContent === '4', null, DEMO_WAIT);
  st = await fstate();
  assert.strictEqual(st.badgeHidden, false, 'the quick scan keeps the view narrowed while OFF');
  assert.strictEqual(st.badgeTitle, 'quick scan', 'suspended categories are not listed as active');
  assert.match(st.btnTitle, /1 exclude rule/, 'toggle tooltip still lists the configured settings');
});

test('zen HUD gains the FILTERED marker whenever the view is actually narrowed', async () => {
  await loadDemo();
  await setQuick('heartbeat');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '4', null, DEMO_WAIT);
  await page.click('#btn-zen');
  await page.waitForFunction(() => /Mask: (ON|OFF) · FILTERED · \d+ shown/.test(
    (document.getElementById('zen-hud') || {}).textContent || ''), null, DEMO_WAIT);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  // bypassed: the quick scan still narrows, so the marker STAYS
  await click('btn-filter');
  await page.waitForFunction(() => document.getElementById('viewer').getAttribute('aria-busy') === 'false' &&
    document.getElementById('st-shown').textContent === '4', null, DEMO_WAIT);
  await page.click('#btn-zen');
  await page.waitForFunction(() => /Mask: (ON|OFF) · FILTERED · \d+ shown/.test(
    (document.getElementById('zen-hud') || {}).textContent || ''), null, DEMO_WAIT);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  // nothing narrowing at all: marker gone, otherwise the format is unchanged
  await setQuick('');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '44', null, DEMO_WAIT);
  await page.click('#btn-zen');
  await page.waitForFunction(() => {
    const hud = (document.getElementById('zen-hud') || {}).textContent || '';
    return /Mask: (ON|OFF) · \d+ shown/.test(hud) && !hud.includes('FILTERED');
  }, null, DEMO_WAIT);
  await page.keyboard.press('Escape');
});

test('fresh session starts with filters ON; persisted rules survive, transient filters do not', async () => {
  await loadDemo();
  await addRule('WifiService', 'exclude');
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await page.waitForFunction(() => document.getElementById('st-filtered') &&
    !document.getElementById('st-filtered').classList.contains('hidden'), null, DEMO_WAIT);
  let st = await fstate();
  assert.strictEqual(st.badgeHidden, false);
  // plain reload (localStorage preserved, files not reloaded): rules persist
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('st-filtered') &&
    !document.getElementById('st-filtered').classList.contains('hidden'), null, DEMO_WAIT);
  st = await fstate();
  assert.strictEqual(st.btnLabel, 'Filter: ON', 'toggle always comes up ON');
  assert.strictEqual(st.btnOn, true);
  assert.strictEqual(st.badgeHidden, false, 'badge reflects the persisted rule');
  assert.ok(!st.badgeTitle.includes('time range'), 'transient time range not in the tooltip');
  // bypass does not persist: set OFF, reload, toggle must be ON again
  await click('btn-filter');
  await page.waitForFunction(() => document.getElementById('btn-filter').textContent === 'Filter: OFF', null, DEMO_WAIT);
  await page.reload({ waitUntil: 'domcontentloaded' });
  // boot completion: updateStatus (via updateZenHud) populates the HUD
  await page.waitForFunction(() => ((document.getElementById('zen-hud') || {}).textContent || '').length > 0, null, DEMO_WAIT);
  st = await fstate();
  assert.strictEqual(st.btnLabel, 'Filter: ON', 'a new session never starts bypassed');
});

test('while bypassed, rule edits are stored not applied; quick scan edits apply immediately', async () => {
  await loadDemo();
  await click('btn-filter');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '44', null, DEMO_WAIT);
  await addRule('ZZZNOMATCH', 'exclude');
  await page.waitForTimeout(400);
  let st = await fstate();
  assert.strictEqual(st.shown, st.total, 'a rule edit while bypassed is stored, not applied');
  assert.strictEqual(st.badgeHidden, true, 'badge hidden: nothing actually narrows');
  // the quick scan applies immediately even while the toggle is OFF
  await setQuick('heartbeat');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '4', null, DEMO_WAIT);
  st = await fstate();
  assert.strictEqual(st.badgeHidden, false, 'badge reflects the live quick scan');
  assert.match(st.badgeTitle, /quick scan/);
  await click('btn-filter'); // ON — the stored rule applies on top of the quick scan
  await page.waitForFunction(() => document.getElementById('viewer').getAttribute('aria-busy') === 'false' &&
    document.getElementById('st-shown').textContent === '4', null, DEMO_WAIT);
  st = await fstate();
  assert.strictEqual(st.shown, '4', 'ZZZNOMATCH excludes nothing from the heartbeat set');
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=filters]').click());
  const ruleVal = await page.evaluate(() =>
    (document.querySelector('#rule-rows tr:last-child [data-k=pattern]') || {}).value);
  assert.strictEqual(ruleVal, 'ZZZNOMATCH', 'the edit-while-bypassed rule survived');
});

test('loading a new file while bypassed keeps the bypassable filters suspended; ON re-filters the new data', async () => {
  await loadDemo();
  await addRule('WifiService', 'exclude');
  await page.waitForFunction(() => Number(document.getElementById('st-shown').textContent) < 44, null, DEMO_WAIT);
  await click('btn-filter');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '44', null, DEMO_WAIT);
  await page.setInputFiles('#file-input', [join(root, 'tests', 'fixtures', 'syslog.log')]);
  await page.waitForFunction(() => Number(document.getElementById('st-total').textContent) > 44, null, DEMO_WAIT);
  await page.waitForTimeout(400);
  let st = await fstate();
  assert.strictEqual(st.shown, st.total, 'new file fully visible while bypassed (rule suspended)');
  assert.strictEqual(st.badgeHidden, true, 'badge stays hidden while bypassed');
  await click('btn-filter');
  await page.waitForFunction(() => Number(document.getElementById('st-shown').textContent) <
    Number(document.getElementById('st-total').textContent), null, DEMO_WAIT);
  st = await fstate();
  assert.strictEqual(st.badgeHidden, false, 'ON re-applies the stored filters to the new data');
});

test('bookmarks-only counts as narrowing for the badge and the toggle bypasses it', async () => {
  await loadDemo();
  await page.evaluate(() => document.querySelector('.vrow .bm').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const star = Array.from(document.querySelectorAll('.chip')).find((c) => c.textContent.includes('★'));
    star.click();
  });
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '1', null, DEMO_WAIT);
  let st = await fstate();
  assert.strictEqual(st.badgeHidden, false, 'bookmarks-only is a narrowing filter');
  assert.match(st.badgeTitle, /bookmarks only/);
  await click('btn-filter');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '44', null, DEMO_WAIT);
  st = await fstate();
  assert.strictEqual(st.badgeHidden, true, 'bypass shows every line');
});

test('band labels read as unfiltered only when nothing actually narrows', async () => {
  await loadDemo();
  await addRule('WifiService', 'exclude');
  await page.waitForFunction(() => Number(document.getElementById('st-shown').textContent) < 44, null, DEMO_WAIT);
  const startBand = await page.evaluate(() => (document.querySelector('.vmark.start span') || {}).textContent || '');
  assert.match(startBand, /first match/, 'filtered wording while ON');
  await click('btn-filter');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '44', null, DEMO_WAIT);
  const band = await page.evaluate(() => (document.querySelector('.vmark.start span') || {}).textContent || '');
  assert.match(band, /start of/, 'unfiltered wording while the rule is bypassed');
  assert.ok(!band.includes('first match'), 'no filtered wording while bypassed');
  // a quick scan while OFF narrows again — the filtered wording must return
  await setQuick('heartbeat');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '4', null, DEMO_WAIT);
  const bandQuick = await page.evaluate(() => (document.querySelector('.vmark.start span') || {}).textContent || '');
  assert.match(bandQuick, /first match/, 'quick scan + OFF keeps the filtered band wording');
});

/* ---------------- SPEC-TABS-001: digit tab switching, text-entry guard, Escape blur ---------------- */

const activeTab = () => page.evaluate(() => document.querySelector('#tabs button.active').dataset.tab);
const assertTabIs = async (name, msg) => {
  assert.strictEqual(await activeTab(), name, msg);
  assert.ok(await page.evaluate((n) => document.getElementById('tab-' + n).classList.contains('active'), name), msg);
};

test('digits 1-8 switch tabs in tab-bar order (AC-1.1)', async () => {
  await fresh();
  // AC-1.1 sequence: 2..8 then 1 (1 = Viewer, the starting tab, so it goes last)
  const seq = [[2, 'search'], [3, 'filters'], [4, 'masks'], [5, 'pii'], [6, 'analysis'], [7, 'export'], [8, 'config'], [1, 'viewer']];
  for (const [digit, tab] of seq) {
    await page.keyboard.press(String(digit));
    await assertTabIs(tab, 'digit ' + digit + ' activates ' + tab);
  }
});

test('modified digits never switch tabs (AC-1.2)', async () => {
  await fresh();
  for (const combo of ['Control+1', 'Meta+1', 'Alt+1', 'Shift+1', 'Control+8', 'Meta+8']) {
    await page.keyboard.press(combo);
    await assertTabIs('viewer', combo + ' is ignored by the app');
  }
});

test('digits do not switch tabs in zen mode (AC-1.3)', async () => {
  await loadDemo();
  await click('btn-zen');
  assert.ok(await page.evaluate(() => document.body.classList.contains('zen')), 'zen entered');
  for (let d = 1; d <= 8; d++) await page.keyboard.press(String(d));
  await assertTabIs('viewer', 'no digit switch while zen hides the tab bar');
  assert.ok(await page.evaluate(() => document.body.classList.contains('zen')), 'zen still active');
  await page.keyboard.press('Escape');
  assert.ok(await page.evaluate(() => !document.body.classList.contains('zen')), 'Escape exits zen');
  await page.keyboard.press('2');
  await assertTabIs('search', 'digits work again after zen exit');
});

test('digit typed in the quick filter goes to the field, no tab switch (AC-2.1)', async () => {
  await loadDemo();
  await page.click('#quick');
  await page.keyboard.type('42');
  assert.strictEqual(await page.evaluate(() => document.getElementById('quick').value), '42', 'digits land in the field');
  await assertTabIs('viewer', 'typing digits in the quick filter never switches tabs');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('viewer').getAttribute('aria-busy') === 'false', null, DEMO_WAIT);
});

test('guard covers input, select and go-to-line fields (AC-2.2)', async () => {
  await loadDemo();
  // go-to-line input
  await page.evaluate(() => document.getElementById('goto-ln').focus());
  await page.keyboard.press('5');
  assert.strictEqual(await page.evaluate(() => document.getElementById('goto-ln').value), '5', 'digit reaches goto-ln');
  await assertTabIs('viewer', 'no switch from goto-ln focus');
  // view-mode select (guard must swallow the digit)
  await page.evaluate(() => document.getElementById('view-mode').focus());
  await page.keyboard.press('5');
  await assertTabIs('viewer', 'no switch from select focus');
  // time-from input lives in the (hidden) Filters tab — switch there first,
  // a .focus() on a display:none element is a silent no-op
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=filters]').click());
  await page.evaluate(() => document.getElementById('time-from').focus());
  await page.keyboard.press('3');
  assert.strictEqual(await page.evaluate(() => document.getElementById('time-from').value), '3', 'digit reaches time-from');
  await assertTabIs('filters', 'no switch from time-from focus');
  // rg-pattern field on the search tab
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=search]').click());
  await page.evaluate(() => document.getElementById('rg-pattern').focus());
  await page.keyboard.press('7');
  assert.strictEqual(await page.evaluate(() => document.getElementById('rg-pattern').value), '7', 'digit reaches rg-pattern');
  await assertTabIs('search', 'no switch from rg-pattern focus');
});

test('contenteditable focus also guards digits (AC-2.4)', async () => {
  await fresh();
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'ce-guard-test';
    d.contentEditable = 'true';
    d.style.position = 'fixed';
    d.style.top = '0';
    document.body.appendChild(d);
    d.focus();
  });
  await page.keyboard.press('6');
  await assertTabIs('viewer', 'contenteditable focus swallows digits');
  assert.strictEqual(await page.evaluate(() => document.getElementById('ce-guard-test').textContent), '6', 'digit lands in the editor');
  await page.evaluate(() => document.getElementById('ce-guard-test').remove());
});

test('Escape blurs a focused field and restores single-key shortcuts (AC-3.1)', async () => {
  await loadDemo();
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=filters]').click()); // time-from is in the Filters tab
  await page.evaluate(() => document.getElementById('time-from').focus());
  assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'time-from', 'field focused first');
  await page.keyboard.press('Escape');
  assert.ok(await page.evaluate(() => document.activeElement === document.body), 'Escape released the field');
  await page.keyboard.press('m');
  assert.ok(await page.evaluate(() => document.getElementById('btn-mask').textContent.includes('OFF')), 'mask toggled without a mouse after Escape');
});

test('zen exit keeps any-focus Escape precedence over blur (AC-3.2)', async () => {
  await loadDemo();
  await page.click('#quick');
  await click('btn-zen'); // programmatic click keeps focus in #quick
  assert.ok(await page.evaluate(() => document.activeElement === document.getElementById('quick')), 'field focused inside zen');
  await page.keyboard.press('Escape');
  assert.ok(await page.evaluate(() => !document.body.classList.contains('zen')), 'first Escape exits zen, does not merely blur');
  assert.ok(await page.evaluate(() => document.activeElement === document.getElementById('quick')), 'field keeps focus through the zen exit');
  await page.keyboard.press('Escape');
  assert.ok(await page.evaluate(() => document.activeElement === document.body), 'second Escape blurs the field');
});

test('search-all close keeps any-focus Escape precedence over blur (AC-3.3)', async () => {
  await loadDemo();
  await setQuick('error');
  await click('btn-sall');
  await page.waitForFunction(() => !document.getElementById('sall').classList.contains('hidden'), null, DEMO_WAIT);
  await page.click('#quick');
  await page.keyboard.press('Escape');
  assert.ok(await page.evaluate(() => document.getElementById('sall').classList.contains('hidden')), 'first Escape closes the panel from field focus');
  assert.ok(await page.evaluate(() => document.activeElement === document.getElementById('quick')), 'field keeps focus through the panel close');
  await page.keyboard.press('Escape');
  assert.ok(await page.evaluate(() => document.activeElement === document.body), 'second Escape blurs the field');
});

test('theme menu still closes with Escape while a field is focused (AC-3.4)', async () => {
  await loadDemo();
  await click('theme-btn');
  assert.ok(await page.evaluate(() => !document.getElementById('theme-menu').classList.contains('hidden')), 'theme menu open');
  await page.evaluate(() => document.getElementById('quick').focus());
  await page.keyboard.press('Escape');
  assert.ok(await page.evaluate(() => document.getElementById('theme-menu').classList.contains('hidden')), 'independent theme listener closes the menu');
  assert.ok(await page.evaluate(() => document.activeElement === document.body), 'Escape also released the field');
});

test('Escape during IME composition does not blur or fire shortcuts (AC-3.5)', async () => {
  await loadDemo();
  const midComposition = await page.evaluate(() => {
    const q = document.getElementById('quick');
    q.focus();
    q.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    // a real IME marks the Escape keydown with isComposing — replay exactly that
    q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
    return document.activeElement === q;
  });
  assert.ok(midComposition, 'Escape during composition neither blurs the field nor fires shortcuts');
  const afterComposition = await page.evaluate(() => {
    const q = document.getElementById('quick');
    q.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return document.activeElement === document.body;
  });
  assert.ok(afterComposition, 'after composition ends, Escape blurs normally');
});

test('digit while the search-all panel is open still switches tabs (AC-E.2)', async () => {
  await loadDemo();
  await setQuick('error');
  await click('btn-sall');
  await page.waitForFunction(() => !document.getElementById('sall').classList.contains('hidden'), null, DEMO_WAIT);
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('6');
  await assertTabIs('analysis', 'digits work outside text fields with the panel open');
});

test('rapid digit switching re-renders both tabs cleanly (AC-E.1)', async () => {
  await loadDemo();
  await page.keyboard.press('6');
  await page.keyboard.press('1');
  await assertTabIs('viewer', 'back on the viewer after the rapid round-trip');
  await page.waitForFunction(() => document.querySelectorAll('#viewer .vrow').length > 0, null, DEMO_WAIT);
  await page.keyboard.press('6');
  await assertTabIs('analysis', 'analysis re-activates');
  assert.ok(await page.evaluate(() => document.getElementById('tab-analysis').innerHTML.length > 0), 'analysis repainted');
});

test('each tab button shows a visible digit badge (AC-4.1)', async () => {
  await fresh();
  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#tabs button')).map((b) => {
      const k = b.querySelector('kbd');
      const cs = k ? getComputedStyle(k) : null;
      const r = k ? k.getBoundingClientRect() : { width: 0, height: 0 };
      return {
        tab: b.dataset.tab,
        kbd: k ? k.textContent : '',
        visible: !!k && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
        title: b.title,
      };
    }));
  const digits = { viewer: 1, search: 2, filters: 3, masks: 4, pii: 5, analysis: 6, export: 7, config: 8 };
  assert.strictEqual(rows.length, 8, 'eight tab buttons');
  for (const row of rows) {
    assert.strictEqual(row.kbd, String(digits[row.tab]), row.tab + ' carries a kbd digit badge');
    assert.ok(row.visible, row.tab + ' badge is rendered at default width');
    assert.ok(!/press \d/.test(row.title), row.tab + ' title no longer duplicates the badge: ' + row.title);
  }
  const search = rows.find((r) => r.tab === 'search');
  assert.ok(search.title.includes('deep scan'), 'search button keeps its long tooltip text');
});

test('tab digit badge stays readable in all six themes', async () => {
  await fresh();
  const results = await page.evaluate(() => {
    const names = Object.keys(window.LT.THEMES);
    const out = [];
    for (const name of names) {
      document.getElementById('theme-btn').click();
      const opt = Array.from(document.querySelectorAll('#theme-menu .theme-opt')).find((o) => o.dataset.value === name);
      opt.click();
      const k = document.querySelector('#tabs button[data-tab=viewer] kbd');
      const cs = getComputedStyle(k);
      const rgb = (s) => (s.match(/\d+/g) || []).map(Number).slice(0, 3);
      const avg = (a) => (a[0] + a[1] + a[2]) / 3;
      const bg = rgb(cs.backgroundColor);
      const ink = rgb(cs.color);
      out.push({
        theme: name,
        bgOpaque: cs.backgroundColor !== 'rgba(0, 0, 0, 0)',
        contrast: Math.abs(avg(ink) - avg(bg)),
      });
    }
    return out;
  });
  assert.strictEqual(results.length, 6, 'six themes cycled');
  for (const r of results) {
    assert.ok(r.bgOpaque, r.theme + ': badge background resolves (theme vars)');
    assert.ok(r.contrast >= 40, r.theme + ': badge ink contrasts with badge background (diff ' + Math.round(r.contrast) + ')');
  }
});

test('Escape hides the find hint immediately — with and without a focused field', async () => {
  await loadDemo();
  const hintHidden = () => page.evaluate(() => document.getElementById('find-hint').classList.contains('hidden'));
  // Ctrl+F intercept shows the hint and focuses the quick filter
  await page.keyboard.press('Control+f');
  assert.ok(await page.evaluate(() => !document.getElementById('find-hint').classList.contains('hidden')), 'hint visible after Ctrl+F');
  await page.keyboard.press('Escape'); // quick filter still focused -> blur branch
  assert.ok(await hintHidden(), 'Escape in the quick filter hides the hint immediately (no timeout wait)');
  assert.ok(await page.evaluate(() => document.activeElement === document.body), 'field also released');
  // second path: hint visible, focus outside any field — Esc still clears it
  await page.keyboard.press('Control+f');
  assert.ok(await page.evaluate(() => !document.getElementById('find-hint').classList.contains('hidden')), 'hint visible again');
  await page.evaluate(() => document.getElementById('quick').blur());
  await page.keyboard.press('Escape');
  assert.ok(await hintHidden(), 'Escape with no field focused also clears the hint');
});

/* ---------------- SPEC-VIEWER-002 follow-up: toggle keeps the user's place ---------------- */

// top fully-visible row identity + scroll offset (nowrap: ROW_H arithmetic)
const viewPos = () => page.evaluate(`JSON.stringify((function () {
  const v = document.getElementById('viewer');
  const vr = v.getBoundingClientRect();
  const rows = Array.from(document.querySelectorAll('.vrow .ln')).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= vr.top - 1 && r.top < vr.bottom;
  });
  return { scrollTop: v.scrollTop, topLine: rows.length ? rows[0].textContent : null,
    shown: document.getElementById('st-shown').textContent };
})())`).then(JSON.parse);

test('Filter toggle is a view no-op while no narrowing filter is configured', async () => {
  await loadDemo();
  // scroll into the middle of the demo log (44 rows at 22px are scrollable)
  await page.evaluate(() => { document.getElementById('viewer').scrollTop = 200; });
  await page.waitForFunction(() => document.getElementById('viewer').scrollTop === 200, null, DEMO_WAIT);
  const before = await viewPos();
  assert.notStrictEqual(before.scrollTop, 0, 'precondition: scrolled away from the top');

  await click('btn-filter'); // OFF
  await page.waitForTimeout(300); // a (buggy) rebuild would land within this window
  let after = await viewPos();
  assert.strictEqual(after.shown, '44');
  assert.strictEqual(after.scrollTop, before.scrollTop, 'OFF must not move the view when nothing narrows');
  assert.strictEqual(after.topLine, before.topLine, 'top line identity unchanged by OFF');

  await click('btn-filter'); // ON
  await page.waitForTimeout(300);
  after = await viewPos();
  assert.strictEqual(after.scrollTop, before.scrollTop, 'ON must not move the view when nothing narrows');
  assert.strictEqual(after.topLine, before.topLine, 'top line identity unchanged by ON');
});

test('Filter toggle re-anchors the top visible line when the view set changes (quick scan + rule)', async () => {
  await fresh();
  const big = join(os.tmpdir(), 'lt-toggle-anchor-' + Date.now() + '.log');
  const lines = [];
  for (let i = 1; i <= 1200; i++) lines.push('09-11 22:14:01.' + String(i % 1000).padStart(3, '0') + '  1000  2000 I VHal: line ' + i);
  fs.writeFileSync(big, lines.join('\n') + '\n');
  try {
    await page.setInputFiles('#file-input', [big]);
    await page.waitForFunction(() => document.getElementById('st-total').textContent === '1200', null, DEMO_WAIT);
    // quick scan (always active) + an exclude rule (suspended while OFF):
    // ON narrows to lines matching 'line 1' minus 'line 11' (~290), OFF keeps
    // only the quick scan (~311) — both toggles change the view set
    await setQuick('line 1');
    await page.waitForFunction(() => Number(document.getElementById('st-shown').textContent) > 0 &&
      Number(document.getElementById('st-shown').textContent) < 1200, null, DEMO_WAIT);
    await addRule('line 11', 'exclude');
    await page.waitForFunction(() => document.getElementById('viewer').getAttribute('aria-busy') === 'false', null, DEMO_WAIT);
    await page.waitForTimeout(150);
    const filteredCount = Number(await page.textContent('#st-shown'));
    // scroll inside the filtered view and anchor on the top visible line
    await page.evaluate(() => { document.getElementById('viewer').scrollTop = 110; });
    await page.waitForFunction(() => document.getElementById('viewer').scrollTop === 110, null, DEMO_WAIT);
    const anchored = await viewPos();
    assert.ok(anchored.topLine, 'precondition: a top line is visible');

    // OFF: the rule is lifted (larger set) with the anchored line at the top
    await click('btn-filter');
    await page.waitForFunction((n) => Number(document.getElementById('st-shown').textContent) > n,
      filteredCount, DEMO_WAIT);
    await page.waitForFunction(() => document.getElementById('viewer').getAttribute('aria-busy') === 'false', null, DEMO_WAIT);
    const off = await viewPos();
    assert.strictEqual(off.topLine, anchored.topLine,
      'bypassed view re-anchors on the previously top line, got ' + off.topLine + ' vs ' + anchored.topLine);

    // ON: the rule re-applies (smaller set) with the same anchor still on top
    await click('btn-filter');
    await page.waitForFunction((n) => document.getElementById('st-shown').textContent === String(n),
      filteredCount, DEMO_WAIT);
    await page.waitForFunction(() => document.getElementById('viewer').getAttribute('aria-busy') === 'false', null, DEMO_WAIT);
    const on = await viewPos();
    assert.strictEqual(on.topLine, anchored.topLine,
      're-filtered view re-anchors on the same line, got ' + on.topLine + ' vs ' + anchored.topLine);
  } finally { fs.rmSync(big, { force: true }); }
});

test('quick scan narrows and highlights even while the Filter toggle is OFF', async () => {
  await loadDemo();
  await click('btn-filter'); // OFF — rules/time/levels/bookmarks-only are bypassed
  await page.waitForFunction(() => document.getElementById('btn-filter').textContent === 'Filter: OFF', null, DEMO_WAIT);
  await page.evaluate(() => { const q = document.getElementById('quick'); q.focus(); });
  await page.keyboard.type('ActivityManager');
  await page.waitForFunction(() => { const s = Number(document.getElementById('st-shown').textContent);
    return s > 0 && s < 44; }, null, DEMO_WAIT);
  await page.waitForFunction(() => document.getElementById('viewer').getAttribute('aria-busy') === 'false', null, DEMO_WAIT);
  const narrowed = Number(await page.textContent('#st-shown'));
  const st = await fstate();
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('mark').length), 5,
    'the live quick scan highlights its matches while the toggle is OFF');
  assert.strictEqual(st.badgeHidden, false, 'badge reflects the quick-scan narrowing while OFF');
  assert.match(st.badgeTitle, /quick scan/);
  // toggling ON changes nothing material: the same set stays, the place is kept
  const before = await viewPos();
  await click('btn-filter'); // ON
  await page.waitForFunction(() => document.getElementById('viewer').getAttribute('aria-busy') === 'false', null, DEMO_WAIT);
  const after = await viewPos();
  assert.strictEqual(after.shown, String(narrowed), 'ON with only the quick scan active keeps the view set');
  assert.strictEqual(after.topLine, before.topLine, 'ON with only the quick scan active keeps the top line');
});
