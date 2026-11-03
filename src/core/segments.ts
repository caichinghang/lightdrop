// A file is cut into fixed 128 KiB segments, each fountain-coded on its own.
// The segment size never depends on the QR density setting, so a transfer can
// be resumed after the sender changes settings (or restarts).
//
// Small segments are what make large files possible: only a handful are ever
// being decoded at once, finished ones go straight to disk.

export const SEG_BYTES = 128 * 1024;

export function segmentCount(totalSize: number): number {
  return Math.max(1, Math.ceil(totalSize / SEG_BYTES));
}

export function segmentLength(totalSize: number, seg: number): number {
  return Math.max(0, Math.min(SEG_BYTES, totalSize - seg * SEG_BYTES));
}

/** Source blocks in a segment for a given block length. */
export function blocksInSegment(totalSize: number, seg: number, blockLen: number): number {
  return Math.max(1, Math.ceil(segmentLength(totalSize, seg) / blockLen));
}
