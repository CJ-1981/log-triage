'use strict';
/* E2E suite (SPEC-FILES-001): files-panel single-line name truncation and
 * instant full-name tooltips on live / cached / missing entries (custom
 * JS tip — native title is delayed/unreliable in Safari and only shows
 * while a name is actually truncated).
 * Run: npm run build && npm run e2e  (wired into package.json scripts.e2e). */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let PORT = 0; // OS-assigned free port
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
  page.on('pageerror', (e) => { page.__pageErrors = (page.__pageErrors || []).concat(String(e)); });
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
});

// zero uncaught page errors in every test (shared suite invariant)
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

const SAMPLE = [
  '09-11 10:10:22.100  1234  5678 D WifiHal: associated rssi=-50',
  '09-11 10:10:22.200  1234  5678 I WifiHal: scan complete',
  '09-11 10:10:22.300  1234  5678 E WifiHal: timeout waiting for driver',
].join('\n') + '\n';

// ~130-char real-disk fixture name: far past the ~250px panel width, yet
// under the 255-byte OS filename cap on every dev/CI platform (plan R2)
function longName() {
  return 'lt-truncate-' + 'overflow'.repeat(13) + '-' + Date.now() + '.log';
}

// never reload against a racing IDB write (CI #53 pattern): poll until the
// entry reads back durably from cacheGetAll
async function waitCachedStored(name) {
  await page.waitForFunction(
    (n) => LT.cacheGetAll().then((es) => es.some((e) => e.name === n && e.data)),
    name, { timeout: 8000 });
}

// fire the delegated mouseover on a .fname and read the instant tip state
// (dispatchEvent exercises the real #file-list delegation path deterministically)
async function hoverFname(selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const t = document.getElementById('fname-tip');
    return t ? { display: t.style.display, text: t.textContent, children: t.children.length } : { display: 'none', text: null, children: 0 };
  }, selector);
}

