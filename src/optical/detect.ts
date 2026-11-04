// Receiver side: camera frame (grayscale) → decoded 223-byte blocks.
//
// 1. Find the four finders on a downscaled, locally thresholded copy
//    (run-length 2:2:7:2:2 scan, cross-checked vertically — the classic QR way).
// 2. Hypothesise grid size and orientation; score each by how well the
//    alignment lattice lines up. The previous frame's answer is tried first.
// 3. Refine every alignment mark locally (handles lens distortion), then
//    sample each module by bilinear interpolation inside its lattice cell.
// 4. Threshold per cell, de-whiten, RS-decode each block independently.

import { BLOCK_BITS, BLOCK_BYTES, DIM_STEP, FINDER, forEachMark, layout, scramble, type Layout } from "./layout";
import { rsDecode } from "./rs";

export interface Gray {
  data: Uint8Array;
  w: number;
  h: number;
}

type Pt = [number, number];

export interface Detection {
  W: number;
  H: number;
  rot: number;
  quad: Pt[];
  pitch: number;
  blocks: (Uint8Array | null)[];
  /** Where the finders were (image order), for tracking in the next frame. */
  track: Track;
}

export interface Track {
  quad: Pt[];
  size: number;
}

export interface Hint {
  W: number;
  H: number;
  rot: number;
}

export function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Gray {
  const data = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) data[i] = (rgba[j]! + 2 * rgba[j + 1]! + rgba[j + 2]!) >> 2;
  return { data, w, h };
}

function sample(g: Gray, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= g.w - 1 || y0 >= g.h - 1) {
    const cx = Math.min(g.w - 1, Math.max(0, Math.round(x)));
    const cy = Math.min(g.h - 1, Math.max(0, Math.round(y)));
    return g.data[cy * g.w + cx]!;
  }
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * g.w + x0;
  const d = g.data;
  const top = d[i]! + (d[i + 1]! - d[i]!) * fx;
  const bot = d[i + g.w]! + (d[i + g.w + 1]! - d[i + g.w]!) * fx;
  return top + (bot - top) * fy;
}

// ---------------------------------------------------------------- finders

interface Candidate {
  x: number;
  y: number;
  size: number;
  count: number;
}

function downscale(g: Gray, f: number): Gray {
  if (f === 1) return g;
  const w = Math.floor(g.w / f);
  const h = Math.floor(g.h / f);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) {
        const row = (y * f + dy) * g.w + x * f;
        for (let dx = 0; dx < f; dx++) s += g.data[row + dx]!;
      }
      out[y * w + x] = s / (f * f);
    }
  }
  return { data: out, w, h };
}

/**
 * Local min/max threshold (in the spirit of zxing's hybrid binarizer): each
 * pixel is compared with the midpoint of the darkest and brightest values
 * around it. Unlike a local *mean*, this isn't dragged down by a dark room
 * around a bright screen, which otherwise turns the screen's black squares
 * "white" at the pattern's edges.
 */
