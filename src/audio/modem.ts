// A small acoustic modem: the receiving phone's speaker talks back to the
// sender's microphone. It only has to carry a few dozen bytes (ACKs and a
// compressed WebRTC answer), so it trades speed for robustness:
//
// - 17 data tones, 2.0–4.4 kHz (phone speakers and laptop mics are both good
//   there), 40 ms symbols → ~100 bit/s.
// - Differential tone coding: each tone is (previous + 1 + nibble) mod 17, so
//   two consecutive symbols never share a tone. The decoder therefore needs no
//   clock recovery at all — it just watches for the dominant tone to change.
// - Each packet starts with an alternating pair of sync tones outside the data
//   band, and ends with a CRC-16.

import { crc16 } from "../core/crc";

export const SYMBOL_SEC = 0.04;
const DATA_BASE_HZ = 2000;
const DATA_STEP_HZ = 150;
const DATA_TONES = 17;
const SYNC_A_HZ = 1550;
const SYNC_B_HZ = 4850;
const SYNC_LEN = 4;
const MAX_PAYLOAD = 32;

const SYNC_A = DATA_TONES;
const SYNC_B = DATA_TONES + 1;
const TONE_HZ = [...Array.from({ length: DATA_TONES }, (_, i) => DATA_BASE_HZ + i * DATA_STEP_HZ), SYNC_A_HZ, SYNC_B_HZ];

export function packetBytes(header: number, payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_PAYLOAD) throw new Error("audio payload too long");
  const body = new Uint8Array(2 + payload.length + 2);
  body[0] = header;
  body[1] = payload.length;
  body.set(payload, 2);
  const c = crc16(body.subarray(0, 2 + payload.length));
  body[2 + payload.length] = c >> 8;
  body[3 + payload.length] = c & 0xff;
  return body;
}

/** Tone indices for one packet, sync included. */
export function packetTones(bytes: Uint8Array): number[] {
  const tones: number[] = [];
  for (let i = 0; i < SYNC_LEN; i++) tones.push(i % 2 ? SYNC_B : SYNC_A);
  let prev = 0;
  for (const b of bytes) {
    for (const nib of [b >> 4, b & 15]) {
      prev = (prev + 1 + nib) % DATA_TONES;
      tones.push(prev);
    }
  }
  return tones;
}

/** PCM for a packet, phase-continuous, with short fades at both ends. */
export function modulate(bytes: Uint8Array, sampleRate: number, amplitude = 0.5): Float32Array {
  const tones = packetTones(bytes);
  const perSym = Math.round(SYMBOL_SEC * sampleRate);
  const fade = Math.round(0.005 * sampleRate);
  const out = new Float32Array(tones.length * perSym + fade * 2);
  let phase = 0;
  let i = fade;
  for (const t of tones) {
    const w = (2 * Math.PI * TONE_HZ[t]!) / sampleRate;
    for (let n = 0; n < perSym; n++, i++) {
      out[i] = Math.sin(phase) * amplitude;
      phase += w;
    }
  }
  for (let n = 0; n < fade; n++) {
    out[fade + n]! *= n / fade;
    out[i - 1 - n]! *= n / fade;
  }
  return out;
}

export interface AudioPacket {
  header: number;
  payload: Uint8Array;
}

/**
 * Streaming demodulator. Push mic samples in any chunk size; complete,
 * CRC-checked packets come out of `onPacket`.
 */
export class Demodulator {
  private readonly hop: number;
  private readonly win: number;
  private readonly ring: Float32Array;
  private readonly window: Float32Array;
  private readonly coeff: Float64Array;
  private filled = 0;
  private sinceHop = 0;
  private runTone = -1;
  private runLen = 0;
  private lastEmitted = -1;
  // packet parser
  private syncSeen = 0;
  private lastSync = -1;
  private inPacket = false;
  private prev = 0;
  private nibbles: number[] = [];
  /** Signal level of the last hop, 0..1-ish, for a UI meter. */
  level = 0;

