#!/usr/bin/env node
'use strict';
/* Captures review screenshots of the built app with headless Chromium.
 * Usage: node tools/shots.mjs  (serves the repo itself on :8902) */
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
  const s = document.getElementById('theme-sel'); s.value = 'paper'; s.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(250);
await shot('2-viewer-paper.png');

// 3: masks panel (midnight)
await page.evaluate(() => {
  const s = document.getElementById('theme-sel'); s.value = 'midnight'; s.dispatchEvent(new Event('change'));
  document.querySelector('#tabs button[data-tab=masks]').click();
});
await page.waitForTimeout(250);
await shot('3-masks.png');

// 4: analysis
await page.evaluate(() => document.querySelector('#tabs button[data-tab=analysis]').click());
await page.waitForTimeout(300);
await shot('4-analysis.png');

// 5: search with instant results + selection copy bar
await page.evaluate(() => document.querySelector('#tabs button[data-tab=search]').click());
await page.evaluate(() => {
  const q = document.getElementById('rg-pattern'); q.value = 'heartbeat ecu=tcam'; q.dispatchEvent(new Event('input'));
});
await page.waitForTimeout(250);
await shot('5-search.png');

await browser.close();
server.close();
console.log('screenshots written to', shotsDir);
