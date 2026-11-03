// Stream density presets: how many modules across the screen, and how many
// frames per second. Block size never changes, so switching levels mid-
// transfer loses nothing.

import { PAYLOAD_LEN } from "./frame";
import { gridFor, layout } from "../optical/layout";

export interface Level {
  cols: number;
  fps: number;
  label: string;
}

/** The auto ladder, slowest to fastest. */
export const LADDER: Level[] = [
  { cols: 96, fps: 12, label: "GENTLE" },
  { cols: 128, fps: 15, label: "EASY" },
  { cols: 160, fps: 20, label: "STEADY" },
  { cols: 192, fps: 24, label: "NORMAL" },
  { cols: 224, fps: 30, label: "QUICK" },
  { cols: 256, fps: 30, label: "FAST" },
  { cols: 296, fps: 30, label: "FASTER" },
  { cols: 336, fps: 30, label: "TURBO" },
  { cols: 384, fps: 30, label: "HYPER" },
  { cols: 448, fps: 30, label: "MAX" },
];

/** Raw optical bytes per second a level pushes on a stage of this aspect (h/w). */
export function levelRate(l: Level, aspect: number): number {
  const { W, H } = gridFor(l.cols, aspect);
  return layout(W, H).blocks * PAYLOAD_LEN * l.fps;
}
