// Reed–Solomon over GF(256) (primitive 0x11d, first consecutive root α^0).
// RS(255, 223): every block in a frame corrects up to 16 bad bytes on its own,
// and a block it can't fix is simply dropped — the fountain code above covers it.
// Ported from the classic Wikiversity "Reed–Solomon codes for coders" layout:
// polynomials are arrays, highest degree first.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

const mul = (a: number, b: number) => (a && b ? EXP[LOG[a]! + LOG[b]!]! : 0);
const div = (a: number, b: number) => (a ? EXP[(LOG[a]! + 255 - LOG[b]!) % 255]! : 0);
const pow = (x: number, p: number) => EXP[(((LOG[x]! * p) % 255) + 255) % 255]!;
const inv = (x: number) => EXP[255 - LOG[x]!]!;

function polyScale(p: number[], x: number): number[] {
  return p.map((c) => mul(c, x));
}
function polyAdd(p: number[], q: number[]): number[] {
  const r = new Array<number>(Math.max(p.length, q.length)).fill(0);
  for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i]!;
  for (let i = 0; i < q.length; i++) r[i + r.length - q.length]! ^= q[i]!;
  return r;
}
function polyMul(p: number[], q: number[]): number[] {
  const r = new Array<number>(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++) for (let i = 0; i < p.length; i++) r[i + j]! ^= mul(p[i]!, q[j]!);
  return r;
}
function polyEval(p: ArrayLike<number>, x: number): number {
  let y = p[0]!;
  for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i]!;
  return y;
}
function polyDivRemainder(dividend: number[], divisor: number[]): number[] {
  const out = dividend.slice();
  for (let i = 0; i < dividend.length - (divisor.length - 1); i++) {
    const coef = out[i]!;
    if (coef === 0) continue;
    for (let j = 1; j < divisor.length; j++) if (divisor[j]) out[i + j]! ^= mul(divisor[j]!, coef);
  }
  return out.slice(out.length - (divisor.length - 1));
}

const generators = new Map<number, Uint8Array>();
function generator(nsym: number): Uint8Array {
  let g = generators.get(nsym);
  if (!g) {
    let p = [1];
    for (let i = 0; i < nsym; i++) p = polyMul(p, [1, pow(2, i)]);
    generators.set(nsym, (g = Uint8Array.from(p)));
  }
  return g;
}

/** msg (k bytes) → codeword (k + nsym bytes), systematic. */
export function rsEncode(msg: Uint8Array, nsym: number): Uint8Array {
  const g = generator(nsym);
  const out = new Uint8Array(msg.length + nsym);
  out.set(msg);
  for (let i = 0; i < msg.length; i++) {
    const coef = out[i]!;
    if (coef === 0) continue;
    const lc = LOG[coef]!;
    for (let j = 1; j < g.length; j++) if (g[j]) out[i + j]! ^= EXP[LOG[g[j]!]! + lc]!;
  }
  out.set(msg);
  return out;
}

function syndromes(cw: Uint8Array, nsym: number): number[] {
  // Padded with a leading 0, as the BM routine below expects.
  const s = new Array<number>(nsym + 1).fill(0);
  for (let i = 0; i < nsym; i++) s[i + 1] = polyEval(cw, pow(2, i));
  return s;
}

/**
 * Decode in place. Returns the k message bytes, or null when the block has
 * more errors than the code can fix.
 */
export function rsDecode(cw: Uint8Array, nsym: number): Uint8Array | null {
  const synd = syndromes(cw, nsym);
  if (synd.every((x) => x === 0)) return cw.subarray(0, cw.length - nsym);

  // Berlekamp–Massey: error locator polynomial.
  let errLoc = [1];
  let oldLoc = [1];
  for (let i = 0; i < nsym; i++) {
    const K = i + 1;
    let delta = synd[K]!;
    for (let j = 1; j < errLoc.length; j++) delta ^= mul(errLoc[errLoc.length - 1 - j]!, synd[K - j]!);
    oldLoc = [...oldLoc, 0];
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, inv(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  while (errLoc.length && errLoc[0] === 0) errLoc.shift();
  const errs = errLoc.length - 1;
  if (errs * 2 > nsym) return null;

  // Chien search.
  const rev = errLoc.slice().reverse();
  const n = cw.length;
  const errPos: number[] = [];
  for (let i = 0; i < n; i++) if (polyEval(rev, pow(2, i)) === 0) errPos.push(n - 1 - i);
  if (errPos.length !== errs) return null;

  // Forney: error magnitudes.
  const coefPos = errPos.map((p) => n - 1 - p);
  let eLoc = [1];
  for (const i of coefPos) eLoc = polyMul(eLoc, polyAdd([1], [pow(2, i), 0]));
  const sRev = synd.slice().reverse();
  const divisor = [1, ...new Array<number>(eLoc.length).fill(0)];
  const errEval = polyDivRemainder(polyMul(sRev, eLoc), divisor).reverse();
  const X = coefPos.map((c) => pow(2, -(255 - c)));
  for (let i = 0; i < X.length; i++) {
    const xi = X[i]!;
    const xiInv = inv(xi);
    let prime = 1;
    for (let j = 0; j < X.length; j++) if (j !== i) prime = mul(prime, 1 ^ mul(xiInv, X[j]!));
    if (prime === 0) return null;
    const y = mul(xi, polyEval(errEval.slice().reverse(), xiInv));
    cw[errPos[i]!]! ^= div(y, prime);
  }
  if (syndromes(cw, nsym).some((x) => x !== 0)) return null;
  return cw.subarray(0, cw.length - nsym);
}