function binarize(g: Gray, radius?: number): Uint8Array {
  const { w, h, data } = g;
  const B = 8;
  const bw = Math.ceil(w / B);
  const bh = Math.ceil(h / B);
  const mn = new Uint8Array(bw * bh).fill(255);
  const mx = new Uint8Array(bw * bh);
  let gmin = 255;
  let gmax = 0;
  for (let y = 0; y < h; y++) {
    const brow = ((y / B) | 0) * bw;
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x]!;
      const bi = brow + ((x / B) | 0);
      if (v < mn[bi]!) mn[bi] = v;
      if (v > mx[bi]!) mx[bi] = v;
    }
  }
  for (let i = 0; i < mn.length; i++) {
    if (mn[i]! < gmin) gmin = mn[i]!;
    if (mx[i]! > gmax) gmax = mx[i]!;
  }
  // Spread min/max over a neighbourhood of blocks (separable).
  const nb = Math.max(1, Math.round((radius ?? Math.max(16, Math.max(w, h) / 16)) / B));
  const spread = (src: Uint8Array, pickMin: boolean) => {
    const tmp = new Uint8Array(src.length);
    const out = new Uint8Array(src.length);
    for (let by = 0; by < bh; by++)
      for (let bx = 0; bx < bw; bx++) {
        let v = pickMin ? 255 : 0;
        for (let k = Math.max(0, bx - nb); k <= Math.min(bw - 1, bx + nb); k++) {
          const u = src[by * bw + k]!;
          v = pickMin ? Math.min(v, u) : Math.max(v, u);
        }
        tmp[by * bw + bx] = v;
      }
    for (let by = 0; by < bh; by++)
      for (let bx = 0; bx < bw; bx++) {
        let v = pickMin ? 255 : 0;
        for (let k = Math.max(0, by - nb); k <= Math.min(bh - 1, by + nb); k++) {
          const u = tmp[k * bw + bx]!;
          v = pickMin ? Math.min(v, u) : Math.max(v, u);
        }
        out[by * bw + bx] = v;
      }
    return out;
  };
  const lo = spread(mn, true);
  const hi = spread(mx, false);
  const gmid = (gmin + gmax) / 2;
  // Regions with little contrast (a dark room's sensor noise) are flat
  // background, not pattern: compare them with the global midpoint instead.
  const minContrast = Math.max(24, (gmax - gmin) * 0.25);
  const thr = new Float32Array(bw * bh);
  for (let i = 0; i < thr.length; i++) thr[i] = hi[i]! - lo[i]! >= minContrast ? (lo[i]! + hi[i]!) / 2 : gmid;
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const brow = ((y / B) | 0) * bw;
    for (let x = 0; x < w; x++) bin[y * w + x] = data[y * w + x]! < thr[brow + ((x / B) | 0)]! ? 1 : 0;
  }
  return bin;
}

const RATIO = [2, 2, 7, 2, 2];

function ratioOk(runs: number[]): boolean {
  const total = runs.reduce((a, b) => a + b, 0);
  if (total < 9) return false;
  const u = total / 15;
  for (let i = 0; i < 5; i++) {
    const e = RATIO[i]! * u;
    if (Math.abs(runs[i]! - e) > e * 0.55 + 0.8) return false;
  }
  return true;
}

/** Walk from (cx, cy) along (dx, dy) through dark-light-dark; return run lengths [inner half, light, dark]. */
function walk(bin: Uint8Array, w: number, h: number, cx: number, cy: number, dx: number, dy: number, max: number): number[] | null {
  const runs = [0, 0, 0];
  let x = cx;
  let y = cy;
  let state = 0; // 0: centre dark, 1: light, 2: outer dark
  while (x >= 0 && y >= 0 && x < w && y < h) {
    const v = bin[y * w + x]!;
    const want = state === 1 ? 0 : 1;
    if (v !== want) {
      state++;
      if (state > 2) break;
      continue;
    }
    runs[state]!++;
    if (runs[state]! > max) return null;
    x += dx;
    y += dy;
  }
  return state >= 2 && runs[2]! > 0 ? runs : null;
}

function crossCheck(bin: Uint8Array, w: number, h: number, cx: number, cy: number, total: number, vertical: boolean): { c: number; total: number } | null {
  const dx = vertical ? 0 : 1;
  const dy = vertical ? 1 : 0;
  const max = Math.ceil(total);
  const a = walk(bin, w, h, cx, cy, -dx, -dy, max);
  const b = walk(bin, w, h, cx, cy, dx, dy, max);
  if (!a || !b) return null;
  const runs = [a[2]!, a[1]!, a[0]! + b[0]! - 1, b[1]!, b[2]!];
  if (!ratioOk(runs)) return null;
  const t = runs.reduce((s, r) => s + r, 0);
  if (Math.abs(t - total) > total * 0.5) return null;
  const start = (vertical ? cy : cx) - a[0]! + 1;
  return { c: start + runs[2]! / 2 - 0.5, total: t };
}

