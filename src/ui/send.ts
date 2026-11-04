import { crc32 } from "../core/crc";
import { FPS, GRIDS, defaults, rawRate } from "../core/density";
import { PAYLOAD_LEN, encodeData, encodeMeta, fileId24 } from "../core/frame";
import { Scheduler } from "../core/scheduler";
import { encodeFrame } from "../optical/encode";
import { QUIET, gridFor, layout } from "../optical/layout";
import { sprite } from "./pixels";
import { formatBytes, formatDuration, h, isTouch, stepper, wantAwake, win } from "./util";

export function fileIdFor(f: File): number {
  return fileId24(crc32(new TextEncoder().encode(`${f.name}|${f.size}|${f.lastModified}`))) || 1;
}

export function pickFileView(onFile: (f: File) => void, onBack: () => void): HTMLElement {
  const input = h("input", { type: "file", hidden: true }) as HTMLInputElement;
  input.onchange = () => input.files?.[0] && onFile(input.files[0]);
  const zone = h(
    "button",
    { class: "dropzone" },
    sprite("folder", 6),
    h("strong", {}, isTouch() ? "CHOOSE A FILE" : "DROP A FILE HERE"),
    h("span", {}, isTouch() ? "photos · videos · documents · any size" : "or click to browse · any size"),
  );
  zone.onclick = () => input.click();
  const view = h(
    "div",
    { class: "desk" },
    win(
      "SEND",
      { onClose: onBack, cls: "win-pick" },
      zone,
      input,
      h(
        "p",
        { class: "note" },
        "On the other device: open this page, press ",
        h("b", {}, "RECEIVE"),
        " and point the camera at this screen. Nothing to connect.",
      ),
    ),
  );
  view.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("over");
  });
  view.addEventListener("dragleave", () => zone.classList.remove("over"));
  view.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files[0];
    if (f) onFile(f);
  });
  return view;
}

const GRID_KEY = "lightdrop.grid";
const FPS_KEY = "lightdrop.fps";

function remembered(key: string, fallback: number, max: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return localStorage.getItem(key) !== null && Number.isInteger(v) && v >= 0 && v < max ? v : fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, v: number) {
  try {
    localStorage.setItem(key, String(v));
  } catch {}
}

/**
 * The streaming screen: the pattern fills the window, with one strip of
 * controls. One-way: the sender loops the file (fountain-coded, so any
 * blocks in any order will do) until you stop it.
 */
