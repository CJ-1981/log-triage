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
    // @MX:NOTE: stallMs is a SILENCE threshold, not a duration cap — every
    // worker message for a request (progress included) resets its timer, and
    // all long operations emit throttled progress at <=60ms, so multi-GB
    // indexing never trips it. It fires only when the worker died without an
    // error event (browser OOM kill, a never-settling await inside the
    // worker), which used to hang every page load until a manual refresh.
    constructor(stallMs) {
      this.next = 0; this.pending = new Map();
      this.stallMs = stallMs || 30000;
      this.dead = false; // a stall was detected; requests fail fast with guidance
      this.worker = this.spawnWorker();
    }
    arm(p) {
      p.timer = setTimeout(() => this.onStall(), this.stallMs);
    }
    onStall() {
      if (this.dead || !this.pending.size) return;
      this.dead = true;
      // Terminate frees the (likely gigabyte-scale) worker heap; the indexes
      // it held are unrecoverable — a respawned worker has no sources, so
      // replaying view requests there would return silently empty pages.
      // Fail-fast with guidance instead, and let the page surface the notice.
      try { if (this.worker.terminate) this.worker.terminate(); } catch (e) { /* already gone */ }
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('viewer worker stopped responding — reload the page to recover'));
      }
      this.pending.clear();
      window.dispatchEvent(new CustomEvent('lt-worker-stall', { detail: { silentMs: this.stallMs } }));
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
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(e.message || 'Paging worker failed')); }
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
        clearTimeout(p.timer);
        this.pending.delete(p.payload.id);
        p.payload = Object.assign({}, p.payload, { id: ++this.next });
        this.pending.set(p.payload.id, p);
        this.arm(p);
        this.inline.postMessage(p.payload);
      }
      return this.inline;
    }
    onMessage(data) {
      const p = this.pending.get(data.id); if (!p) return;
      if (data.progress != null) { if (p.progress) p.progress(data); clearTimeout(p.timer); this.arm(p); return; }
      this.pending.delete(data.id);
      clearTimeout(p.timer);
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
        if (this.dead) return reject(new Error('viewer worker stopped responding — reload the page to recover'));
        const id = ++this.next;
        const entry = { resolve, reject, progress, payload: Object.assign({ id, type }, payload) };
        this.pending.set(id, entry);
        this.arm(entry);
        this.worker.postMessage(entry.payload);
      });
    }
  }
  window.LT.PagingClient = PagingClient;
}());
