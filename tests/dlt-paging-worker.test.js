'use strict';
/* Paging-worker integration tests for binary DLT captures (SPEC-DLT-BINARY-001,
 * R3-2 / AC-E.8): the real worker bundle (build.js WORKER_ORDER) runs in a stub
 * scope exactly like the browser Blob-URL worker, so the assertions cover the
 * index meta surface (utf8 true, warnings passthrough) and the rawNeeded scan
 * paths — full search, quick scan, and the export archive scan — resolving
 * their matches over the format-agnostic record iterator in decoded record
 * index space, never raw byte-lines. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { WORKER_ORDER } = require('../build.js');

const source = WORKER_ORDER.map((n) => fs.readFileSync(path.join(__dirname, '..', 'src', n), 'utf8')).join('\n');
const FX = path.join(__dirname, 'fixtures');
const hexFile = (f) => new Uint8Array(Buffer.from(fs.readFileSync(path.join(FX, f), 'utf8').trim(), 'hex'));
const expectedLines = (f) => fs.readFileSync(path.join(FX, f), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');

/* Boot the unmodified worker bundle against a stub self scope. Replies are
 * asynchronous (the worker handler awaits indexing), so each send registers a
 * waiter that postMessage resolves when a matching reply for its id arrives. */
function makeWorker() {
  const scope = { onmessage: null };
  const waiters = [];
  scope.postMessage = (data) => {
    const at = waiters.findIndex((w) => w.id === data.id && w.match(data));
    if (at < 0) return;
    const [w] = waiters.splice(at, 1);
    if (data.error) w.reject(new Error(data.error));
    else w.resolve(data);
  };
  new Function('self', source + '\n;var LT = self.LT;')(scope);
  let nextId = 0;
  return {
    send(payload, match) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        waiters.push({ id, match, resolve, reject });
        scope.onmessage({ data: Object.assign({ id }, payload) });
      });
    },
  };
}

const emptySpec = { rules: [], levels: [], quick: null, timeFrom: '', timeTo: '' };

test('worker index meta carries the dlt-binary format, utf8 true and zero warnings', async () => {
  const w = makeWorker();
  const res = await w.send({ type: 'index', fileId: 'f1', file: new Blob([hexFile('dlt-binary-sample.hex')]) }, (d) => d.count !== undefined || d.error);
  assert.equal(res.format, 'dlt-binary');
  assert.equal(res.count, 5);
  assert.equal(res.utf8, true, 'no enc? badge driver for binary captures');
  assert.equal(res.warnings, 0);
  assert.equal(res.sample.length, 5);
  assert.equal(res.sample[0].raw, expectedLines('dlt-binary-sample-expected.txt')[0]);
});

test('worker full search resolves a rendered-only token to the decoded record (R3-2)', async () => {
  const w = makeWorker();
  await w.send({ type: 'index', fileId: 'f1', file: new Blob([hexFile('dlt-binary-sample.hex')]) }, (d) => d.count !== undefined || d.error);
  // 'control request' exists only in the rendered line, never in raw bytes
  const res = await w.send({ type: 'search', spec: Object.assign({ pattern: 'control request', options: {} }, emptySpec) }, (d) => d.total !== undefined || d.error);
  assert.equal(res.total, 1);
  const page = await w.send({ type: 'page', search: true, start: 0, size: 10 }, (d) => d.rows !== undefined || d.error);
  assert.equal(page.total, 1);
  assert.equal(page.rows.length, 1);
  assert.match(page.rows[0].raw, /control request hex dead/);
  assert.equal(page.rows[0].lineNo, 4, 'the hit resolves in decoded record index space');
  assert.equal(page.rows[0].ts, '01-01 01:03:00.000');
});

