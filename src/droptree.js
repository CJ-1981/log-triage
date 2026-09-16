/* Log Triage — droptree.js: folder-recursive drag & drop.
 * A folder dropped from Explorer shows up in dataTransfer.files as a single
 * zero-byte pseudo-file; the contained files are only reachable through
 * DataTransferItem.webkitGetAsEntry(). This walks the entry tree (nested
 * folders included) and hands plain File objects — renamed to carry their
 * folder-relative path, so identically named logs from different folders
 * stay distinct in the file list, bookmarks and exports. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  async function collectFromDataTransfer(dt, opts) {
    const maxFiles = (opts && opts.maxFiles) || 2000;
    const maxDepth = (opts && opts.maxDepth) || 12;
    const files = [];
    const failed = [];         // { name, error, pathLen } — unreadable entries
    let skipped = 0;

    const pathLen = (entry) => (entry.fullPath ? String(entry.fullPath).length : 0);
    const asFile = (entry) => new Promise((res, rej) => entry.file(res, rej));
    // Entries must be captured synchronously during the drop event. Plain
    // files keep coming from dataTransfer.files — those File objects Chromium
    // can open even beyond the Windows 260-char MAX_PATH, while the entries
    // API's entry.file() throws NotFoundError there (regression guard). Only
    // DIRECTORIES need the entries walk; dataTransfer.files cannot see inside
    // them. Chromium orders dt.files 1:1 with the file-kind items, so each
    // item keeps its slot whether it is a folder or a loose file; when the
    // list has no slot for an item (synthetic drops), entry.file() is used.
    const items = dt.items ? Array.from(dt.items) : [];
    const allFiles = Array.from(dt.files || []);
    const dirs = [];
    const loose = [];          // promises resolving to File | null
    let listIdx = 0;
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const fromList = allFiles[listIdx] || null;
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry && entry.isDirectory) {
        dirs.push(entry);
        listIdx++;
        continue;
      }
      if (fromList) loose.push(Promise.resolve({ f: fromList }));
      else if (entry) loose.push(asFile(entry).then((f) => ({ f }), (err) => ({ err, name: entry.name })));
      else loose.push(Promise.resolve({}));
      listIdx++;
    }
    const looseSettled = await Promise.all(loose.map((p) => p.then((s) => s, (err) => ({ err }))));
    for (const s of looseSettled) {
      if (s && s.f) files.push(s.f);
      else if (s && s.err) failed.push({ name: s.name || '(dropped file)', error: s.err.message, pathLen: 0 });
      else failed.push({ name: '(dropped file)', error: 'the browser did not expose this file', pathLen: 0 });
    }
    if (!dirs.length) {
      // no folders anywhere in the drop: the direct File objects are the
      // whole story (and the only long-path-safe representation of them)
      return { files, failed, skipped: 0 };
    }

    const pushFile = async (entry, prefix) => {
      if (files.length >= maxFiles) { skipped++; return; }
      let file;
      try {
        file = await asFile(entry);
      } catch (err) {
        // Chromium cannot resolve file entries beyond the Windows 260-char
        // MAX_PATH (NotFoundError) — isolate the failure, keep the rest
        failed.push({ name: prefix + entry.name, error: err.message, pathLen: pathLen(entry) });
        return;
      }
      if (!prefix) { files.push(file); return; }
      try {
        files.push(new File([file], prefix + file.name, { type: file.type }));
      } catch (e) {
        files.push(file); // File constructor unavailable: keep the bare file
      }
    };
    const walk = async (entry, depth, prefix) => {
      if (entry.isFile) {
        await pushFile(entry, prefix);
        return;
      }
      if (!entry.isDirectory) return;
      if (depth >= maxDepth) { skipped++; return; }
      const nextPrefix = prefix + entry.name + '/';
      const reader = entry.createReader();
      for (;;) {
        let batch;
        try {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        } catch (err) {
          failed.push({ name: nextPrefix, error: err.message, pathLen: pathLen(entry) });
          return;
        }
        if (!batch.length) break;
        for (const child of batch) await walk(child, depth + 1, nextPrefix);
      }
    };
    for (const entry of dirs) {
      try {
        await walk(entry, 0, '');
      } catch (err) {
        failed.push({ name: entry.name, error: err.message, pathLen: pathLen(entry) });
      }
    }
    return { files, failed, skipped };
  }

  return { collectFromDataTransfer };
}));
