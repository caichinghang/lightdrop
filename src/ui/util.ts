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
  if (n < 1024) return `${Math.round(n)} B`;
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
  if (!isFinite(sec) || sec < 0) return "--";
  if (sec < 60) return `${Math.max(1, Math.round(sec))}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${String(Math.round(sec % 60)).padStart(2, "0")}s`;
  return `${Math.floor(sec / 3600)}h ${String(Math.round((sec % 3600) / 60)).padStart(2, "0")}m`;
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
let keepAwakeWanted = false;
async function keepAwake(on: boolean) {
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
export function wantAwake(on: boolean) {
  keepAwakeWanted = on;
  void keepAwake(on);
}

export const isTouch = () => matchMedia("(pointer: coarse)").matches;

/** A classic 1-bit window: striped title bar, close box, content. */
export function win(title: string, opts: { onClose?: () => void; cls?: string } = {}, ...body: (Node | string | null | false | undefined)[]): HTMLElement {
  const close = h("button", { class: "win-close", "aria-label": "Close" });
  if (opts.onClose) close.onclick = opts.onClose;
  else close.disabled = true;
  return h(
    "section",
    { class: `win ${opts.cls ?? ""}`.trim() },
    h("header", { class: "win-title" }, close, h("span", { class: "win-name" }, title)),
    h("div", { class: "win-body" }, ...body),
  );
}

/** A terminal-style status line: "LIGHT ....... STREAMING". */
export type LineState = "off" | "wait" | "on";
export function statusLine(label: string): { el: HTMLElement; set(state: LineState, text: string): void } {
  const value = h("span", { class: "sl-value" }, "--");
  const el = h("div", { class: "sl off" }, h("span", { class: "sl-label" }, label), h("span", { class: "sl-dots" }), value);
  return {
    el,
    set(state, text) {
      el.className = `sl ${state}`;
      value.textContent = text.toUpperCase();
    },
  };
}

/** "LABEL [-] value [+]" stepper over a list of options. */
export function stepper(label: string, options: number[], index: number, fmt: (v: number) => string, onChange: (i: number) => void) {
  let i = index;
  const value = h("span", { class: "st-value" });
  const minus = h("button", { class: "btn small st-btn", "aria-label": `${label} down` }, "-");
  const plus = h("button", { class: "btn small st-btn", "aria-label": `${label} up` }, "+");
  const render = () => {
    value.textContent = fmt(options[i]!);
    minus.disabled = i === 0;
    plus.disabled = i === options.length - 1;
  };
  minus.onclick = () => {
    if (i > 0) onChange(--i);
    render();
  };
  plus.onclick = () => {
    if (i < options.length - 1) onChange(++i);
    render();
  };
  render();
  return h("div", { class: "stepper" }, h("span", { class: "st-label" }, label), minus, value, plus);
}
