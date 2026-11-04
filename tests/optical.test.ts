import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame } from "../src/optical/encode.ts";
import { detect, type Gray } from "../src/optical/detect.ts";
import { BLOCK_DATA, QUIET, layout } from "../src/optical/layout.ts";

function rng(seed: number) {
  let s = seed;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) | 0) >>> 0) / 2 ** 32;
}

function makeBlocks(W: number, H: number, seed: number): Uint8Array[] {
  const r = rng(seed);
  return Array.from({ length: layout(W, H).blocks }, () => Uint8Array.from({ length: BLOCK_DATA }, () => (r() * 256) | 0));
}

interface Cam {
  w: number;
  h: number;
  /** grid placement: centre, module pitch in px, rotation (rad), perspective tilt */
  cx: number;
  cy: number;
  pitch: number;
  angle: number;
  tilt: number;
  barrel: number;
  blur: number;
  noise: number;
  /** optional second frame shown below this image row (rolling-shutter tear) */
  tearAt?: number;
  /** screen black / white / surroundings brightness */
  levels?: [number, number, number];
}

/** Photograph a module grid: perspective, lens barrel, blur, low contrast, noise. */
function photograph(grids: Uint8Array[], W: number, H: number, cam: Cam, seed = 7): Gray {
  const { w, h } = cam;
  const out = new Float32Array(w * h);
  const TW = W + 2 * QUIET;
  const TH = H + 2 * QUIET;
  const r = rng(seed);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let sy = 0; sy < 2; sy++)
        for (let sx = 0; sx < 2; sx++) {
          // normalised camera coords with barrel distortion
          let nx = (x + 0.25 + sx * 0.5 - w / 2) / (w / 2);
          let ny = (y + 0.25 + sy * 0.5 - h / 2) / (w / 2);
          const rr = nx * nx + ny * ny;
          nx *= 1 + cam.barrel * rr;
          ny *= 1 + cam.barrel * rr;
          let px = nx * (w / 2) - cam.cx;
          let py = ny * (w / 2) - cam.cy;
          // perspective: depth varies with y
          const z = 1 + cam.tilt * (py / h);
          px *= z;
          py *= z;
          const ca = Math.cos(-cam.angle);
          const sa = Math.sin(-cam.angle);
          const u = (px * ca - py * sa) / cam.pitch + TW / 2;
          const v = (px * sa + py * ca) / cam.pitch + TH / 2;
          const [lo, hi, bg] = cam.levels ?? [35, 205, 90];
          let val = bg; // desk / bezel
          if (u >= 0 && v >= 0 && u < TW && v < TH) {
            const gx = Math.floor(u) - QUIET;
            const gy = Math.floor(v) - QUIET;
            const grid = cam.tearAt !== undefined && y >= cam.tearAt ? grids[1]! : grids[0]!;
            const dark = gx >= 0 && gy >= 0 && gx < W && gy < H && grid[gy * W + gx];
            val = dark ? lo : hi;
          }
          acc += val;
        }
      out[y * w + x] = acc / 4;
    }
  }
  // box blur
  let img = out;
  for (let pass = 0; pass < cam.blur; pass++) {
    const nb = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += img[(y + dy) * w + x + dx]!;
        nb[y * w + x] = s / 9;
      }
    img = nb;
  }
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, img[i]! + (r() - 0.5) * 2 * cam.noise));
  return { data, w, h };
}

function score(blocks: Uint8Array[], got: (Uint8Array | null)[]) {
  let ok = 0;
  let wrong = 0;
  got.forEach((b, i) => {
    if (!b) return;
    if (blocks[i] && b.every((v, k) => v === blocks[i]![k])) ok++;
    else wrong++;
  });
  return { ok, wrong, total: blocks.length };
}

const base: Cam = { w: 1280, h: 720, cx: 0, cy: 0, pitch: 4, angle: 0.03, tilt: 0.08, barrel: 0.03, blur: 1, noise: 12 };

