// Sender-side scheduling: which segment the next frames come from.
//
// Without a back-channel the sender loops over every segment, giving each one
// enough frames for an assumed catch rate, then tops everything up and loops
// again. With sound ACKs it knows which segments are finished and how many
// frames actually reach the camera, so it stops wasting screen time on
// segments the receiver already has and goes back for the ones it's missing.

import { SegmentEncoder } from "./fountain";
import { crc32 } from "./crc";
import { SEG_BYTES, blocksInSegment, segmentCount, segmentLength } from "./segments";

export interface Ack {
  firstIncomplete: number;
  /** bit i = segment firstIncomplete + 1 + i is done */
  bitmap: number;
  /** useful frames received, cumulative, mod 65536 */
  recvCount: number;
}

interface CachedSegment {
  enc: SegmentEncoder;
  crc: number;
}

const DEFAULT_RATE = 0.6;
const BATCH = 6;
const CACHE_SEGMENTS = 12;

export class Scheduler {
  readonly segCount: number;
  readonly done: Uint8Array;
  private readonly sent: Uint32Array;
  private readonly budget: Float64Array;
  private readonly nextSeq: Uint32Array;
  private readonly lastSentAt: Float64Array;
  private readonly cache = new Map<number, CachedSegment>();
  private readonly loading = new Map<number, Promise<CachedSegment>>();
  private cursor = 0;
  private firstIncomplete = 0;
  sentTotal = 0;
  rate = DEFAULT_RATE;
  private lastAck?: { at: number; sent: number; recv: number };
  lastAckAt = 0;

  constructor(
    readonly file: Blob,
    readonly fileId: number,
    public blockLen: number,
  ) {
    this.segCount = segmentCount(file.size);
    this.done = new Uint8Array(this.segCount);
    this.sent = new Uint32Array(this.segCount);
    this.budget = new Float64Array(this.segCount);
    this.nextSeq = new Uint32Array(this.segCount);
    this.lastSentAt = new Float64Array(this.segCount);
    for (let s = 0; s < this.segCount; s++) this.budget[s] = this.initialBudget(s);
  }

  get doneCount(): number {
    let n = 0;
    for (let s = 0; s < this.segCount; s++) n += this.done[s]!;
    return n;
  }

  get finished(): boolean {
    return this.doneCount === this.segCount;
  }

  private k(s: number): number {
    return blocksInSegment(this.file.size, s, this.blockLen);
  }

  private initialBudget(s: number): number {
    return Math.ceil((this.k(s) * 1.05) / this.rate) + 3;
  }

  async segment(s: number): Promise<CachedSegment> {
    const hit = this.cache.get(s);
    if (hit) {
      this.cache.delete(s);
      this.cache.set(s, hit); // LRU touch
      return hit;
    }
    let p = this.loading.get(s);
    if (!p) {
      const blockLen = this.blockLen;
      p = (async (): Promise<CachedSegment> => {
        const start = s * SEG_BYTES;
        const bytes = new Uint8Array(await this.file.slice(start, start + segmentLength(this.file.size, s)).arrayBuffer());
        if (this.blockLen !== blockLen) return this.segment(s); // density changed while reading
        const seg = { enc: new SegmentEncoder(this.fileId, s, bytes, this.blockLen), crc: crc32(bytes) };
        this.cache.set(s, seg);
        while (this.cache.size > CACHE_SEGMENTS) this.cache.delete(this.cache.keys().next().value!);
        this.loading.delete(s);
        return seg;
      })();
      this.loading.set(s, p);
    }
    return p;
  }

  /** Segment the next batch should come from, or -1 when everything is acknowledged. */
  private pick(): number {
    for (let pass = 0; pass < 2; pass++) {
      const span = this.segCount - this.firstIncomplete;
      for (let i = 0; i < span; i++) {
        const s = this.firstIncomplete + ((this.cursor - this.firstIncomplete + i + span) % span);
        if (!this.done[s] && this.sent[s]! < this.budget[s]!) return s;
      }
      // Everything has had its share: top up all unfinished segments and loop.
      let any = false;
      for (let s = this.firstIncomplete; s < this.segCount; s++) {
        if (this.done[s]) continue;
        this.budget[s]! += Math.ceil((this.k(s) * 0.35) / this.rate) + 2;
        any = true;
      }
      if (!any) return -1;
    }
    return -1;
  }

