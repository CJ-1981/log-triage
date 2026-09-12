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
}).listen(8908);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)));
await page.goto('http://127.0.0.1:8908/log-triage.html', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.clear());
await page.setInputFiles('#file-input', [join(root, 'tests', 'fixtures', 'demo.log')]);
await page.waitForFunction(() => document.getElementById('st-total').textContent === '44', null, { timeout: 8000 });
await page.evaluate(() => LT.cachePut({ id: 'cache_gone', name: 'gone.log', size: 12, format: '—', ts: 1 }));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelectorAll('.file-item').length === 2, null, { timeout: 8000 });

const idbIds = () => page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('log-triage-cache'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const ids = await new Promise((res, rej) => { const tx = db.transaction('files', 'readonly'); const rq = tx.objectStore('files').getAllKeys(); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
  db.close();
  return ids;
});

console.log('items:', JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll('.file-item')).map((x) => x.className))));
await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll('.file-item')).find((x) => x.className.includes('missing'));
  el.querySelector('.fx').click();
});
await page.waitForTimeout(600);
console.log('items after X:', JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll('.file-item')).map((x) => x.className))));
console.log('idb ids after X:', JSON.stringify(await idbIds()));
console.log('pageerrors:', JSON.stringify(await page.evaluate(() => window.__errs || [])));

await browser.close();
server.close();
process.exit(0);
