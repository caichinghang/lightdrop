// The Wi-Fi upgrade. The sender's WebRTC offer rides inside the QR stream;
// the receiver's answer has to come back over the ~100 bit/s sound link, so it
// is squeezed to the only three things the sender can't know: ICE username
// fragment, ICE password and DTLS fingerprint (~57 bytes). The sender rebuilds
// a full answer SDP from those. The receiver's own ICE candidates are never
// sent: its connectivity checks reach the sender's candidates, and the sender
// learns the receiver's address from those checks (peer-reflexive candidates).
//
// No STUN/TURN servers: this only ever connects devices that can already reach
// each other (same Wi-Fi, or one on the other's hotspot). If they can't, the
// transfer just stays optical.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export const deflate = (b: Uint8Array) => pipe(b, new CompressionStream("deflate-raw"));
export const inflate = (b: Uint8Array) => pipe(b, new DecompressionStream("deflate-raw"));

export interface CompactAnswer {
  offerId: number;
  ufrag: string;
  pwd: string;
  fingerprint: Uint8Array; // sha-256, 32 bytes
}

function pack6(s: string): Uint8Array {
  const out = new Uint8Array(Math.ceil((s.length * 6) / 8));
  let bit = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error("not an ice-char");
    for (let b = 5; b >= 0; b--, bit++) if (v & (1 << b)) out[bit >> 3]! |= 0x80 >> (bit & 7);
  }
  return out;
}

function unpack6(bytes: Uint8Array, n: number, from: number): string {
  let s = "";
  let bit = from * 8;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let b = 0; b < 6; b++, bit++) v = (v << 1) | ((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1);
    s += B64[v];
  }
  return s;
}

export function encodeAnswer(a: CompactAnswer): Uint8Array {
  const chars = pack6(a.ufrag + a.pwd);
  const out = new Uint8Array(4 + chars.length + 32);
  out[0] = a.offerId & 0xff;
  out[1] = a.offerId >> 8;
  out[2] = a.ufrag.length;
  out[3] = a.pwd.length;
  out.set(chars, 4);
  out.set(a.fingerprint, 4 + chars.length);
  return out;
}

export function decodeAnswer(b: Uint8Array): CompactAnswer | null {
  if (b.length < 4) return null;
  const ul = b[2]!;
  const pl = b[3]!;
  const charBytes = Math.ceil(((ul + pl) * 6) / 8);
  if (b.length !== 4 + charBytes + 32) return null;
  const chars = unpack6(b, ul + pl, 4);
  return {
    offerId: b[0]! | (b[1]! << 8),
    ufrag: chars.slice(0, ul),
    pwd: chars.slice(ul),
    fingerprint: b.slice(4 + charBytes),
  };
}

export function compactFromSdp(offerId: number, sdp: string): CompactAnswer {
  const ufrag = /a=ice-ufrag:(\S+)/.exec(sdp)?.[1];
  const pwd = /a=ice-pwd:(\S+)/.exec(sdp)?.[1];
  const fp = /a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/.exec(sdp)?.[1];
  if (!ufrag || !pwd || !fp) throw new Error("answer SDP missing ICE/DTLS fields");
  return { offerId, ufrag, pwd, fingerprint: Uint8Array.from(fp.split(":").map((h) => parseInt(h, 16))) };
}

export function sdpFromCompact(offerSdp: string, a: CompactAnswer): string {
  const mid = /a=mid:(\S+)/.exec(offerSdp)?.[1] ?? "0";
  const sctpPort = /a=sctp-port:(\d+)/.exec(offerSdp)?.[1] ?? "5000";
  const fp = Array.from(a.fingerprint, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
  return [
    "v=0",
    "o=- 1 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    `a=group:BUNDLE ${mid}`,
    "a=msid-semantic: WMS",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    `a=ice-ufrag:${a.ufrag}`,
    `a=ice-pwd:${a.pwd}`,
    "a=ice-options:trickle",
    `a=fingerprint:sha-256 ${fp}`,
    "a=setup:active",
    `a=mid:${mid}`,
    `a=sctp-port:${sctpPort}`,
    "a=max-message-size:262144",
    "",
  ].join("\r\n");
}

function waitGathered(pc: RTCPeerConnection, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const t = setTimeout(resolve, ms);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

/** Strip lines the answerer doesn't need, so the offer fits in fewer QR frames. */
function slimOffer(sdp: string): string {
  return sdp
    .split("\r\n")
    .filter((l) => !/^a=(extmap-allow-mixed|msid-semantic)/.test(l))
    .filter((l) => !/^a=candidate:.* tcp /.test(l))
    .join("\r\n");
}

export class SenderLink {
  readonly pc = new RTCPeerConnection({ iceServers: [] });
  readonly dc: RTCDataChannel;
  readonly offerId = (Math.random() * 0xffff) | 0;
  offerSdp = "";
  private answered = false;

  constructor() {
    this.dc = this.pc.createDataChannel("file", { ordered: true });
    this.dc.binaryType = "arraybuffer";
  }

  /** Deflated offer SDP for the SIGNAL frames. */
  async offer(): Promise<Uint8Array> {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await waitGathered(this.pc, 2500);
    this.offerSdp = slimOffer(this.pc.localDescription!.sdp);
    return deflate(new TextEncoder().encode(this.offerSdp));
  }

  async accept(a: CompactAnswer): Promise<boolean> {
    if (this.answered || a.offerId !== this.offerId) return false;
    this.answered = true;
    await this.pc.setRemoteDescription({ type: "answer", sdp: sdpFromCompact(this.offerSdp, a) });
    return true;
  }

  close() {
    this.pc.close();
  }
}

export class ReceiverLink {
  readonly pc = new RTCPeerConnection({ iceServers: [] });
  compact?: CompactAnswer;
  onChannel?: (dc: RTCDataChannel) => void;

  constructor() {
    this.pc.ondatachannel = (e) => {
      e.channel.binaryType = "arraybuffer";
      this.onChannel?.(e.channel);
    };
  }

  async answer(offerId: number, deflated: Uint8Array): Promise<Uint8Array> {
    const sdp = new TextDecoder().decode(await inflate(deflated));
    await this.pc.setRemoteDescription({ type: "offer", sdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    this.compact = compactFromSdp(offerId, this.pc.localDescription!.sdp);
    return encodeAnswer(this.compact);
  }

  close() {
    this.pc.close();
  }
}
