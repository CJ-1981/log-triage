'use strict';
/* Unit tests for the paging RPC wrapper's inline fallback. Safari on file://
 * either blocks Blob-URL workers or denies them Blob data reads, which used
 * to leave the viewer empty; the client must fall back to an in-page twin of
 * the worker. Loaded with a minimal window shim (the module is UI glue that
 * returns early under plain Node). */
const test = require('node:test');
const assert = require('node:assert/strict');

const WORKER_ECHO = 'self.onmessage = ({ data: m }) => self.postMessage({ id: m.id, echo: m.type });';
// minimal DOM-event surface so the watchdog's lt-worker-stall dispatch works
globalThis.window = {
  LT: {},
  _listeners: {},
  addEventListener(type, fn) { (this._listeners[type] || (this._listeners[type] = [])).push(fn); },
  dispatchEvent(e) { (this._listeners[e.type] || []).forEach((f) => f(e)); return true; },
};
globalThis.LT_PAGING_WORKER = WORKER_ECHO;
require('../src/app-paging.js');
const { PagingClient } = globalThis.window.LT;

test('falls back to the inline twin when Blob worker spawn throws', async () => {
  globalThis.Worker = undefined; // `new Worker` throws synchronously
  const client = new PagingClient();
  const res = await client.request('page', { start: 7 });
  assert.equal(res.echo, 'page');
});

test('falls back and replays pending when the worker fails before answering', async () => {
  globalThis.Worker = class {
    constructor() { setTimeout(() => this.onerror && this.onerror({ message: 'blocked load' }), 0); }
    postMessage() { /* never answers */ }
  };
  const client = new PagingClient();
  client.request('page', { start: 1 }); // queued on the dying worker
  const res = await client.request('query', {}); // races the error event
  assert.equal(res.echo, 'query');
});

test('worker error after a first answer still rejects pending requests', async () => {
  globalThis.Worker = class {
    constructor() { this.crashed = false; }
    postMessage(m) {
      setTimeout(() => {
        if (this.crashed) return this.onerror({ message: 'crash' });
        this.crashed = true;
        this.onmessage({ data: { id: m.id, echo: m.type } });
        this.onerror({ message: 'crash' });
      }, 0);
    }
  };
  const client = new PagingClient();
  const res = await client.request('page', {});
  assert.equal(res.echo, 'page');
  await assert.rejects(client.request('page', {}), /crash/);
});

test('retries on the inline twin when the worker cannot read Blob data', async () => {
  globalThis.Worker = class {
    postMessage(m) {
      // WebKit on file://: the worker boots but every Blob read fails
      setTimeout(() => this.onmessage({ data: { id: m.id, error: 'The I/O read operation failed.' } }), 0);
    }
  };
  const client = new PagingClient();
  const res = await client.request('index', { file: 'x' });
  assert.equal(res.echo, 'index'); // answered by the inline twin, not the worker
});

test('stale error responses from the abandoned worker are ignored', async () => {
  globalThis.Worker = class {
    postMessage(m) {
      setTimeout(() => {
        this.onmessage({ data: { id: m.id, error: 'The I/O read operation failed.' } });
        // late duplicate after the fallback switched away
        this.onmessage({ data: { id: m.id, error: 'The I/O read operation failed.' } });
      }, 0);
    }
  };
  const client = new PagingClient();
  const res = await client.request('index', {});
  assert.equal(res.echo, 'index');
});

test('once inlined, worker-style I/O errors reject instead of looping', async () => {
  globalThis.Worker = undefined; // start inlined
  globalThis.LT_PAGING_WORKER = 'self.onmessage = ({ data: m }) => self.postMessage({ id: m.id, error: "The I/O read operation failed." });';
  const client = new PagingClient();
  await assert.rejects(client.request('index', {}), /I\/O read/);
});

test('watchdog: total silence rejects pending, fails fast afterwards, and fires lt-worker-stall', async () => {
  globalThis.Worker = class { postMessage() { /* never answers, never errors */ } };
  const stalled = [];
  globalThis.window.addEventListener('lt-worker-stall', (e) => stalled.push(e.detail), { once: true });
  const client = new PagingClient(40);
  await assert.rejects(client.request('page', {}), /stopped responding/);
  assert.equal(stalled.length, 1, 'stall event fired exactly once');
  await assert.rejects(client.request('query', {}), /stopped responding/, 'post-stall requests fail fast instead of hanging');
  assert.equal(stalled.length, 1, 'no duplicate stall events');
});

test('watchdog: progress messages keep the timer alive through a long operation', async () => {
  globalThis.Worker = class {
    postMessage(m) {
      // three progress ticks 15ms apart (threshold 40ms), then the answer
      for (let i = 1; i <= 3; i++) setTimeout(() => this.onmessage({ data: { id: m.id, progress: 'Indexing… ' + i * 10 + '%' } }), 15 * i);
      setTimeout(() => this.onmessage({ data: { id: m.id, echo: m.type } }), 70);
    }
  };
  const client = new PagingClient(40);
  const res = await client.request('index', {});
  assert.equal(res.echo, 'index', 'healthy worker with steady progress never trips the watchdog');
});

test('watchdog: late responses after a stall are ignored and do not resurrect the client', async () => {
  globalThis.Worker = class {
    postMessage(m) { setTimeout(() => this.onmessage({ data: { id: m.id, echo: m.type } }), 120); }
  };
  const client = new PagingClient(40);
  await assert.rejects(client.request('page', {}), /stopped responding/);
  await new Promise((r) => setTimeout(r, 100)); // let the stale echo arrive
  await assert.rejects(client.request('query', {}), /stopped responding/, 'client stays dead after the stall');
});
