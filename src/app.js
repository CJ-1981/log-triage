/* Log Triage — app.js: browser UI glue (virtualized viewer, streaming
 * ingestion, deep scan, panels). Pure logic lives in the other src modules;
 * this file is UI wiring and is exempt from the coverage gate. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const LT = typeof self !== 'undefined' ? self.LT : {};
  if (typeof document === 'undefined') return {}; // Node: skip UI wiring

  /* ---------------- state ---------------- */
  const STATE_KEY = 'log_triage_state_v1';
  const defaults = () => ({
    theme: LT.DEFAULT_THEME || 'midnight',
    maskOn: true, wrapOn: false, follow: false, viewMode: 'merged', activeFile: null, drawerOn: true,
    quick: '', rules: [], customMasks: [], maskEnabled: {}, presets: {},
    timeFrom: '', timeTo: '', sideHidden: false, showOnlyBookmarked: false, bmPanelH: 200, issueGroups: null,
    cap: 100000,
    pii: {
      active: 'local',
      presidio: { url: 'http://127.0.0.1:3000', path: '/analyze', language: 'en', threshold: 0.5, entities: '', timeoutMs: 10000 },
      llm: { url: '', apiKey: '', model: '', promptTemplate: 'Return a JSON array of PII findings [{line, start, end, type, score}] for these lines:\n{lines}', maxLines: 50, temperature: 0, timeoutMs: 30000 },
      proxy: { enabled: false, url: '' },
    },
    bookmarks: null, levels: [], rg: { fixed: false, word: false, invert: false, caseMode: 'smart', before: 0, after: 0 },
    srWrapOn: true, searchHistory: [], quickHistory: [],
  });
  let state = defaults();

  function saveState() {
    try {
      // transient view state (quick filter, level chips, time range, search
      // pattern) is deliberately NOT persisted: a new session must start
      // unfiltered, or freshly loaded files can appear invisible
      const { quick, levels, timeFrom, timeTo, rgPattern, showOnlyBookmarked, zenOn, ...persisted } = state;
      const s = Object.assign({}, persisted, { bookmarks: bookmarksStore.toJSON() });
      localStorage.setItem(STATE_KEY, JSON.stringify(s));
    } catch (e) { /* storage may be unavailable on file:// in some browsers */ }
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (raw) state = Object.assign(defaults(), JSON.parse(raw));
    } catch (e) { /* keep defaults */ }
  }

  /* ---------------- engines ---------------- */
  if (!LT.getProvider('local-regex')) LT.makeLocalRegexProvider(LT.buildBuiltinMaskRules);
  const engine = new LT.MaskEngine();                 // masking
  const filter = new LT.FilterEngine();               // filtering
  const store = new LT.Store(100000);                 // kept lines (cap configurable via presets? default 100k)
  const tally = store.tally;
  const selection = new LT.SelectionModel();
  const bookmarksStore = new LT.BookmarkStore();
  const files = [];                                   // {id, name, size, file, format, done}
  let cacheEntries = [];                              // restored entries from previous sessions (IDB)
  let displayCache = new Map();                       // seq -> rendered text (masked or raw)
  let compiledHighlights = [];
  const HIGHLIGHT_PALETTE = [
    ['Yellow', '#ffd166'], ['Orange', '#ff9f1c'], ['Red', '#ff6b6b'], ['Pink', '#f472b6'],
    ['Purple', '#c084fc'], ['Blue', '#60a5fa'], ['Cyan', '#22d3ee'], ['Green', '#4ade80'],
  ];

  const $ = (id) => document.getElementById(id);
  const esc = LT.escapeHtml;

  function normalizeRule(rule) {
    const r = Object.assign({ name: 'rule', pattern: '', caseSensitive: false, action: 'include', enabled: true }, rule || {});
    if (r.action === 'highlight') {
      if (r.matchMode !== 'literal') r.matchMode = 'regex';
      if (r.target !== 'row') r.target = 'text';
      r.color = LT.normalizeColor(r.color);
    }
    return r;
  }

  function refreshHighlights() {
    compiledHighlights = LT.compileHighlightRules(state.rules.map((r, i) => Object.assign({ id: 'r' + i }, r)));
  }

  /* ---------------- ingestion ---------------- */
  const VALVE = 8 * 1024 * 1024;
  let ingestAbort = false;
  const paging = new LT.PagingClient();
  const PAGE_SIZE = 500;
  let pageStart = 0, viewToken = 0, pageToken = 0, busyToken = 0, loadSerial = Promise.resolve();
  function busy(message) { const token = ++busyToken; $('viewer-busy').classList.add('active'); $('viewer-busy-text').textContent = message; $('st-progress').textContent = message; $('viewer').setAttribute('aria-busy', 'true'); return token; }
  function busyMessage(token, message) { if (token === busyToken) { $('viewer-busy-text').textContent = message; $('st-progress').textContent = message; } }
  function doneBusy(token) { if (token === busyToken) { $('viewer-busy').classList.remove('active'); $('viewer-busy-text').textContent = ''; $('st-progress').textContent = ''; $('viewer').setAttribute('aria-busy', 'false'); } }
  function pagingError(error) { flash(error.message || String(error)); }
  function updatePager() {
    const pages = Math.max(1, Math.ceil(filteredCount / PAGE_SIZE));
    $('page-number').value = Math.floor(pageStart / PAGE_SIZE) + 1;
    $('page-count').textContent = 'of ' + pages.toLocaleString();
    $('page-range').textContent = filteredCount ? (pageStart + 1).toLocaleString() + '–' + Math.min(filteredCount, pageStart + PAGE_SIZE).toLocaleString() + ' of ' + filteredCount.toLocaleString() + ' matching lines' : 'No matching lines';
    $('page-first').disabled = $('page-prev').disabled = pageStart === 0;
    $('page-next').disabled = $('page-last').disabled = pageStart + PAGE_SIZE >= filteredCount;
  }
  async function loadPage(start, bottom = false, owner) {
    const token = ++pageToken, query = viewToken, bt = owner || busy('Loading page…');
    try {
      const result = await paging.request('page', { start: Math.max(0, start), size: PAGE_SIZE });
      if (token !== pageToken || query !== viewToken) return false;
      view = result.rows; pageStart = result.start; filteredCount = result.total;
      seqToIdx = new Map(view.map((r, i) => [r.seq, i]));
      viewMaxLen = Math.min(2000, Math.max(0, ...view.map((r) => r.raw.length)));
      displayCache.clear(); selection.clear(); invalidateHeights();
      viewer().scrollTop = 0; renderRows();
      if (bottom) { viewer().scrollTop = viewer().scrollHeight; renderRows(); }
      updateStatus(); updatePager(); return true;
    } catch (error) { if (token === pageToken) pagingError(error); return false; }
    finally { doneBusy(bt); }
  }

  const EXPORT_BATCH = 2000;
  /** Yields MASKED page batches covering every matching line of the current
   * view (selection-only yields exactly one batch). Consumers convert each
   * batch immediately and drop the rows — the full dataset is never held in
   * memory, matching the multi-GB export target. */
  async function* iterExportBatches(selectionOnly, selectionIndices, opts) {
    const o = opts || {};
    const signal = o.signal || null;
    const expectedRevision = o.expectedRevision;
    const checkStale = () => {
      if (expectedRevision != null && expectedRevision !== lastQueryRevision) {
        const err = new Error('the export scope changed during export — retry');
        err.stale = true; throw err;
      }
    };
    const eng = new LT.MaskEngine();
    for (const id of LT.builtinRuleIds()) eng.setEnabled(id, state.maskEnabled[id] !== false);
    eng.custom = [];
    for (const c of state.customMasks) eng.addCustom(c);
    const maskRec = (r) => Object.assign({}, r, {
      raw: state.maskOn ? eng.maskLine(r.raw) : r.raw,
      // msg is the parsed message column CSV/JSON export; mask it too or the
      // original text leaks even with masking on
      msg: r.msg != null ? (state.maskOn ? eng.maskLine(r.msg) : r.msg) : null,
    });
    const bt = busy('Preparing export…');
    try {
      if (selectionOnly) {
        // selection-only means EXACTLY the selected rows - an empty selection
        // yields no batches, never the whole view (review Task 1)
        const selected = (selectionIndices || []).filter((idx) => view[idx]).map((idx) => maskRec(view[idx]));
        if (selected.length) yield selected;
        return;
      }
      for (let start = 0; ; start += EXPORT_BATCH) {
        signal?.throwIfAborted();
        const part = await paging.request('page', { start, size: EXPORT_BATCH, expectedRevision });
        if (part.stale) { const err = new Error('the export scope changed during export'); err.stale = true; throw err; }
        if (!part.rows.length) break;
        busyMessage(bt, 'Exporting… ' + Math.min(100, Math.round(((start + part.rows.length) / Math.max(1, part.total)) * 100)) + '%');
        yield part.rows.map(maskRec);
        if (start + part.rows.length >= part.total) break;
      }
    } finally { doneBusy(bt); }
  }
  function makeExportMasker() {
    const eng = new LT.MaskEngine();
    for (const id of LT.builtinRuleIds()) eng.setEnabled(id, state.maskEnabled[id] !== false);
    eng.custom = [];
    for (const c of state.customMasks) eng.addCustom(c);
    return eng;
  }

  async function* chunkIter(file) {
    // Prefer File.stream(); some Windows locations+names (e.g. Downloads
    // folders with spaces/parens/@) either reject the first read with
    // 'TypeError: network error' or falsely report an empty stream — in both
    // cases fall back to the FileReader chunked path. A stream that ends
    // mid-file after having delivered bytes throws a readable error.
    const FR = window.FileReader || self.FileReader;
    let reader = null;
    let broken = false;
    let first = null;
    try {
      if (file.stream) reader = file.stream().getReader();
      if (reader) {
        first = await reader.read();
        if (first.done && file.size > 0) broken = true; // lying empty stream
      }
    } catch (e) { broken = true; }
    if (reader && !broken) {
      if (!first.done) yield first.value;
      let streamed = first.value ? first.value.length : 0;
      for (;;) {
        let r;
        try { r = await reader.read(); }
        catch (e) { throw new Error('the file could not be read completely — it may have changed on disk while being read'); }
        if (r.done) {
          if (streamed < file.size) throw new Error('the file read ended prematurely (' + streamed + ' of ' + file.size + ' bytes)');
          return;
        }
        streamed += r.value.length;
        yield r.value;
      }
    }
    // FileReader fallback: reads the whole file from position 0
    for (let pos = 0; pos < file.size; pos += VALVE) {
      const slice = file.slice(pos, Math.min(file.size, pos + VALVE));
      yield await new Promise((res, rej) => {
        const fr = new FR();
        fr.onload = () => res(new Uint8Array(fr.result));
        fr.onerror = () => rej(fr.error);
        fr.readAsArrayBuffer(slice);
      });
    }
  }

  async function* streamLines(file, onBytes) {
    const dec = new TextDecoder('utf-8');
    let buf = '';
    for await (const chunk of chunkIter(file)) {
      if (onBytes) onBytes(chunk.length);
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        yield buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
      }
      if (buf.length > VALVE) { yield buf; buf = ''; } // newline valve
    }
    buf += dec.decode();
    if (buf) yield buf.replace(/\r$/, '');
  }

  async function ingestFile(entry) {
    const bt = busy('Indexing ' + entry.name + '…');
    store.setFileInfo(entry.id, entry.name, entry.size);
    try {
      const result = await paging.request('index', { fileId: entry.id, file: entry.file, sampleLimit: Math.min(100000, state.cap || 100000) }, (p) => { entry.read = p.bytes || entry.read; busyMessage(bt, p.progress); });
      if (ingestAbort || !files.includes(entry)) return;
      entry.format = result.format; entry.lines = result.count; entry.firstLine = result.firstLine; entry.read = entry.size; entry.status = 'done';
      const f = store._files[entry.id];
      Object.assign(f, { total: result.count, kept: result.count, dropped: 0, bytes: entry.size, levelCounts: result.counts });
      store._keptTotal += result.count;
      for (const [level, count] of Object.entries(result.counts)) { const key = level === 'null' ? '__' : level; tally._counts[key] = (tally._counts[key] || 0) + count; }
      // Analysis uses a labeled bounded sample; the viewer uses the full index.
      store.kept.push(...result.sample.slice(0, 2000));
      for (let i = 2000; i < result.sample.length; i += 2000) store.kept.push(...result.sample.slice(i, i + 2000));
    } finally { doneBusy(bt); }
  }

  function tick() {
    // MessageChannel yield: hands control back to the event loop without the
    // timer clamping that hidden/background tabs apply to setTimeout().
    return new Promise((r) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { ch.port1.close(); r(); };
      ch.port2.postMessage(0);
    });
  }

  function loadFiles(fileList) { const pending = loadSerial.then(() => ingestFiles(fileList)); loadSerial = pending.catch(pagingError); return pending; }
  async function handleDrop(dt) {
    // dropped folders are walked recursively (src/droptree.js); the contained
    // files keep their folder-relative path in the file list. Unreadable
    // entries (typically Windows >260-char paths, which Chromium's entry
    // resolution cannot open even with LongPathsEnabled) are isolated and
    // reported instead of aborting the whole drop.
    if (!dt) return;
    try {
      const { files, failed, skipped } = await LT.collectFromDataTransfer(dt, { maxFiles: 2000 });
      if (files.length) loadFiles(files);
      const notes = [];
      if (skipped) notes.push(skipped + ' dropped item(s) skipped (file limit)');
      if (failed.length) {
        const shown = failed.slice(0, 3).map((f) => f.name.split('/').pop() || f.name);
        let why = failed[0].error;
        if (failed.some((f) => (f.pathLen || 0) > 250) || /could not be found|not found/i.test(failed.map((f) => f.error).join(' '))) {
          why = 'path likely exceeds the Windows 260-character limit — copy the folder to a short path (e.g. C:\\Temp\\logs) and drop it again';
        }
        notes.push(failed.length + ' file(s) could not be read (' + shown.join(', ') + (failed.length > 3 ? ', …' : '') + '): ' + why);
      }
      if (notes.length) {
        flash(notes.join(' · '), failed.length ? 15000 : 4000);
      } else if (!files.length) {
        flash('nothing loadable in the drop — the files could not be read (the path may exceed the Windows 260-character limit)', 15000);
      }
    } catch (err) {
      flash('drop failed: ' + err.message);
    }
  }
  async function ingestFiles(fileList) {
    ingestAbort = false;
    // a fresh load shows everything: drop any stale per-file selection
    state.activeFile = null;
    saveState();
    let i = 0;
    for (const f of fileList) {
      const arType = LT.detectArchiveType(f.name);
      if (arType) {
        // archive: decompress recursively, load inner files
        const ap = $('archive-progress');
        ap.classList.add('visible');
        $('archive-progress-msg').textContent = 'extracting ' + f.name + '…';
        let innerFiles = null;
        try {
          const buf = new Uint8Array(await f.arrayBuffer());
          const innerEntries = await LT.extractArchive(f.name, buf, 0, (msg) => {
            $('archive-progress-msg').textContent = msg;
          });
          innerFiles = innerEntries.map((e) => new File([e.data], e.name, { type: 'text/plain' }));
        } catch (err) {
          flash('archive extraction failed: ' + err.message);
        } finally {
          // never leave the full-screen progress overlay up after a failure
          ap.classList.remove('visible');
        }
        if (innerFiles) await ingestFiles(innerFiles);
        continue;
      }
      const entry = { id: 'f' + Date.now() + '_' + (i++) + '_' + Math.floor(Math.random() * 1e6), name: f.name, size: f.size, file: f, status: 'parsing', format: '…', read: 0 };
      files.push(entry);
      renderFiles();
      try {
        await ingestFile(entry);
      } catch (err) {
        entry.status = 'error';
        flash('could not read ' + f.name + ': ' + err.message);
      }
      // in per-file mode a freshly loaded file becomes the displayed one, so
      // new content is never hidden behind another file's view — select it
      // BEFORE the rebuild so the query and the panel highlight agree
      if (entry.status === 'done' && state.viewMode === 'file') { state.activeFile = entry.id; $('view-mode').value = 'file'; }
      renderFiles();
      await onKeptChanged();
      if (entry.status === 'done') await cacheLoadedFile(entry, f);
      if (ingestAbort) break;
    }
    // a 0-byte file that was handed to us readable-looking (drag & drop from
    // a >260-char Windows path does exactly this) indexes to nothing — warn
    // instead of silently showing an empty entry
    const empty = files.filter((f) => f.status === 'done' && f.size === 0 && !f.lines);
    if (empty.length) {
      flash(empty.length + ' loaded file(s) contain 0 lines (' + empty.slice(0, 3).map((f) => f.name).join(', ') + (empty.length > 3 ? ', …' : '') + ') — the file(s) may be unreadable (e.g. the Windows 260-character path limit): copy them to a short path and try again', 15000);
    }
    saveState();
  }

  async function cacheLoadedFile(entry, f) {
    // retire superseded cache entries (same name and size)
    const sup = cacheEntries.filter((c) => c.name === f.name && c.size === f.size);
    for (const c of sup) await LT.cacheDelete(c.id);
    cacheEntries = cacheEntries.filter((c) => !sup.includes(c));
    const ok = await LT.cachePut({ id: 'cache_' + Date.now() + '_' + Math.floor(Math.random() * 1e6), name: f.name, size: f.size, format: f.format, ts: Date.now(), data: f });
    entry.cached = ok;
  }

  /* ---------------- rendering: files ---------------- */
  /** restore the list of last loaded files from the local cache (IDB) */
  async function restoreCache() {
    const entries = await LT.cacheGetAll();
    entries.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    if (!entries.length) return;
    cacheEntries = entries;
    renderFiles();
  }

  let fileFilterText = '';  // transient: name filter for the files panel
  let fileSortMode = 'default'; // transient: default | name | name-desc | size(-desc) | lines(-desc)
  function renderFiles() {
    const el = $('file-list');
    el.innerHTML = '';
    // the Reload button appears only while restorable cached files exist
    $('reload-cached').classList.toggle('hidden', pendingCachedEntries().length === 0);
    const q = fileFilterText.trim().toLowerCase();
    const matchQ = (name) => !q || String(name).toLowerCase().includes(q);
    const stats = store.stats().files;
    const cmp = (a, b) => {
      switch (fileSortMode) {
        case 'name': return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        case 'name-desc': return b.name.toLowerCase().localeCompare(a.name.toLowerCase());
        case 'size': return (a.size || 0) - (b.size || 0);
        case 'size-desc': return (b.size || 0) - (a.size || 0);
        case 'lines': return ((stats[a.id] || {}).total || 0) - ((stats[b.id] || {}).total || 0);
        case 'lines-desc': return ((stats[b.id] || {}).total || 0) - ((stats[a.id] || {}).total || 0);
        default: return 0;
      }
    };
    const live = files.filter((f) => matchQ(f.name)).sort(cmp);
    // merged timeline shows every loaded file, so highlight them all;
    // per-file mode highlights only the file actually on screen
    const mergedView = state.viewMode !== 'file' || !state.activeFile;
    for (const f of live) {
      const st = stats[f.id] || { total: 0, kept: 0 };
      const div = document.createElement('div');
      div.className = 'file-item' + (mergedView || state.activeFile === f.id ? ' active' : '');
      div.innerHTML = '<button class="fx" data-remove="' + esc(f.id) + '" title="remove this file">✕</button>' +
        '<div class="fname">' + esc(f.name) + '</div>' +
        '<div class="fmeta"><span class="badge fmt">' + esc(f.format) + '</span>' +
        '<span>' + LT.fmtBytes(f.size) + '</span><span>' + st.total + ' lines</span>' +
        '<span>' + st.kept + ' kept</span></div>';
      div.onclick = (e) => {
        if (e.target.dataset && e.target.dataset.remove !== undefined) {
          removeFileById(e.target.dataset.remove);
          return;
        }
        state.activeFile = state.activeFile === f.id ? null : f.id;
        state.viewMode = state.activeFile ? 'file' : 'merged';
        const sel = $('view-mode');
        if (sel) sel.value = state.viewMode;
        saveState(); renderFiles(); rebuildView();
      };
      el.appendChild(div);
    }
    // cached entries from previous sessions
    const cached = cacheEntries
      .filter((c) => !files.some((f) => f.name === c.name && f.size === c.size)) // superseded by a live load
      .filter((c) => matchQ(c.name))
      .sort(cmp);
    for (const c of cached) {
      const div = document.createElement('div');
      const fx = document.createElement('button');
      fx.className = 'fx'; fx.textContent = '✕'; fx.title = 'remove from cache';
      fx.onclick = (e) => { e.stopPropagation(); removeFileById(c.id); };
      div.appendChild(fx);
      if (c.data) {
        div.className = 'file-item cached';
        div.title = 'cached — click to load';
        div.insertAdjacentHTML('beforeend', '<div class="fname">' + esc(c.name) + '</div>' +
          '<div class="fmeta"><span class="badge fmt">' + esc(c.format || '—') + '</span>' +
          '<span>' + LT.fmtBytes(c.size) + '</span><span>cached — click to load</span></div>');
        div.onclick = () => loadCachedFile(c);
      } else {
        div.className = 'file-item missing';
        div.title = 'this file could not be restored';
        div.insertAdjacentHTML('beforeend', '<div class="fname muted">' + esc(c.name) + '</div>' +
          '<div class="fmeta"><span class="badge miss">file not found</span>' +
          '<span>' + LT.fmtBytes(c.size) + '</span></div>');
      }
      el.appendChild(div);
    }
    if (!live.length && !cached.length && q) {
      el.insertAdjacentHTML('beforeend', '<div class="muted" style="padding:8px 10px">no files match the filter</div>');
    }
  }

  async function loadCachedFile(c) {
    if (!c.data) { flash('file not found: ' + c.name); return; }
    await loadFiles([new File([c.data], c.name, { type: 'text/plain' })]);
  }

  /** Cached entries from previous sessions that are not loaded right now. */
  function pendingCachedEntries() {
    return cacheEntries.filter((c) => c.data && !files.some((f) => f.name === c.name && f.size === c.size));
  }
  /** One click restores every cached file instead of clicking each entry. */
  async function reloadAllCached() {
    const pending = pendingCachedEntries();
    if (!pending.length) return;
    await loadFiles(pending.map((c) => new File([c.data], c.name, { type: 'text/plain' })));
  }

  function removeFileById(id) {
    if (cacheEntries.some((c) => c.id === id)) {
      cacheEntries = cacheEntries.filter((c) => c.id !== id);
      LT.cacheDelete(id);
      renderFiles(); saveState();
      return;
    }
    const idx = files.findIndex((f) => f.id === id);
    if (idx < 0) return;
    const f = files[idx];
    const keyPrefix = f.name + '|' + f.size + '|';
    files.splice(idx, 1);
    paging.request('remove', { fileId: id }).catch(pagingError);
    store._keptTotal -= Math.max(0, (store._files[id]?.total || 0) - store.kept.filter((r) => r.fileId === id).length);
    store.removeFile(id);
    bookmarksStore.removeByKeyPrefix(keyPrefix); // removed file: drop its bookmarks too
    if (state.activeFile === id) { state.activeFile = null; state.viewMode = 'merged'; }
    const matches = cacheEntries.filter((c) => c.name === f.name && c.size === f.size);
    for (const c of matches) LT.cacheDelete(c.id);
    cacheEntries = cacheEntries.filter((c) => !matches.includes(c));
    displayCache = new Map();
    onKeptChanged(); renderBookmarks(); renderFiles(); saveState();
  }

  /* ---------------- view model ---------------- */
  /** Most-recent-first term history: case-insensitive dedupe, capped at 20. */
  function pushTerm(list, term) {
    const t = String(term || '').trim();
    if (!t) return list;
    return [t].concat(list.filter((x) => x.toLowerCase() !== t.toLowerCase())).slice(0, 20);
  }
  /** Dropdown of previously used terms under a text input. Picking an entry
   * fills the input and fires its normal 'input' handling (debounced). */
  function attachHistory(input, key) {
    let dd = null, items = [], active = -1;
    const close = () => {
      if (dd) { dd.remove(); dd = null; }
      items = []; active = -1;
      input.removeEventListener('keydown', navKey, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
    const render = () => {
      close();
      const term = input.value.trim().toLowerCase();
      items = (state[key] || []).filter((h) => !term || h.toLowerCase().includes(term)).slice(0, 12);
      if (!items.length) return;
      dd = document.createElement('div');
      dd.className = 'history-dd';
      dd.innerHTML = items.map((h, i) => '<div class="history-item' + (i === 0 ? ' active' : '') + '" data-i="' + i + '">' + esc(h) + '</div>').join('');
      active = 0;
      dd.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep input focus: blur-close must not win
        const item = e.target.closest('.history-item');
        if (item) pick(Number(item.dataset.i));
      });
      document.body.appendChild(dd);
      const r = input.getBoundingClientRect();
      dd.style.left = r.left + 'px';
      dd.style.top = (r.bottom + 2) + 'px';
      dd.style.width = Math.max(r.width, 220) + 'px';
      input.addEventListener('keydown', navKey, true);
      window.addEventListener('scroll', close, true);
      window.addEventListener('resize', close);
    };
    const pick = (i) => {
      if (i < 0 || i >= items.length) return;
      input.value = items[i];
      close();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const navKey = (e) => {
      if (!dd) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = e.key === 'ArrowDown' ? Math.min(items.length - 1, active + 1) : Math.max(0, active - 1);
        Array.from(dd.children).forEach((c, i) => c.classList.toggle('active', i === active));
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault(); e.stopPropagation();
        pick(active);
      } else if (e.key === 'Escape') {
        close();
      }
    };
    input.addEventListener('focus', render);
    input.addEventListener('input', render);
    input.addEventListener('blur', () => setTimeout(close, 120));
  }

  let view = [];            // current visible records
  let exportLock = false;   // blocks mutating UI while an export streams
  let exportAbort = null;   // AbortController.abort() for the running export
  let exportAbortController = null; // controller visible to archive export
  let lastQueryRevision = 0; // worker order revision at the last rebuild
  let seqToIdx = new Map();
  let filteredCount = 0;
  let viewMaxLen = 0;       // longest raw line length in the view (chars)
  let charW = 0;            // measured monospace character width (px)

  async function onKeptChanged() {
    bmKeyCache.clear(); filterQuickInit();
    await rebuildView(); renderChips(); updateStatus();
  }

  async function rebuildView() {
    const token = ++viewToken; ++pageToken;
    const bt = busy('Filtering all indexed lines…');
    if (state.activeFile && !files.some((f) => f.id === state.activeFile)) { state.activeFile = null; state.viewMode = 'merged'; $('view-mode').value = 'merged'; }
    // invariant: 'file' mode always displays exactly one file; a restored
    // session may carry viewMode=file with no active file — pick the first
    if (state.viewMode === 'file' && !state.activeFile && files.length) { state.activeFile = files[0].id; $('view-mode').value = 'file'; }
    const spec = {
      fileId: state.viewMode === 'file' ? state.activeFile : null,
      rules: filter.rules, quick: filter.quick, levels: filter.levels,
      timeFrom: filter.timeFrom, timeTo: filter.timeTo,
      bookmarkOnly: state.showOnlyBookmarked,
      bookmarks: files.map((f) => [f.id, bookmarksStore.list(bookmarkKeyFor(f.id)).map((b) => b.lineNo)]),
    };
    try {
      const result = await paging.request('query', { spec }, (p) => busyMessage(bt, p.progress));
      if (token !== viewToken || result.cancelled) return;
      lastQueryRevision = result.revision || 0;
      filteredCount = result.total;
      await loadPage(state.follow ? Math.max(0, Math.floor((filteredCount - 1) / PAGE_SIZE) * PAGE_SIZE) : 0, state.follow, bt);
      if (result.errors?.length) flash(result.errors.map((e) => e.error).join('; '));
      renderFiles(); renderChips(); updateStatus();
    } catch (error) { if (token === viewToken) pagingError(error); }
    finally { doneBusy(bt); }
  }

  function displayText(rec) {
    if (displayCache.has(rec.seq)) return displayCache.get(rec.seq);
    const preview = rec.raw.slice(0, 2000);
    const t = (state.maskOn ? engine.maskLine(preview) : preview) + (rec.raw.length > 2000 ? ' … [long line: click to open full text]' : '');
    displayCache.set(rec.seq, t);
    return t;
  }

  /* ---------------- chips ---------------- */
  function renderChips() {
    const row = $('chips-row');
    row.innerHTML = '';
    // per-file view shows that file's tally; merged view shows everything
    const chips = (state.viewMode === 'file' && state.activeFile)
      ? store.tallyFor(state.activeFile).chipList()
      : tally.chipList();
    if (!chips.length) {
      row.innerHTML = '<span class="muted" id="chips-hint">Level chips appear after loading</span>';
      return;
    }
    // bookmark scope: lines bookmarked within the currently shown file(s)
    const bmInView = files.filter((f) => state.viewMode !== 'file' || !state.activeFile || state.activeFile === f.id)
      .reduce((n, f) => n + bookmarksStore.list(bookmarkKeyFor(f.id)).length, 0);

    if (bmInView > 0 || state.showOnlyBookmarked) {
      const b = document.createElement('button');
      b.className = 'chip' + (state.showOnlyBookmarked ? ' sel' : '');
      b.title = 'show only bookmarked lines';
      b.innerHTML = '<span style="color:var(--warn)">★</span><span class="n">' + bmInView + '</span>';
      b.onclick = () => {
        // a selected ★ chip must always toggle off — even with zero bookmarks,
        // otherwise the filter would be stuck showing an empty view
        if (bmInView === 0 && !state.showOnlyBookmarked) { flash('no bookmarks in this view'); return; }
        setBmOnly(!state.showOnlyBookmarked);
      };
      row.appendChild(b);
    }
    for (const c of chips) {
      const label = c.id === '__' ? '—' : c.id;
      const b = document.createElement('button');
      b.className = 'chip' + (state.levels.includes(c.id) ? ' sel' : '');
      const cls = c.id === '__' ? '' : ' lvl-' + c.id;
      b.innerHTML = '<span class="' + cls.trim() + '">' + label + '</span><span class="n">' + c.count + '</span>';
      b.onclick = () => {
        const i = state.levels.indexOf(c.id);
        if (i >= 0) state.levels.splice(i, 1); else state.levels.push(c.id);
        filter.setLevels(state.levels);
        saveState(); rebuildView(); renderChips();
      };
      row.appendChild(b);
    }
  }

  /* ---------------- virtualized viewer ---------------- */
  const viewer = () => $('viewer');
  let heights = [];     // wrap mode: px height per row
  let heightSum = [];   // prefix sums
  const ROW_H = 22;
  const MARK_H = 26;    // fixed height of the start/end-of-log marker bands

  // With pagination it is easy to lose track of where the log begins and
  // ends, so the first page carries a start band and the last page an end
  // band inside the scrollable area (they participate in the layout as
  // fixed-height offsets).
  const showStartMark = () => pageStart === 0 && view.length > 0;
  const showEndMark = () => view.length > 0 && pageStart + view.length >= filteredCount;
  const topOffset = () => (showStartMark() ? MARK_H : 0);
  // physical-log wording is only truthful without active filters; with any
  // filter the bands bound the MATCHING results instead
  const viewIsFiltered = () => !!(filter.quick || state.levels.length || filter.timeFrom || filter.timeTo ||
    state.showOnlyBookmarked || (state.rules || []).some((r) => r.enabled !== false && String(r.pattern || '').trim()));
  function markLabel(which) {
    const perFile = state.viewMode === 'file' && state.activeFile;
    const fname = perFile ? (files.find((f) => f.id === state.activeFile) || {}).name || 'file' : null;
    const scope = fname || ('merged log (' + files.length + ' file' + (files.length === 1 ? '' : 's') + ')');
    const first = view[0], last = view[view.length - 1];
    if (viewIsFiltered()) {
      return which === 'start'
        ? '▲ first match in ' + scope + ' — source line ' + (first ? first.lineNo : 0)
        : '▼ last match in ' + scope + ' — source line ' + (last ? last.lineNo : 0) + ' — ' + filteredCount.toLocaleString() + ' matches';
    }
    if (which === 'start') return '▲ start of ' + scope;
    return fname
      ? '▼ end of ' + fname + ' — line ' + (last ? last.lineNo : 0)
      : '▼ end of merged log — ' + filteredCount.toLocaleString() + ' lines';
  }

  function invalidateHeights() {
    heights = null; heightSum = null;
  }

  function rowHeight(i) {
    if (!state.wrapOn) return ROW_H;
    measureWrap();
    return heights[i] || ROW_H;
  }

  function measureWrap() {
    if (heights) return;
    const chars = Math.max(8, Math.floor((viewer().clientWidth - (state.viewMode === 'merged' ? 300 : 150)) / monoCharWidth()));
    heights = view.map((r) => Math.max(ROW_H, Math.ceil(displayText(r).length / chars) * ROW_H));
    sumHeights();
  }
  function sumHeights() { heightSum = [0]; for (let i = 0; i < heights.length; i++) heightSum.push(heightSum[i] + heights[i]); }

  function rowsHeight() {
    if (!state.wrapOn) return view.length * ROW_H;
    measureWrap();
    return heightSum[heightSum.length - 1] || 0;
  }

  function totalHeight() {
    return topOffset() + rowsHeight() + (showEndMark() ? MARK_H : 0);
  }

  function findIndexAtOffset(y) {
    y = Math.max(0, y - topOffset());
    if (!state.wrapOn) return Math.floor(y / ROW_H);
    measureWrap();
    let lo = 0, hi = heightSum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (heightSum[mid + 1] <= y) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function monoCharWidth() {
    if (charW) return charW;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    ctx.font = '12.5px "Cascadia Mono", Consolas, "JetBrains Mono", Menlo, monospace';
    charW = (ctx.measureText('MMMMMMMMMM').width / 10) || 7.5;
    return charW;
  }

  function renderRows() {
    const v = viewer();
    const spacer = $('vspacer');
    const top = v.scrollTop;
    const h = v.clientHeight;
    if (state.wrapOn) {
      spacer.style.width = v.clientWidth + 'px';
    } else {
      // explicit width from the widest line in the view: rendered windows are
      // partial, so max-content would collapse the horizontal scroll range
      const gutter = 152 + 34 + 68 + 38 + 24 + (state.viewMode === 'merged' ? 152 : 0);
      spacer.style.width = Math.ceil(Math.max(v.clientWidth, monoCharWidth() * viewMaxLen + gutter)) + 'px';
    }
    spacer.style.height = totalHeight() + 'px';
    const start = Math.max(0, findIndexAtOffset(top) - 5);
    const end = Math.min(view.length, findIndexAtOffset(top + h) + 5);

    // Windowed rows are stacked inside one offset block so they appear at
    // their true scroll position (wrap rows have variable heights).
    const inner = document.createElement('div');
    if (state.wrapOn) {
      measureWrap();
      inner.style.transform = 'translateY(' + (topOffset() + (heightSum[start] || 0)) + 'px)';
    } else {
      inner.style.transform = 'translateY(' + (topOffset() + start * ROW_H) + 'px)';
    }

    const wrapCls = state.wrapOn ? ' wrap' : '';
    if (!view.length) {
      const hint = state.showOnlyBookmarked
        ? '<div class="vrow" style="white-space:normal"><div class="vcell muted" style="white-space:normal">no bookmarked lines in this view — add bookmarks with the ☆ gutter or the B key</div></div>'
        : '';
      inner.innerHTML = hint || '';
    }
    for (let i = start; i < end; i++) {
      const rec = view[i];
      const row = document.createElement('div');
      let cls = 'vrow' + wrapCls;
      if (selection.has(i)) cls += ' sel';
      else if (rec.level === 'W') cls += ' tint-w';
      else if (rec.level === 'E') cls += ' tint-e';
      else if (rec.level === 'F') cls += ' tint-f';
      row.className = cls;
      const bmk = bookmarksStore.has(bookmarkKeyFor(rec.fileId), rec.lineNo);
      const text = displayText(rec);
      const visual = LT.highlightText(text, compiledHighlights);
      const hl = highlightedHtml(text, visual.spans);
      if (visual.row && !selection.has(i)) {
        row.classList.add('rule-highlight-row');
        row.style.setProperty('--rule-row-color', visual.row.color + '33');
        row.title = visual.row.name;
      }
      row.innerHTML =
        '<div class="vcell bm' + (bmk ? ' marked' : '') + '" data-bm="' + i + '">' + (bmk ? '★' : '☆') + '</div>' +
        '<div class="vcell ln">' + rec.lineNo + '</div>' +
        (state.viewMode === 'merged' ? '<div class="vcell fl" title="' + esc(fileDisplayName(rec.fileId)) + '">' + esc(fileDisplayName(rec.fileId)) + '</div>' : '') +
        (rec.level ? '<div class="vcell lv lvl-' + esc(rec.level) + '">' + esc(rec.level) + '</div>' : '<div class="vcell lv"></div>') +
        '<div class="vcell txt" style="white-space:inherit">' + (hl || esc(text)) + '</div>';
      row.dataset.idx = i;
      inner.appendChild(row);
    }
    spacer.innerHTML = '';
    if (showStartMark()) {
      const m = document.createElement('div');
      m.className = 'vmark start';
      const s = document.createElement('span');
      s.textContent = markLabel('start');
      m.appendChild(s);
      spacer.appendChild(m);
    }
    spacer.appendChild(inner);
    if (showEndMark()) {
      const m = document.createElement('div');
      m.className = 'vmark end';
      m.style.top = (topOffset() + rowsHeight()) + 'px';
      const s = document.createElement('span');
      s.textContent = markLabel('end');
      m.appendChild(s);
      spacer.appendChild(m);
    }
    if (state.wrapOn) {
      let changed = false;
      for (const row of inner.children) { const idx = Number(row.dataset.idx); if (!Number.isInteger(idx) || !view[idx]) continue; const height = Math.max(ROW_H, row.offsetHeight); if (heights[idx] !== height) { heights[idx] = height; changed = true; } }
      if (changed) { sumHeights(); spacer.style.height = totalHeight() + 'px'; requestAnimationFrame(renderRows); }
    }
  }

  function fileDisplayName(fileId) {
    const f = files.find((x) => x.id === fileId);
    return f ? f.name : fileId;
  }

  function firstLineOf(f) {
    if (!f) return '*';
    const st = store.kept.find((r) => r.fileId === f.id);
    return st ? st.raw.slice(0, 200) : '*';
  }

  function quickMatchSpans(text) {
    if (!filter._quickRe) return [];
    const src = filter._quickRe;
    const re = src.global ? src : new RegExp(src.source, src.flags + 'g');
    const spans = [];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      if (!m[0].length) { re.lastIndex++; continue; }
      spans.push({ start: m.index, end: m.index + m[0].length });
      if (spans.length >= 100) break;
    }
    re.lastIndex = 0;
    return spans;
  }

  function highlightedHtml(text, colored) {
    const quick = quickMatchSpans(text);
    if (!quick.length && !colored.length) return null;
    const points = new Set([0, text.length]);
    for (const s of quick.concat(colored)) { points.add(s.start); points.add(s.end); }
    const sorted = Array.from(points).sort((a, b) => a - b);
    let out = '';
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1];
      if (a === b) continue;
      const value = esc(text.slice(a, b));
      if (quick.some((s) => a >= s.start && b <= s.end)) { out += '<mark>' + value + '</mark>'; continue; }
      const rule = colored.find((s) => a >= s.start && b <= s.end);
      if (rule) out += '<span class="rule-highlight-text" title="' + esc(rule.name) + '" style="background:' + rule.color + ';color:' + LT.textColor(rule.color) + '">' + value + '</span>';
      else out += value;
    }
    return out;
  }

  function updateStatus() {
    const st = store.stats();
    $('st-total').textContent = st.totalLines;
    $('st-kept').textContent = st.keptTotal;
    $('st-shown').textContent = filteredCount;
    $('st-sel').textContent = selection.count;
    syncExportButtons();
    $('st-bm').textContent = bookmarksStore.all().length;
    const bmCount = $('bm-count');
    if (bmCount) bmCount.textContent = bookmarksStore.all().length;
    $('st-trim').classList.add('hidden');
    updatePager();
  }


  /* ---------------- viewer events ---------------- */
  function bindViewer() {
    const v = viewer();
    v.addEventListener('scroll', () => {
      renderRows();
      if (state.follow && v.scrollTop + v.clientHeight < v.scrollHeight - ROW_H * 2) {
        // user scrolled up: disable follow
        state.follow = false; $('btn-follow').textContent = 'Follow: OFF'; $('btn-follow').classList.remove('on'); saveState();
      }
    });
    let drag = false;
    let lastHoverIdx = -1;
    $('vspacer').addEventListener('mousedown', (e) => {
      const row = e.target.closest('.vrow');
      if (!row) return;
      const idx = Number(row.dataset.idx);
      if (e.target.dataset.bm !== undefined) {
        toggleBookmark(idx);
        return;
      }
      // only trust the drag gesture while the primary button is really held
      drag = (e.buttons & 1) === 1;
      lastHoverIdx = idx;
      if (e.shiftKey) selection.shiftClick(idx);
      else if (e.ctrlKey || e.metaKey) selection.ctrlClick(idx);
      else { selection.click(idx); if (state.drawerOn) showDrawer(view[idx]); }
      renderRows(); updateStatus();
      e.preventDefault();
    });
    $('vspacer').addEventListener('mouseover', (e) => {
      if (!drag) return;
      const row = e.target.closest('.vrow');
      if (!row) return;
      const idx = Number(row.dataset.idx);
      // skip repeat events for the row already handled (renderRows replaces
      // nodes under a stationary cursor, which re-fires mouseover)
      if (idx === lastHoverIdx) return;
      lastHoverIdx = idx;
      if (!(e.buttons & 1)) return; // button released — not a drag
      selection.shiftClick(idx);
      renderRows(); updateStatus();
    });
    const endDrag = () => { drag = false; lastHoverIdx = -1; };
    window.addEventListener('mouseup', endDrag);
    $('viewer').addEventListener('mouseleave', endDrag);
    v.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.vrow');
      if (row && state.drawerOn) showDrawer(view[Number(row.dataset.idx)]);
    });
  }

  function toggleBookmark(idx) {
    const rec = view[idx];
    bookmarksStore.toggle(bookmarkKeyFor(rec.fileId), rec.lineNo, { snippet: displayText(rec).slice(0, 200), ts: rec.ts, fileId: rec.fileId });
    renderBookmarks(); renderChips();
    if (state.showOnlyBookmarked) rebuildView(); else { updateStatus(); renderRows(); }
    saveState();
  }
  let bmRows = []; // bookmark entries currently rendered, index == data-idx
  function renderBookmarks() {
    const list = $('bookmark-list');
    if (!list) return;
    const all = bookmarksStore.all();
    bmRows = all;
    $('bm-count').textContent = all.length;
    if (!all.length) {
      list.innerHTML = '<div class="muted" style="padding:8px 10px">no bookmarks yet — click ☆ in the gutter or press B</div>';
      return;
    }
    list.innerHTML = all.map((b, i) => {
      const fname = b.key.split('|')[0];
      return '<div class="bm-entry" data-idx="' + i + '" data-ln="' + b.lineNo + '">' +
        '<button class="fx" title="remove this bookmark">✕</button>' +
        '<div class="snippet">' + esc(b.meta.snippet || '') + '</div>' +
        '<div class="meta">' + esc(fname) + ':' + b.lineNo + (b.note ? ' — <b>' + esc(b.note) + '</b>' : '') + '</div></div>';
    }).join('');
  }
  function removeBookmark(key, lineNo) {
    bookmarksStore.remove(key, lineNo);
    renderBookmarks(); renderChips(); updateStatus();
    if (state.showOnlyBookmarked && !bookmarksStore.all().length) setBmOnly(false);
    else if (state.showOnlyBookmarked) rebuildView();
    saveState();
  }
  // memoized per file: firstLineOf() scans store.kept, and callers run per
  // kept row / per scroll frame — invalidation happens in onKeptChanged()
  const bmKeyCache = new Map();
  function bookmarkKeyFor(fileId) {
    if (bmKeyCache.has(fileId)) return bmKeyCache.get(fileId);
    const f = files.find((x) => x.id === fileId);
    const k = LT.bookmarkFileKey(f ? f.name : fileId, f ? f.size : 0, firstLineOf(f));
    bmKeyCache.set(fileId, k);
    return k;
  }

  /* Clear button: remove every bookmark in one click (loaded files included). */
  function clearAllBookmarks() {
    const count = bookmarksStore.all().length;
    bookmarksStore.removeAll();
    renderBookmarks(); renderChips(); updateStatus();
    // with no bookmarks left the ★ filter would show nothing and its chip
    // would be un-toggleable — release it so the logs come back
    if (state.showOnlyBookmarked) setBmOnly(false);
    saveState();
    flash(count ? 'cleared ' + count + ' bookmark(s)' : 'no bookmarks to clear');
  }
  function showDrawer(rec) {
    if (!rec) return;
    const d = $('drawer');
    d.className = 'open';
    const maskedLine = engine.maskLine(rec.raw);
    const hasMaskDiff = state.maskOn && maskedLine !== rec.raw;
    const mainLine = hasMaskDiff ? maskedLine : rec.raw;
    const visual = LT.highlightText(mainLine, compiledHighlights);
    const mainHtml = highlightedHtml(mainLine, visual.spans) || esc(mainLine);
    d.innerHTML = '<h3>Line ' + rec.lineNo + ' — ' + esc(fileDisplayName(rec.fileId)) +
      '<button onclick="document.getElementById(\'drawer\').className=\'\'">✕</button></h3>' +
      '<dl>' +
      dv('ts', rec.ts) + dv('level', rec.level) + dv('tag', rec.tag) +
      dv('pid / tid', (rec.pid == null ? '—' : rec.pid) + ' / ' + (rec.tid == null ? '—' : rec.tid)) +
      '<div><dt>' + (hasMaskDiff ? 'masked' : 'raw') +
      (hasMaskDiff
        ? '<button type="button" class="chev-toggle" aria-expanded="false" title="show raw line">▸ raw</button>'
        : '') +
      '</dt><dd>' + mainHtml + '</dd>' +
      (hasMaskDiff ? '<dd class="raw-extra" hidden></dd>' : '') +
      '</div>' +
      '</dl>';
    const chev = d.querySelector('.chev-toggle');
    if (chev) {
      const extra = d.querySelector('.raw-extra');
      chev.onclick = () => {
        // lazy: the raw text only enters the DOM while expanded
        extra.textContent = extra.hidden ? rec.raw : '';
        extra.hidden = !extra.hidden;
        chev.textContent = extra.hidden ? '▸ raw' : '▾ raw';
        chev.setAttribute('aria-expanded', String(!extra.hidden));
        chev.title = extra.hidden ? 'show raw line' : 'hide raw line';
      };
    }
  }
  function dv(k, v) { return '<div><dt>' + k + '</dt><dd>' + esc(v == null ? '—' : String(v)) + '</dd></div>'; }

  /* ---------------- copy ---------------- */
  async function copySelection() {
    if (!selection.count) return;
    const idxs = selection.indices();
    const prefix = $('copy-prefix').value;
    const lines = idxs.map((i) => {
      const rec = view[i];
      const text = displayText(rec);
      if (prefix === 'ln') return '[L' + rec.lineNo + '] ' + text;
      if (prefix === 'file:line') return fileDisplayName(rec.fileId) + ':' + rec.lineNo + ': ' + text;
      return text;
    });
    const payload = lines.join('\n');
    try {
      await navigator.clipboard.writeText(payload);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = payload; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    $('st-progress').textContent = 'copied ' + lines.length + ' line(s)';
    setTimeout(() => { $('st-progress').textContent = ''; }, 2000);
  }

  /* ---------------- search ---------------- */
  function rgOpts() {
    return {
      fixed: $('rg-fixed').checked,
      word: $('rg-word').checked,
      invert: $('rg-invert').checked,
      caseMode: $('rg-case').value,
    };
  }

  function runInstantSearch() {
    const pattern = $('rg-pattern').value;
    const s = LT.buildSearcher(pattern, rgOpts());
    const out = $('search-results');
    if (!pattern) {
      out.innerHTML = '<div class="muted" style="padding:20px">Instant results for kept lines appear here as you type. “Deep scan files” re-reads the full files from disk.</div>';
      $('search-progress').textContent = '';
      return;
    }
    if (!s.ok) {
      out.innerHTML = '<div class="rule-err" style="padding:10px">' + esc(s.error) + '</div>';
      return;
    }
    const t0 = performance.now();
    const res = LT.searchRecords(store.kept, s);
    const mode = $('rg-mode').value;
    renderSearchRows(res, mode, performance.now() - t0);
  }

  /** collapsible per-file group: <details><summary>file (count)</summary>rows</details> */
  function groupHtml(file, rowsHtml, matchCount) {
    return '<details class="sr-group" open><summary class="sr-file" title="click to collapse/expand">' +
      esc(file) + ' <span class="count-pill">' + matchCount + '</span></summary>' + rowsHtml + '</details>';
  }

  /** Uniform full-width bands: row/groups live inside a max-content inner
   * wrapper so every background band stretches to the widest line (Wrap: OFF)
   * or the panel width (Wrap: ON) — never to each line's own text length. */
  function srInner(html) { return '<div class="sr-inner">' + html + '</div>'; }

  function renderSearchRows(res, mode, ms) {
    const out = $('search-results');
    // instant search runs over the analysis sample (bounded); the viewer's
    // filter/paging always cover the complete indexed files, so there is no
    // "kept lines only" nag here anymore
    $('search-progress').textContent = res.total + ' match(es) in analysis sample in ' + ms.toFixed(0) + ' ms — viewer filtering searches complete indexed files';
    const nameOf = (fileId) => fileDisplayName(fileId);
    if (mode === 'count') {
      out.innerHTML = Object.keys(res.byFile).map((f) => '<div class="sr-file">' + esc(nameOf(f)) + ': ' + res.byFile[f] + '</div>').join('') ||
        '<div class="muted" style="padding:20px">no matches</div>';
      return;
    }
    if (mode === 'files') {
      out.innerHTML = Object.keys(res.byFile).map((f) => '<div class="sr-file">' + esc(nameOf(f)) + '</div>').join('') ||
        '<div class="muted" style="padding:20px">no matches</div>';
      return;
    }
    const byFile = {};
    for (const r of res.rows.slice(0, 10000)) {
      const rec = store.kept[r.idx];
      const name = nameOf(rec.fileId);
      (byFile[name] = byFile[name] || []).push({ fileId: rec.fileId, lineNo: rec.lineNo, ts: rec.ts, text: displayText(rec) });
    }
    out.innerHTML = srInner(Object.keys(byFile).map((f) =>
      groupHtml(f, byFile[f].map((r) => srRow(f, r.lineNo, r.ts, r.text, true, r.fileId)).join(''), byFile[f].length)).join('')) ||
      '<div class="muted" style="padding:20px">no matches</div>';
  }

  function srRow(file, lineNo, ts, text, isMatch, fid) {
    const cls = isMatch ? 'hit' : 'ctx';
    return '<div class="sr-row ' + cls + '" data-file="' + esc(file) + '" data-fid="' + esc(fid || '') + '" data-ln="' + lineNo + '">' +
      '<span class="srf" title="' + esc(file) + '">' + esc(file) + '</span>' +
      '<span class="srl">' + lineNo + '</span>' +
      '<span class="srt">' + esc(ts || '—') + '</span>' +
      '<span class="srx">' + esc(text) + '</span></div>';
  }

  let deepAbort = false;
  async function deepScan() {
    const pattern = $('rg-pattern').value;
    const s = LT.buildSearcher(pattern, rgOpts());
    const out = $('search-results');
    if (!pattern) { $('search-progress').textContent = 'enter a pattern first'; return; }
    if (!s.ok) { out.innerHTML = '<div class="rule-err" style="padding:10px">' + esc(s.error) + '</div>'; return; }
    const before = Math.max(0, Number($('rg-before').value) || 0);
    const after = Math.max(0, Number($('rg-after').value) || 0);
    const cap = 10000;
    const cancelBtn = $('btn-deep-cancel');
    deepAbort = false;
    cancelBtn.classList.remove('hidden');
    const results = [];
    let scanned = 0;
    let cancelled = false;
    try {
      for (const entry of files) {
        if (deepAbort) { cancelled = true; break; }
        const ring = [];
        let afterLeft = 0;
        let lineNo = 0;
        for await (const line of streamLines(entry.file, (n) => {
          entry.read += n;
          $('search-progress').textContent = 'deep scan ' + entry.name + ': ' + LT.fmtBytes(entry.read) + ' / ' + LT.fmtBytes(entry.size) + ' — ' + results.length + ' matches';
        })) {
          if (deepAbort) { cancelled = true; break; }
          lineNo++;
          scanned++;
          const masked = state.maskOn ? engine.maskLine(line) : line;
          if (LT.matchLine(s, line)) {
            for (const r of ring) results.push({ file: entry.name, id: entry.id, lineNo: r.lineNo, ts: LT.detectTs(r.text), text: state.maskOn ? engine.maskLine(r.text) : r.text, isMatch: false });
            ring.length = 0;
            results.push({ file: entry.name, id: entry.id, lineNo, ts: LT.detectTs(line), text: masked, isMatch: true });
            afterLeft = after;
          } else if (afterLeft > 0) {
            results.push({ file: entry.name, id: entry.id, lineNo, ts: LT.detectTs(line), text: masked, isMatch: false });
            afterLeft--;
          } else {
            ring.push({ lineNo, text: line });
            while (ring.length > before) ring.shift();
          }
          if (results.length >= cap) break;
          if ((scanned & 0x3fff) === 0) await tick();
        }
        if (results.length >= cap) break;
      }
    } finally {
      cancelBtn.classList.add('hidden');
    }
    const mode = $('rg-mode').value;
    const byFile = {};
    for (const r of results) (byFile[r.file] = byFile[r.file] || []).push(r);
    const total = results.length;
    const note = results.length >= cap ? ' (capped at ' + cap + ' — refine the pattern)'
      : cancelled ? ' (cancelled after ' + scanned + ' lines)' : '';
    $('search-progress').textContent = 'deep scan: ' + total + ' match(es) over ' + scanned + ' lines' + note;
    if (mode === 'count') {
      out.innerHTML = Object.keys(byFile).map((f) => '<div class="sr-file">' + esc(f) + ': ' + byFile[f].filter((r) => r.isMatch).length + '</div>').join('');
      return;
    }
    if (mode === 'files') {
      out.innerHTML = Object.keys(byFile).map((f) => '<div class="sr-file">' + esc(f) + '</div>').join('');
      return;
    }
    out.innerHTML = srInner(Object.keys(byFile).map((f) => {
      const matches = byFile[f].filter((r) => r.isMatch).length;
      return groupHtml(f, byFile[f].map((r) => srRow(f, r.lineNo, r.ts, r.text, r.isMatch, r.id)).join(''), matches);
    }).join('')) || '<div class="muted" style="padding:20px">no matches</div>';
  }

  /* ---------------- filters panel ---------------- */
  function renderRules() {
    const tb = $('rule-rows');
    tb.innerHTML = '';
    state.rules.forEach((r, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td><input type="checkbox" class="toggle" data-i="' + i + '" data-k="enabled"' + (r.enabled ? ' checked' : '') + '></td>' +
        '<td><input type="text" data-i="' + i + '" data-k="name" value="' + esc(r.name || '') + '"></td>' +
        '<td><input type="text" data-i="' + i + '" data-k="pattern" value="' + esc(r.pattern || '') + '">' + (ruleError(r) ? '<div class="rule-err">' + esc(ruleError(r)) + '</div>' : '') + '</td>' +
        '<td><input type="checkbox" class="toggle" data-i="' + i + '" data-k="caseSensitive"' + (r.caseSensitive ? ' checked' : '') + '></td>' +
        '<td><select data-i="' + i + '" data-k="action">' +
        ['include', 'exclude', 'highlight'].map((a) => '<option' + (r.action === a ? ' selected' : '') + '>' + a + '</option>').join('') +
        '</select></td>' +
        '<td>' + (r.action === 'highlight' ? '<select data-i="' + i + '" data-k="matchMode"><option value="regex"' + (r.matchMode !== 'literal' ? ' selected' : '') + '>regex</option><option value="literal"' + (r.matchMode === 'literal' ? ' selected' : '') + '>literal</option></select>' : '<span class="muted">—</span>') + '</td>' +
        '<td>' + (r.action === 'highlight' ? '<select data-i="' + i + '" data-k="target"><option value="text"' + (r.target !== 'row' ? ' selected' : '') + '>text</option><option value="row"' + (r.target === 'row' ? ' selected' : '') + '>row</option></select>' : '<span class="muted">—</span>') + '</td>' +
        '<td>' + (r.action === 'highlight' ? '<div class="rule-color-cell"><div class="rule-palette" role="group" aria-label="Highlight color presets">' +
        HIGHLIGHT_PALETTE.map((c) => '<button type="button" class="rule-swatch' + (LT.normalizeColor(r.color) === c[1] ? ' active' : '') + '" data-i="' + i + '" data-color="' + c[1] + '" style="--swatch:' + c[1] + '" title="' + c[0] + '" aria-label="' + c[0] + '" aria-pressed="' + (LT.normalizeColor(r.color) === c[1]) + '"></button>').join('') +
        '</div><input type="color" class="rule-color" data-i="' + i + '" data-k="color" value="' + LT.normalizeColor(r.color) + '" title="Custom color" aria-label="Custom highlight color"></div>' : '<span class="muted">—</span>') + '</td>' +
        '<td><span class="count-pill" id="hits-' + i + '">' + (filter.hits[r.id] || 0) + '</span></td>' +
        '<td><button data-del="' + i + '">✕</button></td>';
      tb.appendChild(tr);
    });
    tb.onclick = (e) => {
      const swatch = e.target.closest && e.target.closest('.rule-swatch');
      if (swatch) {
        const r = state.rules[Number(swatch.dataset.i)];
        if (!r || r.action !== 'highlight') return;
        r.color = LT.normalizeColor(swatch.dataset.color);
        refreshHighlights(); saveState(); renderRules(); renderRows();
        return;
      }
      const del = e.target.dataset && e.target.dataset.del;
      if (del == null) return;
      const removed = state.rules.splice(Number(del), 1)[0];
      if (removed && removed.action === 'highlight') { refreshHighlights(); saveState(); renderRules(); renderRows(); }
      else applyFilters();
    };
    tb.onchange = (e) => {
      const i = e.target.dataset && e.target.dataset.i;
      const k = e.target.dataset && e.target.dataset.k;
      if (i == null || !k) return;
      const r = state.rules[Number(i)];
      if (!r) return;
      const wasHighlight = r.action === 'highlight';
      r[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      if (wasHighlight && r.action === 'highlight') {
        Object.assign(r, normalizeRule(r));
        refreshHighlights();
        saveState(); renderRules(); renderRows();
        return;
      }
      applyFilters();
    };
  }

  function ruleError(r) {
    if (r.action === 'highlight' && r.matchMode === 'literal') return null;
    try { new RegExp(r.pattern, r.caseSensitive ? '' : 'i'); return null; } catch (e) { return e.message; }
  }

  function applyFilters() {
    state.rules = state.rules.map(normalizeRule);
    filter.setRules(state.rules.map((r, i) => Object.assign({ id: 'r' + i }, r)));
    refreshHighlights();
    filter.quick = state.quick ? { pattern: state.quick, fixed: false, caseSensitive: false } : null; filter.compileQuick();
    filter.setLevels(state.levels);
    filter.timeFrom = $('time-from').value.trim();
    filter.timeTo = $('time-to').value.trim();
    state.timeFrom = filter.timeFrom; state.timeTo = filter.timeTo;
    saveState();
    rebuildView();
    renderRules();
  }

  /* ---------------- presets ---------------- */
  function presetPayload() {
    return {
      rules: state.rules, quick: state.quick, levels: state.levels,
      timeFrom: state.timeFrom, timeTo: state.timeTo,
      maskEnabled: state.maskEnabled, customMasks: state.customMasks, rg: state.rg,
      issueGroups: state.issueGroups,
    };
  }
  function applyPreset(p) {
    state.rules = (p.rules || []).map(normalizeRule);
    state.quick = p.quick || '';
    state.levels = p.levels || [];
    state.issueGroups = Array.isArray(p.issueGroups) ? JSON.parse(JSON.stringify(p.issueGroups)) : JSON.parse(JSON.stringify(LT.DEFAULT_ISSUE_GROUPS));
    state.timeFrom = p.timeFrom || ''; state.timeTo = p.timeTo || '';
    state.maskEnabled = p.maskEnabled || {};
    state.customMasks = p.customMasks || [];
    state.rg = Object.assign({ fixed: false, word: false, invert: false, caseMode: 'smart', before: 0, after: 0 }, p.rg || {});
    syncMasksFromState(); syncRgFromState(); applyFilters(); renderMasks(); $('quick').value = state.quick;
  }
  function renderPresets() {
    const sel = $('preset-sel');
    sel.innerHTML = Object.keys(state.presets).map((n) => '<option>' + esc(n) + '</option>').join('') || '<option value="">— none —</option>';
  }

  /* ---------------- masks panel ---------------- */
  function syncMasksFromState() {
    for (const id of LT.builtinRuleIds()) {
      engine.setEnabled(id, state.maskEnabled[id] !== false);
    }
    engine.custom = [];
    displayCache = new Map();
    for (const c of state.customMasks) engine.addCustom(c);
  }

  function renderMasks() {
    const grid = $('mask-grid');
    grid.innerHTML = '';
    for (const r of engine.rules) {
      const on = state.maskEnabled[r.id] !== false;
      const card = document.createElement('div');
      card.className = 'mask-card';
      const eng = new LT.MaskEngine(); eng.custom = []; eng.setEnabled(r.id, true);
      for (const x of eng.rules) if (x.id !== r.id) eng.setEnabled(x.id, false);
      const sample = SAMPLES[r.id] || '';
      const out = on ? eng.maskLine(sample) : sample;
      card.innerHTML = '<div class="t"><span>' + esc(r.label) + '</span><input type="checkbox" class="toggle" data-mask="' + r.id + '"' + (on ? ' checked' : '') + '></div>' +
        '<div class="ex">' + esc(sample) + '<br><b>' + esc(out) + '</b></div>' +
        '<div class="ex muted">' + esc(r.hint) + '</div>';
      grid.appendChild(card);
    }
    grid.onchange = (e) => {
      const id = e.target.dataset && e.target.dataset.mask;
      if (!id) return;
      state.maskEnabled[id] = e.target.checked;
      syncMasksFromState(); renderMasks(); rebuildView(); saveState();
    };
    const cm = $('cm-list');
    cm.innerHTML = state.customMasks.map((c, i) =>
      '<div class="rowline"><span class="badge">' + esc(c.name) + '</span><span style="font-family:var(--mono)">' + esc(c.pattern) + '</span> → <span style="font-family:var(--mono)">' + esc(c.replacement) + '</span><button data-cm="' + i + '">✕</button></div>').join('');
    cm.onclick = (e) => {
      const i = e.target.dataset && e.target.dataset.cm;
      if (i != null) { state.customMasks.splice(Number(i), 1); syncMasksFromState(); renderMasks(); rebuildView(); saveState(); }
    };
    previewMask();
  }

  const SAMPLES = {
    vin: 'VIN YV4AB9CD12EF34567', iban: 'IBAN DE89370400440532013000', card: 'card 4111 1111 1111 1111',
    ssn: 'ssn 123-45-6789', phoneIntl: 'call +46 70 123 45 67', phoneUs: 'call (555) 123-4567',
    imei: 'IMEI 350774129305118', email: 'mail driver.jung@lotus-tech.example', serial: 'serial SN-A1B2C3D4E5F6',
    mac: 'mac aa:bb:cc:11:22:33', ipv4Private: 'host 192.168.1.104', ipv4Public: 'host 203.0.113.77',
    ipv6: 'link fe80::7a8b:cafe:1234:5678', gnss: 'fix 48.858400, 2.294500',
    subscriberId: 'subscriberId=41011223344', ssid: 'ssid=AndroidShare_4821',
  };

  function previewMask() {
    engine.custom = [];
    for (const c of state.customMasks) engine.addCustom(c);
    $('mask-preview-out').textContent = engine.maskLine($('mask-preview-in').value);
    syncMasksFromState();
  }

  /* ---------------- analysis panel ---------------- */
  /* Issue list: group findings by kind into a collapsible tree, sorted by
   * severity (crit → low), count descending inside a tier. */
  function issueTreeHtml(issues) {
    const sev = LT.ISSUE_SEVERITY || {};
    const RANK = { crit: 0, high: 1, med: 2, low: 3 };
    const byKind = new Map();
    for (const it of issues) {
      if (!byKind.has(it.kind)) byKind.set(it.kind, []);
      byKind.get(it.kind).push(it);
    }
    const tier = (k) => RANK[sev[k]] != null ? RANK[sev[k]] : RANK.low;
    const kinds = [...byKind.keys()].sort((a, b) =>
      tier(a) - tier(b) || byKind.get(b).length - byKind.get(a).length || a.localeCompare(b));
    return kinds.map((k, gi) => {
      const list = byKind.get(k);
      const s = sev[k] || 'low';
      return '<details class="iss-group iss-' + s + '"' + (gi === 0 ? ' open' : '') + '>' +
        '<summary><span class="iss-dot"></span><span class="iss-kind">' + esc(k) + '</span>' +
        '<span class="count-pill">' + list.length + '</span></summary>' +
        list.map((it) => '<div class="issue" data-seq="' + it.seq + '"><span><b>' + esc(it.kind) + '</b> — ' + esc(it.snippet) + '</span><span class="muted">' + esc(it.file) + ':' + it.lineNo + '</span></div>').join('') +
        '</details>';
    }).join('');
  }

  let analysisToken = 0;
  function renderAnalysis() {
    const p = $('analysis-panel');
    if (!p) return;
    const token = ++analysisToken;
    // first paint shows an analyzing placeholder; the (potentially multi-second)
    // heavy pass runs deferred so the tab never freezes without feedback.
    // Re-renders (rule edits, scope change) keep the previous content visible
    // instead of flickering a placeholder.
    if (!p.querySelector('.stat-card')) {
      p.innerHTML = '<div class="muted" style="padding:24px">analyzing…</div>';
    }
    setTimeout(() => { if (token === analysisToken) renderAnalysisInto(p); }, 30);
  }

  function renderAnalysisInto(p) {
    const st = store.stats();
    const sel = state.analysisFile || '';
    const selStats = sel ? (st.files[sel] || { total: 0, kept: 0, dropped: 0, bytes: 0 }) : null;
    const recs = sel ? store.kept.filter((r) => r.fileId === sel) : store.kept;
    const fileOpts = '<option value=""' + (sel ? '' : ' selected') + '>All files (' + files.length + ')</option>' +
      files.map((f) => '<option value="' + esc(f.id) + '"' + (sel === f.id ? ' selected' : '') + '>' + esc(f.name) + '</option>').join('');

    // level chips for the scope: per-file uses scanned level counts
    let levels;
    if (sel) {
      const lt = new LT.LevelTally();
      const lc = selStats.levelCounts || {};
      for (const key of Object.keys(lc)) {
        const lvl = key === 'null' ? null : key;
        for (let i = 0; i < lc[key]; i++) lt.add(lvl);
      }
      levels = lt.chipList();
    } else {
      levels = tally.chipList();
    }
    const maxL = Math.max(1, ...levels.map((l) => l.count));
    const tags = topBy(recs, (r) => r.tag, 12);
    const msgs = topMessages(recs, 12);
    const issues = issueScan(recs);
    const censusRules = engine.rules.concat(engine.custom.filter((r) => r.enabled && r.re));
    const census = LT.collectPiiCensus(recs, censusRules, { maxSamplesPerType: 25, maskText: (s) => engine.maskLine(s) });
    // the open category survives a file-scope change when it still has matches
    if (censusOpenType && !census.some((g) => g.type === censusOpenType)) censusOpenType = null;

    const cards = sel
      ? stat('Lines', selStats.total) + stat('Kept', selStats.kept) + stat('Dropped', selStats.dropped) +
        stat('In memory', recs.length) + stat('Bytes', LT.fmtBytes(selStats.bytes))
      : stat('Files', files.length) + stat('Lines', st.totalLines) + stat('Kept', st.keptTotal) +
        stat('Dropped', st.dropped) + stat('In memory', st.keptInMemory) + stat('Bytes', LT.fmtBytes(st.bytes));

    p.innerHTML =
      '<h2>Overview' + (sel ? ' — ' + esc(fileDisplayName(sel)) : '') + '</h2>' +
      '<div class="rowline"><label class="muted">file: <select id="analysis-file">' + fileOpts + '</select></label>' +
      '<span class="muted">scopes every section below</span></div>' +
      '<div class="card-row">' + cards + '</div>' +
      '<div class="two-col"><div>' +
      '<h2>Levels (scanned lines)</h2>' +
      levels.map((l) => '<div class="hbar"><span style="min-width:18px">' + (l.id === '__' ? '—' : l.id) + '</span><div class="bar" style="width:' + (l.count / maxL * 70) + '%"></div>' + l.count + '</div>').join('') +
      '<h2>Time histogram (kept lines)</h2><canvas id="histo" width="600" height="120"></canvas>' +
      '</div><div>' +
      '<h2>Top tags</h2>' + (tags.length ? tags.map((t) => '<div class="hbar"><span style="min-width:120px">' + esc(t.k) + '</span><div class="bar" style="width:' + (t.n / tags[0].n * 50) + '%"></div>' + t.n + '</div>').join('') : '<span class="muted">none</span>') +
      '<h2>Top message shapes</h2>' + (msgs.length ? msgs.map((t) => '<div class="hbar"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(t.k) + '</span><b>' + t.n + '</b></div>').join('') : '<span class="muted">none</span>') +
      '</div></div>' +
      '<h2>Issue scan</h2>' +
      '<details class="issue-config"><summary class="muted">How it works / configure rules</summary>' +
      '<p class="muted" style="margin:6px 0">Each rule is a case-insensitive keyword pattern scanned against every kept line of the selected scope (first match wins per line, first 200 shown). Click a result to jump to the line. Rules are editable and saved.</p>' +
      '<div id="issue-groups">' + issueGroupRows() + '</div>' +
      '<div class="rowline"><button id="btn-issue-add">+ Add rule</button><button id="btn-issue-restore" title="restore the built-in keyword groups">Restore defaults</button></div>' +
      '</details>' +
      (issues.length ? issueTreeHtml(issues) : '<span class="muted">no issue keywords found</span>') +
      '<h2>PII census (analysis sample)</h2>' +
      (census.length
        ? '<div class="card-row">' + census.map((g) =>
            '<button type="button" class="stat-card census-card" data-census="' + esc(g.type) + '"' +
            ' aria-expanded="' + (censusOpenType === g.type) + '" aria-controls="census-panel">' +
            '<span class="v">' + g.count + '</span><span class="k">' + esc(g.label) + '</span>' +
            '<span class="census-hint">View samples <span aria-hidden="true">›</span></span></button>').join('') + '</div>' +
          '<div id="census-panel" role="region" aria-label="PII sample details"></div>'
        : '<span class="muted">no PII found in this scope</span>');

    const fileSel = p.querySelector('#analysis-file');
    fileSel.value = sel;
    fileSel.onchange = () => { state.analysisFile = fileSel.value; renderAnalysis(); };

    drawHistogram(recs);
    const issueBySeq = new Map(issues.map((it) => [String(it.seq), it]));
    p.querySelectorAll('.issue').forEach((el) => {
      el.onclick = () => { const it = issueBySeq.get(el.dataset.seq); if (it && it.rec) jumpToRecord(it.rec); };
    });
    bindIssueEditor(p);
    p.querySelectorAll('.census-card').forEach((el) => {
      el.onclick = () => {
        censusOpenType = censusOpenType === el.dataset.census ? null : el.dataset.census;
        renderCensusPanel(p, census);
      };
    });
    renderCensusPanel(p, census);
  }

  function issueGroupRows() {
    return state.issueGroups.map((g, i) =>
      '<div class="rowline" data-ig="' + i + '">' +
      '<input type="checkbox" class="toggle" data-ig-i="' + i + '" data-ig-k="on"' + (g.on ? ' checked' : '') + '>' +
      '<input type="text" data-ig-i="' + i + '" data-ig-k="kind" value="' + esc(g.kind) + '" style="width:110px">' +
      '<input type="text" data-ig-i="' + i + '" data-ig-k="pattern" value="' + esc(g.pattern) + '" style="flex:1;min-width:200px;font-family:var(--mono);font-size:12px">' +
      '<button data-ig-del="' + i + '" title="delete rule">✕</button>' +
      '</div>').join('');
  }

  function bindIssueEditor(p) {
    const box = p.querySelector('#issue-groups');
    box.onchange = (e) => {
      const i = Number(e.target.dataset.igI);
      const k = e.target.dataset.igK;
      if (k === undefined || isNaN(i)) return;
      const g = state.issueGroups[i];
      if (!g) return;
      if (k === 'on') g.on = e.target.checked; else g[k] = e.target.value;
      saveState(); renderAnalysis();
    };
    box.onclick = (e) => {
      const i = e.target.dataset ? e.target.dataset.igDel : undefined;
      if (i !== undefined) { state.issueGroups.splice(Number(i), 1); saveState(); renderAnalysis(); }
    };
    p.querySelector('#btn-issue-add').onclick = () => {
      state.issueGroups.push({ kind: 'custom-' + (state.issueGroups.length + 1), pattern: 'CHANGE_ME', on: true });
      saveState(); renderAnalysis();
    };
    p.querySelector('#btn-issue-restore').onclick = () => {
      state.issueGroups = JSON.parse(JSON.stringify(LT.DEFAULT_ISSUE_GROUPS));
      saveState(); renderAnalysis();
    };
  }

  function stat(k, v) { return '<div class="stat-card"><div class="v">' + v + '</div><div class="k">' + k + '</div></div>'; }
  function topBy(records, getter, n) {
    const m = {};
    for (const r of records) { const k = getter(r); if (!k) continue; m[k] = (m[k] || 0) + 1; }
    return Object.keys(m).map((k) => ({ k, n: m[k] })).sort((a, b) => b.n - a.n).slice(0, n);
  }
  function normMsg(msg) {
    return msg
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
      .replace(/0x[0-9a-f]+/gi, '<hex>')
      .replace(/\d+/g, '<n>')
      .replace(/"[^"]*"/g, '<str>')
      .replace(/\s+/g, ' ').trim().slice(0, 90);
  }
  function topMessages(records, n) {
    const m = {};
    for (const r of records) { const k = normMsg(r.msg || r.raw); m[k] = (m[k] || 0) + 1; }
    return Object.keys(m).map((k) => ({ k, n: m[k] })).sort((a, b) => b.n - a.n).slice(0, n);
  }
  function getIssueGroups() {
    return (state.issueGroups || LT.DEFAULT_ISSUE_GROUPS).filter((g) => g.on && g.pattern);
  }
  function issueScan(records) {
    return LT.issueScan(records, getIssueGroups(), fileDisplayName);
  }
  let censusOpenType = null;
  function censusPanelHtml(census) {
    const g = census.find((x) => x.type === censusOpenType);
    if (!g) return '';
    const capped = g.count > g.samples.length;
    return '<div class="census-head">' + esc(g.label) + ' · ' + g.count + ' matches · showing ' + g.samples.length +
      ' example lines' + (capped ? ' (capped at ' + g.samples.length + ')' : '') + '</div>' +
      g.samples.map((s) =>
        '<div class="census-row"><span class="census-loc">' + esc(fileDisplayName(s.fileId)) + ' : ' + s.lineNo + '</span>' +
        '<span class="census-text">' + esc(s.maskedText) + '</span>' +
        '<button type="button" class="census-jump" data-fid="' + esc(s.fileId) + '" data-ln="' + s.lineNo + '">Show in viewer</button></div>').join('');
  }
  function renderCensusPanel(p, census) {
    const panel = p.querySelector('#census-panel');
    if (!panel) return;
    panel.innerHTML = censusPanelHtml(census);
    p.querySelectorAll('.census-card').forEach((el) => el.setAttribute('aria-expanded', String(el.dataset.census === censusOpenType)));
    panel.querySelectorAll('.census-jump').forEach((el) => {
      el.onclick = () => jumpToRecord({ fileId: el.dataset.fid, lineNo: Number(el.dataset.ln) });
    });
  }
  function drawHistogram(recs) {
    const cv = document.getElementById('histo');
    if (!cv) return;
    const css = getComputedStyle(document.body);
    const cAccent = css.getPropertyValue('--accent').trim() || '#0af';
    const cMuted = css.getPropertyValue('--muted').trim() || '#888';
    const cGrid = css.getPropertyValue('--border').trim() || '#333';
    const cWarn = css.getPropertyValue('--warn').trim() || '#fa0';
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(140, cv.clientWidth || 600);
    const H = Math.max(90, cv.clientHeight || 120);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const tsRecs = (recs || store.kept).filter((r) => r.ts);
    if (tsRecs.length < 2) {
      ctx.font = '11px sans-serif';
      ctx.fillStyle = cMuted;
      ctx.fillText('need at least 2 timestamped lines', 8, 16);
      cv.onmousemove = null;
      cv.onmouseleave = null;
      return;
    }

    const toMs = (ts) => {
      const [d, t] = ts.split(' ');
      const [hh, mm, ss] = t.split(':');
      return Number(d.slice(3)) * 86400 + Number(hh) * 3600 + Number(mm) * 60 + Number(ss.split('.')[0]) + Number(ss.split('.')[1] || 0) / 1000;
    };
    const N = 100;
    const lo = toMs(tsRecs[0].ts), hi = toMs(tsRecs[tsRecs.length - 1].ts);
    const span = Math.max(1e-6, hi - lo);
    const counts = new Array(N).fill(0);
    const firstTs = new Array(N);
    const lastTs = new Array(N);
    for (const r of tsRecs) {
      const i = Math.min(N - 1, Math.floor((toMs(r.ts) - lo) / span * N));
      if (firstTs[i] == null) firstTs[i] = r.ts;
      lastTs[i] = r.ts;
      counts[i]++;
    }
    const max = Math.max(...counts, 1);
    const k = Math.pow(10, Math.floor(Math.log10(max)));
    let niceMax = max;
    for (const m of [1, 2, 5, 10]) { const c = m * k; if (c >= max) { niceMax = c; break; } }

    const x0 = 46, x1 = W - 10, y0 = 10, y1 = H - 18;
    const plotW = x1 - x0, plotH = y1 - y0;
    const yFor = (v) => y1 - (v / niceMax) * plotH;
    const xFor = (i) => x0 + (i + 0.5) * (plotW / N);
    const fmtCount = (v) => (v >= 10000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v)));
    const fmtTick = (ms) => {
      const total = Math.floor(ms);
      const days = Math.floor(total / 86400);
      const rem = total - days * 86400;
      const hh = Math.floor(rem / 3600), mm = Math.floor((rem % 3600) / 60);
      return (tsRecs[0].ts.slice(0, 2)) + '-' + String(days).padStart(2, '0') + ' ' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
    };

    let hover = -1;
    function draw() {
      ctx.clearRect(0, 0, W, H);
      ctx.font = '10px sans-serif';
      ctx.textBaseline = 'middle';
      // y gridlines + tick labels (0 / half / max)
      for (let i = 0; i <= 2; i++) {
        const v = niceMax * i / 2;
        const y = yFor(v);
        ctx.strokeStyle = cGrid;
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        ctx.fillStyle = cMuted; ctx.textAlign = 'right';
        ctx.fillText(fmtCount(v), x0 - 4, y);
      }
      // bars (hovered bar highlighted)
      const bw = plotW / N;
      for (let i = 0; i < N; i++) {
        if (!counts[i]) continue;
        const bh = (counts[i] / niceMax) * plotH;
        ctx.fillStyle = i === hover ? cWarn : cAccent;
        ctx.fillRect(x0 + i * bw + 0.5, yFor(counts[i]), Math.max(1, bw - 1), bh);
      }
      // x axis: baseline + time tick labels at ~5 positions
      ctx.strokeStyle = cGrid;
      ctx.beginPath(); ctx.moveTo(x0, y1); ctx.lineTo(x1, y1); ctx.stroke();
      const tickIdx = [0, Math.floor(N * 0.25), Math.floor(N * 0.5), Math.floor(N * 0.75), N - 1];
      tickIdx.forEach((ti, tiPos) => {
        const ts = firstTs[ti] != null ? firstTs[ti] : (lastTs[ti] != null ? lastTs[ti] : null);
        if (ts == null) return;
        ctx.fillStyle = cMuted;
        ctx.textAlign = tiPos === 0 ? 'left' : (tiPos === tickIdx.length - 1 ? 'right' : 'center');
        ctx.fillText(ts.slice(0, 11), Math.min(Math.max(xFor(ti), x0 + 24), x1 - 24), y1 + 8);
      });
      // hover tooltip (only where the bucket has lines)
      if (hover >= 0 && counts[hover] > 0) {
        const from = firstTs[hover] != null ? firstTs[hover].slice(0, 11) : '';
        const to = lastTs[hover] != null ? lastTs[hover].slice(0, 11) : from;
        const text1 = counts[hover] + ' line(s)';
        const text2 = 'from ' + from + (to !== from ? ' to ' + to : '');
        const bw2 = Math.max(ctx.measureText(text1).width, ctx.measureText(text2).width) + 12;
        const bx = Math.min(Math.max(x0 + hover * bw - bw2 / 2, x0), x1 - bw2);
        const by = Math.max(2, yFor(counts[hover]) - 30);
        ctx.fillStyle = css.getPropertyValue('--surface').trim() || '#222';
        ctx.strokeStyle = cGrid;
        ctx.beginPath(); ctx.rect(bx, by, bw2, 26); ctx.fill(); ctx.stroke();
        ctx.fillStyle = css.getPropertyValue('--fg').trim() || '#eee';
        ctx.textAlign = 'left';
        ctx.fillText(text1, bx + 6, by + 9);
        ctx.fillStyle = cMuted;
        ctx.fillText(text2, bx + 6, by + 20);
      }
    }

    cv.onmousemove = (e) => {
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left;
      if (x < x0 || x > x1) { if (hover !== -1) { hover = -1; draw(); } return; }
      const idx = Math.max(0, Math.min(N - 1, Math.floor((x - x0) / (x1 - x0) * N)));
      if (idx !== hover) { hover = idx; draw(); }
    };
    cv.onmouseleave = () => { if (hover !== -1) { hover = -1; draw(); } };

    draw();
  }


  /* ---------------- export ---------------- */
  function syncExportButtons() {
    // selection-only with no rows selected must not export the whole view
    const blocked = $('exp-selection').checked && selection.count === 0;
    ['exp-txt', 'exp-csv', 'exp-json'].forEach((id) => { $(id).disabled = blocked; });
  }

  async function exportRecords(kind) {
    if (exportLock) { flash('export in progress — please wait'); return; }
    const selectionOnly = $('exp-selection').checked;
    const selectionIndices = selection.indices();
    const expectedRevision = lastQueryRevision;
    const prefix = $('exp-prefix').value;
    const name = (base, ext) => LT.timestampedName(new Date(), base, ext);
    let blob, fname, count = 0;
    let sink = null;
    const ac = new AbortController();
    exportAbort = () => ac.abort();
    exportAbortController = ac;
    $('exp-cancel')?.classList.remove('hidden');
    try {
      // open the destination BEFORE any worker request to keep user activation
      sink = await LT.openExportSink({ name: kind === 'bookmarks' ? name('log-triage-bookmarks', 'json') : name('log-triage-extract', kind === 'txt' ? 'log' : kind), mime: kind === 'csv' ? 'text/csv' : kind === 'json' ? 'application/json' : 'text/plain', onDownload: download });
    } catch (err) {
      exportAbort = null;
      flash(err.cancelled ? 'export cancelled' : 'export failed: ' + err.message);
      return;
    }
    exportLock = true;
    const bt = busy('Preparing export…');
    try {
      if (kind === 'bookmarks') {
        const eng = makeExportMasker();
        const maskText = (t) => (state.maskOn ? eng.maskLine(String(t)) : String(t));
        blob = new Blob([JSON.stringify(LT.sanitizeBookmarkPayload(bookmarksStore.toJSON(), maskText), null, 2)], { type: 'application/json' });
        fname = name('log-triage-bookmarks', 'json');
      } else {
        const txtParts = [], csvParts = [], jsonParts = [];
        const batches = iterExportBatches(selectionOnly, selectionIndices, { signal: ac.signal, expectedRevision });
        for await (const batch of batches) {
          if (kind === 'txt') txtParts.push(LT.toText(batch, { prefix }));
          else if (kind === 'csv') { const c = LT.toCsv(batch); csvParts.push(count === 0 ? c : c.slice(c.indexOf('\n') + 1)); }
          else if (kind === 'json') jsonParts.push(JSON.stringify(batch, null, 2).slice(2, -2));
          count += batch.length;
          busyMessage(bt, 'Exporting… ' + count.toLocaleString() + ' lines');
        }
        if (kind === 'txt') { blob = new Blob([txtParts.join('\n')], { type: 'text/plain' }); fname = name('log-triage-extract', 'log'); }
        else if (kind === 'csv') { blob = new Blob([csvParts.join('\n')], { type: 'text/csv' }); fname = name('log-triage-extract', 'csv'); }
        else if (kind === 'json') { blob = new Blob(['[\n' + jsonParts.join(',\n') + '\n]'], { type: 'application/json' }); fname = name('log-triage-extract', 'json'); }
      }
      if (blob) download(blob, fname);
    } catch (err) {
      flash('export failed: ' + err.message);
    } finally {
      $('exp-cancel')?.classList.add('hidden');
      exportAbort = null; exportLock = false;
      doneBusy(bt);
    }
    const note = $('exp-note');
    note.textContent = count.toLocaleString() + ' line(s) exported' + (selectionOnly ? ' (selection only)' : '') + '.';
  }

  /* Archive export: group the masked kept lines by source file and re-pack
   * them with the original (post-extraction) structure, e.g. bundle/a.log. */
  const ARCHIVE_BUFFER_LIMIT = 32 * 1024 * 1024;
  async function exportArchive() {
    let approxBytes = 0;
    const format = $('exp-archive-format').value;
    const note = $('exp-archive-note');
    const selectionOnly = $('exp-selection').checked;
    const selectionIndices = selection.indices();
    const expectedRevision = lastQueryRevision;
    const ac = new AbortController();
    exportAbortController = ac;
    $('exp-archive-cancel')?.classList.remove('hidden');
    const eng = makeExportMasker();
    const fileById = {};
    for (const f of files) fileById[f.id] = f;
    const groups = new Map();
    let total = 0;
    try {
      for await (const batch of iterExportBatches(selectionOnly, selectionIndices, { signal: exportAbortController.signal, expectedRevision })) {
        for (const r of batch) {
          const key = r.fileId;
          if (!groups.has(key)) groups.set(key, { name: (fileById[key] && fileById[key].name) || key + '.log', text: [] });
          const line = state.maskOn ? eng.maskLine(r.raw) : r.raw;
          groups.get(key).text.push(line);
          total++;
          approxBytes += line.length + 1 + 512;
          if (approxBytes > ARCHIVE_BUFFER_LIMIT) {
            const err = new Error('Archive exceeds the buffered limit. Use TXT/CSV with direct file saving, or narrow the export with filters. No archive was created.');
            err.limit = true; throw err;
          }
        }
      }
    } catch (err) { note.textContent = 'archive export failed: ' + err.message; return; }
    const entries = [...groups.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((g) => ({ name: g.name, data: new TextEncoder().encode(g.text.join('\n') + '\n') }));
    if (!entries.length) { note.textContent = 'nothing to export.'; return; }
    exportAbortController = null;
    note.textContent = 'packing ' + entries.length + ' file(s), ' + total.toLocaleString() + ' line(s) as .' + format + '…';
    try {
      const blob = new Blob([await LT.buildArchive(entries, format)], { type: 'application/octet-stream' });
      download(blob, LT.timestampedName(new Date(), 'log-triage-extract', format));
      note.textContent = 'exported ' + entries.length + ' file(s) as .' + format + (format === '7z' ? ' (stored, no recompression)' : '') + '.';
    } catch (err) {
      note.textContent = 'archive export failed: ' + err.message;
    }
  }
  function st() { return store.stats(); }

  function configPayload() {
    const piiCopy = JSON.parse(JSON.stringify(state.pii || {}));
    if (piiCopy.llm) delete piiCopy.llm.apiKey; // never export the API key
    return {
      app: 'log-triage',
      configVersion: 1,
      exportedAt: new Date().toISOString(),
      filters: { rules: state.rules, timeFrom: state.timeFrom, timeTo: state.timeTo },
      masks: { enabled: Object.assign({}, state.maskEnabled), custom: state.customMasks.map((c) => Object.assign({}, c)) },
      issueGroups: state.issueGroups,
      pii: piiCopy,
      cap: state.cap || 100000,
    };
  }

  function exportConfig() {
    const blob = new Blob([JSON.stringify(configPayload(), null, 2)], { type: 'application/json' });
    download(blob, LT.timestampedName(new Date(), 'log-triage-config', 'json'));
    $('config-status').textContent = 'configuration exported';
    setTimeout(() => { $('config-status').textContent = ''; }, 4000);
  }

  function applyConfig(cfg) {
    const applied = [];
    if (cfg.filters && Array.isArray(cfg.filters.rules)) {
      state.rules = cfg.filters.rules.map(normalizeRule);
      if (typeof cfg.filters.timeFrom === 'string') { state.timeFrom = cfg.filters.timeFrom; $('time-from').value = state.timeFrom; }
      if (typeof cfg.filters.timeTo === 'string') { state.timeTo = cfg.filters.timeTo; $('time-to').value = state.timeTo; }
      applyFilters(); renderRules();
      applied.push('filters');
    }
    if (cfg.masks) {
      if (cfg.masks.enabled && typeof cfg.masks.enabled === 'object') {
        for (const id of Object.keys(cfg.masks.enabled)) {
          if (id in state.maskEnabled) state.maskEnabled[id] = !!cfg.masks.enabled[id];
        }
        applied.push('mask rules');
      }
      if (Array.isArray(cfg.masks.custom)) {
        state.customMasks = cfg.masks.custom.map((c) => Object.assign({ name: 'custom', pattern: '', replacement: '', enabled: true }, c));
        applied.push('custom masks');
      }
      syncMasksFromState(); renderMasks();
    }
    if (Array.isArray(cfg.issueGroups)) {
      state.issueGroups = cfg.issueGroups.map((g) => Object.assign({ kind: 'group', pattern: '', on: true }, g));
      renderAnalysis();
      applied.push('issue-scan rules');
    }
    if (cfg.cap && Number(cfg.cap) >= 1000) {
      state.cap = Number(cfg.cap);
      store.cap = state.cap;
      applied.push('kept-line cap');
    }
    saveState(); rebuildView();
    return applied;
  }

  function renderConfigSummary() {
    const enabledMasks = LT.builtinRuleIds().filter((id) => state.maskEnabled[id] !== false).length;
    const enabledIssues = (state.issueGroups || []).filter((g) => g.on).length;
    $('config-cards').innerHTML =
      stat('Filter rules', state.rules.filter((r) => r.enabled !== false).length) +
      stat('Masks on', enabledMasks + '/' + LT.builtinRuleIds().length) +
      stat('Custom masks', state.customMasks.length) +
      stat('Issue rules on', enabledIssues + '/' + (state.issueGroups || []).length) +
      stat('Analysis sample limit', state.cap || 100000) +
      stat('Presets', Object.keys(state.presets).length);
  }

  function importConfigFile(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const cfg = JSON.parse(fr.result);
        if (!cfg || typeof cfg !== 'object' || (!cfg.filters && !cfg.masks && !Array.isArray(cfg.issueGroups))) {
          throw new Error('not a log-triage config file');
        }
        const applied = applyConfig(cfg);
        $('config-status').textContent = 'config imported: ' + (applied.join(', ') || 'empty config');
      } catch (e) {
        $('config-status').textContent = 'import failed: ' + e.message;
      }
    };
    fr.onerror = () => { $('config-status').textContent = 'could not read file'; };
    fr.readAsText(file);
  }

  function st() { return store.stats(); }
  function exportRg() {
    const rows = [];
    document.querySelectorAll('#search-results .sr-row').forEach((el) => {
      rows.push({ file: el.dataset.file, lineNo: Number(el.dataset.ln), text: el.querySelector('.srx').textContent, isMatch: el.classList.contains('hit') });
    });
    if (!rows.length) { $('exp-note').textContent = 'no search results on screen to export'; return; }
    download(new Blob([LT.toRgText(rows)], { type: 'text/plain' }), LT.timestampedName(new Date(), 'log-triage-search', 'txt'));
  }
  function download(blob, fname) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /* ---------------- misc UI ---------------- */
  function jumpTo(idx) {
    switchTab('viewer');
    const v = viewer();
    let y;
    if (state.wrapOn) {
      measureWrap();
      y = (heightSum && heightSum.length > idx) ? heightSum[idx] : 0;
    } else {
      y = idx * ROW_H;
    }
    v.scrollTop = Math.max(0, topOffset() + y - v.clientHeight / 2);
    selection.click(idx);
    renderRows(); updateStatus();
    if (view[idx] && state.drawerOn) showDrawer(view[idx]);
  }

  /** Jump from a search-result row to the line in the viewer. */
  /** bring a record into the viewer: switch file/filters if needed, then jump */
  async function jumpToRecord(rec) {
    if (!rec) return false;
    let located = await paging.request('locate', { fileId: rec.fileId, lineNo: rec.lineNo });
    if (located.at < 0) {
      state.activeFile = rec.fileId; state.viewMode = 'file'; $('view-mode').value = 'file';
      state.showOnlyBookmarked = false; state.quick = ''; $('quick').value = ''; filter.quick = null; filter.compileQuick();
      state.levels = []; filter.setLevels([]); state.timeFrom = state.timeTo = filter.timeFrom = filter.timeTo = ''; $('time-from').value = $('time-to').value = '';
      state.rules = state.rules.map((r) => Object.assign({}, r, { enabled: false })); filter.setRules(state.rules); saveState();
      await rebuildView();
      located = await paging.request('locate', { fileId: rec.fileId, lineNo: rec.lineNo });
    }
    if (located.at < 0) { flash('Line could not be found. Reload the source file.'); return false; }
    switchTab('viewer');
    const start = Math.floor(located.at / PAGE_SIZE) * PAGE_SIZE;
    if (start !== pageStart) await loadPage(start);
    jumpTo(located.at - pageStart); return true;
  }

  async function jumpFromSearch(row) {
    // prefer the row's file id (stable across same-named files), fall back to name
    const f = files.find((f) => f.id === row.dataset.fid)
      || files.find((f) => f.name === row.dataset.file);
    if (!f) return;
    await jumpToRecord({ fileId: f.id, lineNo: Number(row.dataset.ln) });
  }

  async function goToLine() {
    const target = Number($('goto-ln').value);
    const f = files.find((f) => f.id === state.activeFile) || files[0];
    if (!f || !Number.isInteger(target) || target < 1 || target > f.lines) { flash('Enter a line between 1 and ' + (f?.lines || 0)); return; }
    await jumpToRecord({ fileId: f.id, lineNo: target });
  }

  function switchTab(name) {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
    // Filtering can finish while this tab is hidden. Its zero clientHeight
    // intentionally renders only the five overscan rows, so fill the real
    // viewport once the browser has applied the visible-tab layout.
    if (name === 'viewer') requestAnimationFrame(renderRows);
    if (name === 'analysis') renderAnalysis();
    if (name === 'masks') renderMasks();
    if (name === 'filters') renderRules();
    if (name === 'config') renderConfigSummary();
  }

  function setMask(on) {
    state.maskOn = on;
    $('btn-mask').textContent = 'Mask: ' + (on ? 'ON' : 'OFF');
    $('btn-mask').classList.toggle('on', on);
    displayCache = new Map();
    saveState(); renderRows();
  }
  function setWrap(on) {
    state.wrapOn = on;
    $('btn-wrap').textContent = 'Wrap: ' + (on ? 'ON' : 'OFF');
    $('btn-wrap').classList.toggle('on', on);
    // nowrap keeps long lines on one scrollable row; wrap clips to the column
    viewer().classList.toggle('nowrap', !on);
    invalidateHeights(); saveState(); renderRows();
  }
  function setSearchWrap(on) {
    // the Search tab keeps its own wrap preference, independent of the viewer's
    state.srWrapOn = on;
    $('btn-sr-wrap').textContent = 'Wrap: ' + (on ? 'ON' : 'OFF');
    $('btn-sr-wrap').classList.toggle('on', on);
    const box = $('search-results');
    if (box) box.classList.toggle('nowrap', !on);
    saveState();
  }
  let zenHintTimer = null;
  function setZen(on) {
    // session-only focus mode: hides header, sidebar, chips, toolbar, pager
    // and status bar so the viewer fills the window. Not persisted — a
    // reload must never start hidden. Exits: Esc, the floating ✕ Zen button,
    // or the toolbar Zen button again.
    state.zenOn = !!on;
    document.body.classList.toggle('zen', state.zenOn);
    $('btn-zen').classList.toggle('on', state.zenOn);
    const hint = $('zen-hint');
    if (zenHintTimer) { clearTimeout(zenHintTimer); zenHintTimer = null; }
    if (state.zenOn) {
      hint.textContent = 'Zen mode — Esc or the ✕ button exits';
      hint.classList.add('show');
      zenHintTimer = setTimeout(() => hint.classList.remove('show'), 2600);
    } else {
      hint.classList.remove('show');
    }
    invalidateHeights();
    renderRows();
  }
  function setDrawer(on) {
    // line-click detail drawer: ON by default; OFF keeps clicks selection-only
    // so highlighted text can be copied without the drawer covering it
    state.drawerOn = on;
    const btn = $('btn-drawer');
    if (btn) { btn.textContent = 'Drawer: ' + (on ? 'ON' : 'OFF'); btn.classList.toggle('on', on); }
    if (!on && $('drawer').classList.contains('open')) $('drawer').className = '';
    saveState();
  }
  function setFollow(on) {
    state.follow = on;
    $('btn-follow').textContent = 'Follow: ' + (on ? 'ON' : 'OFF');
    $('btn-follow').classList.toggle('on', on);
    if (on) loadPage(Math.max(0, Math.floor((filteredCount - 1) / PAGE_SIZE) * PAGE_SIZE), true);
    saveState();
  }

  function setBmOnly(on) {
    state.showOnlyBookmarked = on;
    saveState(); rebuildView();
  }

  function flash(msg, ms) {
    $('st-progress').textContent = msg;
    setTimeout(() => { $('st-progress').textContent = ''; }, ms || 4000);
  }
  function syncRgFromState() {
    $('rg-fixed').checked = state.rg.fixed; $('rg-word').checked = state.rg.word;
    $('rg-invert').checked = state.rg.invert; $('rg-case').value = state.rg.caseMode;
  }

  function filterQuickInit() {
    filter.quick = state.quick ? { pattern: state.quick, fixed: false, caseSensitive: false } : null; filter.compileQuick();
    filter.setLevels(state.levels);
  }

  /* ---------------- selftest ---------------- */
  function runSelfTest() {
    const app = document.getElementById('app');
    app.innerHTML = '<div id="selftest"><h1>Log Triage self-test</h1><div id="st-body">running…</div></div>';
    const body = document.getElementById('st-body');
    const cases = (LT.CASES && LT.CASES.CASES) || [];
    let pass = 0, fail = 0;
    const rows = [];
    for (const c of cases) {
      try { c.fn(); pass++; rows.push('<div class="st-pass">ok — [' + c.group + '] ' + esc(c.name) + '</div>'); }
      catch (e) { fail++; rows.push('<div class="st-fail">FAIL — [' + c.group + '] ' + esc(c.name) + ': ' + esc(e.message) + '</div>'); }
    }
    const themeErrs = LT.themeCompletenessErrors();
    if (themeErrs.length) { fail++; rows.unshift('<div class="st-fail">FAIL — themes: ' + esc(themeErrs.join('; ')) + '</div>'); }
    else { pass++; rows.unshift('<div class="st-pass">ok — [themes] all six palettes complete</div>'); }
    body.innerHTML = '<p><b>' + pass + ' passed, ' + fail + ' failed</b> (' + cases.length + ' logic cases + theme check)</p>' + rows.join('');
  }

  /* ---------------- universal inline ✕ clear for text inputs ---------------- */
  /* Wraps a text input in a .clr-wrap span (transferring flex styles so row
   * layout is preserved) and appends an ✕ button that empties the field and
   * re-fires input/change so the app's live filters react. Dense rule-table
   * inputs stay plain because wrapping them changes automatic column sizing. */
  function makeClearable(input) {
    if (!input || input.dataset.clearable === '1' || input.type !== 'text' || input.closest('table.rules')) return;
    const wasFocused = document.activeElement === input;
    input.dataset.clearable = '1';
    const wrap = document.createElement('span');
    wrap.className = 'clr-wrap';
    const inline = input.getAttribute('style') || '';
    if (inline.includes('flex')) {
      wrap.setAttribute('style', inline);
      input.removeAttribute('style');
    }
    input.before(wrap);
    wrap.append(input);
    // preserve row layout: a CSS/inline flex on the input must move to the
    // wrapper, which is now the flex child of the row
    const cs = getComputedStyle(input);
    if (cs.flex && cs.flex !== '0 1 auto') {
      wrap.style.flex = cs.flex;
      if (cs.minWidth && cs.minWidth !== 'auto') wrap.style.minWidth = cs.minWidth;
      if (cs.maxWidth && cs.maxWidth !== 'none') wrap.style.maxWidth = cs.maxWidth;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'clr-btn hidden';
    btn.title = 'clear';
    btn.textContent = '✕';
    btn.tabIndex = -1;
    wrap.append(btn);
    const sync = () => btn.classList.toggle('hidden', !input.value);
    input.addEventListener('input', sync);
    btn.addEventListener('click', () => {
      input.value = '';
      sync();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.focus();
    });
    sync();
    // Dynamically rendered fields are decorated on their first focusin. Moving
    // the input into the wrapper blurs it, so restore the user's active field.
    if (wasFocused) input.focus({ preventScroll: true });
  }

  /* ---------------- boot ---------------- */
  function boot() {
    loadState();
    state.rules = (state.rules || []).map(normalizeRule);
    filter.setRules(state.rules.map((r, i) => Object.assign({ id: 'r' + i }, r)));
    refreshHighlights();
    store.cap = state.cap || 100000;
    if (!Array.isArray(state.issueGroups)) {
      state.issueGroups = JSON.parse(JSON.stringify(LT.DEFAULT_ISSUE_GROUPS));
    } else {
      // migration: persisted groups from an older build miss newer built-in
      // rules (e.g. suspend-to-RAM) — append any default group that is absent
      for (const d of LT.DEFAULT_ISSUE_GROUPS) {
        if (!state.issueGroups.some((g) => g.kind === d.kind)) {
          state.issueGroups.push(JSON.parse(JSON.stringify(d)));
        }
      }
    }
    if (location.search.indexOf('selftest') >= 0) { runSelfTest(); return; }

    // --- theme icon + dropdown (replaces the old <select>; fits the mobile header) ---
    document.body.dataset.theme = state.theme;
    const themeBtn = $('theme-btn');
    const themeMenu = $('theme-menu');
    const renderThemeMenu = () => {
      themeMenu.innerHTML = LT.themeNames().map((n) =>
        '<button type="button" class="theme-opt' + (n === state.theme ? ' active' : '') + '" data-value="' + n + '" role="option" aria-selected="' + (n === state.theme) + '">' +
        esc(LT.THEMES[n].label) + '<span class="tick">✓</span></button>').join('');
    };
    const closeThemeMenu = () => { themeMenu.classList.add('hidden'); themeBtn.setAttribute('aria-expanded', 'false'); };
    const setTheme = (n) => {
      state.theme = n;
      document.body.dataset.theme = n;
      renderThemeMenu();
      saveState();
    };
    renderThemeMenu();
    themeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = themeMenu.classList.toggle('hidden');
      themeBtn.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
    themeMenu.addEventListener('click', (e) => {
      const opt = e.target.closest('.theme-opt');
      if (!opt) return;
      setTheme(opt.dataset.value);
      closeThemeMenu();
    });
    document.body.addEventListener('click', closeThemeMenu);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeThemeMenu(); });

    // --- PII Providers tab ---
    const piiSel = $('pii-provider');
    piiSel.value = state.pii.active;
    const applyPiiWarning = () => {
      const remote = state.pii.active !== 'local';
      $('pii-remote-warn').classList.toggle('hidden', !remote);
      $('pii-remote-warn').textContent = 'REMOTE — data leaves this machine';
      $('pii-presidio-box').classList.toggle('hidden', state.pii.active !== 'presidio');
      $('pii-llm-box').classList.toggle('hidden', state.pii.active !== 'llm');
    };
    applyPiiWarning();
    piiSel.onchange = () => {
      state.pii.active = piiSel.value;
      applyPiiWarning(); saveState();
    };
    const piiFields = [
      ['pii-presidio-url', 'presidio', 'url'],
      ['pii-presidio-path', 'presidio', 'path'],
      ['pii-presidio-lang', 'presidio', 'language'],
      ['pii-presidio-threshold', 'presidio', 'threshold', Number],
      ['pii-presidio-timeout', 'presidio', 'timeoutMs', Number],
      ['pii-llm-url', 'llm', 'url'],
      ['pii-llm-key', 'llm', 'apiKey'],
      ['pii-llm-model', 'llm', 'model'],
      ['pii-llm-max', 'llm', 'maxLines', Number],
      ['pii-llm-temp', 'llm', 'temperature', Number],
      ['pii-llm-timeout', 'llm', 'timeoutMs', Number],
      ['pii-proxy-url', 'proxy', 'url'],
    ];
    piiFields.forEach(([id, sect, key, Conv]) => {
      const el = $(id);
      el.value = state.pii[sect] && state.pii[sect][key] != null ? state.pii[sect][key] : '';
      el.onchange = () => {
        const v = Conv ? Conv(el.value) : el.value;
        if (!state.pii[sect]) state.pii[sect] = {};
        state.pii[sect][key] = v;
        saveState();
      };
    });
    $('pii-proxy-on').onchange = (e) => {
      state.pii.proxy.enabled = e.target.checked;
      saveState();
    };
    const proxyFetch = (url, opts) => {
      const target = state.pii.proxy.enabled && state.pii.proxy.url
        ? state.pii.proxy.url.replace(/\/+$/, '') + '/' + url
        : url;
      return fetch(target, opts);
    };
    $('btn-pii-test').onclick = async () => {
      const kind = state.pii.active;
      const s = kind === 'presidio' ? state.pii.presidio : state.pii.llm;
      const st = $('pii-test-status');
      st.textContent = 'testing…';
      st.textContent = kind === 'local' ? 'local engine — always available'
        : JSON.stringify(await LT.testConnection(Object.assign({ kind }, s, { proxyUrl: state.pii.proxy.enabled ? state.pii.proxy.url : '' }), proxyFetch));
    };
    $('btn-pii-scan').onclick = async () => {
      const kind = state.pii.active;
      if (kind === 'local') { flash('local regex engine already runs in real time'); return; }
      const sampleN = Math.min(2000, Number($('pii-scan-sample').value) || 2000);
      const sample = store.kept.slice(0, sampleN).map((r) => r.raw);
      const st = $('pii-findings');
      st.innerHTML = '<span class="muted">scanning ' + sample.length + ' lines…</span>';
      try {
        const prov = state.pii.active === 'presidio'
          ? LT.createRemoteAnalyzer('presidio', Object.assign({}, state.pii.presidio, {
              proxyUrl: state.pii.proxy.enabled ? state.pii.proxy.url : '',
            }), { fetchImpl: proxyFetch })
          : LT.createRemoteAnalyzer('llm', Object.assign({}, state.pii.llm, {
              proxyUrl: state.pii.proxy.enabled ? state.pii.proxy.url : '',
            }), { fetchImpl: proxyFetch });
        const findings = await prov.analyze(sample);
        const byType = {};
        for (const f of findings) byType[f.type] = (byType[f.type] || 0) + 1;
        st.innerHTML = Object.keys(byType).map((k) =>
          '<div class="stat-card"><div class="v">' + byType[k] + '</div><div class="k">' + esc(k) + '</div></div>'
        ).join('') || '<span class="muted">no findings</span>';
      } catch (err) {
        st.innerHTML = '<span class="rule-err">scan failed: ' + esc(err.message) + '</span>';
      }
    };

    const applySide = () => {
      document.getElementById('main').classList.toggle('side-hidden', !!state.sideHidden);
      $('btn-side').classList.toggle('on', !state.sideHidden);
    };
    applySide();

    // drag handle between the Files and Bookmarks panels
    const dragEl = $('side-drag');
    const bmSection = $('bm-section');
    if (state.bmPanelH) bmSection.style.height = state.bmPanelH + 'px';
    dragEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = bmSection.offsetHeight;
      dragEl.classList.add('active');
      dragEl.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const maxH = Math.max(120, document.getElementById('sidebar').clientHeight - 190);
        const h = Math.max(80, Math.min(startH + (startY - ev.clientY), maxH));
        state.bmPanelH = h;
        bmSection.style.height = h + 'px';
      };
      const up = () => {
        dragEl.classList.remove('active');
        dragEl.removeEventListener('pointermove', move);
        dragEl.removeEventListener('pointerup', up);
        saveState();
      };
      dragEl.addEventListener('pointermove', move);
      dragEl.addEventListener('pointerup', up);
    });
    // narrow screens start with the files panel collapsed (it opens as an overlay drawer)
    if (window.innerWidth <= 760 && !state.sideTouched) state.sideHidden = true;
    $('btn-side').onclick = () => {
      state.sideHidden = !state.sideHidden;
      state.sideTouched = true;
      applySide(); saveState(); invalidateHeights(); renderRows();
    };
    window.addEventListener('resize', () => {
      if (window.innerWidth <= 760 && !state.sideTouched) state.sideHidden = true;
      applySide(); invalidateHeights(); renderRows();
    });

    document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });

    $('page-first').onclick = () => loadPage(0);
    $('page-prev').onclick = () => loadPage(pageStart - PAGE_SIZE);
    $('page-next').onclick = () => loadPage(pageStart + PAGE_SIZE);
    $('page-last').onclick = () => loadPage(Math.floor(Math.max(0, filteredCount - 1) / PAGE_SIZE) * PAGE_SIZE, true);
    $('page-number').onkeydown = (e) => { if (e.key === 'Enter') loadPage(Math.min(Math.max(0, Math.ceil(filteredCount / PAGE_SIZE) - 1), Math.max(0, (Number(e.target.value) || 1) - 1)) * PAGE_SIZE); };
    $('viewer-cancel').onclick = () => { ingestAbort = true; ++viewToken; ++pageToken; paging.request('cancel').catch(pagingError); doneBusy(busyToken); flash('Cancelled'); };
    let wheelPaging = false;
    viewer().addEventListener('wheel', async (e) => {
      if (wheelPaging || $('viewer-busy').classList.contains('active')) return;
      const v = viewer();
      if (e.deltaY > 0 && v.scrollTop + v.clientHeight >= v.scrollHeight - 2 && pageStart + PAGE_SIZE < filteredCount) { wheelPaging = true; await loadPage(pageStart + PAGE_SIZE); setTimeout(() => { wheelPaging = false; }, 150); }
      else if (e.deltaY < 0 && v.scrollTop <= 0 && pageStart > 0) { wheelPaging = true; await loadPage(pageStart - PAGE_SIZE, true); setTimeout(() => { wheelPaging = false; }, 150); }
    }, { passive: true });
    viewer().tabIndex = 0;
    viewer().addEventListener('keydown', (e) => {
      if ((e.ctrlKey && e.key === 'Home') || (e.key === 'PageUp' && viewer().scrollTop <= 0)) { e.preventDefault(); loadPage(e.ctrlKey ? 0 : pageStart - PAGE_SIZE, !e.ctrlKey); }
      if ((e.ctrlKey && e.key === 'End') || (e.key === 'PageDown' && viewer().scrollTop + viewer().clientHeight >= viewer().scrollHeight - 2)) { e.preventDefault(); loadPage(e.ctrlKey ? Math.floor(Math.max(0, filteredCount - 1) / PAGE_SIZE) * PAGE_SIZE : pageStart + PAGE_SIZE, e.ctrlKey); }
    });
    $('btn-pick').onclick = () => $('file-input').click();
    $('file-input').onchange = (e) => { loadFiles(Array.from(e.target.files)); e.target.value = ''; };
    $('btn-demo').onclick = () => {
      const f = new File([LT_DEMO_LOG], 'demo.log', { type: 'text/plain' });
      loadFiles([f]);
    };
    $('btn-paste').onclick = () => {
      const t = $('paste-area').value;
      if (!t.trim()) return;
      loadFiles([new File([t], 'pasted.log', { type: 'text/plain' })]);
    };
    $('file-filter').oninput = (e) => { fileFilterText = e.target.value; renderFiles(); };
    $('file-sort').onchange = (e) => { fileSortMode = e.target.value; renderFiles(); };
    $('reload-cached').onclick = () => reloadAllCached();
    $('clear-files').onclick = async () => {
      ++viewToken; ++pageToken; ingestAbort = true;
      fileFilterText = ''; $('file-filter').value = '';
      await paging.request('cancel');
      for (const f of files) await paging.request('remove', { fileId: f.id });
      files.slice().forEach((f) => store.removeFile(f.id));
      store._keptTotal = 0;
      files.length = 0;
      cacheEntries = [];
      await LT.cacheClear();
      bookmarksStore.removeAll();
      state.activeFile = null;
      onKeptChanged(); renderBookmarks(); renderFiles(); saveState();
    };
    const dz = $('dropzone');
    ;['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ;['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', (e) => {
      e.stopPropagation();
      e.preventDefault();
      dz.classList.remove('drag');
      handleDrop(e.dataTransfer);
    });
    document.body.addEventListener('dragover', (e) => e.preventDefault());
    document.body.addEventListener('drop', (e) => {
      e.preventDefault();
      handleDrop(e.dataTransfer);
    });

    // debounced: start matching only after typing pauses
    let quickTimer = null;
    $('quick').oninput = () => {
      state.quick = $('quick').value;
      if (quickTimer) clearTimeout(quickTimer);
      quickTimer = setTimeout(() => {
        if (state.quick.trim()) state.quickHistory = pushTerm(state.quickHistory, state.quick);
        filter.quick = state.quick ? { pattern: state.quick, fixed: false, caseSensitive: false } : null; filter.compileQuick();
        saveState(); rebuildView();
      }, 200);
    };
    attachHistory($('rg-pattern'), 'searchHistory');
    attachHistory($('quick'), 'quickHistory');
    $('btn-sr-wrap').onclick = () => setSearchWrap(!state.srWrapOn);
    $('btn-zen').onclick = () => setZen(!state.zenOn);
    $('zen-fab').onclick = () => setZen(false);
    $('btn-drawer').onclick = () => setDrawer(!state.drawerOn);
    $('btn-mask').onclick = () => setMask(!state.maskOn);
    $('btn-wrap').onclick = () => setWrap(!state.wrapOn);
    $('btn-follow').onclick = () => setFollow(!state.follow);
    $('view-mode').onchange = () => {
      state.viewMode = $('view-mode').value;
      // keep the invariant: 'file' mode always has an active file, merged none
      if (state.viewMode === 'merged') state.activeFile = null;
      else if (!state.activeFile && files.length) state.activeFile = files[0].id;
      saveState(); renderFiles(); rebuildView();
    };
    $('btn-copy').onclick = copySelection;
    $('bookmark-list').addEventListener('click', (e) => {
      const entry = e.target.closest('.bm-entry');
      if (!entry) return;
      const row = bmRows[Number(entry.dataset.idx)];
      if (!row) return;
      if (e.target.closest('.fx')) {
        removeBookmark(row.key, row.lineNo);
        flash('bookmark removed (line ' + row.lineNo + ')');
        return;
      }
      // resolve the bookmark's file identity (name|size|first-line) to the
      // current runtime file — after a reload fileIds are new, the key is not
      const target = files.find((f) => bookmarkKeyFor(f.id) === row.key);
      if (target) { jumpToRecord({ fileId: target.id, lineNo: row.lineNo }); return; }
      flash('that file is not loaded right now — bookmark kept for later');
      setTimeout(() => { $('st-progress').textContent = ''; }, 4000);
    });
    $('clear-bookmarks').onclick = clearAllBookmarks;

    // debounced: start matching only after typing pauses
    let rgTimer = null;
    $('rg-pattern').oninput = () => {
      state.rgPattern = $('rg-pattern').value;
      $('search-progress').textContent = '…';
      if (rgTimer) clearTimeout(rgTimer);
      rgTimer = setTimeout(() => {
        if (state.rgPattern.trim()) {
          state.searchHistory = pushTerm(state.searchHistory, state.rgPattern);
          saveState();
        }
        runInstantSearch();
      }, 250);
    };
    ;['rg-fixed', 'rg-word', 'rg-invert', 'rg-case'].forEach((id) => {
      $(id).onchange = () => {
        state.rg = rgOpts();
        saveState(); runInstantSearch();
      };
    });
    $('btn-deepscan').onclick = deepScan;
    $('btn-deep-cancel').onclick = () => { deepAbort = true; };
    $('btn-rg-export').onclick = exportRg;
    const setAllGroups = (open) => {
      document.querySelectorAll('#search-results details.sr-group').forEach((d) => { d.open = open; });
    };
    $('btn-rg-collapse').onclick = () => setAllGroups(false);
    $('btn-rg-expand').onclick = () => setAllGroups(true);
    $('search-results').addEventListener('click', (e) => {
      const row = e.target.closest('.sr-row');
      if (row) jumpFromSearch(row);
    });
    $('goto-ln').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { goToLine(); e.preventDefault(); }
    });

    $('btn-config-export').onclick = exportConfig;
    $('btn-config-import').onclick = () => $('config-file').click();
    $('config-file').onchange = (e) => {
      const f = e.target.files[0];
      if (f) importConfigFile(f);
      e.target.value = '';
    };
    // kept-line cap (Config tab): applies from the next file load
    const capInput = $('cfg-cap');
    capInput.value = state.cap || 100000;
    capInput.onchange = () => {
      const n = Math.max(1000, Number(capInput.value) || 100000);
      capInput.value = n;
      state.cap = n;
      store.cap = n;
      saveState();
      renderConfigSummary();
      flash('Analysis sample limit set to ' + n.toLocaleString() + '; paging always covers the full file');
    };

    $('btn-add-rule').onclick = () => { state.rules.push({ name: 'rule ' + (state.rules.length + 1), pattern: '', caseSensitive: false, action: 'include', enabled: true }); renderRules(); };
    $('btn-add-highlight').onclick = () => {
      const number = state.rules.filter((r) => r.action === 'highlight').length + 1;
      state.rules.push(normalizeRule({ name: 'highlight ' + number, pattern: '', caseSensitive: false, action: 'highlight', enabled: true, matchMode: 'literal', target: 'text', color: LT.DEFAULT_COLOR }));
      saveState(); refreshHighlights(); renderRules();
    };
    ;['time-from', 'time-to'].forEach((id) => { $(id).onchange = applyFilters; });

    $('btn-preset-save').onclick = () => {
      const name = $('preset-sel').value || prompt('preset name');
      if (!name) return;
      state.presets[name] = presetPayload();
      renderPresets(); saveState();
    };
    $('btn-preset-load').onclick = () => {
      const p = state.presets[$('preset-sel').value];
      if (p) { applyPreset(p); saveState(); }
    };
    $('btn-preset-del').onclick = () => {
      delete state.presets[$('preset-sel').value];
      renderPresets(); saveState();
    };
    $('btn-preset-export').onclick = () => {
      const name = $('preset-sel').value || 'preset';
      download(new Blob([JSON.stringify(state.presets[name] || presetPayload(), null, 2)], { type: 'application/json' }), LT.timestampedName(new Date(), 'log-triage-preset-' + name, 'json'));
    };
    $('btn-preset-import').onclick = () => $('preset-file').click();
    $('preset-file').onchange = (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = () => {
        try { applyPreset(JSON.parse(fr.result)); saveState(); } catch (err) { alert('invalid preset: ' + err.message); }
      };
      fr.readAsText(f);
      e.target.value = '';
    };

    $('btn-mask-all').onclick = () => { for (const id of LT.builtinRuleIds()) state.maskEnabled[id] = true; syncMasksFromState(); renderMasks(); rebuildView(); saveState(); };
    $('btn-mask-none').onclick = () => { for (const id of LT.builtinRuleIds()) state.maskEnabled[id] = false; syncMasksFromState(); renderMasks(); rebuildView(); saveState(); };
    $('btn-add-cm').onclick = () => {
      const pattern = $('cm-pattern').value;
      if (!pattern) return;
      state.customMasks.push({ name: $('cm-name').value || 'custom', pattern, replacement: $('cm-repl').value, enabled: true });
      $('cm-pattern').value = ''; $('cm-name').value = ''; $('cm-repl').value = '';
      syncMasksFromState(); renderMasks(); rebuildView(); saveState();
    };
    $('mask-preview-in').oninput = previewMask;

    $('exp-txt').onclick = () => exportRecords('txt');
    $('exp-csv').onclick = () => exportRecords('csv');
    $('exp-json').onclick = () => exportRecords('json');
    $('exp-selection').onchange = syncExportButtons;
    $('exp-bookmarks').onclick = () => exportRecords('bookmarks');
    $('exp-archive').onclick = () => { exportArchive(); };

    // restore UI state
    $('quick').value = state.quick || '';
    $('time-from').value = state.timeFrom || '';
    $('time-to').value = state.timeTo || '';
    $('view-mode').value = state.viewMode;
    if (state.bookmarks) bookmarksStore.fromJSON(state.bookmarks);
    setMask(state.maskOn);
    setWrap(state.wrapOn);
    setFollow(state.follow);
    setSearchWrap(state.srWrapOn !== false);
    setDrawer(state.drawerOn !== false);
    syncMasksFromState(); syncRgFromState();
    renderChips(); renderRules(); renderPresets(); renderFiles(); renderBookmarks(); updateStatus();
    bindViewer();
    applySide();
    restoreCache().catch(() => {});

    // keyboard
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (e.key === 'm' || e.key === 'M') setMask(!state.maskOn);
      else if (e.key === 'w' || e.key === 'W') setWrap(!state.wrapOn);
      else if (e.key === 'b' || e.key === 'B') { if (view.length) toggleBookmark(selection.count ? selection.indices()[0] : Number((viewer().querySelector('.vrow') || { dataset: { idx: 0 } }).dataset.idx || 0)); }
      else if (e.key === 'Escape' && state.zenOn) { setZen(false); e.preventDefault(); }
      else if (e.key === 'Escape') { selection.clear(); $('drawer').className = ''; renderRows(); updateStatus(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'c')) { if (selection.count) { copySelection(); e.preventDefault(); } }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'a')) { selection.selectAll(view.length); renderRows(); updateStatus(); e.preventDefault(); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

    // inline ✕ clear for every text input (static fields + dynamically
    // rendered rows: wrapped lazily on first focus)
    document.querySelectorAll('input[type=text]').forEach(makeClearable);
    document.addEventListener('focusin', (e) => {
      if (e.target && e.target.matches && e.target.matches('input[type=text]')) makeClearable(e.target);
    });

    // test/automation hook: programmatic file loading (used by manual big-file checks)
    if (typeof window !== 'undefined') window.LT_INGEST = (files) => loadFiles(files);

    return { boot, runSelfTest };
}));