export function findFinders(g: Gray, binRadius?: number): { cands: Candidate[]; scale: number } {
  const f = Math.max(g.w, g.h) > 1100 ? 2 : 1;
  const ds = downscale(g, f);
  const bin = binarize(ds, binRadius);
  const { w, h } = ds;
  const cands: Candidate[] = [];
  const add = (x: number, y: number, size: number) => {
    for (const c of cands) {
      if (Math.abs(c.x - x) < c.size * 0.3 && Math.abs(c.y - y) < c.size * 0.3) {
        c.x = (c.x * c.count + x) / (c.count + 1);
        c.y = (c.y * c.count + y) / (c.count + 1);
        c.size = (c.size * c.count + size) / (c.count + 1);
        c.count++;
        return;
      }
    }
    cands.push({ x, y, size, count: 1 });
  };
  const runs = [0, 0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let len = 0;
    let color = bin[row]!;
    runs.fill(0);
    let nruns = 0;
    for (let x = 0; x <= w; x++) {
      const v = x < w ? bin[row + x]! : 1 - color;
      if (v === color) {
        len++;
        continue;
      }
      // a run of `color` just ended at x-1
      runs.shift();
      runs.push(len);
      nruns++;
      if (color === 1 && nruns >= 5 && ratioOk(runs)) {
        const total = runs.reduce((a, b) => a + b, 0);
        const cx = Math.round(x - runs[4]! - runs[3]! - runs[2]! / 2);
        const v1 = crossCheck(bin, w, h, cx, y, total, true);
        if (v1) {
          const cy = Math.round(v1.c);
          const h1 = crossCheck(bin, w, h, cx, cy, total, false);
          if (h1) add(h1.c, v1.c, (h1.total + v1.total) / 2);
        }
      }
      color = v;
      len = 1;
    }
  }
  return { cands: cands.map((c) => ({ x: (c.x + 0.5) * f - 0.5, y: (c.y + 0.5) * f - 0.5, size: c.size * f, count: c.count })), scale: f };
}

function crop(g: Gray, x0: number, y0: number, w: number, h: number): Gray {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) out.set(g.data.subarray((y0 + y) * g.w + x0, (y0 + y) * g.w + x0 + w), y * w);
  return { data: out, w, h };
}

/**
 * Re-find the four finders near where they were last frame: four small
 * searches instead of a whole-image scan.
 */
function trackFinders(g: Gray, t: Track): Candidate[] | null {
  const out: Candidate[] = [];
  for (const [x, y] of t.quad) {
    const r = Math.round(Math.max(t.size * 1.5, 40));
    const x0 = Math.max(0, Math.round(x - r));
    const y0 = Math.max(0, Math.round(y - r));
    const x1 = Math.min(g.w, Math.round(x + r));
    const y1 = Math.min(g.h, Math.round(y + r));
    if (x1 - x0 < 16 || y1 - y0 < 16) return null;
    const { cands } = findFinders(crop(g, x0, y0, x1 - x0, y1 - y0), Math.round(t.size * 0.9));
    let best: Candidate | undefined;
    for (const c of cands) {
      if (c.size < t.size * 0.6 || c.size > t.size * 1.6) continue;
      if (!best || c.count > best.count) best = c;
    }
    if (!best) return null;
    out.push({ ...best, x: best.x + x0, y: best.y + y0 });
  }
  return out;
}

/** Sub-pixel finder centre: centroid of the dark centre square on the full-resolution image. */
function refineCentre(g: Gray, c: Candidate): Pt {
  const pitch = c.size / 15;
  const r = pitch * 4.6;
  const x0 = Math.max(0, Math.floor(c.x - r));
  const x1 = Math.min(g.w - 1, Math.ceil(c.x + r));
  const y0 = Math.max(0, Math.floor(c.y - r));
  const y1 = Math.min(g.h - 1, Math.ceil(c.y + r));
  let lo = 255;
  let hi = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const v = g.data[y * g.w + x]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const t = (lo + hi) / 2;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((x - c.x) ** 2 + (y - c.y) ** 2 > r * r) continue;
      const v = g.data[y * g.w + x]!;
      if (v < t) {
        const wgt = t - v;
        sx += x * wgt;
        sy += y * wgt;
        n += wgt;
      }
    }
  }
  return n > 0 ? [sx / n, sy / n] : [c.x, c.y];
}

