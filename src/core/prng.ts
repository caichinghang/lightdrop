// Deterministic PRNG shared by sender and receiver. Only integer ops, so every
// JS engine produces the same stream (Math.random / Math.log are not portable).

export function splitmix32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x9e3779b9) | 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export function mix3(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x27d4eb2f, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15) ^ b, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 13) ^ c, 0xc2b2ae3d);
  return (h ^ (h >>> 16)) | 0;
}
