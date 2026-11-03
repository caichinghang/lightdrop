import { test } from "node:test";
import assert from "node:assert/strict";
import { Demodulator, modulate, type AudioPacket } from "../src/audio/modem.ts";
import { ackPacket, fragmentPackets, MsgType, parseAck, parseHeader, Reassembler } from "../src/audio/messages.ts";

function channel(pcm: Float32Array, sr: number, opts: { gain: number; noise: number; echoMs: number; lead: number }) {
  const out = new Float32Array(pcm.length + Math.round(sr * (opts.lead + 0.2)));
  const delay = Math.round((sr * opts.echoMs) / 1000);
  const lead = Math.round(sr * opts.lead);
  let s = 12345;
  for (let i = 0; i < out.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    const n = ((s >>> 0) / 2 ** 32 - 0.5) * 2 * opts.noise;
    const j = i - lead;
    const x = (pcm[j] ?? 0) + 0.4 * (pcm[j - delay] ?? 0);
    out[i] = x * opts.gain + n;
  }
  return out;
}

for (const sr of [44100, 48000]) {
  test(`ack round trip through a noisy, echoey channel @${sr}`, () => {
    const pkt = ackPacket(0xabcd1234, { firstIncomplete: 70001, bitmap: 0b1011, recvCount: 4321 });
    const got: AudioPacket[] = [];
    const demod = new Demodulator(sr, (p) => got.push(p));
    const rx = channel(modulate(pkt, sr), sr, { gain: 0.05, noise: 0.02, echoMs: 7, lead: 0.37 });
    for (let i = 0; i < rx.length; i += 128) demod.push(rx.subarray(i, i + 128));
    assert.equal(got.length, 1);
    assert.equal(parseHeader(got[0]!.header).type, MsgType.Ack);
    const a = parseAck(got[0]!.payload)!;
    assert.equal(a.fileIdLow, 0x1234);
    assert.deepEqual(a.ack, { firstIncomplete: 70001, bitmap: 0b1011, recvCount: 4321 });
  });
}

test("fragmented answer reassembles, back to back packets", () => {
  const sr = 48000;
  const msg = new Uint8Array(57).map((_, i) => (i * 37) & 0xff);
  const pkts = fragmentPackets(MsgType.Answer, 9, msg);
  const pcm = pkts.map((p) => modulate(p, sr));
  const all = new Float32Array(pcm.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of pcm) {
    all.set(p, o);
    o += p.length;
  }
  const r = new Reassembler();
  let out: Uint8Array | undefined;
  const demod = new Demodulator(sr, (p) => {
    const m = r.push(p);
    if (m) out = m.bytes;
  });
  demod.push(channel(all, sr, { gain: 0.2, noise: 0.03, echoMs: 3, lead: 0.1 }));
  assert.deepEqual(out, msg);
  console.log("answer airtime", (all.length / sr).toFixed(2), "s");
});