  constructor(
    readonly sampleRate: number,
    readonly onPacket: (p: AudioPacket) => void,
  ) {
    this.hop = Math.round((SYMBOL_SEC / 5) * sampleRate);
    this.win = Math.round((SYMBOL_SEC / 2) * sampleRate);
    this.ring = new Float32Array(this.win);
    this.window = new Float32Array(this.win);
    for (let n = 0; n < this.win; n++) this.window[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (this.win - 1));
    this.coeff = new Float64Array(TONE_HZ.map((f) => 2 * Math.cos((2 * Math.PI * f) / sampleRate)));
  }

  push(samples: Float32Array) {
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.filled % this.win] = samples[i]!;
      this.filled++;
      if (++this.sinceHop >= this.hop && this.filled >= this.win) {
        this.sinceHop = 0;
        this.analyse();
      }
    }
  }

  private analyse() {
    const start = this.filled % this.win;
    const powers = new Float64Array(TONE_HZ.length);
    let energy = 0;
    for (let t = 0; t < TONE_HZ.length; t++) {
      const c = this.coeff[t]!;
      let s1 = 0;
      let s2 = 0;
      for (let n = 0; n < this.win; n++) {
        const x = this.ring[(start + n) % this.win]! * this.window[n]!;
        const s0 = x + c * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      powers[t] = s1 * s1 + s2 * s2 - c * s1 * s2;
    }
    for (let n = 0; n < this.win; n++) {
      const x = this.ring[n]!;
      energy += x * x;
    }
    this.level = Math.sqrt(energy / this.win);
    let best = 0;
    let second = 0;
    let bi = -1;
    for (let t = 0; t < powers.length; t++) {
      const p = powers[t]!;
      if (p > best) {
        second = best;
        best = p;
        bi = t;
      } else if (p > second) second = p;
    }
    // A clear winner, and enough of the window's energy sitting in that tone.
    const toneEnergy = best / ((this.win * this.win) / 16);
    const tone = bi >= 0 && best > second * 4 && toneEnergy > energy / this.win * 0.15 && this.level > 0.0008 ? bi : -1;
    if (tone === this.runTone) {
      this.runLen++;
      if (this.runLen === 2 && tone >= 0 && tone !== this.lastEmitted) {
        this.lastEmitted = tone;
        this.symbol(tone);
      }
    } else {
      this.runTone = tone;
      this.runLen = 1;
    }
  }

  private symbol(t: number) {
    if (t === SYNC_A || t === SYNC_B) {
      const expected = this.lastSync === SYNC_A ? SYNC_B : SYNC_A;
      this.syncSeen = t === expected ? this.syncSeen + 1 : t === SYNC_A ? 1 : 0;
      this.lastSync = t;
      // Data starts after any B that follows at least one A; a later sync
      // symbol simply re-arms, so losing the first sync tone is harmless.
      this.inPacket = t === SYNC_B && this.syncSeen >= 2;
      if (this.inPacket) {
        this.prev = 0;
        this.nibbles = [];
      }
      return;
    }
    this.syncSeen = 0;
    this.lastSync = -1;
    if (!this.inPacket) return;
    const nib = (t - this.prev - 1 + DATA_TONES * 2) % DATA_TONES;
    this.prev = t;
    if (nib > 15) {
      this.inPacket = false;
      return;
    }
    this.nibbles.push(nib);
    const n = this.nibbles.length;
    if (n >= 4) {
      const len = (this.nibbles[2]! << 4) | this.nibbles[3]!;
      if (len > MAX_PAYLOAD) {
        this.inPacket = false;
        return;
      }
      if (n === (4 + len) * 2) {
        this.inPacket = false;
        const bytes = new Uint8Array(4 + len);
        for (let i = 0; i < bytes.length; i++) bytes[i] = (this.nibbles[2 * i]! << 4) | this.nibbles[2 * i + 1]!;
        const c = crc16(bytes.subarray(0, 2 + len));
        if (((bytes[2 + len]! << 8) | bytes[3 + len]!) !== c) return;
        this.onPacket({ header: bytes[0]!, payload: bytes.slice(2, 2 + len) });
      }
    }
  }
}