test('worker quick scan operates on decoded records, not byte-lines (R3-2, R3-6)', async () => {
  const w = makeWorker();
  await w.send({ type: 'index', fileId: 'f1', file: new Blob([hexFile('dlt-binary-nostorage.hex')]) }, (d) => d.count !== undefined || d.error);
  const spec = Object.assign({}, emptySpec, { quick: { pattern: 'control', fixed: true } });
  const res = await w.send({ type: 'query', spec }, (d) => d.total !== undefined || d.error || d.cancelled);
  assert.equal(res.total, 1);
  const page = await w.send({ type: 'page', start: 0, size: 10 }, (d) => d.rows !== undefined || d.error);
  assert.equal(page.rows.length, 1);
  assert.match(page.rows[0].raw, /control request hex dead/);
  assert.equal(page.rows[0].lineNo, 3);
});

test('worker export archive scan (rawNeeded rules) scans decoded records (R3-2)', async () => {
  const w = makeWorker();
  await w.send({ type: 'index', fileId: 'f1', file: new Blob([hexFile('dlt-binary-sample.hex')]) }, (d) => d.count !== undefined || d.error);
  const spec = Object.assign({}, emptySpec, { rules: [{ id: 'r1', pattern: 'APP1:CTX1', action: 'include', enabled: true }] });
  const res = await w.send({ type: 'exportInit', fileId: 'f1', spec }, (d) => d.total !== undefined || d.error || d.cancelled);
  assert.equal(res.total, 3, 'include rule matched the three APP1:CTX1 records');
  const page = await w.send({ type: 'exportPage', start: 0, size: 10 }, (d) => d.rows !== undefined || d.error);
  assert.equal(page.rows.length, 3);
  for (const row of page.rows) assert.ok(row.raw.includes('APP1:CTX1'));
});

test('worker index meta surfaces the lossy-decode warning count (R5-5, AC-5.5)', async () => {
  // byte-built lossy capture: declared length below the HTYP minimum, then a
  // valid message, then a truncated tail -> one resync + one truncation warning
  const enc = (s) => new TextEncoder().encode(s);
  const cat = (...xs) => { const n = xs.reduce((s, a) => s + a.length, 0); const out = new Uint8Array(n); let p = 0; for (const a of xs) { out.set(a, p); p += a.length; } return out; };
  const u16 = (v) => new Uint8Array([(v >> 8) & 255, v & 255]);
  const msg = (mcnt, s) => {
    const payload = cat(u16(s.length + 1), enc(s), new Uint8Array([0]));
    const head = cat(new Uint8Array([0x23, mcnt]), u16(4 + 10 + payload.length + 4 + 2));
    return cat(head, new Uint8Array([0x41, 1]), enc('APP1'), enc('CTX1'), new Uint8Array([0x00, 0x00, 0x82, 0x00]), payload, new Uint8Array([0x00, 0x00]));
  };
  const good = msg(1, 'first');
  const bad = cat(new Uint8Array([0x23, 9]), u16(5), new Uint8Array(40).fill(0x41)); // length below minLen
  const second = msg(2, 'second');
  const tail = msg(3, 'tailpart').slice(0, -8); // truncated at EOF
  const w = makeWorker();
  const res = await w.send({ type: 'index', fileId: 'f2', file: new Blob([cat(good, bad, second, tail)]) }, (d) => d.count !== undefined || d.error);
  assert.equal(res.format, 'dlt-binary');
  assert.equal(res.warnings, 2, 'resync plus truncation surfaced through the index meta');
  assert.equal(res.count, 3);
});

test('worker index + page parity for the QNX BE-header variant (ADR-0016)', async () => {
  const w = makeWorker();
  const res = await w.send({ type: 'index', fileId: 'f1', file: new Blob([hexFile('dlt-binary-qnx-variant.hex')]) }, (d) => d.count !== undefined || d.error);
  assert.equal(res.format, 'dlt-binary');
  assert.equal(res.count, 3);
  assert.equal(res.warnings, 0);
  assert.equal(res.utf8, true);
  assert.equal(res.sample[0].raw, expectedLines('dlt-binary-qnx-variant-expected.txt')[0]);
  // page rows re-decode exact windows; with the swapped length also able to
  // fit a window they must carry the index-time byte-order policy (R5-6)
  const all = await w.send({ type: 'query', spec: emptySpec }, (d) => d.total !== undefined || d.error || d.cancelled);
  assert.equal(all.total, 3);
  const page = await w.send({ type: 'page', start: 0, size: 10 }, (d) => d.rows !== undefined || d.error);
  assert.deepEqual(page.rows.map((r) => r.raw), expectedLines('dlt-binary-qnx-variant-expected.txt'));
  const search = await w.send({ type: 'search', spec: Object.assign({ pattern: 'kanzi property', options: {} }, emptySpec) }, (d) => d.total !== undefined || d.error);
  assert.equal(search.total, 1, 'rendered-only token found in the variant capture');
});

