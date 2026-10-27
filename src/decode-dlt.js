/* Log Triage — decode-dlt.js: pure binary DLT (.dlt) message decoder.
 *
 * Decodes AUTOSAR DLT v1 binary captures (GENIVI/COVESA "DLT" format): an
 * optional 16-byte storage header per message ("DLT\x01" magic), then the
 * standard header (HTYP typed-flag byte, message counter, 16-bit total
 * length, optional ECU id / session id / timestamp fields), then the
 * optional 10-byte extended header (msin, argument count, APID, CTID),
 * then the payload. Byte order inside multi-byte fields follows the HTYP
 * MSBF flag (big-endian when set, little-endian otherwise).
 *
 * The module is pure: it never touches the DOM, fs, network, or worker
 * plumbing, and never throws for bad message content. It reports
 * structural damage by counting warnings and, for whole-buffer scans,
 * by throwing a single loud error only when no sync point remains at all
 * (SPEC R5-4). Record and line rendering match src/parser.js vocabulary:
 *   record { ts, level, tag, pid, msg }, ts = year-less UTC-naive
 *   'MM-DD HH:MM:SS.mmm' (ADR-0004), tag = 'APID:CTID' with ECU fallback,
 *   pid = session id.
 *
 * Exported (flat, LT.*): dltIsStorageMagic, dltMinHeaderLength,
 * dltPlausibleHeader, dltSniff, dltDecodeMessage, dltScanMessages,
 * dltFindResync, dltEpochToTimeText, dltHexDump, dltHeaderSwap.
 *
 * QNX writer variant (ADR-0021): some QNX DHU captures serialize the
 * standard header's multi-byte fields (length, session id, timestamp)
 * big-endian while keeping the MSBF flag clear, and order the storage
 * header epoch-first with the ECU id last (payload stays per MSBF). The
 * byte order is auto-detected, never assumed: dltHeaderSwap calibrates on
 * the capture head, and page-window re-decodes fall back to the opposite
 * reading when the declared length overshoots the recorded span.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { Object.assign((root.LT || (root.LT = {})), factory()); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_LEN = 16;   // storage header: "DLT\x01" + ECU id + epoch seconds + microseconds
  const EXT_LEN = 10;       // extended header: msin + argc + APID + CTID

  // msin bit fields
  const MSIN_VERB = 0x01, MSIN_MSTP = 0x0e, MSIN_MTIN = 0xf0;

  // Type-info word bits (DLT protocol spec)
  const TI_BOOL = 0x10, TI_SINT = 0x20, TI_UINT = 0x40, TI_FLOA = 0x80;
  const TI_STRG = 0x200, TI_RAWD = 0x400, TI_VARI = 0x800;
  const TI_SCOD = 0x38000, SCOD_UTF8 = 0x8000;

  // TYLE low nibble -> payload byte length (index 0 unused; 5 = 128-bit)
  const TYLE_BYTES = [0, 1, 2, 4, 8, 16];

  // MSTP value -> message-type keyword; per-family MTIN nibble -> subtype word.
  // Index 0 (log) mirrors parser.DLT_LOG_LEVELS ordering; reserved MSTP 5-7
  // and out-of-range MTINs render deterministically as mstp=N / mtin=N.
  const MSTP_WORDS = ['log', 'app_trace', 'nw_trace', 'control', 'extension'];
  const MTIN_WORDS = [
    ['default', 'fatal', 'error', 'warn', 'info', 'debug', 'verbose'],
    ['default', 'variable', 'function_in', 'function_out', 'state', 'vfb'],
    ['default', 'variable', 'function_in', 'function_out', 'state', 'vfb'],
    ['default', 'request', 'response', 'time'],
    ['default'],
  ];
  // Level letter per rendered subtype word; matches parser.DLT_LOG_LEVELS and
  // parser.DLT_TYPE_LEVELS (log level 0 'default' and 7-15 have no level).
  const LOG_LEVELS = { fatal: 'F', error: 'E', warn: 'W', info: 'I', debug: 'D', verbose: 'V' };
  const TRACE_LEVELS = { app_trace: 'D', nw_trace: 'D', control: 'I' };

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function pad3(n) { return (n < 10 ? '00' : n < 100 ? '0' : '') + n; }
  function hex2(n) { return (n < 16 ? '0' : '') + n.toString(16); }

  /* Raw payload rendered as continuous lowercase hex (searchable, stable). */
  function dltHexDump(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += hex2(bytes[i]);
    return out;
  }

  /* Storage-header epoch (uint32 seconds + int32 microseconds, UTC) rendered
   * year-less per ADR-0004; microseconds truncate toward the past. */
  function dltEpochToTimeText(seconds, micros) {
    const d = new Date(seconds * 1000 + Math.floor(micros / 1000));
    return pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' +
      pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()) +
      '.' + pad3(d.getUTCMilliseconds());
  }

  function dltIsStorageMagic(bytes, off) {
    return !!bytes && bytes.length >= off + 4 &&
      bytes[off] === 0x44 && bytes[off + 1] === 0x4c && bytes[off + 2] === 0x54 && bytes[off + 3] === 0x01;
  }

  /* Minimum total message length implied by the HTYP flag bits. */
  function dltMinHeaderLength(htyp) {
    return 4 + (htyp & 0x01 ? EXT_LEN : 0) + (htyp & 0x04 ? 4 : 0) +
      (htyp & 0x08 ? 4 : 0) + (htyp & 0x10 ? 4 : 0);
  }