test("decodes a tilted, distorted, blurry, noisy photo", () => {
  const W = 224, H = 136;
  const blocks = makeBlocks(W, H, 1);
  const g = photograph([encodeFrame(W, H, blocks)], W, H, base);
  const t0 = performance.now();
  const d = detect(g);
  const ms = performance.now() - t0;
  assert.ok(d, "detected");
  const s = score(blocks, d!.blocks);
  console.log(`  ${W}x${H} pitch 4: ${s.ok}/${s.total} blocks, ${s.wrong} wrong, ${ms.toFixed(0)} ms`);
  assert.equal(d!.W, W);
  assert.equal(d!.H, H);
  assert.equal(s.wrong, 0);
  assert.ok(s.ok >= s.total * 0.9);
});

test("small modules (3 px) and stronger distortion", () => {
  const W = 320, H = 184;
  const blocks = makeBlocks(W, H, 2);
  const g = photograph([encodeFrame(W, H, blocks)], W, H, { ...base, pitch: 3.2, barrel: 0.05, angle: -0.05 });
  const d = detect(g);
  assert.ok(d, "detected");
  const s = score(blocks, d!.blocks);
  console.log(`  ${W}x${H} pitch 3.2: ${s.ok}/${s.total} blocks, ${s.wrong} wrong`);
  assert.equal(s.wrong, 0);
  assert.ok(s.ok >= s.total * 0.75);
});

test("phone held sideways (90°) and upside down (180°)", () => {
  const W = 192, H = 112;
  const blocks = makeBlocks(W, H, 3);
  for (const angle of [Math.PI / 2 + 0.02, Math.PI - 0.03]) {
    const g = photograph([encodeFrame(W, H, blocks)], W, H, { ...base, angle, pitch: 3.6 });
    const d = detect(g);
    assert.ok(d, "detected");
    const s = score(blocks, d!.blocks);
    console.log(`  angle ${angle.toFixed(2)}: ${s.ok}/${s.total}`);
    assert.equal(s.wrong, 0);
    assert.ok(s.ok >= s.total * 0.85);
  }
});

test("torn capture yields blocks from both frames", () => {
  const W = 224, H = 136;
  const a = makeBlocks(W, H, 4);
  const b = makeBlocks(W, H, 5);
  const g = photograph([encodeFrame(W, H, a), encodeFrame(W, H, b)], W, H, { ...base, tearAt: 360 });
  const d = detect(g, { W, H, rot: 0 });
  assert.ok(d, "detected");
  const sa = score(a, d!.blocks);
  const sb = score(b, d!.blocks);
  console.log(`  tear: ${sa.ok} from frame A, ${sb.ok} from frame B, of ${a.length}`);
  assert.ok(sa.ok > 3 && sb.ok > 3);
  assert.ok(sa.ok + sb.ok >= a.length * 0.7);
});

test("tall (portrait) grid filmed sideways", () => {
  const W = 128, H = 224;
  const blocks = makeBlocks(W, H, 6);
  const g = photograph([encodeFrame(W, H, blocks)], W, H, { ...base, angle: Math.PI / 2 - 0.02, pitch: 2.9 });
  const d = detect(g);
  assert.ok(d, "detected");
  const s = score(blocks, d!.blocks);
  console.log(`  portrait sideways: ${s.ok}/${s.total}, grid ${d!.W}x${d!.H}`);
  assert.equal(s.wrong, 0);
  assert.ok(s.ok >= s.total * 0.8);
});

test("laptop webcam reading a phone: small, dark room, over-exposed, blurry", () => {
  for (const [W, H, pitch] of [
    [64, 112, 3.4],
    [80, 144, 3.0],
    [96, 168, 2.6],
  ] as const) {
    const blocks = makeBlocks(W, H, 7);
    const g = photograph([encodeFrame(W, H, blocks)], W, H, {
      ...base,
      angle: 0.08,
      tilt: 0.05,
      pitch,
      blur: 2,
      noise: 14,
      levels: [95, 255, 25], // blacks lifted by glare, whites clipped, dark room
    });
    const d = detect(g);
    const s = d ? score(blocks, d.blocks) : { ok: 0, wrong: 0, total: blocks.length };
    console.log(`  webcam ${W}x${H} @ ${pitch}px: ${s.ok}/${s.total}`);
    assert.equal(s.wrong, 0);
    if (W === 64) assert.ok(s.ok >= s.total * 0.75, "coarsest grid must read");
  }
});
