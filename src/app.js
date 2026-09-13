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
    maskOn: true, wrapOn: false, follow: false, viewMode: 'merged', activeFile: null,
    quick: '', rules: [], customMasks: [], maskEnabled: {}, presets: {},
    timeFrom: '', timeTo: '', sideHidden: false, showOnlyBookmarked: false, bmPanelH: 200, issueGroups: null,
    pii: {
      active: 'local',
      presidio: { url: 'http://127.0.0.1:3000', path: '/analyze', language: 'en', threshold: 0.5, entities: '', timeoutMs: 10000 },
      llm: { url: '', apiKey: '', model: '', promptTemplate: 'Return a JSON array of PII findings [{line, start, end, type, score}] for these lines:\n{lines}', maxLines: 50, temperature: 0, timeoutMs: 30000 },
      proxy: { enabled: false, url: '' },
    },
    bookmarks: null, levels: [], rg: { fixed: false, word: false, invert: false, caseMode: 'smart', before: 0, after: 0 },
  });
  let state = defaults();

  function saveState() {
    try {
      // transient view state (quick filter, level chips, time range, search
      // pattern) is deliberately NOT persisted: a new session must start
      // unfiltered, or freshly loaded files can appear invisible
      const { quick, levels, timeFrom, timeTo, rgPattern, showOnlyBookmarked, ...persisted } = state;
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

  const $ = (id) => document.getElementById(id);
  const esc = LT.escapeHtml;

  /* ---------------- ingestion ---------------- */
  const VALVE = 8 * 1024 * 1024;
  let ingestAbort = false;

  async function* chunkIter(file) {
    if (file.stream) {
      const reader = file.stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
      return;
    }
    const FR = window.FileReader || self.FileReader;
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
    const DETECT_AFTER = 1000;
    let sample = [];
    let format = 'plain';
    let detected = false;
    let lineNo = 0;
    const progress = (msg) => { $('st-progress').textContent = msg; };
    const onBytes = (n) => {
      entry.read += n;
      store.addBytes(entry.id, n);
      progress(entry.name + ': ' + LT.fmtBytes(entry.read) + ' / ' + LT.fmtBytes(entry.size));
    };
    const parseAndAdd = (line, no, fastPath) => {
      const rec = LT.parseLine(line, format);
      const kept = fastPath ? true : filter.evaluate({ raw: line, ts: rec.ts, level: rec.level }).kept;
      store.add(entry.id, no, line, rec, kept);
    };
    entry.read = 0;
    store.setFileInfo(entry.id, entry.name, entry.size);
    const fastPath = !filter.rules.some((r) => r.enabled) && !filter.quick &&
      !state.levels.length && !filter.timeFrom && !filter.timeTo;
    for await (const line of streamLines(entry.file, onBytes)) {
      if (ingestAbort) { entry.status = 'cancelled'; return; }
      lineNo++;
      if (!detected) {
        sample.push(line);
        if (sample.length >= DETECT_AFTER) {
          format = LT.detectFormat(sample).format;
          entry.format = format;
          detected = true;
          const base = lineNo - sample.length;
          sample.forEach((l, j) => parseAndAdd(l, base + j + 1, fastPath));
          sample = null;
          renderFiles();
        }
        continue;
      }
      parseAndAdd(line, lineNo, fastPath);
      if ((lineNo & 0x3fff) === 0) await tick(); // yield to UI periodically
    }
    if (!detected && sample) {
      // small file: detection happens at end of stream, then buffered lines parse
      format = LT.detectFormat(sample).format;
      entry.format = format;
      const base = lineNo - sample.length;
      sample.forEach((l, j) => parseAndAdd(l, base + j + 1, fastPath));
    }
    entry.status = 'done';
    entry.lines = lineNo;
    progress('');
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

  async function loadFiles(fileList) {
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
        if (innerFiles) await loadFiles(innerFiles);
        continue;
      }
      const entry = { id: 'f' + Date.now() + '_' + (i++) + '_' + Math.floor(Math.random() * 1e6), name: f.name, size: f.size, file: f, status: 'parsing', format: '…', read: 0 };
      files.push(entry);
      renderFiles();
      await ingestFile(entry);
      renderFiles();
      onKeptChanged();
      if (entry.status === 'done') await cacheLoadedFile(entry, f);
      if (ingestAbort) break;
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

  function renderFiles() {
    const el = $('file-list');
    el.innerHTML = '';
    for (const f of files) {
      const st = store.stats().files[f.id] || { total: 0, kept: 0 };
      const div = document.createElement('div');
      div.className = 'file-item' + (state.activeFile === f.id ? ' active' : '');
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
    for (const c of cacheEntries) {
      if (files.some((f) => f.name === c.name && f.size === c.size)) continue; // superseded by a live load
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
  }

  async function loadCachedFile(c) {
    if (!c.data) { flash('file not found: ' + c.name); return; }
    await loadFiles([new File([c.data], c.name, { type: 'text/plain' })]);
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
  let view = [];            // current visible records
  let seqToIdx = new Map();
  let keptLineMap = new Map(); // "displayName:lineNo" -> record (for jumps)
  let filteredCount = 0;
  let viewMaxLen = 0;       // longest raw line length in the view (chars)
  let charW = 0;            // measured monospace character width (px)

  function onKeptChanged() {
    bmKeyCache.clear(); // kept rows (and thus file identity lines) changed
    filterQuickInit();
    rebuildView();
    renderChips();
    updateStatus();
  }

  function rebuildView() {
    // stale per-file selection (file removed / new load): fall back to merged
    if (state.activeFile && !files.some((f) => f.id === state.activeFile)) {
      state.activeFile = null;
      state.viewMode = 'merged';
      const sel = $('view-mode');
      if (sel) sel.value = 'merged';
    }
    let arr = store.kept.filter((r) => filter.evaluate(r).kept);
    if (state.viewMode === 'file' && state.activeFile) {
      arr = arr.filter((r) => r.fileId === state.activeFile);
    }
    if (state.showOnlyBookmarked) {
      arr = arr.filter((r) => bookmarksStore.has(bookmarkKeyFor(r.fileId), r.lineNo));
    }
    if (state.viewMode === 'merged') {
      arr = LT.mergeTimeline(arr);
    }
    view = arr;
    seqToIdx = new Map(view.map((r, i) => [r.seq, i]));
    keptLineMap = new Map();
    for (const r of store.kept) keptLineMap.set(fileDisplayName(r.fileId) + ':' + r.lineNo, r);
    // widest line in the view drives the nowrap-mode horizontal scroll range
    viewMaxLen = 0;
    for (const r of arr) { if (r.raw.length > viewMaxLen) viewMaxLen = r.raw.length; }
    filteredCount = view.length;
    displayCache = new Map();
    selection.clear();
    invalidateHeights();
    renderFiles(); // refresh active-file highlight (cheap: few items)
    renderChips(); // chips follow the current scope (merged = all files, per-file = active file)
    renderRows();
    updateStatus();
  }

  function displayText(rec) {
    if (displayCache.has(rec.seq)) return displayCache.get(rec.seq);
    const t = state.maskOn ? engine.maskLine(rec.raw) : rec.raw;
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
    const scope = (state.viewMode === 'file' && state.activeFile)
      ? store.kept.filter((r) => r.fileId === state.activeFile)
      : store.kept;
    const bmInView = scope.reduce((n, r) => n + (bookmarksStore.has(bookmarkKeyFor(r.fileId), r.lineNo) ? 1 : 0), 0);
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

  function invalidateHeights() {
    heights = null; heightSum = null;
  }

  function rowHeight(i) {
    if (!state.wrapOn) return ROW_H;
    measureWrap();
    return heights[i] || ROW_H;
  }

  let measureEl = null;
  function measureWrap() {
    if (heights) return;
    const n = view.length;
    heights = new Array(n);
    const v = viewer();
    if (!measureEl) {
      // a real .vrow.wrap clone so measured heights match rendered rows exactly
      measureEl = document.createElement('div');
      measureEl.className = 'vrow wrap';
      measureEl.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;font-family:var(--mono);font-size:12.5px;';
      measureEl.innerHTML = '<div class="vcell bm">☆</div><div class="vcell ln">00000000</div>' +
        '<div class="vcell fl">00000000</div><div class="vcell lv">W</div>' +
        '<div class="vcell txt" style="white-space:inherit"></div>';
      document.body.appendChild(measureEl);
    }
    measureEl.style.display = 'flex';
    measureEl.style.width = v.clientWidth + 'px';
    measureEl.querySelector('.fl').style.display = state.viewMode === 'merged' ? '' : 'none';
    const txtCell = measureEl.querySelector('.txt');
    for (let i = 0; i < n; i++) {
      txtCell.textContent = displayText(view[i]);
      heights[i] = Math.max(ROW_H, measureEl.offsetHeight);
    }
    heightSum = new Array(n + 1); heightSum[0] = 0;
    for (let i = 0; i < n; i++) heightSum[i + 1] = heightSum[i] + heights[i];
  }

  function totalHeight() {
    if (!state.wrapOn) return view.length * ROW_H;
    measureWrap();
    return heightSum[heightSum.length - 1] || 0;
  }

  function findIndexAtOffset(y) {
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
      inner.style.transform = 'translateY(' + (heightSum[start] || 0) + 'px)';
    } else {
      inner.style.transform = 'translateY(' + (start * ROW_H) + 'px)';
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
      const hl = quickSpans(text);
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
    spacer.appendChild(inner);
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

  function quickSpans(text) {
    if (!filter._quickRe) return null;
    // the quick regex is compiled non-global; clone it with /g for span scanning
    const src = filter._quickRe;
    const re = src.global ? src : new RegExp(src.source, src.flags + 'g');
    const spans = [];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      spans.push([m.index, m.index + m[0].length]);
      if (spans.length >= 100) break;
    }
    if (!src.global) re.lastIndex = 0;
    if (!spans.length) return null;
    let out = '', pos = 0;
    for (const [a, b] of spans) {
      out += esc(text.slice(pos, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>';
      pos = b;
    }
    return out + esc(text.slice(pos));
  }

  function updateStatus() {
    const st = store.stats();
    $('st-total').textContent = st.totalLines;
    $('st-kept').textContent = st.keptTotal;
    $('st-shown').textContent = filteredCount;
    $('st-sel').textContent = selection.count;
    $('st-bm').textContent = bookmarksStore.all().length;
    const bmCount = $('bm-count');
    if (bmCount) bmCount.textContent = bookmarksStore.all().length;
    const trim = $('st-trim');
    if (st.trimmed > 0) {
      trim.classList.remove('hidden');
      trim.textContent = 'cap reached — ' + st.trimmed + ' oldest kept lines released from memory (counters remain exact; use Deep scan for full search)';
    } else trim.classList.add('hidden');
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
      else { selection.click(idx); showDrawer(view[idx]); }
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
      if (row) showDrawer(view[Number(row.dataset.idx)]);
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
    d.innerHTML = '<h3>Line ' + rec.lineNo + ' — ' + esc(fileDisplayName(rec.fileId)) +
      '<button onclick="document.getElementById(\'drawer\').className=\'\'">✕</button></h3>' +
      '<dl>' +
      dv('ts', rec.ts) + dv('level', rec.level) + dv('tag', rec.tag) +
      dv('pid', rec.pid) + dv('tid', rec.tid) +
      '<div><dt>masked <button type="button" class="drawer-cp" data-what="masked" title="copy masked line">copy</button></dt><dd>' + esc(maskedLine) + '</dd></div>' +
      '<div><dt>raw <button type="button" class="drawer-cp" data-what="raw" title="copy raw line">copy</button></dt><dd class="raw">' + esc(rec.raw) + '</dd></div>' +
      '</dl>';
    for (const btn of d.querySelectorAll('.drawer-cp')) {
      btn.onclick = async () => {
        const text = btn.dataset.what === 'raw' ? rec.raw : maskedLine;
        try {
          await navigator.clipboard.writeText(text);
          btn.textContent = 'copied ✓';
        } catch (err) {
          btn.textContent = 'copy failed';
        }
        setTimeout(() => { btn.textContent = 'copy'; }, 1500);
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

  function renderSearchRows(res, mode, ms) {
    const out = $('search-results');
    $('search-progress').textContent = res.total + ' match(es) over kept lines in ' + ms.toFixed(0) + ' ms';
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
      (byFile[name] = byFile[name] || []).push({ lineNo: rec.lineNo, ts: rec.ts, text: displayText(rec) });
    }
    out.innerHTML = Object.keys(byFile).map((f) =>
      groupHtml(f, byFile[f].map((r) => srRow(f, r.lineNo, r.ts, r.text, true)).join(''), byFile[f].length)).join('') ||
      '<div class="muted" style="padding:20px">no matches</div>';
  }

  function srRow(file, lineNo, ts, text, isMatch) {
    const cls = isMatch ? 'hit' : 'ctx';
    return '<div class="sr-row ' + cls + '" data-file="' + esc(file) + '" data-ln="' + lineNo + '">' +
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
    deepAbort = false;
    const results = [];
    let scanned = 0;
    for (const entry of files) {
      if (deepAbort) break;
      const ring = [];
      let afterLeft = 0;
      let lineNo = 0;
      for await (const line of streamLines(entry.file, (n) => {
        entry.read += n;
        $('search-progress').textContent = 'deep scan ' + entry.name + ': ' + LT.fmtBytes(entry.read) + ' / ' + LT.fmtBytes(entry.size) + ' — ' + results.length + ' matches';
      })) {
        if (deepAbort) break;
        lineNo++;
        scanned++;
        const masked = state.maskOn ? engine.maskLine(line) : line;
        if (LT.matchLine(s, line)) {
          for (const r of ring) results.push({ file: entry.name, lineNo: r.lineNo, ts: LT.detectTs(r.text), text: state.maskOn ? engine.maskLine(r.text) : r.text, isMatch: false });
          ring.length = 0;
          results.push({ file: entry.name, lineNo, ts: LT.detectTs(line), text: masked, isMatch: true });
          afterLeft = after;
        } else if (afterLeft > 0) {
          results.push({ file: entry.name, lineNo, ts: LT.detectTs(line), text: masked, isMatch: false });
          afterLeft--;
        } else {
          ring.push({ lineNo, text: line });
          while (ring.length > before) ring.shift();
        }
        if (results.length >= cap) { deepAbort = false; break; }
        if ((scanned & 0x3fff) === 0) await tick();
      }
      if (results.length >= cap) break;
    }
    const mode = $('rg-mode').value;
    const byFile = {};
    for (const r of results) (byFile[r.file] = byFile[r.file] || []).push(r);
    const total = results.length;
    const note = results.length >= cap ? ' (capped at ' + cap + ' — refine the pattern)' : '';
    $('search-progress').textContent = 'deep scan: ' + total + ' match(es) over ' + scanned + ' lines' + note;
    if (mode === 'count') {
      out.innerHTML = Object.keys(byFile).map((f) => '<div class="sr-file">' + esc(f) + ': ' + byFile[f].filter((r) => r.isMatch).length + '</div>').join('');
      return;
    }
    if (mode === 'files') {
      out.innerHTML = Object.keys(byFile).map((f) => '<div class="sr-file">' + esc(f) + '</div>').join('');
      return;
    }
    out.innerHTML = Object.keys(byFile).map((f) => {
      const matches = byFile[f].filter((r) => r.isMatch).length;
      return groupHtml(f, byFile[f].map((r) => srRow(f, r.lineNo, r.ts, r.text, r.isMatch)).join(''), matches);
    }).join('') || '<div class="muted" style="padding:20px">no matches</div>';
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
        '<td><span class="count-pill" id="hits-' + i + '">' + (filter.hits[r.id] || 0) + '</span></td>' +
        '<td><button data-del="' + i + '">✕</button></td>';
      tb.appendChild(tr);
    });
    tb.onchange = tb.onclick = (e) => {
      const del = e.target.dataset && e.target.dataset.del;
      if (del != null) { state.rules.splice(Number(del), 1); applyFilters(); return; }
      const i = e.target.dataset && e.target.dataset.i;
      const k = e.target.dataset && e.target.dataset.k;
      if (i == null || !k) return;
      const r = state.rules[Number(i)];
      if (!r) return;
      r[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      applyFilters();
    };
  }

  function ruleError(r) {
    try { new RegExp(r.pattern, r.caseSensitive ? '' : 'i'); return null; } catch (e) { return e.message; }
  }

  function applyFilters() {
    filter.setRules(state.rules.map((r, i) => Object.assign({ id: 'r' + i }, r)));
    filter.quick = state.quick ? { pattern: state.quick, fixed: false, caseSensitive: false } : null;
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
    state.rules = p.rules || [];
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
  function renderAnalysis() {
    const p = $('analysis-panel');
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
    const census = piiCensus(recs);

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
      (issues.length ? issues.map((i) => '<div class="issue" data-seq="' + i.seq + '"><span><b>' + i.kind + '</b> — ' + esc(i.snippet) + '</span><span class="muted">' + esc(i.file) + ':' + i.lineNo + '</span></div>').join('') : '<span class="muted">no issue keywords found</span>') +
      '<h2>PII census (kept lines, sample)</h2>' +
      '<div class="card-row">' + Object.keys(census).map((k) => '<div class="stat-card"><div class="v">' + census[k] + '</div><div class="k">' + esc(k) + '</div></div>').join('') + '</div>';

    const fileSel = p.querySelector('#analysis-file');
    fileSel.value = sel;
    fileSel.onchange = () => { state.analysisFile = fileSel.value; renderAnalysis(); };

    drawHistogram(recs);
    p.querySelectorAll('.issue').forEach((el, idx) => {
      el.onclick = () => { const it = issues[idx]; if (it && it.rec) jumpToRecord(it.rec); };
    });
    bindIssueEditor(p);
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
  function piiCensus(records) {
    const eng = new LT.MaskEngine();
    const sample = records.slice(0, 50000);
    eng.maskLines(sample.map((r) => r.raw));
    return eng.hitCounts();
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
  function exportRecords(kind) {
    const prefix = $('exp-prefix').value;
    const selectionOnly = $('exp-selection').checked;
    let recs = selectionOnly && selection.count ? selection.indices().map((i) => view[i]) : store.kept;
    if (state.viewMode === 'file' && state.activeFile) recs = recs.filter((r) => r.fileId === state.activeFile);
    const eng = new LT.MaskEngine();
    for (const id of LT.builtinRuleIds()) eng.setEnabled(id, state.maskEnabled[id] !== false);
    eng.custom = [];
    for (const c of state.customMasks) eng.addCustom(c);
    const masked = recs.map((r) => Object.assign({}, r, { raw: state.maskOn ? eng.maskLine(r.raw) : r.raw }));
    const note = $('exp-note');
    if (state.maskOn && st().trimmed > 0) note.textContent = 'note: export covers kept lines in memory (' + masked.length + ') — trimmed lines are not included.';
    else note.textContent = masked.length + ' line(s) will be exported' + (selectionOnly ? ' (selection only)' : '') + '.';
    const name = (base, ext) => LT.timestampedName(new Date(), base, ext);
    let blob, fname;
    if (kind === 'txt') { blob = new Blob([LT.toText(masked, { prefix })], { type: 'text/plain' }); fname = name('log-triage-extract', 'log'); }
    else if (kind === 'csv') { blob = new Blob([LT.toCsv(masked)], { type: 'text/csv' }); fname = name('log-triage-extract', 'csv'); }
    else if (kind === 'json') { blob = new Blob([LT.toJson(masked)], { type: 'application/json' }); fname = name('log-triage-extract', 'json'); }
    else if (kind === 'bookmarks') { blob = new Blob([LT.bookmarksToJson(bookmarksStore)], { type: 'application/json' }); fname = name('log-triage-bookmarks', 'json'); }
    if (blob) download(blob, fname);
  }

  /* Archive export: group the masked kept lines by source file and re-pack
   * them with the original (post-extraction) structure, e.g. bundle/a.log. */
  async function exportArchive() {
    const format = $('exp-archive-format').value;
    const note = $('exp-archive-note');
    const selectionOnly = $('exp-selection').checked;
    let recs = selectionOnly && selection.count ? selection.indices().map((i) => view[i]) : store.kept;
    if (state.viewMode === 'file' && state.activeFile) recs = recs.filter((r) => r.fileId === state.activeFile);
    if (!recs.length) { note.textContent = 'nothing to export.'; return; }
    const eng = new LT.MaskEngine();
    for (const id of LT.builtinRuleIds()) eng.setEnabled(id, state.maskEnabled[id] !== false);
    eng.custom = [];
    for (const c of state.customMasks) eng.addCustom(c);
    const fileById = {};
    for (const f of files) fileById[f.id] = f;
    const groups = new Map();
    for (const r of recs) {
      const key = r.fileId;
      if (!groups.has(key)) groups.set(key, { name: (fileById[key] && fileById[key].name) || key + '.log', text: [] });
      groups.get(key).text.push(state.maskOn ? eng.maskLine(r.raw) : r.raw);
    }
    const entries = [...groups.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((g) => ({ name: g.name, data: new TextEncoder().encode(g.text.join('\n') + '\n') }));
    note.textContent = 'packing ' + entries.length + ' file(s), ' + recs.length + ' line(s) as .' + format + '…';
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
      state.rules = cfg.filters.rules.map((r) => Object.assign({ name: 'rule', pattern: '', caseSensitive: false, action: 'include', enabled: true }, r));
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
      applied.push('issue-scan rules');
    }
    if (cfg.pii && typeof cfg.pii === 'object') {
      const pii = cfg.pii;
      if (pii.active) { state.pii.active = pii.active; applied.push('pii provider'); }
      if (pii.presidio) state.pii.presidio = pii.presidio;
      if (pii.llm && pii.llm.url) { state.pii.llm = pii.llm; if (pii.llm.apiKey) state.pii.llm.apiKey = pii.llm.apiKey; }
      if (pii.proxy) state.pii.proxy = pii.proxy;
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
    v.scrollTop = Math.max(0, y - v.clientHeight / 2);
    selection.click(idx);
    renderRows(); updateStatus();
    if (view[idx]) showDrawer(view[idx]);
  }

  /** Jump from a search-result row to the line in the viewer. */
  /** bring a record into the viewer: switch file/filters if needed, then jump */
  function jumpToRecord(rec) {
    if (!seqToIdx.has(rec.seq)) {
      let changed = false;
      if (state.viewMode === 'file' && state.activeFile !== rec.fileId) {
        state.activeFile = rec.fileId; // switch to the file the match belongs to
        changed = true;
      }
      if (state.showOnlyBookmarked && !bookmarksStore.has(bookmarkKeyFor(rec.fileId), rec.lineNo)) {
        state.showOnlyBookmarked = false;
        changed = true;
      }
      if (state.quick) { state.quick = ''; $('quick').value = ''; filter.quick = null; changed = true; }
      if (state.levels.length) { state.levels = []; filter.setLevels([]); renderChips(); changed = true; }
      if (state.timeFrom || state.timeTo) {
        state.timeFrom = ''; state.timeTo = '';
        filter.timeFrom = ''; filter.timeTo = '';
        $('time-from').value = ''; $('time-to').value = '';
        changed = true;
      }
      if (changed) { saveState(); rebuildView(); }
    }
    if (seqToIdx.has(rec.seq)) { jumpTo(seqToIdx.get(rec.seq)); return true; }
    flash('that line is outside the kept-line cap — use Deep scan to find it');
    return false;
  }

  function jumpFromSearch(row) {
    const file = row.dataset.file;
    const lineNo = Number(row.dataset.ln);
    const rec = keptLineMap.get(file + ':' + lineNo);
    if (rec) { jumpToRecord(rec); return; }
    // line beyond the kept cap: show what we have from the search itself
    switchTab('viewer');
    const d = $('drawer');
    d.className = 'open';
    d.innerHTML = '<h3>' + esc(file) + ':' + esc(lineNo) +
      ' <small class="muted">(beyond kept-line cap)</small><button onclick="document.getElementById(\'drawer\').className=\'\'">✕</button></h3>' +
      '<dl><div><dt>text</dt><dd>' + esc(row.querySelector('.srx').textContent) + '</dd></div></dl>' +
      '<p class="muted">This line was released from memory (kept-line cap). Deep scan re-read the file from disk to find it.</p>';
  }

  /** Go-to-line: scroll the viewer to a specific line number. */
  function goToLine() {
    const target = parseInt($('goto-ln').value, 10);
    if (!target || target < 1) return;
    for (let i = 0; i < view.length; i++) {
      if (view[i].lineNo === target) { jumpTo(i); return; }
    }
    $('st-progress').textContent = 'line ' + target + ' is not in the current view (filtered out or beyond the kept-line cap)';
    setTimeout(() => { $('st-progress').textContent = ''; }, 4000);
  }

  function switchTab(name) {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
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
  function setFollow(on) {
    state.follow = on;
    $('btn-follow').textContent = 'Follow: ' + (on ? 'ON' : 'OFF');
    $('btn-follow').classList.toggle('on', on);
    if (on) viewer().scrollTop = viewer().scrollHeight;
    saveState();
  }

  function setBmOnly(on) {
    state.showOnlyBookmarked = on;
    saveState(); rebuildView();
  }

  function flash(msg) {
    $('st-progress').textContent = msg;
    setTimeout(() => { $('st-progress').textContent = ''; }, 4000);
  }
  function syncRgFromState() {
    $('rg-fixed').checked = state.rg.fixed; $('rg-word').checked = state.rg.word;
    $('rg-invert').checked = state.rg.invert; $('rg-case').value = state.rg.caseMode;
  }

  function filterQuickInit() {
    filter.quick = state.quick ? { pattern: state.quick, fixed: false, caseSensitive: false } : null;
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
   * re-fires input/change so the app's live filters react. */
  function makeClearable(input) {
    if (!input || input.dataset.clearable === '1' || input.type !== 'text') return;
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
  }

  /* ---------------- boot ---------------- */
  function boot() {
    loadState();
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
    $('clear-files').onclick = async () => {
      files.slice().forEach((f) => store.removeFile(f.id));
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
    dz.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) loadFiles(Array.from(e.dataTransfer.files)); });
    document.body.addEventListener('dragover', (e) => e.preventDefault());
    document.body.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length) loadFiles(Array.from(e.dataTransfer.files));
    });

    // debounced: start matching only after typing pauses
    let quickTimer = null;
    $('quick').oninput = () => {
      state.quick = $('quick').value;
      if (quickTimer) clearTimeout(quickTimer);
      quickTimer = setTimeout(() => {
        filter.quick = state.quick ? { pattern: state.quick, fixed: false, caseSensitive: false } : null;
        saveState(); rebuildView();
      }, 200);
    };
    $('btn-mask').onclick = () => setMask(!state.maskOn);
    $('btn-wrap').onclick = () => setWrap(!state.wrapOn);
    $('btn-follow').onclick = () => setFollow(!state.follow);
    $('view-mode').onchange = () => { state.viewMode = $('view-mode').value; saveState(); rebuildView(); };
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
      const rec = keptLineMap.get(row.key.split('|')[0] + ':' + row.lineNo);
      if (rec) { jumpToRecord(rec); return; }
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
      rgTimer = setTimeout(runInstantSearch, 250);
    };
    ;['rg-fixed', 'rg-word', 'rg-invert', 'rg-case'].forEach((id) => {
      $(id).onchange = () => {
        state.rg = rgOpts();
        saveState(); runInstantSearch();
      };
    });
    $('btn-deepscan').onclick = deepScan;
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

    $('btn-add-rule').onclick = () => { state.rules.push({ name: 'rule ' + (state.rules.length + 1), pattern: '', caseSensitive: false, action: 'include', enabled: true }); renderRules(); };
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
