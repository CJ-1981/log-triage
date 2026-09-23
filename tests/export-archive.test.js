'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const EA = require('../src/export-archive.js');
const LT = require('../src/archive.js');

const enc = (s) => new TextEncoder().encode(s);
const dec = (bytes) => new TextDecoder().decode(bytes);

// build entries whose content streams in TWO chunks per entry (exercises the
// streaming crc/size accounting) and counts factory invocations
function mkEntries(groups, counter) {
  return groups.map((g) => ({
    name: g.name,
    chunksFactory: async function* () {
      if (counter) counter.calls = (counter.calls || 0) + 1;
      const all = enc(g.lines.join('\n') + '\n');
      const mid = Math.max(1, all.length >> 1);
      yield all.subarray(0, mid);
      yield all.subarray(mid);
    },
  }));
}

async function collect(entries, format) {
  const chunks = [];
  await EA.streamArchive(entries, format, (b) => chunks.push(b), {});
  return concat(chunks);
}

function concat(chunks) {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

test('zip stream round-trips through the in-house zip reader', async () => {
  const groups = [
    { name: 'b.log', lines: ['alpha 1', 'vin YV4AB9CD12EF34567', 'gamma'] },
    { name: 'a.log', lines: ['x'.repeat(40)] },
  ];
  const bytes = await collect(mkEntries(groups), 'zip');
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'zip local header magic');
  const raw = await LT.extractArchive('x.zip', bytes, 0, () => {});
  const entries = raw.map((e) => ({ name: e.name.replace(/^[^/]+\//, ''), data: e.data }));
  const byName = new Map(entries.map((e) => [e.name, dec(e.data)]));
  assert.strictEqual(entries.length, 2, 'two entries extracted');
  assert.strictEqual(byName.get('b.log'), 'alpha 1\nvin YV4AB9CD12EF34567\ngamma\n');
  assert.strictEqual(byName.get('a.log'), 'x'.repeat(40) + '\n');
});

test('tar stream round-trips through parseTar', async () => {
  const groups = [{ name: 'only.log', lines: ['one', 'two three'] }];
  const bytes = await collect(mkEntries(groups), 'tar');
  const entries = LT.parseTar(bytes);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(dec(entries[0].data), 'one\ntwo three\n');
});

test('tar.gz stream round-trips through gunzipData + parseTar', async () => {
  const groups = [{ name: 'n.log', lines: ['gzip me', 'twice'] }];
  const bytes = await collect(mkEntries(groups), 'tar.gz');
  assert.deepEqual([...bytes.subarray(0, 2)], [0x1f, 0x8b], 'gzip magic');
  const tar = await LT.gunzipData(bytes);
  const entries = LT.parseTar(tar);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(dec(entries[0].data), 'gzip me\ntwice\n');
});

test('zip streams single-pass, tar needs the two-pass factory', async () => {
  const counter = { calls: 0 };
  const groups = [{ name: 'a.log', lines: ['a'] }, { name: 'b.log', lines: ['b'] }];
  await collect(mkEntries(groups, counter), 'zip');
  assert.strictEqual(counter.calls, 2, 'zip: one factory run per entry');
  counter.calls = 0;
  await collect(mkEntries(groups, counter), 'tar');
  assert.strictEqual(counter.calls, 4, 'tar: two factory runs per entry (size pass + write pass)');
});

test('streamArchive honors cancellation and propagates write errors', async () => {
  const groups = [{ name: 'a.log', lines: ['data'] }];
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    EA.streamArchive(mkEntries(groups), 'zip', () => Promise.resolve(), { signal: ac.signal }),
    /cancelled/,
  );
  await assert.rejects(
    EA.streamArchive(mkEntries(groups), 'zip', () => Promise.reject(new Error('disk full')), {}),
    /disk full/,
  );
  await assert.rejects(EA.streamArchive(mkEntries(groups), '7z', () => {}, {}), /not streamable/);
});
