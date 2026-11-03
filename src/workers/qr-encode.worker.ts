// QR generation off the main thread. The mask is pinned (any mask is valid to
// a decoder), which skips the spec's 8-way mask search and is ~4× faster.
import QRCode from "qrcode";

self.onmessage = (e: MessageEvent) => {
  const { id, frames, ecc, version } = e.data as { id: number; frames: ArrayBuffer[]; ecc: "L" | "M"; version: number };
  try {
    let size = 0;
    const out = frames.map((buf) => {
      const qr = QRCode.create([{ data: new Uint8Array(buf), mode: "byte" } as unknown as QRCode.QRCodeSegment], {
        errorCorrectionLevel: ecc,
        version,
        maskPattern: 4,
      } as QRCode.QRCodeOptions);
      size = qr.modules.size;
      return Uint8Array.from(qr.modules.data as unknown as ArrayLike<number>);
    });
    (self as unknown as Worker).postMessage({ id, size, modules: out }, out.map((m) => m.buffer));
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