test('worker text scans still run over byteLines after the iterator switch', async () => {
  const w = makeWorker();
  const res = await w.send({ type: 'index', fileId: 'f3', file: new Blob([fs.readFileSync(path.join(FX, 'dlt-viewer-sample.txt'))]) }, (d) => d.count !== undefined || d.error);
  assert.equal(res.format, 'dlt');
  assert.equal(res.count, 42);
  assert.equal(res.warnings, 0);
  const search = await w.send({ type: 'search', spec: Object.assign({ pattern: 'CAN bus status', options: {} }, emptySpec) }, (d) => d.total !== undefined || d.error);
  assert.equal(search.total, 1);
  const page = await w.send({ type: 'page', search: true, start: 0, size: 10 }, (d) => d.rows !== undefined || d.error);
  assert.match(page.rows[0].raw, /CAN bus status ok/);
});

test('mixed binary + text sources in one worker classify per file and merge by timeKey (AC-E.7)', async () => {
  const w = makeWorker();
  const bin = await w.send({ type: 'index', fileId: 'f1', file: new Blob([hexFile('dlt-binary-sample.hex')]) }, (d) => d.count !== undefined || d.error);
  assert.equal(bin.format, 'dlt-binary', 'per-file classification: binary source stays dlt-binary');
  assert.equal(bin.count, 5);
  const txt = await w.send({ type: 'index', fileId: 'f2', file: new Blob([fs.readFileSync(path.join(FX, 'dlt-viewer-sample.txt'))]) }, (d) => d.count !== undefined || d.error);
  assert.equal(txt.format, 'dlt', 'per-file classification: text source stays dlt');
  assert.equal(txt.count, 42);
  // quick scan spans both sources through the format-agnostic record iterator
  const spec = Object.assign({}, emptySpec, { quick: { pattern: 'ECU1', fixed: true } });
  const res = await w.send({ type: 'query', spec }, (d) => d.total !== undefined || d.error || d.cancelled);
  assert.equal(res.total, 47, '5 binary + 42 text rows match in decoded record space');
  const page = await w.send({ type: 'page', start: 0, size: 50 }, (d) => d.rows !== undefined || d.error);
  assert.equal(page.total, 47);
  const rows = page.rows;
  // merged timeKey sort: every binary record (01-01 storage timestamps)
  // precedes the text capture (09-03 timestamps), each group in time order
  assert.deepEqual(rows.slice(0, 5).map((r) => r.fileId), ['f1', 'f1', 'f1', 'f1', 'f1']);
  assert.deepEqual(rows.slice(0, 5).map((r) => r.lineNo), [1, 2, 3, 4, 5]);
  assert.deepEqual(rows.slice(5).map((r) => r.fileId), new Array(42).fill('f2'));
  assert.deepEqual(rows.slice(5).map((r) => r.lineNo), Array.from({ length: 42 }, (_, i) => i + 1), 'per-file lineNo restarts after the source switch');
  assert.equal(rows[0].seq, 1);
  assert.equal(rows[5].seq, 6, 'seq stays global while lineNo is per file (nextBase accumulation)');
  assert.match(rows[0].raw, /APP1:CTX1/, 'binary rows render decoded');
  assert.match(rows[5].raw, /camera service starting/, 'text rows follow the binary block by timeKey');
});