function pickQuad(cands: Candidate[]): Candidate[] | null {
  // Real finders are hit by many scan rows; chance look-alikes by one or two.
  const top = Math.max(...cands.map((c) => c.count), 0);
  const pool = cands
    .filter((c) => c.count >= Math.max(2, top * 0.25) || cands.length <= 4)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  if (pool.length < 4) return null;
  let best: Candidate[] | null = null;
  let bestArea = 0;
  const n = pool.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++) {
          const q = [pool[a]!, pool[b]!, pool[c]!, pool[d]!];
          const sizes = q.map((p) => p.size);
          if (Math.max(...sizes) > Math.min(...sizes) * 1.9) continue;
          const ordered = orderClockwise(q);
          if (!convex(ordered)) continue;
          const area = polyArea(ordered);
          const minSide = Math.min(...ordered.map((p, i) => Math.hypot(p.x - ordered[(i + 1) % 4]!.x, p.y - ordered[(i + 1) % 4]!.y)));
          if (minSide < Math.max(...sizes) * 2.5) continue;
          if (area > bestArea) {
            bestArea = area;
            best = ordered;
          }
        }
  return best;
}

function orderClockwise<T extends { x: number; y: number }>(q: T[]): T[] {
  const cx = q.reduce((s, p) => s + p.x, 0) / q.length;
  const cy = q.reduce((s, p) => s + p.y, 0) / q.length;
  const sorted = q.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // start at the corner nearest the image's top-left
  let k = 0;
  for (let i = 1; i < 4; i++) if (sorted[i]!.x + sorted[i]!.y < sorted[k]!.x + sorted[k]!.y) k = i;
  return [...sorted.slice(k), ...sorted.slice(0, k)];
}

function convex(q: { x: number; y: number }[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const c = q[(i + 2) % 4]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const s = Math.sign(cross);
    if (s === 0) return false;
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

function polyArea(q: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i]!;
    const n = q[(i + 1) % q.length]!;
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

// ---------------------------------------------------------------- geometry

type Homography = Float64Array;

/** Homography mapping src[i] → dst[i] (4 points). */
function homography(src: Pt[], dst: Pt[]): Homography | null {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i]!;
    const [x, y] = dst[i]!;
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[p]![c]!)) p = r;
    if (Math.abs(A[p]![c]!) < 1e-12) return null;
    [A[c], A[p]] = [A[p]!, A[c]!];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r]![c]! / A[c]![c]!;
      for (let k = c; k < 9; k++) A[r]![k]! -= f * A[c]![k]!;
    }
  }
  const hm = new Float64Array(9);
  for (let i = 0; i < 8; i++) hm[i] = A[i]![8]! / A[i]![i]!;
  hm[8] = 1;
  return hm;
}

function apply(hm: Homography, u: number, v: number): Pt {
  const d = hm[6]! * u + hm[7]! * v + hm[8]!;
  return [(hm[0]! * u + hm[1]! * v + hm[2]!) / d, (hm[3]! * u + hm[4]! * v + hm[5]!) / d];
}

/** Light-ring minus dark-ring contrast of an alignment mark centred at c. */
function markContrast(g: Gray, c: Pt, ex: Pt, ey: Pt): number {
  let light = 0;
  let dark = 0;
  for (let j = -2; j <= 2; j++) {
    for (let i = -2; i <= 2; i++) {
      const d = Math.max(Math.abs(i), Math.abs(j));
      if (d === 1) light += sample(g, c[0] + i * ex[0] + j * ey[0], c[1] + i * ex[1] + j * ey[1]);
      else if (d === 0 || (d === 2 && (i === 0 || j === 0 || Math.abs(i) === Math.abs(j))))
        dark += sample(g, c[0] + i * ex[0] + j * ey[0], c[1] + i * ex[1] + j * ey[1]);
    }
  }
  return light / 8 - dark / 9;
}

function cornersFor(W: number, H: number): Pt[] {
  const a = FINDER / 2;
  return [
    [a, a],
    [W - a, a],
    [W - a, H - a],
    [a, H - a],
  ];
}

/**
 * How well the alignment marks line up where (W, H, rot) predicts them:
 * their mean contrast as a fraction of the black–white range seen at the
 * finders. ~1 for the right answer; random data averages out near 0.
 */
