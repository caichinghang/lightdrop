// What the sound link says: ACKs, and the WebRTC answer split into fragments
// (one bad symbol then only costs one ~2 s fragment, not the whole answer).

import type { Ack } from "../core/scheduler";
import { packetBytes, type AudioPacket } from "./modem";

export const enum MsgType {
  Ack = 1,
  Answer = 2,
}

const FRAG_CHUNK = 19;

export function header(type: MsgType, frag = 0, count = 1): number {
  return (type << 4) | (frag << 2) | (count - 1);
}

export function parseHeader(h: number) {
  return { type: h >> 4, frag: (h >> 2) & 3, count: (h & 3) + 1 };
}

export function ackPacket(fileId: number, a: Ack): Uint8Array {
  const p = new Uint8Array(9);
  const v = new DataView(p.buffer);
  v.setUint16(0, fileId & 0xffff, true);
  v.setUint16(2, a.firstIncomplete & 0xffff, true);
  p[4] = (a.firstIncomplete >>> 16) & 0xff;
  v.setUint16(5, a.bitmap, true);
  v.setUint16(7, a.recvCount, true);
  return packetBytes(header(MsgType.Ack), p);
}

export function parseAck(p: Uint8Array): { fileIdLow: number; ack: Ack } | null {
  if (p.length < 9) return null;
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  return {
    fileIdLow: v.getUint16(0, true),
    ack: {
      firstIncomplete: v.getUint16(2, true) | (p[4]! << 16),
      bitmap: v.getUint16(5, true),
      recvCount: v.getUint16(7, true),
    },
  };
}

/** Split a message into ≤4 fragments, each tagged with a message id. */
export function fragmentPackets(type: MsgType, msgId: number, bytes: Uint8Array): Uint8Array[] {
  const count = Math.ceil(bytes.length / FRAG_CHUNK);
  if (count > 4) throw new Error("message too long for the sound link");
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = bytes.subarray(i * FRAG_CHUNK, (i + 1) * FRAG_CHUNK);
    const p = new Uint8Array(1 + chunk.length);
    p[0] = msgId;
    p.set(chunk, 1);
    out.push(packetBytes(header(type, i, count), p));
  }
  return out;
}

export class Reassembler {
  private parts = new Map<string, (Uint8Array | undefined)[]>();

  /** Returns the whole message once its last missing fragment arrives. */
  push(pkt: AudioPacket): { type: number; bytes: Uint8Array } | null {
    const { type, frag, count } = parseHeader(pkt.header);
    if (pkt.payload.length < 1) return null;
    const key = `${type}:${pkt.payload[0]}:${count}`;
    let parts = this.parts.get(key);
    if (!parts) this.parts.set(key, (parts = new Array(count)));
    parts[frag] = pkt.payload.subarray(1);
    for (let i = 0; i < count; i++) if (!parts[i]) return null;
    this.parts.delete(key);
    const len = parts.reduce((n, p) => n + p!.length, 0);
    const bytes = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
      bytes.set(p!, o);
      o += p!.length;
    }
    return { type, bytes };
  }
}
