'use strict';
/* E2E suite (SPEC-VIEWER-004): Source code syntax color highlighter for scripts and configs. */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let PORT = 0;
let server;
let browser;
let page;
const url = () => `http://127.0.0.1:${PORT}/log-triage.html`;

before(async () => {
  server = spawn(process.execPath, [join(root, 'tools', 'serve.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
  });
  await new Promise((res, rej) => {
    const onData = (d) => {
      const m = String(d).match(/SERVER_PORT:(\d+)/);
      if (m) res(Number(m[1]));
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
    setTimeout(() => rej(new Error('static server did not report SERVER_PORT within 3s')), 3000);
  }).then((p) => { PORT = p; });
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  page = await ctx.newPage();
  page.on('pageerror', (e) => { page.__pageErrors = (page.__pageErrors || []).concat(String(e)); });
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
});

afterEach(async () => {
  const errs = page && page.__pageErrors ? page.__pageErrors.splice(0) : [];
  assert.strictEqual(errs.length, 0, 'uncaught page errors: ' + errs.join(' | '));
});

async function fresh() {
  await page.goto(url(), { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.deleteDatabase('log-triage-cache');
    r.onsuccess = r.onerror = r.onblocked = () => res();
  }));
  await page.evaluate(() => localStorage.removeItem('log_triage_state_v1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
}

test('SPEC-VIEWER-004: Python and Batch syntax highlighting and toolbar switch toggle', async () => {
  await fresh();

  const pythonContent = `def compute_metrics(count=42): # calculate total
    status = "OK"
    return count * 2
`;

  // 1. Ingest script.py via window.LT_INGEST
  await page.evaluate(async (content) => {
    const f = new File([content], 'script.py', { type: 'text/plain' });
    await window.LT_INGEST([f]);
  }, pythonContent);

  // Wait for file entry in files list
  await page.waitForSelector('.file-item');
  const badgeText = await page.textContent('.file-item .badge.fmt');
  assert.strictEqual(badgeText, 'python', 'badge displays python format');

  // Verify #btn-syntax is visible and defaults to Syntax: ON
  const btnSyntax = await page.waitForSelector('#btn-syntax:not(.hidden)');
  const btnText = await btnSyntax.textContent();
  assert.ok(btnText.includes('Syntax: ON'), 'button text is Syntax: ON');

  // Verify syntax token spans in viewer
  await page.waitForSelector('.vrow .syn-kwd');
  const kwdText = await page.$eval('.vrow .syn-kwd', (el) => el.textContent);
  assert.strictEqual(kwdText, 'def', 'def is highlighted with .syn-kwd');

  const cmtText = await page.$eval('.vrow .syn-cmt', (el) => el.textContent);
  assert.strictEqual(cmtText, '# calculate total', 'comment is highlighted with .syn-cmt');

  // Toggle button to Syntax: OFF
  await btnSyntax.click();
  const btnTextOff = await btnSyntax.textContent();
  assert.ok(btnTextOff.includes('Syntax: OFF'), 'button text toggled to Syntax: OFF');

  // Verify syntax spans are removed
  const synKwdCount = await page.$$eval('.vrow .syn-kwd', (els) => els.length);
  assert.strictEqual(synKwdCount, 0, 'syntax token spans are removed when Syntax: OFF');

  // Toggle button back to Syntax: ON
  await btnSyntax.click();
  const btnTextOn = await btnSyntax.textContent();
  assert.ok(btnTextOn.includes('Syntax: ON'), 'button text toggled back to Syntax: ON');
  await page.waitForSelector('.vrow .syn-kwd');
});

test('SPEC-VIEWER-004: Standard log files hide #btn-syntax button', async () => {
  await fresh();

  const logContent = `01-20 12:34:56.789  1000  1001 I ActivityManager: Displayed com.example.app\n`;

  await page.evaluate(async (content) => {
    const f = new File([content], 'logcat.log', { type: 'text/plain' });
    await window.LT_INGEST([f]);
  }, logContent);

  await page.waitForSelector('.file-item');
  const isHidden = await page.$eval('#btn-syntax', (el) => el.classList.contains('hidden'));
  assert.strictEqual(isHidden, true, '#btn-syntax is hidden for standard log files');
});

async function addRule(pattern, action) {
  await page.evaluate(() => document.querySelector('#tabs button[data-tab=filters]').click());
  await page.evaluate(() => document.getElementById('btn-add-rule').click());
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

test('SPEC-VIEWER-004: Multi-layer visual precedence (mark > highlight rule > syntax spans)', async () => {
  await fresh();

  const pythonContent = `def calculate_metrics(count=42): # calculate total
    status = "active"
    return status
`;

  await page.evaluate(async (content) => {
    const f = new File([content], 'service.py', { type: 'text/plain' });
    await window.LT_INGEST([f]);
  }, pythonContent);

  await page.waitForSelector('.vrow .syn-kwd');

  // Add highlight rule for "metrics"
  await addRule('metrics', 'highlight');

  // Verify .rule-highlight-text exists in the viewer
  await page.waitForSelector('.vrow .rule-highlight-text');
  const ruleText = await page.$eval('.vrow .rule-highlight-text', (el) => el.textContent);
  assert.strictEqual(ruleText, 'metrics', 'rule highlight covers metrics');

  // Verify syntax tokens like "def" still rendered with .syn-kwd
  const kwdText = await page.$eval('.vrow .syn-kwd', (el) => el.textContent);
  assert.strictEqual(kwdText, 'def', 'def still highlighted with .syn-kwd');

  // Enter search pattern in quick filter: "calculate"
  await page.fill('#quick', 'calculate');
  await page.waitForSelector('.vrow mark');

  const marks = await page.$$eval('.vrow mark', (els) => els.map((e) => e.textContent));
  assert.ok(marks.includes('calculate'), 'quick search mark wraps calculate');

  // Precedence invariant: mark, rule-highlight-text, and syn-kwd coexist on the same line
  const hasMark = await page.$$eval('.vrow:first-child mark', (els) => els.length > 0);
  const hasRule = await page.$$eval('.vrow:first-child .rule-highlight-text', (els) => els.length > 0);
  const hasSyn = await page.$$eval('.vrow:first-child .syn-kwd', (els) => els.length > 0);
  assert.ok(hasMark && hasRule && hasSyn, 'mark, rule-highlight-text, and syn-* coexist in proper layers');
});

test('SPEC-VIEWER-004: Line-click detail drawer renders syntax highlighting', async () => {
  await fresh();

  const pythonContent = `def inspect_event(code=100): # event handler
    pass
`;

  await page.evaluate(async (content) => {
    const f = new File([content], 'handler.py', { type: 'text/plain' });
    await window.LT_INGEST([f]);
  }, pythonContent);

  await page.waitForSelector('.vrow');

  // Click row to open drawer
  await page.click('.vrow:first-child');
  await page.waitForSelector('#drawer.open');

  // Verify drawer contains syntax highlighted spans
  await page.waitForSelector('#drawer .syn-kwd');
  const drawerKwd = await page.$eval('#drawer .syn-kwd', (el) => el.textContent);
  assert.strictEqual(drawerKwd, 'def', 'drawer contains .syn-kwd def');

  const drawerNum = await page.$eval('#drawer .syn-num', (el) => el.textContent);
  assert.strictEqual(drawerNum, '100', 'drawer contains .syn-num 100');

  // Toggle syntax OFF
  await page.click('#btn-syntax');
  // Click row again to refresh drawer
  await page.click('.vrow:first-child');
  const drawerKwdsOff = await page.$$eval('#drawer .syn-kwd', (els) => els.length);
  assert.strictEqual(drawerKwdsOff, 0, 'drawer syntax spans removed when Syntax: OFF');
});

test('SPEC-VIEWER-004: Multi-format code ingestion and file switching', async () => {
  await fresh();

  const shellContent = `#!/bin/bash\necho "Running $TASK_NAME"\n`;
  const jsonContent = `{\n  "version": 42,\n  "enabled": true\n}\n`;

  await page.evaluate(async ({ sh, js }) => {
    const f1 = new File([sh], 'run.sh', { type: 'text/plain' });
    const f2 = new File([js], 'manifest.json', { type: 'text/plain' });
    await window.LT_INGEST([f1, f2]);
  }, { sh: shellContent, js: jsonContent });

  await page.waitForFunction(() => document.querySelectorAll('.file-item').length === 2);

  // Switch to run.sh
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.file-item'));
    const shItem = items.find((el) => el.textContent.includes('run.sh'));
    if (shItem) shItem.click();
    const sel = document.getElementById('view-mode');
    sel.value = 'file';
    sel.dispatchEvent(new Event('change'));
  });

  await page.waitForSelector('.file-item.active');
  const activeBadge1 = await page.textContent('.file-item.active .badge.fmt');
  assert.strictEqual(activeBadge1, 'shell', 'active badge is shell');

  // Verify Shell tokens
  await page.waitForSelector('.vrow .syn-builtin');
  const builtin = await page.$eval('.vrow .syn-builtin', (el) => el.textContent);
  assert.strictEqual(builtin, 'echo', 'echo highlighted as builtin');

  // Switch to manifest.json
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.file-item'));
    const jsonItem = items.find((el) => el.textContent.includes('manifest.json'));
    if (jsonItem) jsonItem.click();
  });

  await page.waitForFunction(() => document.querySelector('.file-item.active').textContent.includes('manifest.json'));
  const activeBadge2 = await page.textContent('.file-item.active .badge.fmt');
  assert.strictEqual(activeBadge2, 'json', 'active badge is json');

  // Verify JSON tokens
  await page.waitForSelector('.vrow .syn-num');
  const numVal = await page.$eval('.vrow .syn-num', (el) => el.textContent);
  assert.strictEqual(numVal, '42', '42 highlighted as number');
});

test('SPEC-VIEWER-004: All 6 color themes define syntax color variables', async () => {
  await fresh();

  const themes = ['midnight', 'monokai', 'paper', 'solarized-dark', 'solarized-light', 'high-contrast'];
  for (const th of themes) {
    const color = await page.evaluate((themeName) => {
      document.body.setAttribute('data-theme', themeName);
      return getComputedStyle(document.body).getPropertyValue('--syn-kwd').trim();
    }, th);
    assert.ok(color && color.length > 0, `theme ${th} defines --syn-kwd: ${color}`);
  }
});

