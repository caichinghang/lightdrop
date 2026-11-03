// Optical frame format. Every QR code is self-describing: a receiver can lock
// on mid-stream with no handshake. All frames in a stream are padded to the
// same length so every QR code has the same version (needed for the grid).
//
//  0  u8   magic 0x4C ('L')
//  1  u8   magic 0xD7
//  2  u8   version << 4 | type
//  3  u8   flags (reserved, 0)
//  4  u32  fileId     stable per file (name+size+mtime), so resume survives restarts
//  8  ...  type-specific
//
// DATA   (type 1)  8 u32 seg · 12 u16 seq · 14 u32 segCrc · 18 u48 totalSize · 24 payload
// META   (type 2)  8 u48 totalSize · 14 u8 nameLen · name · u8 typeLen · type
// SIGNAL (type 3)  8 u16 offerId · 10 u8 part · 11 u8 parts · 12 u16 len · 14 deflated SDP chunk

export const MAGIC0 = 0x4c;
export const MAGIC1 = 0xd7;
export const VERSION = 1;
export const DATA_HEADER = 24;

export const enum FrameType {
  Data = 1,
  Meta = 2,
  Signal = 3,
}

export interface DataFrame {
  type: FrameType.Data;
  fileId: number;
  seg: number;
  seq: number;
  segCrc: number;
  totalSize: number;
  payload: Uint8Array;
}
export interface MetaFrame {
  type: FrameType.Meta;
  fileId: number;
  totalSize: number;
  name: string;
  mime: string;
}
export interface SignalFrame {
  type: FrameType.Signal;
  fileId: number;
  offerId: number;
  part: number;
  parts: number;
  chunk: Uint8Array;
}
export type Frame = DataFrame | MetaFrame | SignalFrame;

const enc = new TextEncoder();
const dec = new TextDecoder();

function header(out: Uint8Array, type: FrameType, fileId: number): DataView {
  const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out[0] = MAGIC0;
  out[1] = MAGIC1;
  out[2] = (VERSION << 4) | type;
  out[3] = 0;
  v.setUint32(4, fileId >>> 0, true);
  return v;
}

function setU48(v: DataView, at: number, n: number) {
  v.setUint32(at, n % 0x100000000, true);
  v.setUint16(at + 4, Math.floor(n / 0x100000000), true);
}
function getU48(v: DataView, at: number): number {
  return v.getUint32(at, true) + v.getUint16(at + 4, true) * 0x100000000;
}

export function encodeData(
  frameLen: number,
  fileId: number,
  seg: number,
  seq: number,
  segCrc: number,
  totalSize: number,
  payload: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(frameLen);
  const v = header(out, FrameType.Data, fileId);
  v.setUint32(8, seg, true);
  v.setUint16(12, seq, true);
  v.setUint32(14, segCrc >>> 0, true);
  setU48(v, 18, totalSize);
  out.set(payload.subarray(0, frameLen - DATA_HEADER), DATA_HEADER);
  return out;
}

export function encodeMeta(frameLen: number, fileId: number, totalSize: number, name: string, mime: string): Uint8Array {
  const out = new Uint8Array(frameLen);
  const v = header(out, FrameType.Meta, fileId);
  setU48(v, 8, totalSize);
  // Truncate on a byte budget that always fits the smallest frame size.
  const budget = Math.max(16, frameLen - 16);
  const mimeBytes = enc.encode(mime).subarray(0, Math.min(100, budget >> 2));
  let nameBytes = enc.encode(name);
  const nameMax = Math.min(255, budget - mimeBytes.length);
  if (nameBytes.length > nameMax) nameBytes = enc.encode(truncateUtf8(name, nameMax));
  out[14] = nameBytes.length;
  out.set(nameBytes, 15);
  out[15 + nameBytes.length] = mimeBytes.length;
  out.set(mimeBytes, 16 + nameBytes.length);
  return out;
}

function truncateUtf8(s: string, maxBytes: number): string {
  // Keep the extension: "very-long-name….pdf"
  const dot = s.lastIndexOf(".");
  const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : "";
  let base = ext ? s.slice(0, dot) : s;
  while (enc.encode(base + "…" + ext).length > maxBytes && base.length > 0) base = base.slice(0, -1);
  return base + "…" + ext;
}

export function signalChunkCapacity(frameLen: number): number {
  return frameLen - 14;
}

export function encodeSignal(
  frameLen: number,
  fileId: number,
  offerId: number,
  part: number,
  parts: number,
  chunk: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(frameLen);
  const v = header(out, FrameType.Signal, fileId);
  v.setUint16(8, offerId, true);
  out[10] = part;
  out[11] = parts;
  v.setUint16(12, chunk.length, true);
  out.set(chunk, 14);
  return out;
}

export function parseFrame(bytes: Uint8Array): Frame | null {
  if (bytes.length < 16 || bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1) return null;
  if (bytes[2]! >> 4 !== VERSION) return null;
  const type = bytes[2]! & 0x0f;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fileId = v.getUint32(4, true);
  if (type === FrameType.Data) {
    if (bytes.length <= DATA_HEADER) return null;
    return {
      type,
      fileId,
      seg: v.getUint32(8, true),
      seq: v.getUint16(12, true),
      segCrc: v.getUint32(14, true),
      totalSize: getU48(v, 18),
      payload: bytes.subarray(DATA_HEADER),
    };
  }
  if (type === FrameType.Meta) {
    const nameLen = bytes[14]!;
    const mimeLen = bytes[15 + nameLen] ?? 0;
    if (16 + nameLen + mimeLen > bytes.length) return null;
    return {
      type,
      fileId,
      totalSize: getU48(v, 8),
      name: dec.decode(bytes.subarray(15, 15 + nameLen)),
      mime: dec.decode(bytes.subarray(16 + nameLen, 16 + nameLen + mimeLen)),
    };
  }
  if (type === FrameType.Signal) {
    const len = v.getUint16(12, true);
    if (14 + len > bytes.length || bytes[11] === 0) return null;
    return {
      type,
      fileId,
      offerId: v.getUint16(8, true),
      part: bytes[10]!,
      parts: bytes[11]!,
      chunk: bytes.subarray(14, 14 + len),
    };
  }
  return null;
}
