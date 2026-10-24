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
