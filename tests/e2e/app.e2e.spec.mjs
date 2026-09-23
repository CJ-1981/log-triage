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
    q.value = 'heartbeat ecu=tcam';
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
  // changing the page clears the selection -> selection-only export disabled again
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await page.waitForSelector('#pager', { state: 'visible', timeout: 5000 });
  await page.evaluate(() => document.getElementById('page-next').click());
  await page.waitForFunction(() => document.getElementById('page-number').value === '2', null, { timeout: 5000 });
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=export]').click());
  await page.waitForFunction(() => document.getElementById('exp-txt').disabled, null, { timeout: 5000 });
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
    return t.includes('Top message shapes') && (t.includes('d***@***.example') || t.includes('driver.jung@'));
  }, null, { timeout: 10000 });
  let text = await page.evaluate(() => document.getElementById('tab-analysis').textContent);
  assert.ok(!text.includes('driver.jung@lotus-tech.example'), 'mask ON: no raw email anywhere in analysis');
  assert.ok(text.includes('d***@***.example'), 'mask ON: masked email shown in issue snippet / message shapes');
  // toggle mask OFF (via viewer toolbar) → analysis re-render shows the raw text
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await page.click('#btn-mask');
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=analysis]').click());
  await page.waitForFunction(() => document.getElementById('tab-analysis').textContent.includes('driver.jung@lotus-tech.example'), null, { timeout: 10000 });
  // restore mask ON
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
  await page.click('#btn-mask');
});
