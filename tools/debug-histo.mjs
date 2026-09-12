#!/usr/bin/env node
'use strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/log-triage.html';
    res.writeHead(200, { 'content-type': extname(p) === '.html' ? 'text/html' : 'text/plain' });
    res.end(await readFile(normalize(join(root, p))));
  } catch { res.writeHead(404); res.end(); }
}).listen(8909);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:8909/log-triage.html', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.clear());
await page.evaluate(() => document.getElementById('btn-demo').click());
await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
await page.evaluate(() => document.querySelector('#tabs button[data-tab=analysis]').click());
await page.waitForTimeout(400);
await page.screenshot({ path: join(root, 'tests', 'tmp', 'histo-demo.png') });
// hover a bar to check the tooltip
const box = await page.evaluate(() => {
  const r = document.getElementById('histo').getBoundingClientRect();
  return { x: r.x + 200, y: r.y + r.height * 0.5 };
});
await page.mouse.move(box.x, box.y);
await page.waitForTimeout(150);
await page.screenshot({ path: join(root, 'tests', 'tmp', 'histo-hover.png') });
await browser.close();
server.close();
console.log('shots saved');
process.exit(0);
