// Camera frame → decoded blocks, off the main thread. Each worker remembers
// the grid size and orientation it last saw, so most frames skip the search.
import { detect, toGray, type Hint } from "../optical/detect";

let hint: Hint | undefined;
let misses = 0;
let canvas: OffscreenCanvas | undefined;

self.onmessage = (e: MessageEvent) => {
  const { id, bitmap, buf, w, h } = e.data as { id: number; bitmap?: ImageBitmap; buf?: ArrayBuffer; w?: number; h?: number };
  const t0 = performance.now();
  try {
    let rgba: Uint8ClampedArray;
    let iw: number;
    let ih: number;
    if (bitmap) {
      iw = bitmap.width;
      ih = bitmap.height;
      if (!canvas || canvas.width !== iw || canvas.height !== ih) canvas = new OffscreenCanvas(iw, ih);
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      rgba = ctx.getImageData(0, 0, iw, ih).data;
    } else {
      iw = w!;
      ih = h!;
      rgba = new Uint8ClampedArray(buf!);
    }
    const d = detect(toGray(rgba, iw, ih), hint);
    const ok = d ? (d.blocks.filter(Boolean) as Uint8Array[]) : [];
    if (d && ok.length) {
      hint = { W: d.W, H: d.H, rot: d.rot };
      misses = 0;
    } else if (++misses >= 3) {
      hint = undefined;
    }
    (self as unknown as Worker).postMessage(
      {
        id,
        blocks: ok,
        total: d?.blocks.length ?? 0,
        quad: d?.quad ?? null,
        grid: d ? `${d.W}×${d.H}` : "",
        w: iw,
        h: ih,
        ms: performance.now() - t0,
      },
      ok.map((b) => b.buffer as ArrayBuffer),
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, blocks: [], total: 0, quad: null, error: String(err), ms: performance.now() - t0 });
  }
};
