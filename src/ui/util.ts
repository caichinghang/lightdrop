export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDuration(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "—";
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`;
  return `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;
}

/** Rolling rate over the last few seconds. */
export class RateMeter {
  private samples: { t: number; v: number }[] = [];
  constructor(private readonly windowMs = 3000) {}
  push(value: number, t = performance.now()) {
    this.samples.push({ t, v: value });
    while (this.samples.length > 2 && t - this.samples[0]!.t > this.windowMs) this.samples.shift();
  }
  /** units per second */
  get rate(): number {
    const a = this.samples[0];
    const b = this.samples[this.samples.length - 1];
    if (!a || !b || b.t - a.t < 300) return 0;
    return ((b.v - a.v) * 1000) / (b.t - a.t);
  }
}

let wakeLock: WakeLockSentinel | undefined;
export async function keepAwake(on: boolean) {
  try {
    if (on && !wakeLock) {
      wakeLock = await navigator.wakeLock?.request("screen");
      wakeLock?.addEventListener("release", () => (wakeLock = undefined));
    } else if (!on) {
      await wakeLock?.release();
      wakeLock = undefined;
    }
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && wakeLock === undefined && keepAwakeWanted) void keepAwake(true);
});
let keepAwakeWanted = false;
export function wantAwake(on: boolean) {
  keepAwakeWanted = on;
  void keepAwake(on);
}

export const isTouch = () => matchMedia("(pointer: coarse)").matches;

export const icons = {
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`,
  receive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>`,
  light: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  sound: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>`,
  wifi: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0"/><circle cx="12" cy="19.5" r="1"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`,
  expand: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`,
  file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
};

export function svg(markup: string, cls = "icon"): HTMLElement {
  const s = document.createElement("span");
  s.className = cls;
  s.innerHTML = markup;
  return s;
}

/** A status pill: off / waiting / on. */
export function chip(icon: string, label: string): { el: HTMLElement; set(state: "off" | "wait" | "on", text?: string): void } {
  const text = h("span", {}, label);
  const el = h("div", { class: "chip off" }, svg(icon), text);
  return {
    el,
    set(state, t) {
      el.className = `chip ${state}`;
      if (t !== undefined) text.textContent = t;
    },
  };
}

const WIFI_KEY = "lightdrop.wifi";

/** Whether to try the Wi-Fi upgrade. Off is better on school/office networks,
 *  which usually block device-to-device traffic. Remembered per device. */
export function wifiEnabled(): boolean {
  try {
    return localStorage.getItem(WIFI_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setWifiEnabled(on: boolean) {
  try {
    localStorage.setItem(WIFI_KEY, on ? "1" : "0");
  } catch {}
}

export function wifiToggle(onChange: (on: boolean) => void): HTMLElement {
  const box = h("input", { type: "checkbox", checked: wifiEnabled() }) as HTMLInputElement;
  box.onchange = () => {
    setWifiEnabled(box.checked);
    onChange(box.checked);
  };
  return h(
    "label",
    { class: "toggle" },
    box,
    h("span", {}, h("b", {}, "Use Wi-Fi when possible"), h("br"), h("span", { class: "muted small" }, "Turn off on school or office Wi-Fi — they block devices from talking to each other.")),
  );
}