/* Read the fixed part of a standard header. Returns null unless the version
 * bits are 0b001 (DLT v1). `length` is the declared TOTAL message length.
 * `lenSwap` (QNX variant) reads the length — and every other standard-header
 * multi-byte field, exposed as `be` — in the byte order opposite to MSBF. */
function probeHeader(bytes, off, lenSwap) {
  if (!bytes || off < 0 || off + 4 > bytes.length) return null;
  const htyp = bytes[off];
  if ((htyp & 0xe0) !== 0x20) return null;
  const msbf = !!(htyp & 0x02);
  const be = msbf !== !!lenSwap;
  const length = be ? ((bytes[off + 2] << 8) | bytes[off + 3])
    : (bytes[off + 2] | (bytes[off + 3] << 8));
  return { htyp, msbf, length, minLen: dltMinHeaderLength(htyp), lenSwap: !!lenSwap, be };
}

/* Byte-level plausibility of a record boundary at `off`: DLT v1 version
 * bits, a declared length at least the HTYP minimum, and the message fitting
 * within `end` (default: buffer end). Multi-field, so text rarely passes. */
function dltPlausibleHeader(bytes, off, end, lenSwap) {
  const p = probeHeader(bytes, off, lenSwap);
  return !!p && p.length >= p.minLen && off + p.length <= (end === undefined ? bytes.length : end);
}

  /* Classification sniff for detect.js (SPEC R1-2). `head` is the leading
   * chunk of the file (at least 4 bytes), `fileSize` the full file size.
   * storageHeader=true means the file starts with DLT storage-header magic.
   * A headerless capture is classified binary only when the first message's
   * boundary is followed by another plausible boundary (chained look-ahead) or
   * the first message alone decodes to a complete verbose typed structure —
   * text rarely satisfies either. The authoritative veto against text files
   * happens at index time in paged.js, which sees the full document. */
  function dltSniff(head, fileSize) {
    const no = { binary: false, storageHeader: false };
    if (!head || head.length < 4) return no;
    if (dltIsStorageMagic(head, 0)) return { binary: true, storageHeader: true };
    let first = probeHeader(head, 0);
    if (!first || first.length < first.minLen || first.length > fileSize) first = probeHeader(head, 0, true); // QNX BE-header head
    if (!first || first.length < first.minLen || first.length > fileSize) return no;
    const next = first.length;
    if (next + 4 <= head.length) {
      if (dltIsStorageMagic(head, next) && next + STORAGE_LEN <= fileSize) return { binary: true, storageHeader: false };
      if (dltPlausibleHeader(head, next, fileSize)) return { binary: true, storageHeader: false };
      if (dltPlausibleHeader(head, next, fileSize, true)) return { binary: true, storageHeader: false }; // QNX BE-header chain
    }
    if (next <= head.length) {
      const m = dltDecodeMessage(head.subarray(0, next));
      if (m && !m.implausible && !m.truncated && m.verbose && m.clean) return { binary: true, storageHeader: false };
    }
    return no;
  }

  /* How many consecutive record boundaries a byte-order reading walks from
   * `from` before a header probe fails or a message overruns the buffer. */
  const SWAP_HOPS = 32;
  function swapWalkHops(bytes, from, lenSwap) {
    let pos = from, hops = 0;
    while (pos < bytes.length && hops < SWAP_HOPS) {
      const off = pos + (dltIsStorageMagic(bytes, pos) ? STORAGE_LEN : 0);
      const probe = probeHeader(bytes, off, lenSwap);
      if (!probe || probe.length < probe.minLen || off + probe.length > bytes.length) break;
      pos = off + probe.length;
      hops++;
    }
    return hops;
  }

  /* Standard-header byte-order calibration (QNX variant, ADR-0021). A size
   * check alone cannot tell the readings apart — the byte-swapped reading of
   * a short length is a huge value that still "fits" any real capture — so
   * walk the capture head under each reading and pick the swapped one only
   * when it chains strictly further while the conformant reading dies early.
   * Conformant captures that walk SWAP_HOPS boundaries keep MSBF semantics. */
  function dltHeaderSwap(bytes) {
    if (!bytes || bytes.length < 8) return false;
    const conformant = swapWalkHops(bytes, 0, false);
    if (conformant >= SWAP_HOPS) return false;
    return swapWalkHops(bytes, 0, true) > conformant;
  }

  /* True when the 16 bytes at `off` hold the QNX epoch-first storage header
   * (sec, µs, ECU id) instead of the AUTOSAR order (ECU id, sec, µs). The
   * micros field of a conformant header can never be printable through all
   * four bytes (its high byte is below 0x10 for any µs under one second), so
   * a printable tail plus a non-printable id slot is decisive. */
  function dltStorageTsFirst(bytes, off) {
    return isIdBytes(bytes, off + 12) && !isIdBytes(bytes, off + 4);
  }

  function isIdBytes(bytes, off) {
    if (!bytes || bytes.length < off + 4) return false;
    let end = off + 4;
    while (end > off && (bytes[end - 1] === 0 || bytes[end - 1] === 0x20)) end--;
    if (end === off) return false;
    for (let i = off; i < end; i++) if (bytes[i] < 0x20 || bytes[i] > 0x7e) return false;
    return true;
  }

