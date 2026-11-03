// Systematic random linear fountain code over GF(2), per segment.
//
// Frame seq < k carries source block `seq` verbatim. Frame seq >= k is the XOR
// of a pseudorandom half of the k blocks, chosen deterministically from
// (fileId, seg, seq). The receiver runs incremental Gaussian elimination, so
// ANY k linearly independent frames rebuild the segment — on average about
// k + 1.6 frames, versus ~1.15·k for the LT/soliton code decimen uses.
// Dense rows are affordable because segments are small (k ≈ 90–350).

import { mix3, splitmix32 } from "./prng";

/** Coefficient row for frame `seq`, as a k-bit little-endian bitset. */
export function coefficients(fileId: number, seg: number, seq: number, k: number): Uint32Array {
  const words = (k + 31) >>> 5;
  const row = new Uint32Array(words);
  if (seq < k) {
    row[seq >>> 5] = 1 << (seq & 31);
    return row;
  }
  const rnd = splitmix32(mix3(fileId, seg, seq));
  for (;;) {
    for (let w = 0; w < words; w++) row[w] = rnd();
    const tail = k & 31;
    if (tail) row[words - 1]! &= (1 << tail) - 1;
    if (row.some((x) => x !== 0)) return row;
  }
}

/** Uint32 view over a block; blocks are always a multiple of 4 bytes. */
function words(b: Uint8Array): Uint32Array {
  return new Uint32Array(b.buffer, b.byteOffset, b.byteLength >>> 2);
}

function xorInto(dst: Uint32Array, src: Uint32Array) {
  for (let i = 0; i < dst.length; i++) dst[i]! ^= src[i]!;
}

/**
 * Sender side: a segment's bytes padded out to k blocks of `blockLen`.
 */
export class SegmentEncoder {
  readonly k: number;
  private readonly data: Uint8Array;

  constructor(
    readonly fileId: number,
    readonly seg: number,
    bytes: Uint8Array,
    readonly blockLen: number,
  ) {
    if (blockLen % 4 !== 0) throw new Error("blockLen must be a multiple of 4");
    this.k = Math.max(1, Math.ceil(bytes.length / blockLen));
    this.data = new Uint8Array(this.k * blockLen);
    this.data.set(bytes);
  }

  block(i: number): Uint8Array {
    return this.data.subarray(i * this.blockLen, (i + 1) * this.blockLen);
  }

  /** Payload for frame `seq`. */
  encode(seq: number): Uint8Array {
    if (seq < this.k) return this.block(seq);
    const row = coefficients(this.fileId, this.seg, seq, this.k);
    const out = new Uint8Array(this.blockLen);
    const o = words(out);
    for (let i = 0; i < this.k; i++) {
      if (row[i >>> 5]! & (1 << (i & 31))) xorInto(o, words(this.block(i)));
    }
    return out;
  }
}

interface Pivot {
  row: Uint32Array;
  data: Uint8Array;
}

function lowestBit(row: Uint32Array, from: number): number {
  for (let w = from >>> 5; w < row.length; w++) {
    let x = row[w]!;
    if (w === from >>> 5) x &= ~0 << (from & 31);
    if (x) return (w << 5) + (31 - Math.clz32(x & -x));
  }
  return -1;
}

/**
 * Receiver side: incremental Gaussian elimination. Rows are kept in echelon
 * form keyed by their lowest set column; the back-substitution only runs once,
 * at full rank.
 */
export class SegmentDecoder {
  readonly k: number;
  rank = 0;
  private readonly pivots: (Pivot | undefined)[];
  private readonly seen = new Set<number>();

  constructor(
    readonly fileId: number,
    readonly seg: number,
    readonly segLen: number,
    readonly blockLen: number,
  ) {
    this.k = Math.max(1, Math.ceil(segLen / blockLen));
    this.pivots = new Array(this.k);
  }

  get complete(): boolean {
    return this.rank === this.k;
  }

  get deficit(): number {
    return this.k - this.rank;
  }

  /** Returns true when the frame added information. */
  add(seq: number, payload: Uint8Array): boolean {
    if (this.complete || this.seen.has(seq) || payload.length < this.blockLen) return false;
    this.seen.add(seq);
    // Fast path: a source block we have no pivot for yet.
    if (seq < this.k && !this.pivots[seq]) {
      this.pivots[seq] = { row: coefficients(this.fileId, this.seg, seq, this.k), data: payload.slice(0, this.blockLen) };
      this.rank++;
      return true;
    }
    const row = coefficients(this.fileId, this.seg, seq, this.k);
    const data = payload.slice(0, this.blockLen);
    const dw = words(data);
    let col = lowestBit(row, 0);
    while (col >= 0) {
      const p = this.pivots[col];
      if (!p) {
        this.pivots[col] = { row, data };
        this.rank++;
        return true;
      }
      xorInto(row, p.row);
      xorInto(dw, words(p.data));
      col = lowestBit(row, col + 1);
    }
    return false; // linearly dependent
  }

  /** Back-substitute and return the segment's bytes. Only valid when complete. */
  solve(): Uint8Array {
    if (!this.complete) throw new Error("segment not complete");
    for (let c = this.k - 1; c >= 0; c--) {
      const p = this.pivots[c]!;
      let j = lowestBit(p.row, c + 1);
      while (j >= 0) {
        const q = this.pivots[j]!; // already reduced to a unit row
        xorInto(p.row, q.row);
        xorInto(words(p.data), words(q.data));
        j = lowestBit(p.row, j + 1);
      }
    }
    const out = new Uint8Array(this.segLen);
    for (let c = 0; c < this.k; c++) {
      const start = c * this.blockLen;
      if (start >= this.segLen) break;
      out.set(this.pivots[c]!.data.subarray(0, Math.min(this.blockLen, this.segLen - start)), start);
    }
    return out;
  }
}
