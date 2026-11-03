// Geometry of a Lightdrop optical frame, shared by encoder and detector.
//
//   ┌───────────────────────────────────────────┐
//   │ ▣           ·           ·             ▣  │  ▣ finder (15×15, 2:2:7:2:2 rings)
//   │                                           │  · alignment mark (5×5), every 24 modules
//   │ ·           ·           ·             ·  │
//   │      data modules, read row by row       │
//   │ ▣           ·           ·             ▣  │
//   └───────────────────────────────────────────┘
//
// The four finders give a homography; the alignment lattice corrects lens
// distortion locally. Data modules carry independent RS(255,223) blocks, each
// a contiguous run of 2040 modules — i.e. a horizontal band — so a capture
// torn by the screen refresh still yields every block on either side of the tear.

export const FINDER = 15;
export const FINDER_ZONE = 17; // finder + 2-module white separator
export const MARK = 5;
/** Fixed lattice pitch. Fixed (not proportional) so that each grid size puts
 *  its marks somewhere different in the image — which is how the detector
 *  tells 216 columns from 224. */
export const LATTICE = 24;
export const QUIET = 3; // white border modules drawn around the grid
export const BLOCK_BYTES = 255;
export const BLOCK_DATA = 223;
export const BLOCK_BITS = BLOCK_BYTES * 8;
/** Grid sizes are multiples of this, so the detector can snap its estimate. */
export const DIM_STEP = 8;

export interface Layout {
  W: number;
  H: number;
  /** Lattice node module coordinates (continuous; module i spans [i, i+1)). */
  nodesX: number[];
  nodesY: number[];
  /** Data module indices (y*W + x), in reading order. */
  data: Int32Array;
  blocks: number;
}

function nodes(n: number): number[] {
  const end = n - FINDER / 2;
  const out = [FINDER / 2];
  for (let x = FINDER / 2 + LATTICE; x <= end - 10; x += LATTICE) out.push(x);
  out.push(end);
  return out;
}

const cache = new Map<string, Layout>();

export function layout(W: number, H: number): Layout {
  const key = `${W}x${H}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const nodesX = nodes(W);
  const nodesY = nodes(H);
  const reserved = new Uint8Array(W * H);
  const fz = FINDER_ZONE;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inX = x < fz || x >= W - fz;
      const inY = y < fz || y >= H - fz;
      if (inX && inY) reserved[y * W + x] = 1;
    }
  }
  forEachMark(nodesX, nodesY, (cx, cy) => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) reserved[(cy + dy) * W + cx + dx] = 1;
  });
  let count = 0;
  for (let i = 0; i < reserved.length; i++) if (!reserved[i]) count++;
  const data = new Int32Array(count);
  let j = 0;
  for (let i = 0; i < reserved.length; i++) if (!reserved[i]) data[j++] = i;
  const l = { W, H, nodesX, nodesY, data, blocks: Math.floor(count / BLOCK_BITS) };
  cache.set(key, l);
  return l;
}

/** Alignment marks: every lattice node except the four corners (finders). */
export function forEachMark(nodesX: number[], nodesY: number[], fn: (cx: number, cy: number, i: number, j: number) => void) {
  const nx = nodesX.length - 1;
  const ny = nodesY.length - 1;
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      if ((i === 0 || i === nx) && (j === 0 || j === ny)) continue;
      fn(Math.floor(nodesX[i]!), Math.floor(nodesY[j]!), i, j);
    }
  }
}

/** Whitening stream for block b, so every region of the frame is ~50% dark. */
export function scramble(bytes: Uint8Array, block: number) {
  let s = (block + 1) * 0x9e3779b1;
  for (let i = 0; i < bytes.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    bytes[i]! ^= s & 0xff;
  }
}

/** Grid size for a target width that fits a stage's aspect ratio. */
export function gridFor(cols: number, aspect: number): { W: number; H: number } {
  const snap = (n: number) => Math.max(64, Math.round(n / DIM_STEP) * DIM_STEP);
  // aspect = height / width of the drawing area
  if (aspect >= 1) return { W: snap(cols), H: snap(cols * Math.min(aspect, 2.2)) };
  return { W: snap(cols), H: snap(cols * Math.max(aspect, 0.45)) };
}
