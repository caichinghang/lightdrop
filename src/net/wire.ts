// Data-channel protocol once the Wi-Fi link is up. The receiver asks for the
// segments it is missing; the sender streams them raw (no fountain coding —
// the channel is reliable), with backpressure on bufferedAmount.

import { Scheduler } from "../core/scheduler";
import { SEG_BYTES, segmentLength } from "../core/segments";
import type { Receiver } from "../core/receiver";

const CHUNK = 64 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const NEED_BATCH = 64;

export interface WireMeta {
  t: "meta";
  fileId: number;
  size: number;
  name: string;
  mime: string;
}

export class WireSender {
  private queue: number[] = [];
  private pumping = false;
  bytesSent = 0;

  constructor(
    private readonly dc: RTCDataChannel,
    private readonly sched: Scheduler,
    meta: WireMeta,
    private readonly onNeed: (missing: number[]) => void,
  ) {
    dc.bufferedAmountLowThreshold = 1024 * 1024;
    dc.send(JSON.stringify(meta));
    dc.addEventListener("message", (e) => {
      if (typeof e.data !== "string") return;
      const msg = JSON.parse(e.data) as { t: string; segs?: number[] };
      if (msg.t === "need" && msg.segs) {
        this.queue = msg.segs.filter((s) => s >= 0 && s < sched.segCount);
        onNeed(this.queue);
        void this.pump();
      }
    });
  }

  private async drain() {
    if (this.dc.bufferedAmount < HIGH_WATER) return;
    await new Promise<void>((r) => this.dc.addEventListener("bufferedamountlow", () => r(), { once: true }));
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && this.dc.readyState === "open") {
        const s = this.queue.shift()!;
        const start = s * SEG_BYTES;
        const len = segmentLength(this.sched.file.size, s);
        const bytes = new Uint8Array(await this.sched.file.slice(start, start + len).arrayBuffer());
        const { crc } = await this.sched.segment(s);
        for (let off = 0; off < len; off += CHUNK) {
          await this.drain();
          const part = bytes.subarray(off, Math.min(len, off + CHUNK));
          const msg = new Uint8Array(13 + part.length);
          const v = new DataView(msg.buffer);
          msg[0] = 1;
          v.setUint32(1, s, true);
          v.setUint32(5, off, true);
          v.setUint32(9, crc, true);
          msg.set(part, 13);
          this.dc.send(msg);
          this.bytesSent += part.length;
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}

export class WireReceiver {
  private requested = new Set<number>();
  private timer: ReturnType<typeof setInterval>;
  bytesReceived = 0;
  private lastRxAt = 0;

  constructor(
    private readonly dc: RTCDataChannel,
    private readonly rx: Receiver,
    onMeta: (m: WireMeta) => void,
  ) {
    dc.addEventListener("message", (e) => {
      if (typeof e.data === "string") {
        const m = JSON.parse(e.data) as WireMeta;
        if (m.t === "meta") {
          onMeta(m);
          this.requestMore(true);
        }
        return;
      }
      const msg = new Uint8Array(e.data as ArrayBuffer);
      if (msg[0] !== 1) return;
      const v = new DataView(msg.buffer);
      const seg = v.getUint32(1, true);
      this.bytesReceived += msg.length - 13;
      this.lastRxAt = performance.now();
      rx.onRawSegment(seg, v.getUint32(5, true), v.getUint32(9, true), msg.subarray(13));
      if (rx.done?.[seg]) {
        this.requested.delete(seg);
        if (this.requested.size === 0) this.requestMore(true);
      }
    });
    // Fallback in case a segment failed its CRC and the request went quiet.
    this.timer = setInterval(() => this.requestMore(false), 3000);
    dc.addEventListener("close", () => clearInterval(this.timer));
  }

  private requestMore(force: boolean) {
    if (this.dc.readyState !== "open" || this.rx.completed) return;
    // The periodic re-ask is only for a stalled link (e.g. a segment failed
    // its CRC); while data flows it would just make the sender resend.
    if (!force && performance.now() - this.lastRxAt < 3000) return;
    const segs = this.rx.missing(NEED_BATCH);
    if (!segs.length) return;
    this.requested = new Set(segs);
    this.dc.send(JSON.stringify({ t: "need", segs }));
  }

  stop() {
    clearInterval(this.timer);
  }
}
