/* Browser RPC wrapper. A separate worker owns indexes, matching and raw page caches. */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  /* Safari on file:// pages refuses Blob-URL workers (opaque origin), in one
   * of two ways: the worker load is blocked outright, or the worker boots but
   * every Blob data read inside it fails ("The I/O read operation failed."),
   * dead-ending ingestion with an empty viewer. The worker bundle ships
   * inlined in the page anyway (LT_PAGING_WORKER), so run that identical
   * code against a stub worker scope on the main thread instead — the main
   * thread can read the same in-memory Files on that origin. */
  class InlineWorker {
    constructor(source) {
      const scope = { onmessage: null };
      scope.postMessage = (data) => { setTimeout(() => { if (this.onmessage) this.onmessage({ data }); }, 0); };
      // Appended so the worker script's bare LT references bind to the stub
      // scope once its bundled UMD modules have registered there.
      this.scope = scope;
      new Function('self', source + '\n;var LT = self.LT;')(scope);
    }
    postMessage(data) { setTimeout(() => { if (this.scope.onmessage) this.scope.onmessage({ data }); }, 0); }
  }

  class PagingClient {
    constructor() {
      this.next = 0; this.pending = new Map();
      this.worker = this.spawnWorker();
    }
    spawnWorker() {
      let worker;
      try {
        const url = URL.createObjectURL(new Blob([LT_PAGING_WORKER], { type: 'text/javascript' }));
        worker = new Worker(url); URL.revokeObjectURL(url);
      } catch (e) { return this.useInlineWorker(); }
      // An error before the first response means the worker never booted —
      // switch to the inline twin; afterwards a worker error just fails the
      // in-flight requests (previous behavior).
      let answered = false;
      worker.onmessage = ({ data }) => { answered = true; this.onMessage(data); };
      worker.onerror = (e) => {
        if (this.worker !== worker) return;
        if (!answered) { this.worker = this.useInlineWorker(); return; }
        for (const p of this.pending.values()) p.reject(new Error(e.message || 'Paging worker failed'));
        this.pending.clear();
      };
      return worker;
    }
    useInlineWorker() {
      if (!this.inline) {
        this.inline = new InlineWorker(LT_PAGING_WORKER);
        this.inline.onmessage = ({ data }) => this.onMessage(data);
      }
      // Re-request everything pending on the worker we gave up on under
      // fresh ids, so stale responses from the old worker find no pending
      // entry and are ignored instead of rejecting live requests.
      for (const p of Array.from(this.pending.values())) {
        this.pending.delete(p.payload.id);
        p.payload = Object.assign({}, p.payload, { id: ++this.next });
        this.pending.set(p.payload.id, p);
        this.inline.postMessage(p.payload);
      }
      return this.inline;
    }
    onMessage(data) {
      const p = this.pending.get(data.id); if (!p) return;
      if (data.progress != null) { if (p.progress) p.progress(data); return; }
      this.pending.delete(data.id);
      if (data.error) {
        // Worker booted but cannot read Blob data (WebKit on file://): retry
        // on the inline twin once, then surface further errors as before.
        if (!this.inline && /i\/o read/i.test(data.error)) {
          this.pending.set(data.id, p);
          this.worker = this.useInlineWorker();
          return;
        }
        p.reject(new Error(data.error));
      } else p.resolve(data);
    }
    request(type, payload = {}, progress) {
      return new Promise((resolve, reject) => {
        const id = ++this.next;
        const entry = { resolve, reject, progress, payload: Object.assign({ id, type }, payload) };
        this.pending.set(id, entry);
        this.worker.postMessage(entry.payload);
      });
    }
  }
  window.LT.PagingClient = PagingClient;
}());
