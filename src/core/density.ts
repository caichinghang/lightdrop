// Stream density presets. Frame sizes are the QR byte-mode capacity at ECC L
// for that version, trimmed so the payload is a multiple of 4 bytes.

import { DATA_HEADER } from "./frame";

const CAPACITY_L: Record<number, number> = { 10: 271, 15: 520, 20: 858, 25: 1273, 30: 1732, 35: 2223, 40: 2953 };

export function frameLenFor(version: number): number {
  const cap = CAPACITY_L[version]!;
  return DATA_HEADER + Math.floor((cap - DATA_HEADER) / 4) * 4;
}

export interface Level {
  version: number;
  codes: 1 | 2 | 4;
  fps: number;
  label: string;
}

/** The auto ladder, slowest to fastest. */
export const LADDER: Level[] = [
  { version: 15, codes: 1, fps: 15, label: "Gentle" },
  { version: 20, codes: 1, fps: 20, label: "Easy" },
  { version: 25, codes: 1, fps: 24, label: "Steady" },
  { version: 25, codes: 2, fps: 30, label: "Normal" },
  { version: 30, codes: 2, fps: 30, label: "Quick" },
  { version: 35, codes: 2, fps: 30, label: "Fast" },
  { version: 40, codes: 2, fps: 30, label: "Faster" },
  { version: 40, codes: 4, fps: 30, label: "Turbo" },
  { version: 40, codes: 4, fps: 45, label: "Hyper" },
  { version: 40, codes: 4, fps: 60, label: "Max" },
];

/** Raw optical bytes per second a level pushes, before loss. */
export function levelRate(l: Level): number {
  return (frameLenFor(l.version) - DATA_HEADER) * l.codes * l.fps;
}