test('AC-FILES-001/002: a long live-entry name renders on one clipped line and the tooltip carries the exact stored name', async () => {
  await fresh();
  const name = longName();
  const p = join(os.tmpdir(), name);
  fs.writeFileSync(p, SAMPLE);
  try {
    await page.setInputFiles('#file-input', [p]);
    await page.waitForFunction(() => document.querySelectorAll('.file-item').length === 1, null, { timeout: 8000 });
    const info = await page.evaluate(`JSON.stringify((() => {
      const el = document.querySelector('.file-item .fname');
      const cs = getComputedStyle(el);
      return {
        whiteSpace: cs.whiteSpace,
        overflow: cs.overflow,
        textOverflow: cs.textOverflow,
        height: el.getBoundingClientRect().height,
        oneLineLimit: (parseFloat(cs.fontSize) || 12.5) * 1.75,
        clipped: el.scrollWidth > el.clientWidth,
        title: el.getAttribute('title'),
        text: el.textContent,
      };
    })())`).then(JSON.parse);
    assert.strictEqual(info.whiteSpace, 'nowrap', 'name is forced onto a single line');
    assert.strictEqual(info.overflow, 'hidden', 'overflow is clipped, not wrapped');
    assert.strictEqual(info.textOverflow, 'ellipsis', 'ellipsis is the truncation indicator');
    assert.ok(info.height <= info.oneLineLimit, 'single-line height: ' + info.height + ' <= ' + info.oneLineLimit);
    assert.ok(info.clipped, 'a ~130-char name overflows the panel (scrollWidth > clientWidth)');
    assert.strictEqual(info.title, null, 'no native title on the name (instant custom tip replaces it)');
    assert.strictEqual(info.text, name, 'visible text is the unshortened name');
    const tip = await hoverFname('.file-item .fname');
    assert.strictEqual(tip.display, 'block', 'instant tooltip appears on hover of a truncated name');
    assert.strictEqual(tip.text, name, 'tooltip equals the exact stored name');
    assert.strictEqual(tip.children, 0, 'tooltip holds plain text, no injected markup');
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('AC-FILES-005: HTML-special characters — tooltip decodes to the exact raw name with no injected markup', async () => {
  await fresh();
  // special characters AND long enough to truncate, so the instant tip engages.
  // Windows filenames cannot contain < > " (nor \ / : * ? |), so the hostile
  // alphabet is platform-split: POSIX exercises the full markup set, Windows
  // the legal-but-HTML-hostile subset (& ' ( ) # % + , ; = ! @) — the esc()
  // contract is exercised by & and ' on every platform.
  const stem = process.platform === 'win32'
    ? "lt-a&b'c(d)#e%f+g,h;i=k!j@"
    : 'lt-a<b>c&d"e\'f-';
  const name = stem + 'overflow'.repeat(12) + '.log';
  const p = join(os.tmpdir(), name);
  fs.writeFileSync(p, SAMPLE);
  try {
    await page.setInputFiles('#file-input', [p]);
    await page.waitForFunction(() => document.querySelectorAll('.file-item').length === 1, null, { timeout: 8000 });
    const info = await page.evaluate(`JSON.stringify((() => {
      const el = document.querySelector('.file-item .fname');
      const item = document.querySelector('.file-item');
      return {
        clipped: el.scrollWidth > el.clientWidth,
        text: el.textContent,
        childNodes: el.childNodes.length,
        childNodeTypes: Array.from(el.childNodes).map((n) => n.nodeType),
        badges: item.querySelectorAll('.fmeta .badge').length,
        items: document.querySelectorAll('.file-item').length,
      };
    })())`).then(JSON.parse);
    assert.strictEqual(info.items, 1, 'one entry rendered');
    assert.ok(info.clipped, 'the special-char name is truncated (tip path exercised)');
    assert.strictEqual(info.text, name, 'visible text is the exact raw name');
    assert.strictEqual(info.childNodes, 1, 'fname holds a single text node (no injected elements)');
    assert.deepStrictEqual(info.childNodeTypes, [3], 'the only child is a text node');
    assert.ok(info.badges >= 1, 'metadata badges still render (DOM shape intact)');
    const tip = await hoverFname('.file-item .fname');
    assert.strictEqual(tip.display, 'block', 'tooltip appears for the truncated special-char name');
    assert.strictEqual(tip.text, name, 'tooltip text decodes to the exact raw name');
    assert.strictEqual(tip.children, 0, 'tooltip injects no markup for markup-like names');
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('AC-FILES-003: cached entry keeps the ↻ suffix and container tooltip while the name tooltip carries the stored name; click still loads', async () => {
  await fresh();
  const name = longName();
  const p = join(os.tmpdir(), name);
  fs.writeFileSync(p, SAMPLE);
  try {
    await page.setInputFiles('#file-input', [p]);
    await page.waitForFunction(() => document.getElementById('st-total').textContent === '3', null, { timeout: 8000 });
    await waitCachedStored(name);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('.file-item.cached').length === 1, null, { timeout: 20000 });
    const info = await page.evaluate(`JSON.stringify((() => {
      const item = document.querySelector('.file-item.cached');
      const fname = item.querySelector('.fname');
      return {
        after: getComputedStyle(fname, '::after').content,
        containerTitle: item.getAttribute('title'),
      };
    })())`).then(JSON.parse);
    const tip = await hoverFname('.file-item.cached .fname');
    assert.strictEqual(tip.display, 'block', 'instant tooltip appears on the truncated cached name');
    assert.strictEqual(tip.text, name, 'cached name tooltip equals the stored name');
    assert.ok(info.after.includes('↻'), '↻ suffix rule intact, got ' + info.after);
    assert.strictEqual(info.containerTitle, 'cached — click to load', 'container tooltip unchanged');
    await page.evaluate(() => document.querySelector('.file-item.cached').click());
    await page.waitForFunction(() => document.getElementById('st-total').textContent === '3', null, { timeout: 20000 });
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('AC-FILES-004: missing entry keeps the line-through and container tooltip while the name tooltip carries the stored name', async () => {
  await fresh();
  const name = 'missed-archive_src-' + 'overflow'.repeat(10) + '-gone.log';
  const stored = await page.evaluate(
    (n) => LT.cachePut({ id: 'cache_missing_e2e', name: n, size: 12, format: '—', ts: 1 }),
    name);
  assert.strictEqual(stored, true, 'metadata-only cache entry seeded');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.file-item.missing').length === 1, null, { timeout: 8000 });
  const info = await page.evaluate(`JSON.stringify((() => {
    const item = document.querySelector('.file-item.missing');
    const fname = item.querySelector('.fname');
    return {
      decoration: getComputedStyle(fname).textDecorationLine,
      containerTitle: item.getAttribute('title'),
    };
  })())`).then(JSON.parse);
  const tip = await hoverFname('.file-item.missing .fname');
  assert.strictEqual(tip.display, 'block', 'instant tooltip appears on the truncated missing name');
  assert.strictEqual(tip.text, name, 'missing name tooltip equals the stored name');
  assert.ok(info.decoration.includes('line-through'), 'line-through intact, got ' + info.decoration);
  assert.strictEqual(info.containerTitle, 'this file could not be restored', 'container tooltip unchanged');
});

test('AC-FILES-006: a short cached name does not clip and the ↻ suffix stays visible', async () => {
  await fresh();
  await page.setInputFiles('#file-input', [join(root, 'tests', 'fixtures', 'demo.log')]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  await waitCachedStored('demo.log');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.file-item.cached').length === 1, null, { timeout: 20000 });
  const info = await page.evaluate(`JSON.stringify((() => {
    const el = document.querySelector('.file-item.cached .fname');
    return { clipped: el.scrollWidth > el.clientWidth, after: getComputedStyle(el, '::after').content };
  })())`).then(JSON.parse);
  assert.ok(!info.clipped, 'short name is not clipped (scrollWidth <= clientWidth)');
  assert.ok(info.after.includes('↻'), '↻ suffix still rendered, got ' + info.after);
  const tip = await hoverFname('.file-item.cached .fname');
  assert.strictEqual(tip.display, 'none', 'no tooltip for an untruncated name (tip is truncation-gated)');
});

test('single file selected activates per-file mode, not merged timeline', async () => {
  await fresh();
  // 1. Single file loaded via file picker
  await page.setInputFiles('#file-input', [join(root, 'tests', 'fixtures', 'demo.log')]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
  const viewMode = await page.evaluate(() => document.getElementById('view-mode').value);
  assert.strictEqual(viewMode, 'file', 'single file load must activate per-file mode');
  const activeCount = await page.evaluate(() => document.querySelectorAll('.file-item.active').length);
  assert.strictEqual(activeCount, 1, 'only the single loaded file is highlighted');
  const fileColCount = await page.evaluate(() => document.querySelectorAll('.vrow .vcell.fl').length);
  assert.strictEqual(fileColCount, 0, 'per-file mode viewer omits the file name column');

  // Clicking the file item when only 1 file is loaded should stay in per-file mode
  await page.evaluate(() => document.querySelector('.file-item').click());
  const viewModeAfterClick = await page.evaluate(() => document.getElementById('view-mode').value);
  assert.strictEqual(viewModeAfterClick, 'file', 'clicking the only file keeps per-file mode');

  // 2. Loading a second file (multi-file load)
  await page.setInputFiles('#file-input', [
    join(root, 'tests', 'fixtures', 'syslog.log'),
    join(root, 'tests', 'fixtures', 'apache.log'),
  ]);
  await page.waitForFunction(() => document.getElementById('st-total').textContent === '57', null, { timeout: 8000 });
  const multiMode = await page.evaluate(() => document.getElementById('view-mode').value);
  assert.strictEqual(multiMode, 'merged', 'multi-file load activates merged mode');

  // 3. Removing files down to 1 file transitions back to per-file mode
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.file-item'));
    const syslog = items.find((el) => el.textContent.includes('syslog.log'));
    if (syslog) syslog.querySelector('.fx').click();
  });
  await page.waitForFunction(() => document.querySelectorAll('.file-item').length === 2, null, { timeout: 5000 });
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.file-item'));
    const apache = items.find((el) => el.textContent.includes('apache.log'));
    if (apache) apache.querySelector('.fx').click();
  });
  await page.waitForFunction(() => document.querySelectorAll('.file-item').length === 1, null, { timeout: 5000 });
  const remainingMode = await page.evaluate(() => document.getElementById('view-mode').value);
  assert.strictEqual(remainingMode, 'file', 'reducing to 1 file transitions to per-file mode');
});

test('merged timeline viewer truncated file name column shows tooltip instantly', async () => {
  await fresh();
  const name = longName();
  const p = join(os.tmpdir(), name);
  const EARLY_SAMPLE = [
    '08-24 10:00:00.100  1234  5678 D WifiHal: associated rssi=-50',
    '08-24 10:00:00.200  1234  5678 I WifiHal: scan complete',
    '08-24 10:00:00.300  1234  5678 E WifiHal: timeout waiting for driver',
  ].join('\n') + '\n';
  fs.writeFileSync(p, EARLY_SAMPLE);
  try {
    // Load two files to activate merged timeline mode
    await page.setInputFiles('#file-input', [p, join(root, 'tests', 'fixtures', 'demo.log')]);
    await page.waitForFunction(() => document.querySelectorAll('.file-item').length === 2, null, { timeout: 8000 });
    await page.waitForFunction(() => document.getElementById('st-total').textContent === '47', null, { timeout: 8000 });
    await page.waitForFunction(() => document.getElementById('view-mode').value === 'merged', null, { timeout: 8000 });
    await page.waitForFunction(() => document.querySelectorAll('.vrow .vcell.fl').length > 0, null, { timeout: 8000 });

    // Find the long-name cell and demo.log cell in the viewer
    const cellInfo = await page.evaluate(`JSON.stringify((() => {
      const longCell = Array.from(document.querySelectorAll('.vrow .vcell.fl')).find((c) => c.textContent.includes('lt-truncate-'));
      const shortCell = Array.from(document.querySelectorAll('.vrow .vcell.fl')).find((c) => c.textContent === 'demo.log');
      return {
        hasLong: !!longCell,
        hasShort: !!shortCell,
        longClipped: longCell ? longCell.scrollWidth > longCell.clientWidth : false,
        longTitle: longCell ? longCell.getAttribute('title') : undefined,
        shortClipped: shortCell ? shortCell.scrollWidth > shortCell.clientWidth : false,
        shortTitle: shortCell ? shortCell.getAttribute('title') : undefined,
      };
    })())`).then(JSON.parse);

    assert.ok(cellInfo.hasLong, 'viewer contains row for long file');
    assert.ok(cellInfo.hasShort, 'viewer contains row for short file');
    assert.ok(cellInfo.longClipped, 'long file name cell is truncated (scrollWidth > clientWidth)');
    assert.strictEqual(cellInfo.longTitle, null, 'long file name cell carries NO native title');
    assert.ok(!cellInfo.shortClipped, 'short file name cell is NOT truncated');
    assert.strictEqual(cellInfo.shortTitle, null, 'short file name cell carries NO native title');

    // Hover truncated file name cell -> instant tooltip appears with full name
    const longTip = await page.evaluate(() => {
      const longCell = Array.from(document.querySelectorAll('.vrow .vcell.fl')).find((c) => c.textContent.includes('lt-truncate-'));
      longCell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      const t = document.getElementById('fname-tip');
      return t ? { display: t.style.display, text: t.textContent } : { display: 'none', text: null };
    });
    assert.strictEqual(longTip.display, 'block', 'instant tooltip appears on truncated viewer file cell');
    assert.strictEqual(longTip.text, name, 'tooltip text matches full unshortened file name');

    // Hover untruncated file name cell -> tooltip is hidden
    const shortTip = await page.evaluate(() => {
      const shortCell = Array.from(document.querySelectorAll('.vrow .vcell.fl')).find((c) => c.textContent === 'demo.log');
      shortCell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      const t = document.getElementById('fname-tip');
      return t ? { display: t.style.display, text: t.textContent } : { display: 'none', text: null };
    });
    assert.strictEqual(shortTip.display, 'none', 'tooltip stays hidden for untruncated viewer file cell');

    // Moving mouse out of viewer hides the tooltip
    await page.evaluate(() => {
      const v = document.getElementById('viewer');
      v.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    });
    const tipAfterLeave = await page.evaluate(() => {
      const t = document.getElementById('fname-tip');
      return t ? t.style.display : 'none';
    });
    assert.strictEqual(tipAfterLeave, 'none', 'tooltip hides when mouse leaves viewer');
  } finally {
    fs.rmSync(p, { force: true });
  }
});