export function latticeScore(
  g: Gray,
  quad: Pt[],
  W: number,
  H: number,
  rot: number,
  range: number,
  edges: "all" | "tb" | "lr" = "all",
): number {
  const l = layout(W, H);
  const dst = [0, 1, 2, 3].map((k) => quad[(k + rot) % 4]!);
  const hm = homography(cornersFor(W, H), dst);
  if (!hm) return 0;
  const nx = l.nodesX.length - 1;
  const ny = l.nodesY.length - 1;
  let sum = 0;
  let total = 0;
  forEachMark(l.nodesX, l.nodesY, (cx, cy, i, j) => {
    if (edges === "tb" && j !== 0 && j !== ny) return;
    if (edges === "lr" && i !== 0 && i !== nx) return;
    const c = apply(hm, cx + 0.5, cy + 0.5);
    const px = apply(hm, cx + 1.5, cy + 0.5);
    const py = apply(hm, cx + 0.5, cy + 1.5);
    const ex: Pt = [px[0] - c[0], px[1] - c[1]];
    const ey: Pt = [py[0] - c[0], py[1] - c[1]];
    // Lens distortion moves marks by a module or two away from where the
    // corner homography puts them: take the best of a small neighbourhood.
    let best = -Infinity;
    for (let b = -2; b <= 2; b++)
      for (let a = -2; a <= 2; a++) {
        const s = markContrast(g, [c[0] + (a * ex[0] + b * ey[0]) * 0.5, c[1] + (a * ex[1] + b * ey[1]) * 0.5], ex, ey);
        if (s > best) best = s;
      }
    total++;
    sum += best;
  });
  return total ? sum / total / Math.max(16, range) : 0;
}

/** Black–white range from the finders: dark centre vs. the light ring around it. */
function finderRange(g: Gray, quad: Pt[], pitch: number): number {
  let r = 0;
  for (const [x, y] of quad) {
    const dark = sample(g, x, y);
    let light = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) light += sample(g, x + dx * pitch * 4.5, y + dy * pitch * 4.5);
    r += light / 4 - dark;
  }
  return r / 4;
}

// ---------------------------------------------------------------- sampling

export function buildMesh(g: Gray, l: Layout, corners: Pt[]): Pt[][] | null {
  const hm = homography(cornersFor(l.W, l.H), corners);
  if (!hm) return null;
  const nx = l.nodesX.length;
  const ny = l.nodesY.length;
  const mesh: Pt[][] = [];
  const offs: Pt[][] = [];
  for (let j = 0; j < ny; j++) {
    mesh.push([]);
    offs.push([]);
    for (let i = 0; i < nx; i++) {
      const u = l.nodesX[i]!;
      const v = l.nodesY[j]!;
      const pred = apply(hm, u, v);
      const isCorner = (i === 0 || i === nx - 1) && (j === 0 || j === ny - 1);
      if (isCorner) {
        mesh[j]!.push(pred);
        offs[j]!.push([0, 0]);
        continue;
      }
      // Distortion is smooth: start from the neighbours' correction.
      const nb: Pt[] = [];
      if (i > 0) nb.push(offs[j]![i - 1]!);
      if (j > 0) nb.push(offs[j - 1]![i]!);
      const o0: Pt = nb.length ? [nb.reduce((s, p) => s + p[0], 0) / nb.length, nb.reduce((s, p) => s + p[1], 0) / nb.length] : [0, 0];
      const c0: Pt = [pred[0] + o0[0], pred[1] + o0[1]];
      const px = apply(hm, u + 1, v);
      const py = apply(hm, u, v + 1);
      const ex: Pt = [px[0] - pred[0], px[1] - pred[1]];
      const ey: Pt = [py[0] - pred[0], py[1] - pred[1]];
      const pitch = Math.hypot(ex[0], ex[1]);
      const R = Math.max(1, Math.round(pitch * 0.9));
      const step = pitch > 6 ? 1 : 0.5;
      // On a sharp image the contrast peak is a plateau about a module wide;
      // its centroid, not its first maximum, is the mark's centre.
      const scores: number[] = [];
      let best = -Infinity;
      for (let dy = -R; dy <= R; dy += step) {
        for (let dx = -R; dx <= R; dx += step) {
          const s = markContrast(g, [c0[0] + dx, c0[1] + dy], ex, ey);
          scores.push(dx, dy, s);
          if (s > best) best = s;
        }
      }
      let found: Pt = c0;
      if (best > 8) {
        const t = best * 0.85;
        let sx = 0;
        let sy = 0;
        let sw = 0;
        for (let k = 0; k < scores.length; k += 3) {
          const wgt = scores[k + 2]! - t;
          if (wgt <= 0) continue;
          sx += scores[k]! * wgt;
          sy += scores[k + 1]! * wgt;
          sw += wgt;
        }
        found = [c0[0] + sx / sw, c0[1] + sy / sw];
      }
      mesh[j]!.push(found);
      offs[j]!.push([found[0] - pred[0], found[1] - pred[1]]);
    }
  }
  return mesh;
}

