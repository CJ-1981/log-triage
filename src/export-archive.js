/* Log Triage — export-archive.js: streaming archive assembly for exports.
 * Entries arrive as { name, chunksFactory } where chunksFactory() returns an
 * async iterable of Uint8Array; nothing is ever buffered whole. Formats:
 *   zip    — stored entries with data descriptors (flag bit 3): sizes/CRC are
 *            written after the data, so entries stream in a single pass.
 *   tar    — the header needs the size up front, so each entry runs its factory
 *            twice (size pass, then write pass).
 *   tar.gz — the tar byte stream piped through CompressionStream('gzip').
 *   7z     — NOT streamable (sizes live in the start header); the caller keeps
 *            the bounded buffered writer for it. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  // raw CRC state (finalize with crcFinish)
  function crcFeed(state, chunk) {
    let c = state;
    for (let i = 0; i < chunk.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ chunk[i]) & 0xff];
    return c >>> 0;
  }
  function crcFinish(state) { return (state ^ 0xffffffff) >>> 0; }

  const enc = new TextEncoder();
  const u16 = (v) => new Uint8Array([v & 255, (v >>> 8) & 255]);
  const u32 = (v) => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
  const dosTime = (d) => (((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31)) & 0xffff;
  const dosDate = (d) => ((((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)) & 0xffff;

  /* yield a byte block while keeping the running offset in sync */
  async function* put(bytes, state) { state.offset += bytes.length; yield bytes; }

  async function* zipChunks(entries) {
    const now = new Date();
    const t = u16(dosTime(now)), d = u16(dosDate(now));
    const state = { offset: 0 };
    const central = [];
    for await (const e of entries) {
      const name = enc.encode(e.name);
      if (name.length > 65535) throw new Error('archive entry name too long');
      central.push({ name, offset: state.offset, crc: 0, size: 0 });
      // local file header: flag bit 3 (data descriptor follows the data) + UTF-8
      yield* put(u32(0x04034b50), state); yield* put(u16(20), state); yield* put(u16(0x0808), state);
      yield* put(u16(0), state); yield* put(t, state); yield* put(d, state);
      yield* put(u32(0), state); yield* put(u32(0), state); yield* put(u32(0), state);
      yield* put(u16(name.length), state); yield* put(u16(0), state); yield* put(name, state);
      let crc = 0xffffffff, size = 0;
      for await (const chunk of await e.chunksFactory()) {
        crc = crcFeed(crc, chunk);
        size += chunk.length;
        yield* put(chunk, state);
      }
      crc = crcFinish(crc);
      if (size > 0xffffffff) throw new Error('a file exceeds the 4 GiB zip entry limit — split the export with filters');
      Object.assign(central[central.length - 1], { crc, size });
      yield* put(u32(0x08074b50), state); yield* put(u32(crc), state); yield* put(u32(size), state); yield* put(u32(size), state);
    }
    const cdStart = state.offset;
    for (const c of central) {
      yield* put(u32(0x02014b50), state); yield* put(u16(20), state); yield* put(u16(20), state);
      yield* put(u16(0x0808), state); yield* put(u16(0), state); yield* put(t, state); yield* put(d, state);
      yield* put(u32(c.crc), state); yield* put(u32(c.size), state); yield* put(u32(c.size), state);
      yield* put(u16(c.name.length), state); yield* put(u16(0), state); yield* put(u16(0), state);
      yield* put(u16(0), state); yield* put(u16(0), state); yield* put(u32(0), state); yield* put(u32(c.offset), state);
      yield* put(c.name, state);
    }
    const cdSize = state.offset - cdStart;
    if (central.length > 0xffff) throw new Error('too many files for a zip archive');
    yield* put(u32(0x06054b50), state); yield* put(u16(0), state); yield* put(u16(0), state);
    yield* put(u16(central.length), state); yield* put(u16(central.length), state);
    yield* put(u32(cdSize), state); yield* put(u32(cdStart), state); yield* put(u16(0), state);
  }

  function tarHeader(name, size) {
    const header = new Uint8Array(512);
    const nameBytes = enc.encode(name);
    header.set(nameBytes.subarray(0, Math.min(100, nameBytes.length)), 0);
    header.set(enc.encode('0000644\0'), 100);
    header.set(enc.encode(size.toString(8).padStart(11, '0') + '\0'), 124);
    header.set(enc.encode('        '), 148);
    header[156] = 48; // '0' — regular file
    header.set(enc.encode('ustar\0'), 257);
    header.set(enc.encode('00'), 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
    return header;
  }

  async function* tarChunks(entries) {
    const state = { offset: 0 };
    for await (const e of entries) {
      let size = 0;
      for await (const c of await e.chunksFactory()) size += c.length;
      yield* put(tarHeader(e.name, size), state);
      for await (const c of await e.chunksFactory()) yield* put(c, state);
      const pad = (512 - (size % 512)) % 512;
      if (pad) yield* put(new Uint8Array(pad), state);
    }
    yield* put(new Uint8Array(1024), state);
  }

  /* ReadableStream from an async iterator (avoid relying on ReadableStream.from) */
  function streamOf(iter) {
    return new ReadableStream({
      async pull(controller) {
        const { value, done } = await iter.next();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      async cancel(reason) { try { await iter.return(reason); } catch (e) { /* generator already finished */ } },
    });
  }

  async function* gzipWrap(inner) {
    const compressed = streamOf(inner).pipeThrough(new CompressionStream('gzip'));
    for await (const chunk of compressed) yield chunk;
  }

  /** Stream an archive built from entries into write(byteBlock). Returns the
   * total number of bytes written. Never buffers a whole entry. */
  async function streamArchive(entries, format, write, opts) {
    const o = opts || {};
    const signal = o.signal || null;
    const onBytes = o.onBytes || (() => {});
    let gen;
    if (format === 'zip') gen = zipChunks(entries);
    else if (format === 'tar') gen = tarChunks(entries);
    else if (format === 'tar.gz') {
      if (typeof CompressionStream !== 'function') {
        throw new Error('this browser cannot compress streams (no CompressionStream) — choose .zip or .tar instead');
      }
      gen = gzipWrap(tarChunks(entries));
    } else throw new Error(format + ' is not streamable — use the buffered export for this format');
    let written = 0;
    for await (const block of gen) {
      if (signal && signal.aborted) throw new Error('export cancelled');
      await write(block);
      written += block.length;
      onBytes(written);
    }
    return written;
  }

  return { streamArchive };
}));
