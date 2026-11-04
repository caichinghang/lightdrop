// Receiver-side state for one transfer: collects optical blocks, decodes
// segments, and hands finished ones to the sink.

import { FrameType, parseFrame, type DataFrame } from "./frame";
import { SegmentDecoder } from "./fountain";
import { segmentCount, segmentLength } from "./segments";
import type { Ack } from "./scheduler";

export interface SegmentSink {
  /** Resume state for a file, if a previous attempt saved one. */
  open(info: TransferInfo): Promise<Uint8Array | undefined>;
  write(seg: number, bytes: Uint8Array, done: Uint8Array): Promise<void>;
}

export interface TransferInfo {
  fileId: number;
  totalSize: number;
  name: string;
  mime: string;
}

export interface ReceiverEvents {
  onLock?(info: TransferInfo): void;
  onMeta?(info: TransferInfo): void;
  onProgress?(): void;
  onComplete?(info: TransferInfo): void;
}

/** Partially decoded segments held in memory at once. */
const MAX_DECODERS = 64;
/** A different stream takes over when the current one has been silent this long. */
const SWITCH_AFTER_MS = 4000;

export class Receiver {
  info?: TransferInfo;
  done?: Uint8Array;
  doneCount = 0;
  segCount = 0;
  usefulFrames = 0;
  totalFrames = 0;
  bytesDone = 0;
  completed = false;
  private decoders = new Map<number, SegmentDecoder>();
  private lastUseful = 0;
  private opening?: Promise<void>;
  private pendingWrites = new Set<Promise<void>>();
  private haveMeta = false;

  constructor(
    private readonly sink: SegmentSink,
    private readonly events: ReceiverEvents = {},
  ) {}

  get progress(): number {
    return this.info ? this.bytesDone / Math.max(1, this.info.totalSize) : 0;
  }

  /** Like `progress`, but also credits segments that are partly decoded, so
   *  the number moves frame by frame instead of every segment. */
  get smoothProgress(): number {
    if (!this.info) return 0;
    let partial = 0;
    for (const d of this.decoders.values()) partial += (d.rank / d.k) * d.segLen;
    return Math.min(1, (this.bytesDone + partial) / Math.max(1, this.info.totalSize));
  }

  private lock(fileId: number, totalSize: number) {
    this.info = { fileId, totalSize, name: "", mime: "" };
    this.haveMeta = false;
    this.segCount = segmentCount(totalSize);
    this.done = new Uint8Array(this.segCount);
    this.doneCount = 0;
    this.bytesDone = 0;
    this.completed = false;
    this.decoders.clear();
    this.opening = undefined;
    this.lastUseful = performance.now();
    this.events.onLock?.(this.info);
  }

  /** Accept frames for `fileId`? Locks on (or switches) as needed. */
  private accept(fileId: number, totalSize: number | undefined): boolean {
    if (this.info?.fileId === fileId) return true;
    if (totalSize === undefined) return false;
    const idle = performance.now() - this.lastUseful > SWITCH_AFTER_MS;
    if (!this.info || this.completed || idle) {
      this.lock(fileId, totalSize);
      return true;
    }
    return false;
  }

  /** Opening the sink needs the file name, so it waits for the first META frame. */
  private ensureOpen(): Promise<void> | undefined {
    if (!this.haveMeta || !this.info) return undefined;
    if (!this.opening) {
      const info = this.info;
      this.opening = this.sink.open(info).then((resume) => {
        if (this.info !== info || !resume || resume.length !== this.segCount) return;
        for (let s = 0; s < this.segCount; s++) {
          if (resume[s] && !this.done![s]) this.markDone(s);
        }
        this.events.onProgress?.();
        if (this.doneCount === this.segCount && this.pendingWrites.size === 0 && !this.completed) {
          this.completed = true;
          this.events.onComplete?.(info);
        }
      });
    }
    return this.opening;
  }

  onFrame(bytes: Uint8Array) {
    const f = parseFrame(bytes);
    if (!f) return;
    this.totalFrames++;
    if (f.type === FrameType.Meta) {
      if (!this.accept(f.fileId, f.totalSize)) return;
      if (!this.haveMeta) {
        this.haveMeta = true;
        this.info!.name = f.name || "file";
        this.info!.mime = f.mime || "application/octet-stream";
        void this.ensureOpen();
        this.events.onMeta?.(this.info!);
      }
      return;
    }
    // Data blocks don't carry the file size; they count once META has locked us on.
    if (this.info?.fileId !== f.fileId) return;
    this.onData(f);
  }

  private onData(f: DataFrame) {
    const done = this.done!;
    if (f.seg >= this.segCount || done[f.seg]) return;
    let d = this.decoders.get(f.seg);
    if (!d) {
      if (this.decoders.size >= MAX_DECODERS) this.evict();
      d = new SegmentDecoder(f.fileId, f.seg, segmentLength(this.info!.totalSize, f.seg), f.payload.length);
      this.decoders.set(f.seg, d);
    }
    if (f.payload.length !== d.blockLen) {
      // The sender changed density mid-segment: start this segment over.
      d = new SegmentDecoder(f.fileId, f.seg, segmentLength(this.info!.totalSize, f.seg), f.payload.length);
      this.decoders.set(f.seg, d);
    }
    if (!d.add(f.seq, f.payload)) return;
    this.usefulFrames++;
    this.lastUseful = performance.now();
    if (d.complete) {
      this.decoders.delete(f.seg);
      // Every block passed its own Reed–Solomon check, so no segment CRC here.
      this.finishSegment(f.seg, d.solve());
    }
    this.events.onProgress?.();
  }

  private evict() {
    let worst: number | undefined;
    let worstRank = Infinity;
    for (const [s, d] of this.decoders) {
      if (d.rank < worstRank) {
        worstRank = d.rank;
        worst = s;
      }
    }
    if (worst !== undefined) this.decoders.delete(worst);
  }

  private markDone(seg: number) {
    this.done![seg] = 1;
    this.doneCount++;
    this.bytesDone += segmentLength(this.info!.totalSize, seg);
  }

  private finishSegment(seg: number, bytes: Uint8Array) {
    const info = this.info!;
    this.markDone(seg);
    const done = this.done!;
    const write = (async () => {
      // Without META we can't open the sink yet; wait for it.
      while (!this.ensureOpen()) {
        if (this.info !== info) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      await this.ensureOpen();
      if (this.info !== info) return;
      await this.sink.write(seg, bytes, done);
    })();
    this.pendingWrites.add(write);
    void write.finally(() => {
      this.pendingWrites.delete(write);
      if (this.info === info && this.doneCount === this.segCount && this.pendingWrites.size === 0 && !this.completed) {
        this.completed = true;
        this.events.onComplete?.(info);
      }
    });
  }

  ack(): Ack | undefined {
    if (!this.done) return undefined;
    let f = 0;
    while (f < this.segCount && this.done[f]) f++;
    let bitmap = 0;
    for (let i = 0; i < 16; i++) if (this.done[f + 1 + i]) bitmap |= 1 << i;
    return { firstIncomplete: f, bitmap, recvCount: this.usefulFrames & 0xffff };
  }
}
