/* Runs inside the dedicated paging worker; never on the UI thread. */
'use strict';
const sources = [];
let nextBase = 0, queryToken = 0, searchToken = 0, indexToken = 0;
let order = new Float64Array(), searchOrder = new Float64Array();
let allOrder = null, version = 0;
const emit = (id, value) => self.postMessage(Object.assign({ id }, value));
const sourceOf = (id) => {
  let lo = 0, hi = sources.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (sources[mid].base <= id) lo = mid + 1; else hi = mid; }
  return sources[lo - 1];
};
async function records(ids, start, size) {
  const rows = [];
  for (let i = start; i < Math.min(ids.length, start + size); i++) { const s = sourceOf(ids[i]); if (s && !s.removed) rows.push(await s.get(ids[i] - s.base)); }
  return rows;
}
async function buildOrder(id, token) {
  if (allOrder) return allOrder;
  const currentVersion = version;
  const count = sources.reduce((n, s) => n + (s.removed ? 0 : s.count), 0);
  let ids = new Float64Array(count), p = 0;
  for (const s of sources) if (!s.removed) for (let i = 0; i < s.count; i++) { ids[p++] = s.base + i; if ((p & 65535) === 0) { await new Promise((r) => setTimeout(r, 0)); if (token !== queryToken) return null; } }
  const compare = (a, b) => { const sa = sourceOf(a), sb = sourceOf(b); return sa.times.get(a - sa.base) - sb.times.get(b - sb.base) || a - b; };
  ids = await LT.sortIds(ids, compare, () => token !== queryToken, () => emit(id, { progress: 'Ordering timeline…' }));
  if (currentVersion === version && token === queryToken) allOrder = ids;
  return ids;
}
async function query(id, spec, search) {
  const token = search ? ++searchToken : ++queryToken;
  const cancelled = () => token !== (search ? searchToken : queryToken);
  const filter = new LT.FilterEngine();
  filter.setRules(spec.rules || []); filter.setLevels(spec.levels || []); filter.quick = spec.quick || null;
  filter.timeFrom = spec.timeFrom || ''; filter.timeTo = spec.timeTo || '';
  const searcher = search ? LT.buildSearcher(spec.pattern, spec.options) : null;
  const rawNeeded = search || !!filter.quick || filter.rules.some((r) => r.enabled);
  const chosen = sources.filter((s) => !s.removed && (!spec.fileId || spec.fileId === s.id));
  const matches = new LT.Column(Float64Array);
  const bookmarkSets = new Map((spec.bookmarks || []).map(([fileId, lines]) => [fileId, new Set(lines)]));
  let lastProgress = 0;
  for (const s of chosen) {
    let i = 0;
    const progress = (bytes) => { if (performance.now() - lastProgress > 60) { emit(id, { progress: (search ? 'Searching' : 'Filtering') + '… ' + Math.floor(bytes / Math.max(1, s.file.size) * 100) + '%' }); lastProgress = performance.now(); } };
    const accepts = (rec, index) => (!spec.bookmarkOnly || (bookmarkSets.get(s.id) || new Set()).has(index + 1)) && (search ? LT.matchLine(searcher, rec.raw) : filter.evaluate(rec).kept);
    if (rawNeeded) {
      for await (const line of LT.byteLines(s.file, progress, cancelled)) { const rec = Object.assign({ raw: line.raw }, s.metadata(i)); if (accepts(rec, i)) matches.push(s.base + i); i++; }
    } else {
      for (; i < s.count; i++) { if (accepts(s.metadata(i), i)) matches.push(s.base + i); if ((i & 16383) === 0) { progress(i / Math.max(1, s.count) * s.file.size); await new Promise((r) => setTimeout(r, 0)); if (cancelled()) break; } }
    }
    if (cancelled()) { emit(id, { cancelled: true }); return; }
  }
  let result;
  if (!search && !spec.fileId) {
    const sorted = await buildOrder(id, token);
    if (!sorted || cancelled()) { emit(id, { cancelled: true }); return; }
    const flags = new Map(chosen.map((s) => [s.id, new Uint8Array(s.count)]));
    for (let i = 0; i < matches.length; i++) { const value = matches.get(i), s = sourceOf(value); flags.get(s.id)[value - s.base] = 1; }
    result = new Float64Array(matches.length); let p = 0;
    for (let i = 0; i < sorted.length; i++) { const value = sorted[i], s = sourceOf(value); if (flags.get(s.id)?.[value - s.base]) result[p++] = value; if ((i & 65535) === 0) { await new Promise((r) => setTimeout(r, 0)); if (cancelled()) { emit(id, { cancelled: true }); return; } } }
  } else { result = new Float64Array(matches.length); for (let i = 0; i < matches.length; i++) result[i] = matches.get(i); }
  if (cancelled()) { emit(id, { cancelled: true }); return; }
  if (search) searchOrder = result; else order = result;
  emit(id, { total: result.length, errors: searcher && !searcher.ok ? [{ error: searcher.error }] : filter.errors() });
}
self.onmessage = async ({ data: m }) => {
  const { id, type } = m;
  try {
    if (type === 'index') {
      const token = ++indexToken;
      const s = new LT.PagedLog(m.file, m.fileId, nextBase);
      let last = 0;
      const sample = await s.index((bytes) => { if (performance.now() - last > 60) { emit(id, { progress: 'Indexing… ' + Math.floor(bytes / Math.max(1, m.file.size) * 100) + '%', bytes }); last = performance.now(); } }, () => token !== indexToken, m.sampleLimit);
      nextBase += s.count; sources.push(s); allOrder = null; version++;
      emit(id, { count: s.count, counts: s.counts, format: s.format, firstLine: s.firstLine, maxLength: s.maxLength, sample });
    } else if (type === 'query' || type === 'search') await query(id, m.spec, type === 'search');
    else if (type === 'page') { const ids = m.search ? searchOrder : order; const start = Math.max(0, Math.min(m.start, Math.max(0, Math.floor((ids.length - 1) / m.size) * m.size))); const rows = await records(ids, start, m.size); emit(id, { rows, start, total: ids.length }); }
    else if (type === 'record') { const s = sources.find((s) => s.id === m.fileId && !s.removed); emit(id, { record: s ? await s.get(m.lineNo - 1) : null }); }
    else if (type === 'locate') { let at = -1; const s = sources.find((s) => s.id === m.fileId && !s.removed); if (s) { const value = s.base + m.lineNo - 1; for (let i = 0; i < order.length; i++) { if (order[i] === value) { at = i; break; } if ((i & 65535) === 0) await new Promise((r) => setTimeout(r, 0)); } } emit(id, { at }); }
    else if (type === 'remove') { queryToken++; searchToken++; indexToken++; const s = sources.find((s) => s.id === m.fileId); if (s) { s.removed = true; s.cache.clear(); s.offsets = s.times = s.levels = null; } allOrder = null; version++; emit(id, {}); }
    else if (type === 'cancel') { queryToken++; searchToken++; indexToken++; emit(id, {}); }
  } catch (error) { emit(id, { error: error.message }); }
};
