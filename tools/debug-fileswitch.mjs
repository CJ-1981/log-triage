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
}).listen(8910);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)));
await page.goto('http://127.0.0.1:8910/log-triage.html', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.clear());
await page.setInputFiles('#file-input', [
  join(root, 'tests', 'fixtures', 'demo.log'),
  join(root, 'tests', 'fixtures', 'syslog.log'),
]);
await page.waitForFunction(() => document.getElementById('st-total').textContent === '52', null, { timeout: 8000 });
await page.evaluate(() => document.querySelectorAll('.file-item')[0].click());
await page.waitForFunction(() => document.getElementById('view-mode').value === 'file', null, { timeout: 5000 });
await page.waitForFunction(() => document.getElementById('st-shown').textContent === '44', null, { timeout: 5000 });
console.log('demo per-file view active');
await page.evaluate(() => {
  document.querySelector('#tabs button[data-tab=search]').click();
  const q = document.getElementById('rg-pattern');
  q.value = 'Failed password for admin';
  q.dispatchEvent(new Event('input'));
});
await page.waitForFunction(() => document.getElementById('search-progress').textContent.includes('match'), null, { timeout: 10000 });
await page.waitForFunction(() => document.querySelector('#search-results .sr-row') !== null, null, { timeout: 5000 });
const rowInfo = await page.evaluate(`JSON.stringify((() => {
  const r = document.querySelector('#search-results .sr-row');
  return { file: r.dataset.file, ln: r.dataset.ln, text: r.querySelector('.srx').textContent.slice(0, 60) };
})())`).then(JSON.parse);
console.log('first row:', JSON.stringify(rowInfo));
await page.evaluate(() => document.querySelector('#search-results .sr-row').click());
await page.waitForTimeout(400);
console.log(JSON.stringify(await page.evaluate(`JSON.stringify((() => {
  return {
    viewMode: document.getElementById('view-mode').value,
    shown: document.getElementById('st-shown').textContent,
    active: (document.querySelector('.file-item.active .fname') || { textContent: '' }).textContent,
    drawer: document.getElementById('drawer').textContent.slice(0, 80),
    errs: window.__errs || []
  };
})())`).then(JSON.parse)));

await browser.close();
server.close();
process.exit(0);
