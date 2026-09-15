/* Browser RPC wrapper. A separate worker owns indexes, matching and raw page caches. */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  class PagingClient {
    constructor() {
      const url = URL.createObjectURL(new Blob([LT_PAGING_WORKER], { type: 'text/javascript' }));
      this.worker = new Worker(url); URL.revokeObjectURL(url);
      this.next = 0; this.pending = new Map();
      this.worker.onmessage = ({ data }) => { const p = this.pending.get(data.id); if (!p) return; if (data.progress != null) { if (p.progress) p.progress(data); return; } this.pending.delete(data.id); if (data.error) p.reject(new Error(data.error)); else p.resolve(data); };
      this.worker.onerror = (e) => { for (const p of this.pending.values()) p.reject(new Error(e.message || 'Paging worker failed')); this.pending.clear(); };
    }
    request(type, payload = {}, progress) { return new Promise((resolve, reject) => { const id = ++this.next; this.pending.set(id, { resolve, reject, progress }); this.worker.postMessage(Object.assign({ id, type }, payload)); }); }
  }
  window.LT.PagingClient = PagingClient;
}());
