'use strict';
/* E2E suite (SPEC-VIEWER-003): Markdown file support in viewer with 'Markdown: ON/OFF' switch and Mermaid rendering. */
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

test('SPEC-VIEWER-003: Markdown format detection and switch button toggle with Mermaid rendering', async () => {
  await fresh();

  const mdContent = `# Architectural Overview

This is an automated architectural document with tables and diagrams.

| Component | Status |
|---|---|
| Core Engine | Active |
| Viewer | Ready |

\`\`\`mermaid
graph TD
  User[User Client] --> Server[App Server]
  Server --> DB[(Database)]
\`\`\`

Conclusion note.
`;

  // Ingest sample markdown file via window.LT_INGEST
  await page.evaluate(async (content) => {
    const f = new File([content], 'architecture.md', { type: 'text/markdown' });
    await window.LT_INGEST([f]);
  }, mdContent);

  // AC-001: Format badge in file list shows 'markdown'
  const badgeText = await page.textContent('.file-item .badge.fmt');
  assert.equal(badgeText, 'markdown', 'Format badge should be markdown');

  // AC-002: Toolbar switch button #btn-markdown is visible
  const btnVisible = await page.isVisible('#btn-markdown');
  assert.equal(btnVisible, true, '#btn-markdown should be visible for .md files');

  // AC-003: Defaults to 'Markdown: OFF' and shows raw rows
  const btnTextOff = (await page.textContent('#btn-markdown')).trim();
  assert.equal(btnTextOff, 'Markdown: OFF', 'Button defaults to Markdown: OFF');
  const viewerVisible = await page.isVisible('#viewer');
  assert.equal(viewerVisible, true, '#viewer is visible when OFF');
  const mdViewerHidden = await page.evaluate(() => document.getElementById('md-viewer').classList.contains('hidden'));
  assert.equal(mdViewerHidden, true, '#md-viewer is hidden when OFF');

  // AC-004: Click #btn-markdown toggles to ON, renders HTML & SVG
  await page.click('#btn-markdown');
  const btnTextOn = (await page.textContent('#btn-markdown')).trim();
  assert.equal(btnTextOn, 'Markdown: ON', 'Button toggles to Markdown: ON');
  const hasOnClass = await page.evaluate(() => document.getElementById('btn-markdown').classList.contains('on'));
  assert.equal(hasOnClass, true, 'Button carries .on class when active');

  const viewerHidden = await page.evaluate(() => document.getElementById('viewer').classList.contains('hidden'));
  assert.equal(viewerHidden, true, '#viewer is hidden when Markdown: ON');
  const mdViewerVisible = await page.isVisible('#md-viewer');
  assert.equal(mdViewerVisible, true, '#md-viewer is visible when Markdown: ON');

  // Verify rendered markdown content
  const h1Text = await page.textContent('#md-viewer h1');
  assert.equal(h1Text, 'Architectural Overview', 'H1 rendered correctly');
  const tableTh = await page.textContent('#md-viewer table th');
  assert.equal(tableTh, 'Component', 'Table rendered correctly');

  // AC-005: Verify Mermaid flowchart SVG diagram
  const svgExists = await page.isVisible('#md-viewer .mermaid-diagram');
  assert.equal(svgExists, true, 'Mermaid SVG diagram rendered');
  const svgContent = await page.innerHTML('#md-viewer .mermaid-container');
  assert.ok(svgContent.includes('User Client'), 'Diagram contains node User Client');
  assert.ok(svgContent.includes('App Server'), 'Diagram contains node App Server');
  assert.ok(svgContent.includes('Database'), 'Diagram contains node Database');

  // Toggle back to Markdown: OFF
  await page.click('#btn-markdown');
  const btnTextBackOff = (await page.textContent('#btn-markdown')).trim();
  assert.equal(btnTextBackOff, 'Markdown: OFF', 'Button returns to Markdown: OFF');
  const mdViewerBackHidden = await page.evaluate(() => document.getElementById('md-viewer').classList.contains('hidden'));
  assert.equal(mdViewerBackHidden, true, '#md-viewer is hidden again');
  const viewerBackVisible = await page.isVisible('#viewer');
  assert.equal(viewerBackVisible, true, '#viewer is restored');
});

test('SPEC-VIEWER-003: Switch button visibility dynamically tracks active file type', async () => {
  await fresh();

  // Ingest both a standard log file and a markdown file
  await page.evaluate(async () => {
    const f1 = new File(['line 1: normal log\nline 2: normal log'], 'service.log', { type: 'text/plain' });
    const f2 = new File(['# Documentation\n\nSome details here.'], 'guide.md', { type: 'text/markdown' });
    await window.LT_INGEST([f1, f2]);
  });

  // Switch to per-file mode
  await page.selectOption('#view-mode', 'file');

  // Click service.log
  await page.locator('.file-item:has-text("service.log")').click();
  let btnHidden = await page.evaluate(() => document.getElementById('btn-markdown').classList.contains('hidden'));
  assert.equal(btnHidden, true, '#btn-markdown is hidden for service.log');

  // Click guide.md
  await page.locator('.file-item:has-text("guide.md")').click();
  let btnVisible = await page.evaluate(() => !document.getElementById('btn-markdown').classList.contains('hidden'));
  assert.equal(btnVisible, true, '#btn-markdown is visible when guide.md is selected');
});
