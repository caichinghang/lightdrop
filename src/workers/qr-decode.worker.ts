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
  const { id, bitmap, buf, w, h, maxSymbols } = e.data as {
    id: number;
    bitmap?: ImageBitmap;
    /** Fallback when the main thread can't make ImageBitmaps from video: raw RGBA. */
    buf?: ArrayBuffer;
    w?: number;
    h?: number;
    maxSymbols: number;
  };
  try {
    await ready;
    const t0 = performance.now();
    let img: ImageData;
    if (bitmap) {
      if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      }
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } else {
      img = new ImageData(new Uint8ClampedArray(buf!), w!, h!);
    }
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
    const ms = performance.now() - t0;
    (self as unknown as Worker).postMessage({ id, codes, boxes, w: img.width, h: img.height, ms }, codes.map((c) => c.buffer));
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err), codes: [], boxes: [] });
  }
};
