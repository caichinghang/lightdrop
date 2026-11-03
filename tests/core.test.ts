import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/core/scheduler.ts";
import { Receiver, type SegmentSink } from "../src/core/receiver.ts";
import { encodeData, encodeMeta, encodeSignal, parseFrame, FrameType, PAYLOAD_LEN } from "../src/core/frame.ts";
import { SegmentDecoder, SegmentEncoder } from "../src/core/fountain.ts";
import { SEG_BYTES } from "../src/core/segments.ts";

function randomBytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) | 0;
    out[i] = s >>> 24;
  }
  return out;
}

test("fountain decodes from repair frames only, near k frames", () => {
  const bytes = randomBytes(100_000);
  const enc = new SegmentEncoder(7, 3, bytes, 1000);
  const dec = new SegmentDecoder(7, 3, bytes.length, 1000);
  let used = 0;
  for (let seq = enc.k; !dec.complete; seq++) {
    dec.add(seq, enc.encode(seq));
    used++;
  }
  assert.ok(used <= enc.k + 12, `used ${used} for k=${enc.k}`);
  assert.deepEqual(dec.solve(), bytes);
});

test("fountain decodes with 40% loss, mixed systematic/repair", () => {
  const bytes = randomBytes(SEG_BYTES - 13, 9);
  const enc = new SegmentEncoder(1, 0, bytes, 2928);
  const dec = new SegmentDecoder(1, 0, bytes.length, 2928);
  let seq = 0;
  let i = 0;
  while (!dec.complete) {
    if (++i % 5 >= 2) dec.add(seq, enc.encode(seq));
    seq++;
  }
  assert.deepEqual(dec.solve(), bytes);
});

test("frame round trip", () => {
  const d = parseFrame(encodeData(0xdeadbeef, 70000, 513, new Uint8Array(PAYLOAD_LEN).fill(9)));
  assert.equal(d?.type, FrameType.Data);
  if (d?.type !== FrameType.Data) return;
  assert.equal(d.fileId, 0xadbeef);
  assert.equal(d.seg, 70000);
  assert.equal(d.seq, 513);
  assert.equal(d.payload.length, PAYLOAD_LEN);
  const m = parseFrame(encodeMeta(5, 5_000_000_000, "photo of the beach at sunset with friends.jpeg".repeat(10), "image/jpeg"));
  assert.equal(m?.type, FrameType.Meta);
  if (m?.type === FrameType.Meta) {
    assert.ok(m.name.endsWith(".jpeg"));
    assert.equal(m.mime, "image/jpeg");
    assert.equal(m.totalSize, 5_000_000_000);
  }
  const s = parseFrame(encodeSignal(5, 77, 1, 3, new Uint8Array([1, 2, 3])));
  assert.equal(s?.type, FrameType.Signal);
});

class MemSink implements SegmentSink {
  segs = new Map<number, Uint8Array>();
  async open() {
    return undefined;
  }
  async write(seg: number, bytes: Uint8Array) {
    this.segs.set(seg, bytes);
  }
}

async function simulate(size: number, loss: number, acks: boolean) {
  const bytes = randomBytes(size, 3);
  const file = new Blob([bytes as BlobPart]);
  const sched = new Scheduler(file, 42, PAYLOAD_LEN);
  const sink = new MemSink();
  let complete = false;
  const rx = new Receiver(sink, { onComplete: () => (complete = true) });
  rx.onFrame(encodeMeta(42, size, "a.bin", "application/octet-stream"));
  let frames = 0;
  let lossSeed = 5;
  while (!complete && frames < 200_000) {
    const batch = await sched.nextBatch();
    if (!batch.length) break;
    for (const b of batch) {
      frames++;
      lossSeed = (Math.imul(lossSeed, 1664525) + 1013904223) | 0;
      if ((lossSeed >>> 0) / 2 ** 32 < loss) continue;
      rx.onFrame(encodeData(42, b.seg, b.seq, b.payload));
    }
    if (acks && frames % 120 < batch.length) sched.onAck(rx.ack()!, performance.now() + frames * 100);
    await new Promise((r) => setImmediate(r));
  }
  for (let i = 0; i < 20 && !complete; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(complete, "transfer completed");
  const out = new Uint8Array(size);
  for (const [s, b] of sink.segs) out.set(b, s * SEG_BYTES);
  assert.deepEqual(out, bytes);
  return frames;
}

test("end to end, 1.2 MB, 30% loss, no back-channel", async () => {
  const frames = await simulate(1_200_000, 0.3, false);
  console.log("no-ack blocks", frames, "ideal", Math.ceil(1_200_000 / PAYLOAD_LEN));
});

test("end to end, 1.2 MB, 30% loss, with ACKs", async () => {
  const frames = await simulate(1_200_000, 0.3, true);
  console.log("ack blocks", frames, "ideal", Math.ceil(1_200_000 / PAYLOAD_LEN));
});
