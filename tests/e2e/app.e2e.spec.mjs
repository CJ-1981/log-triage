'use strict';
/* E2E suite: Playwright Chromium against the built single-file HTML.
 * Run: npm run build && npm run e2e  (CI installs playwright + chromium first). */
import { test, before, after, beforeEach, afterEach } from 'node:test';
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

// TDD enhancement (retrospective R1): every test must end with zero uncaught
// page errors — UI handlers that throw (e.g. undefined functions) fail here
afterEach(async () => {
  const errs = page && page.__pageErrors ? page.__pageErrors.splice(0) : [];
  assert.strictEqual(errs.length, 0, 'uncaught page errors: ' + errs.join(' | '));
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

test('search matches scroll horizontally on narrow viewports (no truncation)', async () => {
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
  assert.ok(geo.hScroll, 'results panel gains a horizontal scroll range on narrow screens');
  assert.ok(geo.cellW > 200, 'match text cell is not squeezed to nothing: ' + geo.cellW);
  await page.evaluate(() => { document.getElementById('search-results').scrollLeft = 300; });
  await page.waitForTimeout(150);
  const sl = await page.evaluate(() => document.getElementById('search-results').scrollLeft);
  assert.ok(sl > 100, 'panel scrolls horizontally, scrollLeft=' + sl);
  await page.setViewportSize({ width: 1440, height: 900 });
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

test('config tab exports and imports filter/mask/issue-scan configuration', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
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
  assert.strictEqual(cfg.issueGroups.length, 5, 'five issue-scan groups exported');
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
  // enabling with no bookmarks flashes a hint and stays off
  await click('btn-bmonly');
  assert.ok(await page.evaluate(() => document.getElementById('btn-bmonly').textContent.includes('OFF')), 'stays off with no bookmarks');
  assert.match(await page.evaluate(() => document.getElementById('st-progress').textContent), /no bookmarks/);
  // bookmark lines 2 and 4 via the gutter (re-query rows: render replaces DOM)
  await page.evaluate(() => {
    const rows = document.querySelectorAll('.vrow');
    rows[1].querySelector('.bm').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await page.evaluate(() => {
    const rows = document.querySelectorAll('.vrow');
    rows[3].querySelector('.bm').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await click('btn-bmonly');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '2', null, { timeout: 5000 });
  const lns = await page.evaluate(() => Array.from(document.querySelectorAll('.vrow .ln')).map((x) => Number(x.textContent)));
  assert.deepStrictEqual(lns, [2, 4], 'only the bookmarked lines remain, got ' + JSON.stringify(lns));
  // unbookmarking the only visible bookmark while ON re-filters the view
  await page.evaluate(() => document.querySelector('.vrow .bm').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '1', null, { timeout: 5000 });
  const lnAfter = await page.evaluate(() => Number(document.querySelector('.vrow .ln').textContent));
  assert.strictEqual(lnAfter, 4, 'remaining bookmarked line is line 4');
  await click('btn-bmonly'); // back to all lines
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '44');
});

test('file cache: previous session is listed after reload, cached file reloads, missing content shows as file not found', async () => {
  await fresh();
  await page.setInputFiles('#file-input', [join(root, 'tests', 'fixtures', 'demo.log')]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  // reopen the app: the cache lists the previous file as restorable
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.file-item').length === 1, null, { timeout: 8000 });
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