export function sendView(file: File, onBack: () => void): { el: HTMLElement; dispose: () => void } {
  const fileId = fileIdFor(file);
  const phone = isTouch();
  // Settings are remembered per device and direction (phone-as-sender vs
  // computer-as-sender behave very differently).
  const d = defaults(phone);
  const sfx = phone ? ".phone" : ".desk";
  let gridIdx = remembered(GRID_KEY + sfx, d.grid, GRIDS.length);
  let fpsIdx = remembered(FPS_KEY + sfx, d.fps, FPS.length);
  const sched = new Scheduler(file, fileId, PAYLOAD_LEN);
  let disposed = false;

  // ---- view ----
  const canvas = h("canvas", { class: "code" }) as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;
  const stage = h("div", { class: "stage" }, canvas);

  const info = h("span", { class: "strip-text" });
  const gridStep = stepper("GRID", GRIDS, gridIdx, (v) => String(v), (i) => {
    gridIdx = i;
    remember(GRID_KEY + sfx, i);
    recomputeGrid();
  });
  const fpsStep = stepper("FPS", FPS, fpsIdx, (v) => String(v), (i) => {
    fpsIdx = i;
    remember(FPS_KEY + sfx, i);
    updateInfo();
  });
  const fsBtn = h("button", { class: "btn small" }, "FULL");
  fsBtn.title = "Fullscreen";
  fsBtn.onclick = () => toggleFullscreen();
  // iPhone Safari can't make a page element fullscreen.
  if (!document.fullscreenEnabled) fsBtn.hidden = true;
  const stopBtn = h("button", { class: "btn small" }, "STOP");
  stopBtn.onclick = onBack;
  const strip = h(
    "div",
    { class: "strip" },
    h("div", { class: "strip-file" }, sprite("file", 2), h("span", { class: "ellipsis" }, file.name), info),
    h("div", { class: "strip-ctl" }, gridStep, fpsStep, fsBtn, stopBtn),
  );
  const el = h("div", { class: "send-layout" }, stage, strip);

  function toggleFullscreen() {
    const p = document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.();
    void p?.catch(() => {});
  }

  // ---- grid geometry ----
  let grid = { W: 0, H: 0 };
  function stageAspect(): number {
    return Math.max(1, stage.clientHeight - 16) / Math.max(1, stage.clientWidth - 16);
  }
  function recomputeGrid() {
    const dpr = window.devicePixelRatio || 1;
    // Never below 2 device pixels per module.
    const maxCols = Math.floor(((Math.min(stage.clientWidth, stage.clientHeight) - 16) * dpr) / 2) - 2 * QUIET;
    const cols = Math.max(64, Math.min(GRIDS[gridIdx]!, maxCols));
    grid = gridFor(cols, stageAspect());
    updateInfo();
  }
  function updateInfo() {
    if (!grid.W) return;
    const rate = rawRate(grid.W, FPS[fpsIdx]!, stageAspect());
    // One pass over the file; a receiver catching most frames needs ~1.2 passes.
    info.textContent = `${formatBytes(file.size)} · ~${formatDuration((file.size * 1.2) / rate)} per pass`;
  }
  const ro = new ResizeObserver(() => recomputeGrid());
  ro.observe(stage);

  // ---- frame production ----
  let pending: Awaited<ReturnType<Scheduler["nextBatch"]>> = [];
  async function nextData() {
    if (!pending.length) pending = await sched.nextBatch();
    return pending.shift();
  }

  /** One frame of blocks: a META block (name, size), then data. Small grids
   *  carry META only every few frames so data still gets through. */
  let frameNo = 0;
  async function buildFrame(): Promise<{ W: number; H: number; grid: Uint8Array } | null> {
    const { W, H } = grid;
    if (!W) return null;
    const n = layout(W, H).blocks;
    const blocks: Uint8Array[] = [];
    if (n >= 4 || frameNo++ % 4 === 0) blocks.push(encodeMeta(fileId, file.size, file.name, file.type));
    while (blocks.length < n) {
      const b = await nextData();
      if (!b) break;
      blocks.push(encodeData(fileId, b.seg, b.seq, b.payload));
    }
    return { W, H, grid: encodeFrame(W, H, blocks) };
  }

  function draw(f: { W: number; H: number; grid: Uint8Array }) {
    const tw = f.W + 2 * QUIET;
    const th = f.H + 2 * QUIET;
    if (canvas.width !== tw || canvas.height !== th) {
      canvas.width = tw;
      canvas.height = th;
    }
    const img = ctx.createImageData(tw, th);
    const px = new Uint32Array(img.data.buffer);
    px.fill(0xffffffff);
    for (let y = 0; y < f.H; y++) {
      const row = (y + QUIET) * tw + QUIET;
      for (let x = 0; x < f.W; x++) if (f.grid[y * f.W + x]) px[row + x] = 0xff000000;
    }
    ctx.putImageData(img, 0, 0);
    // A whole number of device pixels per module keeps every module the same size.
    const dpr = window.devicePixelRatio || 1;
    const m = Math.max(1, Math.floor(Math.min(((stage.clientWidth - 16) * dpr) / tw, ((stage.clientHeight - 16) * dpr) / th)));
    canvas.style.width = `${(tw * m) / dpr}px`;
    canvas.style.height = `${(th * m) / dpr}px`;
  }

  type Built = { W: number; H: number; grid: Uint8Array } | null;
  let building = false;
  let ready: Built = null;
  let nextAt = 0;
  function tick(now: number) {
    if (disposed) return;
    requestAnimationFrame(tick);
    if (!ready && !building) {
      building = true;
      void buildFrame().then((f) => {
        ready = f;
        building = false;
      });
    }
    if (!ready || now < nextAt) return;
    draw(ready);
    ready = null;
    const interval = 1000 / FPS[fpsIdx]!;
    nextAt = now - nextAt > interval * 2 ? now + interval : nextAt + interval;
  }

  wantAwake(true);
  requestAnimationFrame(() => {
    recomputeGrid();
    requestAnimationFrame(tick);
  });

  return {
    el,
    dispose() {
      disposed = true;
      ro.disconnect();
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      wantAwake(false);
    },
  };
}
