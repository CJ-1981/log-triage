#!/usr/bin/env node
'use strict';
/* Captures review screenshots of the built app with headless Chromium.
 * Usage: node tools/shots.mjs  (serves the repo itself on :8902)
 * Set SHOTS_DIR to override the output directory (default tests/tmp/shots;
 * README images are regenerated with SHOTS_DIR=docs/img). */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const shotsDir = process.env.SHOTS_DIR || join(root, 'tests', 'tmp', 'shots');
mkdirSync(shotsDir, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.log': 'text/plain; charset=utf-8' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/log-triage.html';
    const data = await readFile(normalize(join(root, p)));
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
}).listen(8902);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const base = 'http://127.0.0.1:8902/log-triage.html';

const shot = (name) => page.screenshot({ path: join(shotsDir, name) });
// themes are switched through the header 🎨 dropdown (the old inline
// #theme-sel was removed in v1.4x — driving it silently kept the wrong theme)
const setTheme = (name) => page.evaluate((n) => {
  document.getElementById('theme-btn').click();
  const opt = Array.from(document.querySelectorAll('#theme-menu .theme-opt')).find((o) => o.dataset.value === n);
  if (opt) opt.click();
}, name);

await page.goto(base + '?v=' + Date.now(), { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.removeItem('log_triage_state_v1'));
await page.evaluate(() => document.getElementById('btn-demo').click());
await page.waitForFunction(() => document.getElementById('st-total').textContent === '44');

// 1: midnight, quick filter + selection + drawer
await page.evaluate(() => {
  const q = document.getElementById('quick'); q.value = 'CAN'; q.dispatchEvent(new Event('input'));
});
await page.waitForTimeout(250);
await page.evaluate(() => document.querySelector('.vrow').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
await page.waitForTimeout(250);
await shot('1-viewer-midnight.png');

// 2: paper theme, unfiltered
await page.evaluate(() => {
  const q = document.getElementById('quick'); q.value = ''; q.dispatchEvent(new Event('input'));
});
await setTheme('paper');
await page.waitForTimeout(250);
await shot('2-viewer-paper.png');

// 3: masks panel (midnight)
await setTheme('midnight');
await page.evaluate(() => document.querySelector('#tabs button[data-tab=masks]').click());
await page.waitForTimeout(250);
await shot('3-masks.png');

// 4: analysis
await page.evaluate(() => document.querySelector('#tabs button[data-tab=analysis]').click());
await page.waitForTimeout(300);
await shot('4-analysis.png');

// 5: multifile search with instant results
await page.evaluate(() => document.querySelector('#tabs button[data-tab=search]').click());
await page.evaluate(() => {
  const q = document.getElementById('rg-pattern'); q.value = 'heartbeat ecu=tcam'; q.dispatchEvent(new Event('input'));
});
await page.waitForTimeout(250);
await shot('5-search.png');

// 6: viewer Search all — every quick-filter match in the bottom panel
await page.evaluate(() => document.querySelector('#tabs button[data-tab=viewer]').click());
await page.evaluate(() => {
  const q = document.getElementById('quick'); q.value = 'heartbeat'; q.dispatchEvent(new Event('input'));
});
await page.waitForTimeout(300);
await page.evaluate(() => document.getElementById('btn-sall').click());
await page.waitForFunction(() => document.querySelectorAll('#sall-rows .sr-row').length === 4);
await page.waitForTimeout(150);
await shot('6-search-all.png');

await browser.close();
server.close();
console.log('screenshots written to', shotsDir);
