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
}).listen(8906);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)));
const url = 'http://127.0.0.1:8906/log-triage.html';

// replicate test 12 exactly, including fresh()
await page.goto(url + '?x=' + Date.now(), { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.removeItem('log_triage_state_v1'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.setInputFiles('#file-input', [
  join(root, 'tests', 'fixtures', 'demo.log'),
  join(root, 'tests', 'fixtures', 'syslog.log'),
]);
await page.waitForFunction(() => document.querySelectorAll('.file-item').length === 2, null, { timeout: 8000 });
await page.waitForFunction(() => document.getElementById('st-total').textContent === '52', null, { timeout: 8000 });
const dump = (label) => page.evaluate(`JSON.stringify((() => ({
  label: ${JSON.stringify(label)},
  viewMode: document.getElementById('view-mode').value,
  shown: document.getElementById('st-shown').textContent,
  quick: document.getElementById('quick').value,
  activeCls: (document.querySelector('.file-item') || { className: 'none' }).className,
  errs: (window.__errs || []).length,
  stored: (localStorage.getItem('log_triage_state_v1') || '').slice(0, 120)
}))())`).then(JSON.parse);

console.log('after load:', JSON.stringify(await dump('after load')));
await page.evaluate(() => document.querySelectorAll('.file-item')[0].click());
await page.waitForFunction(() => document.getElementById('view-mode').value === 'file', null, { timeout: 5000 });
console.log('after click0:', JSON.stringify(await dump('after click0')));
await page.waitForTimeout(500);
console.log('after 500ms:', JSON.stringify(await dump('after 500ms')));

await browser.close();
server.close();
process.exit(0);
