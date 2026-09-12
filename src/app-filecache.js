/* Log Triage — app-filecache.js: IndexedDB cache of last loaded files.
 * Stores file contents so a session can be restored after reopening the app.
 * Entries without data render greyed out as "file not found". Browser-only
 * glue (exempt from the coverage gate); every call degrades gracefully when
 * IndexedDB is unavailable. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DB = 'log-triage-cache';
  const STORE = 'files';

  function openDb() {
    return new Promise((res, rej) => {
      if (typeof indexedDB === 'undefined') { rej(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'id' }); };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  function txDone(tx) {
    return new Promise((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error('transaction aborted'));
    });
  }

  /** cachePut(entry) -> true if stored (content cached), false on failure */
  async function cachePut(entry) {
    let db;
    try {
      db = await openDb();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(entry);
      await txDone(tx);
      return true;
    } catch {
      return false;
    } finally {
      if (db) db.close();
    }
  }

  /** cachePutMeta(entry) -> metadata-only entry (content could not be cached) */
  async function cachePutMeta(entry) {
    const meta = Object.assign({}, entry);
    delete meta.data;
    return cachePut(meta);
  }

  async function cacheGetAll() {
    let db;
    try {
      db = await openDb();
      const tx = db.transaction(STORE, 'readonly');
      const rq = tx.objectStore(STORE).getAll();
      const items = await new Promise((res, rej) => {
        rq.onsuccess = () => res(rq.result || []);
        rq.onerror = () => rej(rq.error);
      });
      return items;
    } catch {
      return [];
    } finally {
      if (db) db.close();
    }
  }

  async function cacheDelete(id) {
    let db;
    try {
      db = await openDb();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      await txDone(tx);
      return true;
    } catch {
      return false;
    } finally {
      if (db) db.close();
    }
  }

  async function cacheClear() {
    let db;
    try {
      db = await openDb();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      await txDone(tx);
      return true;
    } catch {
      return false;
    } finally {
      if (db) db.close();
    }
  }

  return { cachePut, cachePutMeta, cacheGetAll, cacheDelete, cacheClear };
}));
