/* Log Triage — lzma.js: pure-JS LZMA1 + LZMA2 decoder (no WASM, no deps).
 * Decodes raw LZMA1 streams (7z coder id 03 01 01) and chunked LZMA2 streams
 * (7z coder id 21) into a caller-sized Uint8Array. Encoding is deliberately
 * not implemented: the browser pipeline only needs extraction. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TOP = 1 << 24;

  /* LZMA1 decoder state: probability model + position/state machine decoding
   * into `out` starting at outPosStart. The range coder is (re-)attached to a
   * byte position via rcInit(src, pos) — LZMA2 continuation chunks keep the
   * probability state but re-init the coder. dictStart limits how far back
   * match distances may reach (LZMA2 dictionary resets). */
  function createDecoderState(props, out, dictStart, outPosStart) {
    if (props > 224) throw new Error('lzma: invalid properties byte ' + props);
    const lc = props % 9;
    const rest = (props / 9) | 0;
    const lp = rest % 5;
    const pb = (rest / 5) | 0;

    // probability bank layout (canonical LZMA order, sized for pb=4)
    let base = 0;
    const OFF_LIT = base; base += 0x300 << (lc + lp);
    const OFF_IS_MATCH = base; base += 192;
    const OFF_IS_REP = base; base += 12;
    const OFF_IS_REPG0 = base; base += 12;
    const OFF_IS_REPG1 = base; base += 12;
    const OFF_IS_REPG2 = base; base += 12;
    const OFF_IS_REP0LONG = base; base += 192;
    const OFF_POS_SLOT = base; base += 256;
    const OFF_SPEC_POS = base; base += 115;
    const OFF_ALIGN = base; base += 16;
    const OFF_LEN = base; base += 514;
    const OFF_REP_LEN = base; base += 514;
    const probs = new Uint16Array(base);
    probs.fill(1024);

    // range decoder state (attached per chunk via rcInit)
    let src = null;
    let p = 0;
    let hardEnd = 0;
    let code = 0;
    let range = 0xFFFFFFFF;

    function rcInit(nextSrc, pos, end) {
      src = nextSrc;
      p = pos;
      hardEnd = end == null ? src.length : Math.min(end, src.length);
      // one zero byte, then a 32-bit big-endian code
      if (src[p] !== 0) throw new Error('lzma: corrupt stream (bad range coder init)');
      p++;
      code = 0;
      for (let i = 0; i < 4; i++) code = ((code << 8) | src[p++]) >>> 0;
      range = 0xFFFFFFFF;
    }

    function normalize() {
      while (range < TOP) {
        if (p >= hardEnd) throw new Error('lzma: unexpected end of stream');
        range = (range << 8) >>> 0;
        code = ((code << 8) | src[p++]) >>> 0;
      }
    }

    function decodeBit(idx) {
      const prob = probs[idx];
      const bound = (range >>> 11) * prob;
      let bit;
      if ((code >>> 0) < bound) {
        probs[idx] = prob + ((2048 - prob) >> 5);
        range = bound;
        bit = 0;
      } else {
        probs[idx] = prob - (prob >> 5);
        code = (code - bound) >>> 0;
        range = (range - bound) >>> 0;
        bit = 1;
      }
      normalize();
      return bit;
    }

    function decodeTree(idx, bits) {
      let m = 1;
      for (let i = 0; i < bits; i++) m = (m << 1) | decodeBit(idx + m);
      return m - (1 << bits);
    }

    function decodeDirect(bits) {
      let res = 0;
      do {
        range = range >>> 1;
        code = (code - range) >>> 0;
        const borrow = code >>> 31;
        if (borrow) code = (code + range) >>> 0;
        if (code === range) throw new Error('lzma: corrupt stream (range marker)');
        normalize();
        res = (res << 1) + (1 - borrow);
      } while (--bits);
      return res;
    }

    function decodeLen(off, posState) {
      if (decodeBit(off) === 0) return decodeTree(off + 2 + posState * 8, 3);
      if (decodeBit(off + 1) === 0) return 8 + decodeTree(off + 2 + 128 + posState * 8, 3);
      return 16 + decodeTree(off + 2 + 256, 8);
    }

    let outPos = outPosStart || 0;
    let state = 0;
    let rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0;
    const posStateMask = (1 << pb) - 1;
    const lpMask = (1 << lp) - 1;

    function dictCheck(dist) {
      if (dist + 1 > outPos - dictStart) throw new Error('lzma: corrupt stream (distance beyond dictionary)');
    }

    function copyMatch(len, dist) {
      dictCheck(dist);
      let from = outPos - dist - 1;
      for (let i = 0; i < len; i++) out[outPos++] = out[from++];
    }

    function decode(target) {
      while (outPos < target) {
        const posState = outPos & posStateMask;
        if (decodeBit(OFF_IS_MATCH + (state << 4) + posState) === 0) {
          const prevByte = outPos > 0 ? out[outPos - 1] : 0;
          const litBase = (((outPos & lpMask) << lc) + (prevByte >> (8 - lc))) * 0x300;
          let sym = 1;
          if (state >= 7) {
            dictCheck(rep0);
            let matchByte = out[outPos - rep0 - 1];
            do {
              const matchBit = (matchByte >> 7) & 1;
              matchByte = (matchByte << 1) & 0xff;
              const bit = decodeBit(OFF_LIT + litBase + ((1 + matchBit) << 8) + sym);
              sym = (sym << 1) | bit;
              if (matchBit !== bit) break;
            } while (sym < 0x100);
          }
          while (sym < 0x100) sym = (sym << 1) | decodeBit(OFF_LIT + litBase + sym);
          out[outPos++] = sym - 0x100;
          state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        } else if (decodeBit(OFF_IS_REP + state) === 0) {
          rep3 = rep2; rep2 = rep1; rep1 = rep0;
          const len = decodeLen(OFF_LEN, posState) + 2;
          state = state < 7 ? 7 : 10;
          const lenToPosState = Math.min(len - 2, 3);
          const posSlot = decodeTree(OFF_POS_SLOT + (lenToPosState << 6), 6);
          let dist;
          if (posSlot < 4) {
            dist = posSlot;
          } else {
            const numDirectBits = (posSlot >> 1) - 1;
            dist = (2 | (posSlot & 1)) << numDirectBits;
            if (posSlot < 14) {
              const off = OFF_SPEC_POS + dist - posSlot;
              let m = 1, add = 0;
              for (let i = 0; i < numDirectBits; i++) {
                const bit = decodeBit(off + m);
                m = (m << 1) | bit;
                add |= bit << i;
              }
              dist += add;
            } else {
              dist += decodeDirect(numDirectBits - 4) << 4;
              let m = 1, add = 0;
              for (let i = 0; i < 4; i++) {
                const bit = decodeBit(OFF_ALIGN + m);
                m = (m << 1) | bit;
                add |= bit << i;
              }
              dist += add;
            }
          }
          rep0 = dist;
          copyMatch(len, dist);
        } else if (decodeBit(OFF_IS_REPG0 + state) === 0) {
          if (decodeBit(OFF_IS_REP0LONG + (state << 4) + posState) === 0) {
            dictCheck(rep0);
            out[outPos] = out[outPos - rep0 - 1];
            outPos++;
            state = state < 7 ? 9 : 11;
            continue;
          }
          const len = decodeLen(OFF_REP_LEN, posState) + 2;
          state = state < 7 ? 8 : 11;
          copyMatch(len, rep0);
        } else {
          let dist;
          if (decodeBit(OFF_IS_REPG1 + state) === 0) {
            dist = rep1;
          } else {
            if (decodeBit(OFF_IS_REPG2 + state) === 0) {
              dist = rep2;
            } else {
              dist = rep3;
              rep3 = rep2;
            }
            rep2 = rep1;
          }
          rep1 = rep0;
          rep0 = dist;
          const len = decodeLen(OFF_REP_LEN, posState) + 2;
          state = state < 7 ? 8 : 11;
          copyMatch(len, rep0);
        }
      }
    }

    return { rcInit, decode };
  }

  /** Raw LZMA1 stream (no header, no end marker): decode exactly outSize bytes.
   * Optional `end` bounds the readable input (a folder's packed stream), so a
   * corrupt stream cannot decode into the neighbouring pack data. */
  function lzmaDecode(src, pos, outSize, props, end) {
    const out = new Uint8Array(outSize);
    const dec = createDecoderState(props, out, 0, 0);
    dec.rcInit(src, pos, end);
    dec.decode(outSize);
    return out;
  }

  /** Chunked LZMA2 stream spanning src[pos..end): decode exactly outSize bytes.
   * Chunk controls (verified against archives produced by 7-Zip):
   * 0x00 end of stream; 0x01/0x02 uncompressed (stored) chunks, 0x01 also
   * resets the dictionary; 0x03..0x7F invalid; 0x80..0xDF LZMA chunks that
   * keep properties AND decoder state (only the range coder re-inits);
   * 0xE0..0xFF LZMA chunks with a new properties byte, dictionary reset and
   * full state reset. */
  function lzma2Decode(src, pos, end, outSize) {
    const out = new Uint8Array(outSize);
    let outPos = 0;
    let dictStart = 0;
    let props = -1;
    let dec = null;
    let p = pos;
    while (p < end) {
      const control = src[p++];
      if (control === 0) break;
      if (control === 1 || control === 2) {
        const size = (src[p] << 8) + src[p + 1] + 1;
        p += 2;
        if (p + size > end) throw new Error('lzma2: unexpected end of stream (truncated chunk)');
        if (outPos + size > outSize) throw new Error('lzma2: output size mismatch');
        out.set(src.subarray(p, p + size), outPos);
        p += size;
        outPos += size;
        if (control === 1) dictStart = outPos;
        dec = null;
      } else if (control >= 0x80) {
        const unpacked = ((control & 0x1f) << 16) + (src[p] << 8) + src[p + 1] + 1;
        const packed = (src[p + 2] << 8) + src[p + 3] + 1;
        if (control >= 0xE0) {
          props = src[p + 4];
          p += 5;
          dictStart = outPos;
          dec = null;
        } else {
          p += 4;
        }
        if (props < 0) throw new Error('lzma2: LZMA chunk without properties');
        if (p + packed > end) throw new Error('lzma2: unexpected end of stream (truncated chunk)');
        if (outPos + unpacked > outSize) throw new Error('lzma2: output size mismatch');
        if (!dec) dec = createDecoderState(props, out, dictStart, outPos);
        dec.rcInit(src, p);
        dec.decode(outPos + unpacked);
        outPos += unpacked;
        p += packed;
      } else {
        throw new Error('lzma2: unknown control byte 0x' + control.toString(16));
      }
    }
    if (outPos !== outSize) throw new Error('lzma2: output size mismatch (got ' + outPos + ' of ' + outSize + ')');
    return out;
  }

  return { lzmaDecode, lzma2Decode };
}));