export function readBits(g: Gray, l: Layout, mesh: Pt[][]): Uint8Array {
  const { W, H, nodesX, nodesY } = l;
  const cellX = new Int32Array(W);
  const cellY = new Int32Array(H);
  for (let x = 0, i = 0; x < W; x++) {
    while (i < nodesX.length - 2 && x + 0.5 >= nodesX[i + 1]!) i++;
    cellX[x] = i;
  }
  for (let y = 0, j = 0; y < H; y++) {
    while (j < nodesY.length - 2 && y + 0.5 >= nodesY[j + 1]!) j++;
    cellY[y] = j;
  }
  const values = new Float32Array(W * H);
  const ncx = nodesX.length - 1;
  const sums = new Float64Array(ncx * (nodesY.length - 1));
  const counts = new Uint32Array(sums.length);
  for (const idx of l.data) {
    const x = idx % W;
    const y = (idx - x) / W;
    const i = cellX[x]!;
    const j = cellY[y]!;
    const u = (x + 0.5 - nodesX[i]!) / (nodesX[i + 1]! - nodesX[i]!);
    const v = (y + 0.5 - nodesY[j]!) / (nodesY[j + 1]! - nodesY[j]!);
    const p00 = mesh[j]![i]!;
    const p10 = mesh[j]![i + 1]!;
    const p01 = mesh[j + 1]![i]!;
    const p11 = mesh[j + 1]![i + 1]!;
    const px = (1 - u) * (1 - v) * p00[0] + u * (1 - v) * p10[0] + (1 - u) * v * p01[0] + u * v * p11[0];
    const py = (1 - u) * (1 - v) * p00[1] + u * (1 - v) * p10[1] + (1 - u) * v * p01[1] + u * v * p11[1];
    const val = sample(g, px, py);
    values[idx] = val;
    sums[j * ncx + i]! += val;
    counts[j * ncx + i]!++;
  }
  const bits = new Uint8Array(l.data.length);
  for (let k = 0; k < l.data.length; k++) {
    const idx = l.data[k]!;
    const x = idx % W;
    const y = (idx - x) / W;
    const c = cellY[y]! * ncx + cellX[x]!;
    bits[k] = values[idx]! < sums[c]! / counts[c]! ? 1 : 0;
  }
  return bits;
}

function decodeBlock(bits: Uint8Array, b: number): Uint8Array | null {
  const cw = new Uint8Array(BLOCK_BYTES);
  let o = b * BLOCK_BITS;
  for (let i = 0; i < BLOCK_BYTES; i++) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | bits[o++]!;
    cw[i] = v;
  }
  scramble(cw, b);
  const out = rsDecode(cw, 32);
  return out ? out.slice() : null;
}

/** Do the first two blocks decode with the plain corner homography? */
function probe(g: Gray, l: Layout, corners: Pt[]): boolean {
  const hm = homography(cornersFor(l.W, l.H), corners);
  if (!hm || l.blocks === 0) return false;
  const n = Math.min(l.data.length, BLOCK_BITS * Math.min(2, l.blocks));
  const vals = new Float32Array(n);
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const idx = l.data[k]!;
    const x = idx % l.W;
    const y = (idx - x) / l.W;
    const [px, py] = apply(hm, x + 0.5, y + 0.5);
    vals[k] = sample(g, px, py);
    sum += vals[k]!;
  }
  const t = sum / n;
  const bits = new Uint8Array(n);
  for (let k = 0; k < n; k++) bits[k] = vals[k]! < t ? 1 : 0;
  for (let b = 0; b * BLOCK_BITS < n; b++) if (decodeBlock(bits, b)) return true;
  return false;
}