  /** The next batch of (segment, seq) frames to show. */
  async nextBatch(): Promise<{ seg: number; seq: number; payload: Uint8Array; crc: number }[]> {
    const s = this.pick();
    if (s < 0) return [];
    this.cursor = s;
    const { enc, crc } = await this.segment(s);
    // Prefetch the next segment so the stream never stalls on a file read.
    if (s + 1 < this.segCount) void this.segment(s + 1);
    const n = Math.max(1, Math.min(BATCH, Math.ceil(this.budget[s]! - this.sent[s]!)));
    const out = [];
    for (let i = 0; i < n; i++) {
      let seq = this.nextSeq[s]!;
      // seq is a u16 on the wire: once wrapped, stay in the repair range.
      if (seq > 0xffff) seq = enc.k + ((seq - enc.k) % (0x10000 - enc.k));
      this.nextSeq[s]!++;
      out.push({ seg: s, seq, payload: enc.encode(seq), crc });
    }
    this.sent[s]! += n;
    this.sentTotal += n;
    this.lastSentAt[s] = performance.now();
    if (this.sent[s]! >= this.budget[s]!) this.cursor = s + 1 < this.segCount ? s + 1 : this.firstIncomplete;
    return out;
  }

  /**
   * Switch QR density. Unfinished segments start over at the new block size
   * (the receiver resets them too); finished ones stay finished.
   */
  setBlockLen(blockLen: number) {
    if (blockLen === this.blockLen) return;
    this.blockLen = blockLen;
    this.cache.clear();
    this.loading.clear();
    for (let s = 0; s < this.segCount; s++) {
      if (this.done[s]) continue;
      this.sent[s] = 0;
      this.nextSeq[s] = 0;
      this.budget[s] = this.initialBudget(s);
    }
    this.cursor = this.firstIncomplete;
  }

  /** Apply a receiver ACK (from sound or the data channel). */
  onAck(ack: Ack, now = performance.now()) {
    this.lastAckAt = now;
    const f = Math.min(ack.firstIncomplete, this.segCount);
    for (let s = 0; s < f; s++) this.done[s] = 1;
    for (let i = 0; i < 16; i++) if (ack.bitmap & (1 << i) && f + 1 + i < this.segCount) this.done[f + 1 + i] = 1;
    this.firstIncomplete = Math.min(f, this.segCount - 1);

    if (this.lastAck) {
      const dSent = this.sentTotal - this.lastAck.sent;
      const dRecv = (ack.recvCount - this.lastAck.recv + 0x10000) & 0xffff;
      if (dSent > 20) {
        const r = Math.min(1, Math.max(0.05, dRecv / dSent));
        this.rate = this.rate * 0.6 + r * 0.4;
      }
    }
    this.lastAck = { at: now, sent: this.sentTotal, recv: ack.recvCount };

    // Segments near the front that used up their budget but are still missing
    // need more frames now, not on the next full loop of the file.
    for (let s = f; s < Math.min(this.segCount, f + 17); s++) {
      if (this.done[s] || this.sent[s]! < this.budget[s]!) continue;
      if (now - this.lastSentAt[s]! < 1500) continue; // the ACK may predate our last frames
      this.budget[s] = this.sent[s]! + Math.ceil((this.k(s) * 0.25) / this.rate) + 4;
      this.cursor = Math.min(this.cursor, s);
    }
    if (this.cursor < f) this.cursor = f;
  }

  /** Bytes the receiver has confirmed. */
  get ackedBytes(): number {
    let n = 0;
    for (let s = 0; s < this.segCount; s++) if (this.done[s]) n += segmentLength(this.file.size, s);
    return n;
  }
}
