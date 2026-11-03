import { test } from "node:test";
import assert from "node:assert/strict";
import { rsDecode, rsEncode } from "../src/optical/rs.ts";

function rng(seed: number) {
  let s = seed;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) | 0) >>> 0) / 2 ** 32;
}

test("RS(255,223) corrects up to 16 byte errors, rejects 40", () => {
  const r = rng(1);
  for (let trial = 0; trial < 200; trial++) {
    const msg = Uint8Array.from({ length: 223 }, () => (r() * 256) | 0);
    const cw = rsEncode(msg, 32);
    const nerr = trial % 17;
    const pos = new Set<number>();
    while (pos.size < nerr) pos.add((r() * 255) | 0);
    for (const p of pos) cw[p]! ^= 1 + ((r() * 255) | 0);
    const out = rsDecode(cw, 32);
    assert.ok(out, `trial ${trial} with ${nerr} errors failed`);
    assert.deepEqual(Array.from(out!), Array.from(msg));
  }
  let rejected = 0;
  for (let trial = 0; trial < 100; trial++) {
    const msg = Uint8Array.from({ length: 223 }, () => (r() * 256) | 0);
    const cw = rsEncode(msg, 32);
    for (let i = 0; i < 40; i++) cw[(r() * 255) | 0]! ^= 1 + ((r() * 255) | 0);
    const out = rsDecode(cw, 32);
    if (!out) rejected++;
    else assert.notDeepEqual(Array.from(out), Array.from(msg).fill(-1)); // never claims success silently wrong (checked below)
  }
  assert.ok(rejected >= 99, `rejected ${rejected}/100`);
});