// ---------------------------------------------------------------- entry

function dimCandidates(est: number): number[] {
  const out: number[] = [];
  for (let n = Math.max(64, Math.floor((est * 0.85) / DIM_STEP) * DIM_STEP); n <= est * 1.15 + DIM_STEP; n += DIM_STEP) out.push(n);
  return out;
}

export function detect(g: Gray, hint?: Hint, track?: Track): Detection | null {
  let q: Candidate[] | null = null;
  if (track) {
    const t = trackFinders(g, track);
    if (t) q = orderClockwise(t);
  }
  if (!q) q = pickQuad(findFinders(g).cands);
  if (!q) return null;
  const quad = q.map((c) => refineCentre(g, c));
  const pitch = q.reduce((s, c) => s + c.size, 0) / 4 / 15;
  const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  // Hypotheses: previous frame first, then every orientation × nearby size.
  type Hyp = { W: number; H: number; rot: number; score: number };
  const hyps: Hyp[] = [];
  const range = finderRange(g, quad, pitch);
  if (hint) {
    const s = latticeScore(g, quad, hint.W, hint.H, hint.rot, range);
    if (s > 0.4) hyps.push({ ...hint, score: s });
  }
  if (!hyps.length) {
    // Width only moves the marks along the top/bottom edges and height only
    // those along the sides, so score them separately (cheap), then combine
    // the best few of each.
    for (let rot = 0; rot < 4; rot++) {
      const c = [0, 1, 2, 3].map((k) => quad[(k + rot) % 4]!);
      const wEst = (dist(c[0]!, c[1]!) + dist(c[3]!, c[2]!)) / 2 / pitch + FINDER;
      const hEst = (dist(c[0]!, c[3]!) + dist(c[1]!, c[2]!)) / 2 / pitch + FINDER;
      const h0 = Math.round(hEst / DIM_STEP) * DIM_STEP;
      const w0 = Math.round(wEst / DIM_STEP) * DIM_STEP;
      const ws = dimCandidates(wEst)
        .map((W) => ({ W, s: latticeScore(g, quad, W, h0, rot, range, "tb") }))
        .sort((x, y) => y.s - x.s)
        .slice(0, 2);
      const hs = dimCandidates(hEst)
        .map((H) => ({ H, s: latticeScore(g, quad, w0, H, rot, range, "lr") }))
        .sort((x, y) => y.s - x.s)
        .slice(0, 2);
      for (const { W } of ws)
        for (const { H } of hs) {
          const s = latticeScore(g, quad, W, H, rot, range);
          if (s > 0.25) hyps.push({ W, H, rot, score: s });
        }
    }
    hyps.sort((a, b) => b.score - a.score);
  }
  if (!hyps.length) return null;

  // The lattice is nearly symmetric under rotation, so several orientations
  // can score alike. A cheap probe — the first blocks, read with the corner
  // homography alone — tells which one actually decodes.
  let pick = hyps[0]!;
  for (const hyp of hyps.slice(0, 8)) {
    const corners = [0, 1, 2, 3].map((k) => quad[(k + hyp.rot) % 4]!);
    if (probe(g, layout(hyp.W, hyp.H), corners)) {
      pick = hyp;
      break;
    }
  }
  const l = layout(pick.W, pick.H);
  const corners = [0, 1, 2, 3].map((k) => quad[(k + pick.rot) % 4]!);
  const mesh = buildMesh(g, l, corners);
  if (!mesh) return null;
  const bits = readBits(g, l, mesh);
  const blocks: (Uint8Array | null)[] = [];
  for (let b = 0; b < l.blocks; b++) blocks.push(decodeBlock(bits, b));
  return { W: pick.W, H: pick.H, rot: pick.rot, quad: corners, pitch, blocks, track: { quad, size: pitch * 15 } };
}
