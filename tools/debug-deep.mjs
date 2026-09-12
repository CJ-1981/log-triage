#!/usr/bin/env node
'use strict';
/* Debug probe: load the stress fixture, run deep scan, capture every error. */
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
}).listen(8904);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('CONSOLE:', m.text().slice(0, 300)); });
page.on('requestfailed', (r) => console.log('REQFAIL:', r.url()));

await page.goto('http://127.0.0.1:8904/log-triage.html?v=' + Date.now(), { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.clear());
await page.evaluate(async () => {
  const r = await fetch('/tests/tmp/stress.log');
  window.LT_INGEST([new File([await r.blob()], 'stress.log', { type: 'text/plain' })]);
});
await page.waitForFunction(() => document.getElementById('st-progress').textContent === '', null, { timeout: 120000 });
console.log('ingested:', await page.evaluate(() => document.getElementById('st-total').textContent));

await page.evaluate(() => {
  document.querySelector('#tabs button[data-tab=search]').click();
  const q = document.getElementById('rg-pattern');
  q.value = 'ecu=gateway alive';
  q.dispatchEvent(new Event('input'));
});
await page.waitForTimeout(400);
await page.evaluate(() => document.getElementById('btn-deepscan').click());
await page.waitForFunction(() => /^deep scan: /.test(document.getElementById('search-progress').textContent), null, { timeout: 120000 });
console.log('final:', await page.evaluate(() => document.getElementById('search-progress').textContent));
console.log('errs:', await page.evaluate(() => JSON.stringify(window.__errs)));

await browser.close();
server.close();
process.exit(0);
