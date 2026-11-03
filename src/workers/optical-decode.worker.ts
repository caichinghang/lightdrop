// Camera frame → decoded blocks, off the main thread. Each worker remembers
// the grid size, orientation and finder positions it last saw, so most frames
// skip the search, read back only the pattern's area, and re-find the
// finders with four small local scans.
import { detect, toGray, type Hint, type Track } from "../optical/detect";

let hint: Hint | undefined;
let track: Track | undefined;
let misses = 0;
let canvas: OffscreenCanvas | undefined;

type Pt = [number, number];
const shift = (q: Pt[], dx: number, dy: number): Pt[] => q.map(([x, y]) => [x + dx, y + dy]);

self.onmessage = (e: MessageEvent) => {
  const { id, bitmap, buf, w, h } = e.data as { id: number; bitmap?: ImageBitmap; buf?: ArrayBuffer; w?: number; h?: number };
  const t0 = performance.now();
  try {
    let iw: number;
    let ih: number;
    let ctx: OffscreenCanvasRenderingContext2D | undefined;
    let full: Uint8ClampedArray | undefined;
    if (bitmap) {
      iw = bitmap.width;
      ih = bitmap.height;
      if (!canvas || canvas.width !== iw || canvas.height !== ih) canvas = new OffscreenCanvas(iw, ih);
      ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
    } else {
      iw = w!;
      ih = h!;
      full = new Uint8ClampedArray(buf!);
    }

    // Region to read: around last frame's pattern, or the whole frame.
    let rx = 0;
    let ry = 0;
    let rw = iw;
    let rh = ih;
    if (track) {
      const xs = track.quad.map((p) => p[0]);
      const ys = track.quad.map((p) => p[1]);
      const m = track.size * 1.6 + 0.08 * Math.max(iw, ih);
      rx = Math.max(0, Math.floor(Math.min(...xs) - m));
      ry = Math.max(0, Math.floor(Math.min(...ys) - m));
      rw = Math.min(iw, Math.ceil(Math.max(...xs) + m)) - rx;
      rh = Math.min(ih, Math.ceil(Math.max(...ys) + m)) - ry;
    }
    let rgba: Uint8ClampedArray;
    if (ctx) rgba = ctx.getImageData(rx, ry, rw, rh).data;
    else if (rx === 0 && ry === 0 && rw === iw) rgba = full!.subarray(0, iw * rh * 4);
    else {
      rgba = new Uint8ClampedArray(rw * rh * 4);
      for (let y = 0; y < rh; y++) rgba.set(full!.subarray(((ry + y) * iw + rx) * 4, ((ry + y) * iw + rx + rw) * 4), y * rw * 4);
    }

    const local = track ? { quad: shift(track.quad, -rx, -ry), size: track.size } : undefined;
    const d = detect(toGray(rgba, rw, rh), hint, local);
    const ok = d ? (d.blocks.filter(Boolean) as Uint8Array[]) : [];
    if (d && ok.length) {
      hint = { W: d.W, H: d.H, rot: d.rot };
      track = { quad: shift(d.track.quad, rx, ry), size: d.track.size };
      misses = 0;
    } else if (++misses >= 2) {
      hint = undefined;
      track = undefined;
    }
    (self as unknown as Worker).postMessage(
      {
        id,
        blocks: ok,
        total: d?.blocks.length ?? 0,
        quad: d ? shift(d.quad, rx, ry) : null,
        grid: d ? `${d.W}x${d.H}` : "",
        w: iw,
        h: ih,
        ms: performance.now() - t0,
      },
      ok.map((b) => b.buffer as ArrayBuffer),
    );
  } catch (err) {
    track = undefined;
    (self as unknown as Worker).postMessage({ id, blocks: [], total: 0, quad: null, error: String(err), ms: performance.now() - t0 });
  }
};
