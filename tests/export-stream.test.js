'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const LT = require('../src/export-stream.js');

const enc = (s) => new TextEncoder().encode(s);
const dec = (chunks) => chunks.map((c) => Buffer.from(c).toString('utf8')).join('');

function demoBatch() {
  return [{ file: 'a.log', lineNo: 1, ts: '09-11 22:14:01.100', level: 'I', tag: 'VHal', pid: 1000, msg: 'alpha', raw: '09-11 22:14:01.100  1000  2000 I VHal: alpha' }];
}

test('writer awaits each sink write in order and closes exactly once', async () => {
  let active = 0, closed = 0; const output = [];
  const sink = {
    async write(bytes) {
      assert.equal(++active, 1, 'writes are sequential');
      await new Promise((resolve) => setImmediate(resolve));
      output.push(...bytes); --active;
    },
    async close() { closed++; },
    async abort() { assert.fail('unexpected abort'); },
  };
  async function* input() { yield Uint8Array.of(65); yield Uint8Array.of(66); }
  assert.equal(await LT.writeChunks(input(), sink, {}), 2);
  assert.deepEqual(output, [65, 66]);
  assert.equal(closed, 1);
});

test('writer aborts the sink and rethrows on write failure', async () => {
  let aborted = null;
  const sink = {
    async write() { throw new Error('disk full'); },
    async close() { assert.fail('no close after failure'); },
    async abort(err) { aborted = err; },
  };
  async function* input() { yield Uint8Array.of(1); }
  await assert.rejects(() => LT.writeChunks(input(), sink, {}), /disk full/);
  assert.equal(aborted.message, 'disk full');
});

test('writer rethrows on close failure after aborting the sink', async () => {
  const sink = { async write() {}, async close() { throw new Error('close boom'); }, async abort(err) { assert.equal(err.message, 'close boom'); } };
  await assert.rejects(() => LT.writeChunks((async function* () { yield Uint8Array.of(1); })(), sink, {}), /close boom/);
});

test('cancellation between chunks stops the stream and aborts the sink', async () => {
  const controller = new AbortController();
  let aborted = 0, writes = 0;
  const sink = {
    async write() { writes++; if (writes === 1) controller.abort(); },
    async close() { assert.fail('no close after cancellation'); },
    async abort() { aborted++; },
  };
  async function* input() { for (let i = 1; i <= 3; i++) yield Uint8Array.of(i); }
  await assert.rejects(() => LT.writeChunks(input(), sink, { signal: controller.signal }), /cancelled|abort/);
  assert.equal(writes, 1, 'stopped right after the first write');
  assert.equal(aborted, 1, 'sink aborted once');
});

test('serializeExport txt applies prefixes and newlines across batches', async () => {
  const b1 = [{ file: 'a.log', lineNo: 1, raw: 'one' }];
  const b2 = [{ file: 'a.log', lineNo: 2, raw: 'two' }];
  const out = await collect(LT.serializeExport([b1, b2], { format: 'txt', prefix: 'file:line' }));
  assert.equal(out, 'a.log:1: one\na.log:2: two\n');
});

test('serializeExport csv emits exactly one header across batches', async () => {
  const b1 = [{ file: 'a.log', lineNo: 1, ts: 't', level: 'I', tag: 'T', pid: 5, msg: 'm,1' }];
  const b2 = [{ file: 'a.log', lineNo: 2, ts: '', level: '', tag: '', pid: '', msg: null, raw: 'raw row' }];
  const out = await collect(LT.serializeExport([b1, b2], { format: 'csv' }));
  const lines = out.replace(/\n$/, '').split('\n');
  assert.equal(lines[0], 'file,lineNo,ts,level,tag,pid,message');
  assert.equal(lines.length, 3, 'one header + two rows');
  assert.ok(lines[1].includes('"m,1"'), 'csv quoting applied');
  assert.ok(lines[2].endsWith('raw row'), 'msg null falls back to masked raw');
  // unknown format yields no chunks (defensive)
  const none = await collect(LT.serializeExport([b1], { format: 'yaml' }));
  assert.equal(none, '');
  // null/missing optional fields become empty CSV cells
  const sparse = await collect(LT.serializeExport([[{ file: 'a.log', lineNo: 3, ts: null, level: null, tag: null, pid: null, msg: null, raw: 'r' }]], { format: 'csv' }));
  assert.ok(sparse.startsWith('file,lineNo,ts,level,tag,pid,message'), 'sparse row still uses the header');
  assert.ok(sparse.includes(',,,,'), 'null optional columns render empty');
});

test('serializeExport and writeChunks default to txt/none without opts', async () => {
  const b1 = [{ file: 'a.log', lineNo: 1, raw: 'one' }];
  const out = await collect(LT.serializeExport([b1], undefined, 'none'));
  // serializeExport(batches) with no opts: format 'txt', prefix 'none'
  assert.equal(out, 'one\n');
});

test('serializeExport json emits valid JSON across batches and for zero rows', async () => {
  const b1 = [{ file: 'a', lineNo: 1, ts: null, level: 'I', tag: 'T', pid: 1, msg: 'x' }];
  const b2 = [{ file: 'a', lineNo: 2, ts: null, level: 'I', tag: 'T', pid: 1, msg: null, raw: 'raw two' }];
  const out = await collect(LT.serializeExport([b1], { format: 'json' }));
  assert.deepStrictEqual(JSON.parse(out), [{ file: 'a', lineNo: 1, ts: null, level: 'I', tag: 'T', pid: 1, message: 'x' }]);
  const out2 = await collect(LT.serializeExport([b1, b2], { format: 'json' }));
  const parsed = JSON.parse(out2);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].message, 'raw two', 'msg null falls back to masked raw');
  const empty = await collect(LT.serializeExport([], { format: 'json' }));
  assert.deepStrictEqual(JSON.parse(empty), []);
});

test('serializeExport txt applies prefixes and handles unknown formats', async () => {
  const b1 = [{ file: 'a.log', lineNo: 1, raw: 'one' }];
  const out = await collect(LT.serializeExport([b1], { format: 'txt', prefix: 'ln' }));
  assert.equal(out, '[L1] one\n');
  const csv = await collect(LT.serializeExport([[{ file: 'a', lineNo: 1, msg: 'm,1', raw: 'r' }]], { format: 'csv' }));
  assert.ok(csv.includes('"m,1"'), 'csv quoting applied');
});

test('writeChunks rejects when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  let abortedSink = 0;
  const sink = { async write() {}, async close() {}, async abort() { abortedSink++; } };
  await assert.rejects(() => LT.writeChunks((async function* () { yield Uint8Array.of(1); })(), sink, { signal: controller.signal }), /cancelled|abort/);
  assert.equal(abortedSink, 1);
});

test('writeChunks reports byte totals via onBytes', async () => {
  let reported = 0;
  const sink = { async write() {}, async close() {}, async abort() {} };
  async function* input() { yield Uint8Array.of(1, 2, 3); yield Uint8Array.of(4, 5); }
  const n = await LT.writeChunks(input(), sink, { onBytes: (total) => { reported = total; } });
  assert.equal(n, 5);
  assert.equal(reported, 5);
});

async function collect(iter) {
  const chunks = [];
  for await (const c of iter) chunks.push(c);
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}
