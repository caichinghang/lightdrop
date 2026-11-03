// Sender side: turn up to `layout.blocks` 223-byte blocks into a module grid.

import { BLOCK_DATA, FINDER, forEachMark, layout, scramble } from "./layout";
import { rsEncode } from "./rs";

/** Module grid, 1 = dark, row-major W×H. */
export function encodeFrame(W: number, H: number, blocks: Uint8Array[]): Uint8Array {
  const l = layout(W, H);
  const grid = new Uint8Array(W * H);

  // Finders: 2:2:7:2:2 concentric squares.
  const finder = (ox: number, oy: number) => {
    for (let y = 0; y < FINDER; y++) {
      for (let x = 0; x < FINDER; x++) {
        const d = Math.max(Math.abs(x - 7), Math.abs(y - 7));
        grid[(oy + y) * W + ox + x] = d <= 3 || d >= 6 ? 1 : 0;
      }
    }
  };
  finder(0, 0);
  finder(W - FINDER, 0);
  finder(0, H - FINDER);
  finder(W - FINDER, H - FINDER);

  // Alignment marks: dark ring, light ring, dark centre.
  forEachMark(l.nodesX, l.nodesY, (cx, cy) => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        grid[(cy + dy) * W + cx + dx] = d === 1 ? 0 : 1;
      }
    }
  });

  // Data: RS-encode and whiten each block, then lay bits out in reading order.
  let bit = 0;
  for (let b = 0; b < l.blocks; b++) {
    const msg = new Uint8Array(BLOCK_DATA);
    const src = blocks[b];
    if (src) msg.set(src.subarray(0, BLOCK_DATA));
    const cw = rsEncode(msg, 32);
    scramble(cw, b);
    for (let i = 0; i < cw.length; i++) {
      const v = cw[i]!;
      for (let k = 7; k >= 0; k--) grid[l.data[bit++]!] = (v >> k) & 1;
    }
  }
  // Leftover modules: noise, so they look like data and keep contrast even.
  let s = 0x2545f491;
  for (; bit < l.data.length; bit++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    grid[l.data[bit]!] = s & 1;
  }
  return grid;
}
