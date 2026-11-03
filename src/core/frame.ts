// Block format. Each optical frame carries many independent 223-byte blocks
// (one RS codeword each). Every block is self-describing, so blocks from a
// torn capture — half one frame, half the next — are all usable.
//
//  0  u8   version << 4 | type
//  1  u24  fileId (stable per file, so resume survives restarts)
//
// DATA   (type 1)  4 u24 seg · 7 u16 seq · 9 payload (212 bytes)
// META   (type 2)  4 u48 totalSize · 10 u8 nameLen · name · u8 mimeLen · mime
// SIGNAL (type 3)  4 u16 offerId · 6 u8 part · 7 u8 parts · 8 u8 len · 9 deflated SDP chunk

import { BLOCK_DATA } from "../optical/layout";

export const VERSION = 2;
export const DATA_HEADER = 9;
/** Fountain block size: fixed, whatever the stream density. */
export const PAYLOAD_LEN = 212;
export const SIGNAL_CHUNK = BLOCK_DATA - 9;

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

export const fileId24 = (id: number) => id & 0xffffff;

function u24(b: Uint8Array, at: number, v: number) {
  b[at] = v & 0xff;
  b[at + 1] = (v >>> 8) & 0xff;
  b[at + 2] = (v >>> 16) & 0xff;
}
const getU24 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);

function header(type: FrameType, fileId: number): Uint8Array {
  const out = new Uint8Array(BLOCK_DATA);
  out[0] = (VERSION << 4) | type;
  u24(out, 1, fileId24(fileId));
  return out;
}

export function encodeData(fileId: number, seg: number, seq: number, payload: Uint8Array): Uint8Array {
  const out = header(FrameType.Data, fileId);
  u24(out, 4, seg);
  out[7] = seq & 0xff;
  out[8] = seq >>> 8;
  out.set(payload.subarray(0, PAYLOAD_LEN), DATA_HEADER);
  return out;
}

export function encodeMeta(fileId: number, totalSize: number, name: string, mime: string): Uint8Array {
  const out = header(FrameType.Meta, fileId);
  const v = new DataView(out.buffer);
  v.setUint32(4, totalSize % 0x100000000, true);
  v.setUint16(8, Math.floor(totalSize / 0x100000000), true);
  const mimeBytes = enc.encode(mime).subarray(0, 60);
  let nameBytes = enc.encode(name);
  const nameMax = BLOCK_DATA - 12 - mimeBytes.length;
  if (nameBytes.length > nameMax) nameBytes = enc.encode(truncateUtf8(name, nameMax));
  out[10] = nameBytes.length;
  out.set(nameBytes, 11);
  out[11 + nameBytes.length] = mimeBytes.length;
  out.set(mimeBytes, 12 + nameBytes.length);
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

export function encodeSignal(fileId: number, offerId: number, part: number, parts: number, chunk: Uint8Array): Uint8Array {
  const out = header(FrameType.Signal, fileId);
  out[4] = offerId & 0xff;
  out[5] = offerId >>> 8;
  out[6] = part;
  out[7] = parts;
  out[8] = chunk.length;
  out.set(chunk.subarray(0, SIGNAL_CHUNK), 9);
  return out;
}

export function parseFrame(bytes: Uint8Array): Frame | null {
  if (bytes.length < BLOCK_DATA || bytes[0]! >> 4 !== VERSION) return null;
  const type = bytes[0]! & 0x0f;
  const fileId = getU24(bytes, 1);
  if (type === FrameType.Data) {
    return { type, fileId, seg: getU24(bytes, 4), seq: bytes[7]! | (bytes[8]! << 8), payload: bytes.subarray(DATA_HEADER, DATA_HEADER + PAYLOAD_LEN) };
  }
  if (type === FrameType.Meta) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const nameLen = bytes[10]!;
    const mimeLen = bytes[11 + nameLen] ?? 0;
    if (12 + nameLen + mimeLen > bytes.length) return null;
    return {
      type,
      fileId,
      totalSize: v.getUint32(4, true) + v.getUint16(8, true) * 0x100000000,
      name: dec.decode(bytes.subarray(11, 11 + nameLen)),
      mime: dec.decode(bytes.subarray(12 + nameLen, 12 + nameLen + mimeLen)),
    };
  }
  if (type === FrameType.Signal) {
    const len = bytes[8]!;
    if (bytes[7] === 0 || len > SIGNAL_CHUNK) return null;
    return { type, fileId, offerId: bytes[4]! | (bytes[5]! << 8), part: bytes[6]!, parts: bytes[7]!, chunk: bytes.subarray(9, 9 + len) };
  }
  return null;
}
