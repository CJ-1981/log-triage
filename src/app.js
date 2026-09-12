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
    timeFrom: '', timeTo: '', sideHidden: false,
    bookmarks: null, levels: [], rg: { fixed: false, word: false, invert: false, caseMode: 'smart', before: 0, after: 0 },
  });
  let state = defaults();

  function saveState() {
    try {
      const s = Object.assign({}, state, { bookmarks: bookmarksStore.toJSON() });
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
      const entry = { id: 'f' + Date.now() + '_' + (i++), name: f.name, size: f.size, file: f, status: 'parsing', format: '…', read: 0 };
      files.push(entry);
      renderFiles();
      await ingestFile(entry);
      renderFiles();
      onKeptChanged();
      if (ingestAbort) break;
    }
    saveState();
  }

  /* ---------------- rendering: files ---------------- */
  function renderFiles() {
    const el = $('file-list');
    el.innerHTML = '';
    for (const f of files) {
      const st = store.stats().files[f.id] || { total: 0, kept: 0 };
      const div = document.createElement('div');
      div.className = 'file-item' + (state.activeFile === f.id ? ' active' : '');
      div.innerHTML = '<div class="fname">' + esc(f.name) + '</div>' +
        '<div class="fmeta"><span class="badge fmt">' + esc(f.format) + '</span>' +
        '<span>' + LT.fmtBytes(f.size) + '</span><span>' + st.total + ' lines</span>' +
        '<span>' + st.kept + ' kept</span></div>';
      div.onclick = () => { state.activeFile = state.activeFile === f.id ? null : f.id; saveState(); renderFiles(); refreshView(); };
      el.appendChild(div);
    }
  }

  /* ---------------- view model ---------------- */
  let view = [];            // current visible records
  let seqToIdx = new Map();
  let keptLineMap = new Map(); // "displayName:lineNo" -> record (for jumps)
  let filteredCount = 0;
  let viewMaxLen = 0;       // longest raw line length in the view (chars)
  let charW = 0;            // measured monospace character width (px)

  function onKeptChanged() {
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
    const chips = tally.chipList();
    if (!chips.length) {
      row.innerHTML = '<span class="muted" id="chips-hint">Level chips appear after loading</span>';
      return;
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

  function currentFileKey() {
    const f = files.find((x) => x.id === (state.activeFile || ''));
    return LT.bookmarkFileKey(f ? f.name : '*', f ? f.size : 0, firstLineOf(f));
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
    $('vspacer').addEventListener('mousedown', (e) => {
      const row = e.target.closest('.vrow');
      if (!row) return;
      const idx = Number(row.dataset.idx);
      if (e.target.dataset.bm !== undefined) {
        toggleBookmark(idx);
        return;
      }
      drag = true;
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
      selection.shiftClick(Number(row.dataset.idx));
      renderRows(); updateStatus();
    });
    window.addEventListener('mouseup', () => { drag = false; });
    v.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.vrow');
      if (row) showDrawer(view[Number(row.dataset.idx)]);
    });
  }

  function toggleBookmark(idx) {
    const rec = view[idx];
    bookmarksStore.toggle(bookmarkKeyFor(rec.fileId), rec.lineNo, { snippet: displayText(rec).slice(0, 200), ts: rec.ts, fileId: rec.fileId });
    updateStatus(); renderRows(); saveState();
  }
  function bookmarkKeyFor(fileId) {
    return LT.bookmarkFileKey(fileDisplayName(fileId), fileSizeOf(fileId), firstLineOf(files.find((x) => x.id === fileId)));
  }
  function fileSizeOf(fileId) {
    const f = files.find((x) => x.id === fileId);
    return f ? f.size : 0;
  }

  function showDrawer(rec) {
    if (!rec) return;
    const d = $('drawer');
    d.className = 'open';
    d.innerHTML = '<h3>Line ' + rec.lineNo + ' — ' + esc(fileDisplayName(rec.fileId)) +
      '<button onclick="document.getElementById(\'drawer\').className=\'\'">✕</button></h3>' +
      '<dl>' +
      dv('ts', rec.ts) + dv('level', rec.level) + dv('tag', rec.tag) + dv('pid', rec.pid) +
      '<div><dt>masked</dt><dd>' + esc(engine.maskLine(rec.raw)) + '</dd></div>' +
      '<div><dt>raw</dt><dd class="raw">' + esc(rec.raw) + '</dd></div>' +
      '</dl>';
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
      '<div class="sr-file">' + esc(f) + ' (' + byFile[f].length + ')</div>' +
      byFile[f].map((r) => srRow(f, r.lineNo, r.ts, r.text, true)).join('')).join('') ||
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
    out.innerHTML = Object.keys(byFile).map((f) =>
      '<div class="sr-file">' + esc(f) + '</div>' +
      byFile[f].map((r) => srRow(f, r.lineNo, r.ts, r.text, r.isMatch)).join('')).join('');
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
    };
  }
  function applyPreset(p) {
    state.rules = p.rules || [];
    state.quick = p.quick || '';
    state.levels = p.levels || [];
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
    const levels = tally.chipList();
    const maxL = Math.max(1, ...levels.map((l) => l.count));
    const tags = topBy((r) => r.tag, 12);
    const msgs = topMessages(12);
    const issues = issueScan();
    const census = piiCensus();

    p.innerHTML =
      '<h2>Overview</h2>' +
      '<div class="card-row">' +
      stat('Files', files.length) + stat('Lines', st.totalLines) + stat('Kept', st.keptTotal) +
      stat('Dropped', st.dropped) + stat('In memory', st.keptInMemory) + stat('Bytes', LT.fmtBytes(st.bytes)) +
      '</div>' +
      '<div class="two-col"><div>' +
      '<h2>Levels (all scanned lines)</h2>' +
      levels.map((l) => '<div class="hbar"><span style="min-width:18px">' + (l.id === '__' ? '—' : l.id) + '</span><div class="bar" style="width:' + (l.count / maxL * 70) + '%"></div>' + l.count + '</div>').join('') +
      '<h2>Time histogram (kept lines)</h2><canvas id="histo" width="600" height="120"></canvas>' +
      '</div><div>' +
      '<h2>Top tags</h2>' + tags.map((t) => '<div class="hbar"><span style="min-width:120px">' + esc(t.k) + '</span><div class="bar" style="width:' + (t.n / tags[0].n * 50) + '%"></div>' + t.n + '</div>').join('') +
      '<h2>Top message shapes</h2>' + msgs.map((t) => '<div class="hbar"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(t.k) + '</span><b>' + t.n + '</b></div>').join('') +
      '</div></div>' +
      '<h2>Issue scan</h2>' +
      (issues.length ? issues.map((i) => '<div class="issue" data-seq="' + i.seq + '"><span><b>' + i.kind + '</b> — ' + esc(i.snippet) + '</span><span class="muted">' + esc(i.file) + ':' + i.lineNo + '</span></div>').join('') : '<span class="muted">no issue keywords found</span>') +
      '<h2>PII census (kept lines, sample)</h2>' +
      '<div class="card-row">' + Object.keys(census).map((k) => '<div class="stat-card"><div class="v">' + census[k] + '</div><div class="k">' + esc(k) + '</div></div>').join('') + '</div>';

    drawHistogram();
    p.querySelectorAll('.issue').forEach((el) => {
      el.onclick = () => { const seq = Number(el.dataset.seq); if (seqToIdx.has(seq)) { jumpTo(seqToIdx.get(seq)); } };
    });
  }

  function stat(k, v) { return '<div class="stat-card"><div class="v">' + v + '</div><div class="k">' + k + '</div></div>'; }
  function topBy(getter, n) {
    const m = {};
    for (const r of store.kept) { const k = getter(r); if (!k) continue; m[k] = (m[k] || 0) + 1; }
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
  function topMessages(n) {
    const m = {};
    for (const r of store.kept) { const k = normMsg(r.msg || r.raw); m[k] = (m[k] || 0) + 1; }
    return Object.keys(m).map((k) => ({ k, n: m[k] })).sort((a, b) => b.n - a.n).slice(0, n);
  }
  const ISSUE_GROUPS = [
    ['crash', /fatal exception|tombstone|beginning of crash/i],
    ['anr', /\banr in |input dispatching timed out/i],
    ['proc-death', /has died|am_proc_died|force stopping/i],
    ['connectivity', /connectivityservice|networkmonitor|data_disconnected|wifiservice|deactivatedatacall/i],
    ['auth', /auth error|auth blocked|authentication failed|token refresh|credential/i],
  ];
  function issueScan() {
    const out = [];
    for (const r of store.kept) {
      for (const [kind, re] of ISSUE_GROUPS) {
        if (re.test(r.raw)) {
          out.push({ kind, snippet: (r.msg || r.raw).slice(0, 110), file: fileDisplayName(r.fileId), lineNo: r.lineNo, seq: r.seq });
          break;
        }
      }
      if (out.length >= 200) break;
    }
    return out;
  }
  function piiCensus() {
    const eng = new LT.MaskEngine();
    const sample = store.kept.slice(0, 50000);
    eng.maskLines(sample.map((r) => r.raw));
    return eng.hitCounts();
  }
  function drawHistogram() {
    const cv = document.getElementById('histo');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const style = getComputedStyle(document.body);
    ctx.clearRect(0, 0, cv.width, cv.height);
    const tsRecs = store.kept.filter((r) => r.ts);
    if (tsRecs.length < 2) {
      ctx.fillStyle = style.getPropertyValue('--muted');
      ctx.fillText('need at least 2 timestamped lines', 12, 20);
      return;
    }
    const toMs = (ts) => {
      const [d, t] = ts.split(' ');
      const [hh, mm, ss] = t.split(':');
      return Number(d.slice(3)) * 86400 + Number(hh) * 3600 + Number(mm) * 60 + Number(ss.split('.')[0]) + Number(ss.split('.')[1] || 0) / 1000;
    };
    const lo = toMs(tsRecs[0].ts), hi = toMs(tsRecs[tsRecs.length - 1].ts);
    const buckets = new Array(100).fill(0);
    for (const r of tsRecs) {
      const i = Math.min(99, Math.floor((toMs(r.ts) - lo) / Math.max(1e-6, hi - lo) * 100));
      buckets[i]++;
    }
    const max = Math.max(...buckets);
    ctx.fillStyle = style.getPropertyValue('--accent');
    const bw = cv.width / 100;
    buckets.forEach((n, i) => {
      const h = n / max * (cv.height - 8);
      ctx.fillRect(i * bw, cv.height - h, bw - 0.5, h);
    });
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
  function jumpFromSearch(row) {
    const file = row.dataset.file;
    const lineNo = Number(row.dataset.ln);
    const rec = keptLineMap.get(file + ':' + lineNo);
    if (rec) {
      if (seqToIdx.has(rec.seq)) {
        jumpTo(seqToIdx.get(rec.seq));
        return;
      }
      $('st-progress').textContent = 'line ' + lineNo + ' is hidden by active filters — clear quick filter / chips to view it';
      setTimeout(() => { $('st-progress').textContent = ''; }, 4000);
      return;
    }
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

  /* ---------------- boot ---------------- */
  function boot() {
    loadState();
    if (location.search.indexOf('selftest') >= 0) { runSelfTest(); return; }

    const sel = $('theme-sel');
    for (const n of LT.themeNames()) {
      const o = document.createElement('option');
      o.value = n; o.textContent = LT.THEMES[n].label;
      sel.appendChild(o);
    }
    sel.value = state.theme;
    document.body.dataset.theme = state.theme;
    sel.onchange = () => { state.theme = sel.value; document.body.dataset.theme = sel.value; saveState(); };

    const applySide = () => {
      document.getElementById('main').classList.toggle('side-hidden', !!state.sideHidden);
      $('btn-side').classList.toggle('on', !state.sideHidden);
    };
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
    $('clear-files').onclick = () => { files.length = 0; store.kept.length = 0; onKeptChanged(); renderFiles(); };
    const dz = $('dropzone');
    ;['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ;['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) loadFiles(Array.from(e.dataTransfer.files)); });
    document.body.addEventListener('dragover', (e) => e.preventDefault());
    document.body.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length) loadFiles(Array.from(e.dataTransfer.files));
    });

    $('quick').oninput = () => {
      state.quick = $('quick').value;
      filter.quick = state.quick ? { pattern: state.quick, fixed: false, caseSensitive: false } : null;
      saveState(); rebuildView();
    };
    $('btn-mask').onclick = () => setMask(!state.maskOn);
    $('btn-wrap').onclick = () => setWrap(!state.wrapOn);
    $('btn-follow').onclick = () => setFollow(!state.follow);
    $('view-mode').onchange = () => { state.viewMode = $('view-mode').value; saveState(); rebuildView(); };
    $('btn-copy').onclick = copySelection;
    $('btn-bookmarks').onclick = () => {
      const all = bookmarksStore.all();
      const d = $('drawer');
      d.className = 'open';
      d.innerHTML = '<h3>Bookmarks (' + all.length + ')<button onclick="document.getElementById(\'drawer\').className=\'\'">✕</button></h3>' +
        (all.length ? all.map((b) => '<div class="issue" data-key="' + esc(b.key) + '" data-ln="' + b.lineNo + '"><span>' + esc(b.meta.snippet || '') + (b.note ? ' — <b>' + esc(b.note) + '</b>' : '') + '</span><span class="muted">' + esc(b.key.split('|')[0]) + ':' + b.lineNo + '</span></div>').join('') : '<span class="muted">no bookmarks yet — click the ☆ gutter or press B</span>');
      d.querySelectorAll('.issue').forEach((el) => {
        el.onclick = () => {
          const rec = view.find((r) => r.lineNo === Number(el.dataset.ln) && fileDisplayName(r.fileId) === el.dataset.key.split('|')[0]);
          if (rec && seqToIdx.has(rec.seq)) jumpTo(seqToIdx.get(rec.seq));
        };
      });
    };

    $('rg-pattern').oninput = () => { state.rgPattern = $('rg-pattern').value; runInstantSearch(); };
    ;['rg-fixed', 'rg-word', 'rg-invert', 'rg-case'].forEach((id) => {
      $(id).onchange = () => {
        state.rg = rgOpts();
        saveState(); runInstantSearch();
      };
    });
    $('btn-deepscan').onclick = deepScan;
    $('btn-rg-export').onclick = exportRg;
    $('search-results').addEventListener('click', (e) => {
      const row = e.target.closest('.sr-row');
      if (row) jumpFromSearch(row);
    });
    $('goto-ln').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { goToLine(); e.preventDefault(); }
    });

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

    ;['exp-txt'].forEach(() => {});
    $('exp-txt').onclick = () => exportRecords('txt');
    $('exp-csv').onclick = () => exportRecords('csv');
    $('exp-json').onclick = () => exportRecords('json');
    $('exp-bookmarks').onclick = () => exportRecords('bookmarks');

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
    renderChips(); renderRules(); renderPresets(); renderFiles(); updateStatus();
    bindViewer();
    applySide();

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

  // test/automation hook: programmatic file loading (used by manual big-file checks)
  if (typeof window !== 'undefined') window.LT_INGEST = (files) => loadFiles(files);

  return { boot, runSelfTest };
}));
