// Stream settings. There is no back-channel, so the person sending picks
// these (the receiver screen says which way to go). Block size never changes,
// so adjusting mid-transfer loses nothing.

import { PAYLOAD_LEN } from "./frame";
import { gridFor, layout } from "../optical/layout";

/** Modules across the pattern: fewer = bigger squares = easier to read. */
export const GRIDS = [64, 80, 96, 128, 160, 192, 224, 256, 296, 336];

/** Pattern changes per second. Slower lets a camera in a dim room (long
 *  exposure) catch each pattern cleanly instead of a blend of two. */
export const FPS = [6, 8, 10, 12, 15, 20, 24, 30];

/** Phones usually send to a laptop webcam: coarse and slow. Computers usually
 *  send to a phone camera, which resolves much finer patterns. */
export function defaults(isPhone: boolean): { grid: number; fps: number } {
  return isPhone ? { grid: GRIDS.indexOf(80), fps: FPS.indexOf(10) } : { grid: GRIDS.indexOf(224), fps: FPS.indexOf(15) };
}

/** Raw bytes per second for a grid on a stage of this aspect (height / width). */
export function rawRate(cols: number, fps: number, aspect: number): number {
  const { W, H } = gridFor(cols, aspect);
  return layout(W, H).blocks * PAYLOAD_LEN * fps;
}
