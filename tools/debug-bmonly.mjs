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
}).listen(8907);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)));
await page.goto('http://127.0.0.1:8907/log-triage.html', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.clear());
await page.evaluate(() => document.getElementById('btn-demo').click());
await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });

const dump = (label) => page.evaluate(`JSON.stringify((() => ({
  label: ${JSON.stringify(label)},
  btn: document.getElementById('btn-bmonly').textContent,
  shown: document.getElementById('st-shown').textContent,
  progress: document.getElementById('st-progress').textContent,
  lns: Array.from(document.querySelectorAll('.vrow .ln')).map((x) => Number(x.textContent)).slice(0, 8),
  errs: window.__errs || []
}))())`).then(JSON.parse);

console.log(JSON.stringify(await dump('start')));
// enable with no bookmarks
await page.evaluate(() => document.getElementById('btn-bmonly').click());
console.log(JSON.stringify(await dump('enable w/o bookmarks')));
// bookmark two lines
await page.evaluate(() => {
  const rows = document.querySelectorAll('.vrow');
  rows[1].querySelector('.bm').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  rows[3].querySelector('.bm').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
});
console.log(JSON.stringify(await dump('after bookmarking')));
await page.evaluate(() => document.getElementById('btn-bmonly').click());
await page.waitForTimeout(400);
console.log(JSON.stringify(await dump('after enable with bookmarks')));

await browser.close();
server.close();
process.exit(0);
