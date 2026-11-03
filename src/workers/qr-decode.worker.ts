// QR decoding with zxing-cpp compiled to WASM (zxing-wasm). Safari has no
// BarcodeDetector, and Chrome's returns text, which mangles binary payloads.
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

const ready = prepareZXingModule({
  overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) },
  fireImmediately: true,
});

let canvas: OffscreenCanvas | undefined;

self.onmessage = async (e: MessageEvent) => {
  const { id, bitmap, maxSymbols } = e.data as { id: number; bitmap: ImageBitmap; maxSymbols: number };
  try {
    await ready;
    if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    }
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const results = await readBarcodes(img, {
      formats: ["QRCode"],
      tryHarder: false,
      tryInvert: false,
      tryRotate: false,
      maxNumberOfSymbols: maxSymbols,
    });
    const codes = results.filter((r) => r.isValid).map((r) => r.bytes.slice());
    const boxes = results
      .filter((r) => r.isValid)
      .map((r) => [r.position.topLeft, r.position.topRight, r.position.bottomRight, r.position.bottomLeft].map((p) => [p.x, p.y]));
    (self as unknown as Worker).postMessage({ id, codes, boxes, w: img.width, h: img.height }, codes.map((c) => c.buffer));
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err), codes: [], boxes: [] });
  }
};