/* Decode one message from `bytes`, a window that starts at a storage header
 * or a standard header. `headerSwap` selects the QNX big-endian standard-
 * header reading when index-time calibration picked it (dltHeaderSwap).
 * Every payload read is bounded by the declared total length, so a trailing
 * next-record header inside a page window is ignored. Returns null when the
 * window cannot hold even a header, otherwise
 * { record, line, consumed, warnings, truncated, verbose, clean, implausible }
 * where record is null for framing-only messages (AC-E.6) and consumed
 * counts standard-header + payload bytes only (the storage header is
 * framing: the next boundary sits at storageLen + consumed). */
function dltDecodeMessage(bytes, headerSwap) {
  if (!bytes || !bytes.length) return null;
  let pos = 0, ecu = '', sec = null, micros = 0;
  const hasStorage = dltIsStorageMagic(bytes, 0);
  if (hasStorage) {
    if (bytes.length < STORAGE_LEN) return fail(bytes.length);
    pos = STORAGE_LEN;
  }
  if (bytes.length - pos < 4) return pos === bytes.length ? okFraming(pos, 0, false) : fail(bytes.length - pos);
  let probe = probeHeader(bytes, pos, headerSwap);
  if (!probe || probe.length < probe.minLen) return { record: null, line: null, consumed: 0, warnings: 0, implausible: true };
  if (headerSwap === undefined && bytes.length - pos < probe.length) {
    // Policy-less page-window re-decode: the window is one recorded message
    // span, so a declared length overshooting it while the opposite
    // byte-order reading fits means index time walked the swapped reading
    // (QNX header variant). Adopt it so page rows match index rows. Callers
    // that know the calibrated policy pass it explicitly and never flip
    // here — a byte-swapped length can also land below the true span, where
    // "fits" proves nothing.
    const alt = probeHeader(bytes, pos, !probe.lenSwap);
    if (alt && alt.length >= alt.minLen && bytes.length - pos >= alt.length) probe = alt;
  }
  if (hasStorage) {
    if (dltStorageTsFirst(bytes, 0)) {
      // QNX epoch-first storage header: sec + µs ahead of the ECU id.
      ecu = trimId(bytes, 12);
      sec = readU32(bytes, 4, probe.msbf);
      micros = readI32(bytes, 8, probe.msbf);
      if (micros < 0 || micros >= 1000000) {
        sec = readU32(bytes, 4, !probe.msbf);
        micros = readI32(bytes, 8, !probe.msbf);
      }
    } else {
      // Storage-header time fields carry no byte-order bit of their own;
      // they follow the MSBF flag of the standard header behind them.
      ecu = trimId(bytes, 4);
      sec = readU32(bytes, 8, probe.msbf);
      micros = readI32(bytes, 12, probe.msbf);
    }
  }
  const truncated = bytes.length - pos < probe.length;
  const end = truncated ? bytes.length : pos + probe.length;
  // `consumed` counts standard-header + payload bytes only: the storage
  // header is framing, so the next boundary sits at pos + consumed.
  const consumed = truncated ? bytes.length - pos : probe.length;
  let p = pos + 4;
  let stdEcu = '', session = null;
  if (probe.htyp & 0x04) { stdEcu = trimId(bytes, p); p += 4; }
  if (probe.htyp & 0x08) { session = readU32(bytes, p, probe.be); p += 4; }
  if (probe.htyp & 0x10) { p += 4; } // TMSP: relative 0.1 ms counter, framing only (R2-3)
    let msin = 0, argc = 0, apid = '', ctid = '';
    const ueh = !!(probe.htyp & 0x01);
    if (ueh) {
      if (p + EXT_LEN > end) return fail(bytes.length - pos);
      msin = bytes[p]; argc = bytes[p + 1];
      apid = trimId(bytes, p + 2); ctid = trimId(bytes, p + 6);
      p += EXT_LEN;
    }
    const mcnt = bytes[pos + 1];
    const verbose = ueh && !!(msin & MSIN_VERB);
    const mstp = ueh ? (msin & MSIN_MSTP) >> 1 : -1;
    const mtin = ueh ? (msin & MSIN_MTIN) >> 4 : -1;
    const warnings = truncated ? 1 : 0;
    let msg = '', clean = true;
    if (p < end) {
      if (verbose && argc > 0) {
        const r = decodeArgs(bytes, p, end, probe.msbf, argc);
        if (r.invalid) {
          // Typed decode hit an invalid structure: hex fallback from the first
          // argument plus a warning (R5-2), counted once even for a truncated
          // tail message. Clean flag drops so sniff never leans on it.
          clean = false;
          if (!truncated) {
            msg = 'hex ' + dltHexDump(bytes.subarray(r.argStart, end));
            return finish(consumed, ecu, stdEcu, session, mcnt, msin, mstp, mtin, apid, ctid, sec, micros, msg, 1, verbose, false, false);
          }
        } else if (r.leftover > 0) {
          // Greedy argument decode stopped short of the declared end: append
          // the residue as hex so no bytes are dropped silently (R5-2).
          msg = (r.text ? r.text + ' ' : '') + 'hex ' + dltHexDump(bytes.subarray(end - r.leftover, end));
        } else {
          msg = r.text;
        }
      }
      if (!msg) msg = 'hex ' + dltHexDump(bytes.subarray(p, end));
    }
    if (p >= end) {
      // Header-only message: framing completes cleanly, no record (AC-E.6).
      return { record: null, line: null, consumed, warnings, truncated, verbose, clean };
    }
    return finish(consumed, ecu, stdEcu, session, mcnt, msin, mstp, mtin, apid, ctid, sec, micros, msg, warnings, verbose, clean, truncated);
  }

  /* Shared tail: builds the record + rendered line and returns the result.
   * `clean` is false when a verbose typed structure was invalid, so sniff
   * never treats the message as classification evidence. */
  function finish(consumed, ecu, stdEcu, session, mcnt, msin, mstp, mtin, apid, ctid, sec, micros, msg, warnings, verbose, clean, truncated) {
    const typeWord = mstp >= 0 ? (mstp < MSTP_WORDS.length ? MSTP_WORDS[mstp] : 'mstp=' + mstp) : '-';
    const words = mstp >= 0 && mstp < MTIN_WORDS.length ? MTIN_WORDS[mstp] : null;
    const subWord = mstp < 0 ? '-' : (words ? (mtin < words.length ? words[mtin] : 'mtin=' + mtin) : 'mtin=' + mtin);
    let level = null;
    if (typeWord === 'log') level = LOG_LEVELS[subWord] || null;
    else level = TRACE_LEVELS[typeWord] || null;
    const ecuStr = ecu || stdEcu;
    const tag = (apid && ctid) ? apid + ':' + ctid : (apid || ctid) || ecuStr;
    const pid = session === null ? null : String(session);
    const ts = sec === null ? null : dltEpochToTimeText(sec, micros);
    const record = { ts, level, tag: tag || null, pid, msg };
    const line = (ts ? ts + ' ' : '') + mcnt + ' ' + (ecuStr || '-') + ' ' + (tag || '-') + ' ' +
      (pid === null ? '-' : pid) + ' ' + typeWord + ' ' + subWord + (msg ? ' ' + msg : '');
    return { record, line, consumed, warnings, truncated, verbose, clean };
  }

  /* Truncated framing (incomplete storage or standard header): no record,
   * one warning, everything up to the buffer end consumed. */
  function fail(consumed) {
    return { record: null, line: null, consumed, warnings: 1, truncated: true, verbose: false, clean: false };
  }

  function okFraming(consumed, warnings, truncated) {
    return { record: null, line: null, consumed, warnings, truncated, verbose: false, clean: true };
  }

  /* Walk a whole buffer message by message (index-time reference semantics,
   * SPEC R5). Returns { records: [{ offset, record, line }], warnings }.
   * Record offsets are message starts: the storage-header position when the
   * record carries one, else the standard header (AC-E.9) — so a storage
   * header is framing that precedes its record's offset and is never an
   * offset itself (R1-5). Throws one loud error when damage leaves no
   * plausible boundary anywhere ahead (R5-4). The standard-header byte
   * order is calibrated once on the buffer head (dltHeaderSwap) and applied
   * to every boundary. */
  function dltScanMessages(bytes) {
    const records = [];
    let warnings = 0;
    let pos = 0;
    const swap = dltHeaderSwap(bytes);
    while (pos < bytes.length) {
      // A storage header is framing in front of the message; the decode
      // window always starts at `pos` (storage included).
      const storage = dltIsStorageMagic(bytes, pos);
      const off = storage ? pos + STORAGE_LEN : pos;
      if (storage && bytes.length <= off) {
        // Bare storage header (clean empty capture) or truncated framing tail.
        if (bytes.length - pos < STORAGE_LEN) warnings++;
        break;
      }
      if (bytes.length - off < 4) { warnings++; break; } // residue shorter than any header
      const probe = probeHeader(bytes, off, swap);
      if (!probe || probe.length < probe.minLen) {
        pos = resyncOrThrow(bytes, pos, records.length);
        warnings++;
        continue;
      }
      if (off + probe.length > bytes.length) {
        // Declared length overshoots the buffer. When a plausible boundary
        // hides inside the span the declared length was corrupt: resync (R5-2).
        // Otherwise this is the truncated final message (R5-1): emit the
        // partial record and one warning, then stop.
        if (dltFindResync(bytes, pos + 1) >= 0) {
          pos = resyncOrThrow(bytes, pos, records.length);
          warnings++;
          continue;
        }
        const m = dltDecodeMessage(bytes.subarray(pos), swap);
        if (m && m.record) records.push({ offset: pos, record: m.record, line: m.line });
        warnings += m ? m.warnings : 1;
        break;
      }
      const m = dltDecodeMessage(bytes.subarray(pos), swap);
      if (!m || m.implausible || m.consumed <= 0) {
        pos = resyncOrThrow(bytes, pos, records.length);
        warnings++;
        continue;
      }
      warnings += m.warnings;
      if (m.record) records.push({ offset: pos, record: m.record, line: m.line });
      pos += (storage ? STORAGE_LEN : 0) + m.consumed;
    }
    return { records, warnings };
  }

  function resyncOrThrow(bytes, pos, indexed) {
    const next = dltFindResync(bytes, pos + 1);
    if (next < 0) {
      throw new Error('dlt: no plausible DLT boundary found after byte ' + pos + ' (' + indexed + ' records indexed)');
    }
    return next;
  }

  /* Forward scan for the next plausible record boundary: storage magic backed
   * by a plausible standard header, or a bare plausible standard header.
   * Deterministic left-to-right (R5-6); -1 when exhausted. */
  function dltFindResync(bytes, from) {
    for (let i = Math.max(0, from); i + 4 <= bytes.length; i++) {
      if (dltIsStorageMagic(bytes, i)) {
        if (i + STORAGE_LEN + 4 <= bytes.length && dltPlausibleHeader(bytes, i + STORAGE_LEN)) return i;
      } else if (dltPlausibleHeader(bytes, i)) {
        return i;
      }
    }
    return -1;
  }

  /* Decode `argc` typed arguments in [from, end). Greedy but bounded: an
   * invalid structure reports { invalid, argStart } so the caller can fall
   * back to hex from the first argument; leftover bytes after the last
   * argument are reported so the caller can hex-render them. */
  function decodeArgs(bytes, from, end, msbf, argc) {
    const parts = [];
    let p = from;
    for (let a = 0; a < argc; a++) {
      const argStart = p;
      if (p + 4 > end) return { invalid: true, argStart, text: null, leftover: 0 };
      const ti = readU32(bytes, p, msbf);
      p += 4;
      const r = decodeOneArg(bytes, p, end, ti, msbf);
      if (r.invalid) return { invalid: true, argStart, text: null, leftover: 0 };
      parts.push(r.text);
      p = r.p;
    }
    return { invalid: false, text: parts.join(' '), leftover: end - p, argStart: -1 };
  }

  /* Decode one argument (type word already consumed). Returns the rendered
   * text and the position after the argument, or { invalid: true }. */
  function decodeOneArg(bytes, start, end, ti, msbf) {
    let p = start;
    // VARI: an attribute name string precedes the value; numeric types also
    // carry a unit string. Both are consumed and not rendered (R3-2).
    if (ti & TI_VARI) {
      const name = readLenBytes(bytes, p, end, msbf);
      if (name.invalid) return { invalid: true, p, text: null };
      p = name.p;
      if (ti & (TI_SINT | TI_UINT | TI_FLOA)) {
        const unit = readLenBytes(bytes, p, end, msbf);
        if (unit.invalid) return { invalid: true, p, text: null };
        p = unit.p;
      }
    }
    if (ti & TI_STRG) {
      const scod = ti & TI_SCOD;
      if (scod !== 0 && scod !== SCOD_UTF8) return { invalid: true, p, text: null }; // HEX/BIN coding: hex fallback
      const s = readLenBytes(bytes, p, end, msbf);
      if (s.invalid) return { invalid: true, p, text: null };
      const text = scod === SCOD_UTF8 ? utf8Text(s.bytes) : asciiText(s.bytes);
      return { invalid: false, p: s.p, text: stripOneNul(text) };
    }
    if (ti & TI_BOOL) {
      if ((ti & 0xf) !== 1 || p + 1 > end) return { invalid: true, p, text: null };
      return { invalid: false, p: p + 1, text: bytes[p] ? 'true' : 'false' };
    }
    if (ti & (TI_SINT | TI_UINT)) {
      const n = TYLE_BYTES[ti & 0xf];
      if (!n || p + n > end) return { invalid: true, p, text: null };
      return { invalid: false, p: p + n, text: intText(bytes, p, n, !!(ti & TI_SINT), msbf) };
    }
    if (ti & TI_FLOA) {
      const tyle = ti & 0xf;
      const n = tyle === 2 ? 2 : tyle === 3 ? 4 : tyle === 4 ? 8 : 0; // half/single/double
      if (!n || p + n > end) return { invalid: true, p, text: null };
      return { invalid: false, p: p + n, text: floatText(bytes, p, n, msbf) };
    }
    if (ti & TI_RAWD) {
      const raw = readLenBytes(bytes, p, end, msbf);
      if (raw.invalid) return { invalid: true, p, text: null };
      return { invalid: false, p: raw.p, text: dltHexDump(raw.bytes) };
    }
    return { invalid: true, p, text: null };
  }

  /* uint16 length prefix + bytes; DLT string/RAW lengths include the
   * terminating NUL for strings, so exactly one trailing NUL is stripped
   * when rendering (dlt-viewer parity). */
  function readLenBytes(bytes, p, end, msbf) {
    if (p + 2 > end) return { invalid: true, p, bytes: null };
    const len = msbf ? ((bytes[p] << 8) | bytes[p + 1]) : (bytes[p] | (bytes[p + 1] << 8));
    if (p + 2 + len > end) return { invalid: true, p, bytes: null };
    return { invalid: false, p: p + 2 + len, bytes: bytes.subarray(p + 2, p + 2 + len) };
  }

  function stripOneNul(s) {
    return s.length && s.charCodeAt(s.length - 1) === 0 ? s.slice(0, -1) : s;
  }

  function asciiText(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  /* UTF-8 decode; any byte that cannot extend (or start) a valid sequence
   * renders as a lowercase \xNN escape (AC-4.3) so the original bytes stay
   * visible in filter, search, and export. */
  function utf8Text(bytes) {
    let out = '';
    let i = 0;
    while (i < bytes.length) {
      const n = utf8SeqLen(bytes, i);
      if (!n) { out += '\\x' + hex2(bytes[i]); i++; continue; }
      if (n === 1) { out += String.fromCharCode(bytes[i]); i++; continue; }
      let cp = bytes[i] & (n === 2 ? 0x1f : n === 3 ? 0x0f : 0x07);
      for (let k = 1; k < n; k++) cp = (cp << 6) | (bytes[i + k] & 0x3f);
      out += String.fromCodePoint(cp);
      i += n;
    }
    return out;
  }

  /* Length of the UTF-8 sequence at `i` (with overlong/surrogate bounds), 0
   * when the lead or any continuation byte is invalid or truncated. */
  function utf8SeqLen(b, i) {
    const c = b[i];
    if (c < 0x80) return 1;
    let n, lo, hi;
    if (c < 0xc2) return 0; // continuation byte or overlong 2-byte lead
    if (c < 0xe0) { n = 2; lo = 0x80; hi = 0xbf; }
    else if (c < 0xf0) {
      n = 3;
      if (c === 0xe0) { lo = 0xa0; hi = 0xbf; } // overlong lead: tighter floor
      else if (c === 0xed) { lo = 0x80; hi = 0x9f; } // surrogate-half lead: tighter ceiling
    } else if (c < 0xf5) {
      n = 4;
      if (c === 0xf0) { lo = 0x90; hi = 0xbf; }       // overlong lead: tighter floor
      else if (c === 0xf4) { lo = 0x80; hi = 0x8f; }  // beyond U+10FFFF: tighter ceiling
    } else return 0;
    if (i + n > b.length) return 0;
    for (let k = 1; k < n; k++) {
      const cc = b[i + k];
      const low = k === 1 ? lo : 0x80;
      const high = k === 1 ? hi : 0xbf;
      if (cc < low || cc > high) return 0;
    }
    return n;
  }

  /* Integers up to 32-bit return as plain Numbers; 64/128-bit use BigInt so
   * magnitude survives exactly (R3-2), rendered as decimal strings. */
  function intText(bytes, p, n, signed, msbf) {
    let v = 0n;
    if (msbf) {
      for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(bytes[p + i]);
    } else {
      for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[p + i]);
    }
    if (signed) v = BigInt.asIntN(n * 8, v);
    return (n <= 4 ? Number(v) : v).toString();
  }

  function floatText(bytes, p, n, msbf) {
    if (n === 2) {
      const h = msbf ? ((bytes[p] << 8) | bytes[p + 1]) : ((bytes[p + 1] << 8) | bytes[p]);
      return String(halfToDouble(h));
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return String(n === 4 ? dv.getFloat32(p, !msbf) : dv.getFloat64(p, !msbf));
  }

  /* IEEE 754 binary16 -> Number, exact (values this small are sums of powers
   * of two). Subnormal: mantissa * 2^-24; special: NaN / +/-Infinity. */
  function halfToDouble(h) {
    const s = (h >> 15) & 1;
    const e = (h >> 10) & 0x1f;
    const m = h & 0x3ff;
    if (e === 0x1f) return m ? NaN : (s ? -Infinity : Infinity);
    if (e === 0) return (s ? -1 : 1) * m * Math.pow(2, -24);
    return (s ? -1 : 1) * (1 + m / 1024) * Math.pow(2, e - 15);
  }

  function trimId(bytes, off) {
    let end = off + 4;
    while (end > off && (bytes[end - 1] === 0 || bytes[end - 1] === 0x20)) end--;
    return asciiText(bytes.subarray(off, end));
  }

  function readU32(bytes, off, msbf) {
    return msbf
      ? (((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0)
      : (((bytes[off + 3] << 24) | (bytes[off + 2] << 16) | (bytes[off + 1] << 8) | bytes[off]) >>> 0);
  }

  /* int32 variant (bitwise ops keep the sign) for storage-header microseconds. */
  function readI32(bytes, off, msbf) {
    return msbf
      ? ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3])
      : ((bytes[off + 3] << 24) | (bytes[off + 2] << 16) | (bytes[off + 1] << 8) | bytes[off]);
  }

  return {
    dltIsStorageMagic,
    dltMinHeaderLength,
    dltPlausibleHeader,
    dltSniff,
    dltDecodeMessage,
    dltScanMessages,
    dltFindResync,
    dltEpochToTimeText,
    dltHexDump,
    dltHeaderSwap,
  };
}));
