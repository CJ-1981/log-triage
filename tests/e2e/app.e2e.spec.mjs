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
