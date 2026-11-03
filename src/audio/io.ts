// Browser side of the sound link: the receiver plays packets through its
// speaker, the sender listens with its microphone.

import { Demodulator, modulate, type AudioPacket } from "./modem";

const TAP_WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("tap", Tap);
`;

let sharedCtx: AudioContext | undefined;

/** Must first be called from a user gesture (iOS keeps audio locked otherwise). */
export function audioContext(): AudioContext {
  sharedCtx ??= new AudioContext();
  if (sharedCtx.state === "suspended") void sharedCtx.resume();
  return sharedCtx;
}

export class SoundTalker {
  private busy: Promise<void> = Promise.resolve();
  volume = 0.35;

  /** Play packets back to back; resolves when the last one has finished. */
  say(packets: Uint8Array[]): Promise<void> {
    const run = async () => {
      const ctx = audioContext();
      for (const p of packets) {
        const pcm = modulate(p, ctx.sampleRate, this.volume);
        const buf = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
        buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        await new Promise<void>((resolve) => {
          src.onended = () => resolve();
          src.start();
        });
        await new Promise((r) => setTimeout(r, 60));
      }
    };
    this.busy = this.busy.then(run, run);
    return this.busy;
  }
}

export class SoundListener {
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private demod?: Demodulator;
  lastPacketAt = 0;

  constructor(private readonly onPacket: (p: AudioPacket) => void) {}

  get level(): number {
    return this.demod?.level ?? 0;
  }

  async start() {
    const ctx = audioContext();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: "text/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, "tap");
    this.demod = new Demodulator(ctx.sampleRate, (p) => {
      this.lastPacketAt = performance.now();
      this.onPacket(p);
    });
    this.node.port.onmessage = (e) => this.demod!.push(e.data as Float32Array);
    const mute = ctx.createGain();
    mute.gain.value = 0; // keeps the graph pulling without echoing the mic
    src.connect(this.node).connect(mute).connect(ctx.destination);
  }

  stop() {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
  }
}
