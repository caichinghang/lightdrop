import { crc32 } from "../core/crc";
import { LADDER, levelRate } from "../core/density";
import { PAYLOAD_LEN, SIGNAL_CHUNK, encodeData, encodeMeta, encodeSignal, fileId24 } from "../core/frame";
import { Scheduler } from "../core/scheduler";
import { SoundListener } from "../audio/io";
import { MsgType, parseAck, parseHeader, Reassembler } from "../audio/messages";
import { SenderLink, decodeAnswer } from "../net/rtc";
import { WireSender } from "../net/wire";
import { encodeFrame } from "../optical/encode";
import { QUIET, gridFor, layout } from "../optical/layout";
import { asciiBar, sprite } from "./pixels";
import {
  RateMeter,
  asciiCheck,
  formatBytes,
  formatDuration,
  h,
  isTouch,
  setWifiEnabled,
  statusLine,
  wantAwake,
  wifiEnabled,
  win,
} from "./util";

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
        " and point the camera at this screen. No pairing. No network.",
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

/** The streaming screen. Returns the view and a cleanup function. */
export function sendView(file: File, onBack: () => void): { el: HTMLElement; dispose: () => void } {
  const fileId = fileIdFor(file);
  // Start middling; with sound ACKs, Auto climbs within seconds.
  let levelIdx = isTouch() ? 3 : 4;
  let auto = true;
  let level = LADDER[levelIdx]!;
  const sched = new Scheduler(file, fileId, PAYLOAD_LEN);
  let disposed = false;
  let lastLevelChange = performance.now();
  let finished = false;
  let wifiBytes = 0;
  let wifiOpen = false;
  let frameNo = 0;
  const rate = new RateMeter(4000);

  // ---- view ----
  const canvas = h("canvas", { class: "code" }) as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;
  const stage = h("div", { class: "stage" }, canvas);
  const wifiOverlay = h(
    "div",
    { class: "stage-overlay", hidden: true },
    sprite("wifi", 8),
    h("strong", {}, "SENDING OVER WI-FI"),
    h("span", {}, "You can put the devices down."),
  );
  const doneOverlay = h(
    "div",
    { class: "stage-overlay", hidden: true },
    sprite("face", 8),
    h("strong", {}, "DELIVERED"),
    h("span", {}, `${file.name} arrived safely.`),
  );
  stage.append(wifiOverlay, doneOverlay);

  const lLight = statusLine("LIGHT");
  const lSound = statusLine("SOUND");
  const lWifi = statusLine("WI-FI");
  lLight.set("on", "streaming");
  const bar = h("pre", { class: "bar" }, asciiBar(0, 18));
  const stat = h("div", { class: "stat" }, "Waiting for a receiver...");
  const levelLine = h("div", { class: "level" });

  const levelSel = h("select", { class: "select" }) as HTMLSelectElement;
  levelSel.append(h("option", { value: "auto" }, "AUTO"));
  LADDER.forEach((l, i) => levelSel.append(h("option", { value: String(i) }, `${l.label}  ${l.cols} cols @ ${l.fps}fps`)));
  levelSel.onchange = () => {
    auto = levelSel.value === "auto";
    setLevel(auto ? levelIdx : Number(levelSel.value));
  };

  const fsBtn = h("button", { class: "btn" }, "FULLSCREEN");
  fsBtn.onclick = () => {
    const p = document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen?.();
    void p?.catch(() => {});
  };
  const stopBtn = h("button", { class: "btn" }, "STOP");
  stopBtn.onclick = onBack;

  const panel = win(
    "TRANSMITTING",
    { onClose: onBack, cls: "win-panel" },
    h(
      "div",
      { class: "file-row" },
      sprite("file", 3),
      h("div", { class: "file-meta" }, h("strong", { class: "ellipsis" }, file.name), h("span", {}, formatBytes(file.size))),
    ),
    bar,
    stat,
    h("div", { class: "lines" }, lLight.el, lSound.el, lWifi.el),
    levelLine,
    h(
      "details",
      { class: "settings" },
      h("summary", {}, "SETTINGS"),
      h("label", { class: "field" }, h("span", {}, "DENSITY"), levelSel),
      h("p", { class: "small" }, "AUTO keeps raising density while the receiver keeps up (it reports back by sound), and backs off when speed drops."),
      asciiCheck(
        "USE WI-FI WHEN POSSIBLE",
        wifiEnabled(),
        (on) => {
          setWifiEnabled(on);
          if (on) startLink();
          else stopLink();
        },
        "Turn off on school or office Wi-Fi.",
      ),
    ),
    h("div", { class: "row-btns" }, fsBtn, stopBtn),
  );
  const el = h("div", { class: "send-layout" }, stage, panel);

  // ---- grid geometry ----
  let grid = { W: 0, H: 0 };
  function stageAspect(): number {
    const w = Math.max(1, stage.clientWidth - 16);
    const hh = Math.max(1, stage.clientHeight - 16);
    return hh / w;
  }
  function recomputeGrid() {
    const dpr = window.devicePixelRatio || 1;
    // Never below 2 device pixels per module.
    const maxCols = Math.floor(((stage.clientWidth - 16) * dpr) / 2) - 2 * QUIET;
    const cols = Math.max(64, Math.min(level.cols, maxCols));
    grid = gridFor(cols, stageAspect());
  }

  function setLevel(i: number) {
    levelIdx = Math.max(0, Math.min(LADDER.length - 1, i));
    level = LADDER[levelIdx]!;
    recomputeGrid();
    lastLevelChange = performance.now();
    sched.resetRate();
    levelLine.textContent = `${auto ? "AUTO > " : ""}${level.label} · ${grid.W}x${grid.H} @ ${level.fps}fps · ${layout(grid.W, grid.H).blocks} blocks/frame`;
  }
  const ro = new ResizeObserver(() => setLevel(levelIdx));
  ro.observe(stage);

  // ---- Wi-Fi upgrade (optional) ----
  let link: SenderLink | undefined;
  let signalChunks: Uint8Array[] | undefined;

  function startLink() {
    if (link) return;
    const l = (link = new SenderLink());
    lWifi.set("wait", "offering");
    l.offer()
      .then((deflated) => {
        if (link !== l) return;
        const chunks: Uint8Array[] = [];
        for (let o = 0; o < deflated.length; o += SIGNAL_CHUNK) chunks.push(deflated.subarray(o, o + SIGNAL_CHUNK));
        signalChunks = chunks;
      })
      .catch(() => lWifi.set("off", "unavailable"));
    l.dc.onopen = () => {
      wifiOpen = true;
      lWifi.set("on", "connected");
      lLight.set("off", "paused");
      wifiOverlay.hidden = false;
      new WireSender(l.dc, sched, { t: "meta", fileId, size: file.size, name: file.name, mime: file.type }, () => {});
    };
    l.dc.onclose = () => {
      wifiOpen = false;
      if (link === l) lWifi.set("off", "lost");
      if (!finished) lLight.set("on", "streaming");
      wifiOverlay.hidden = true;
    };
    l.dc.addEventListener("message", (e) => {
      if (typeof e.data !== "string") return;
      const m = JSON.parse(e.data);
      if (m.t === "progress") {
        wifiBytes = m.bytes;
        if (m.ack) sched.onAck(m.ack);
        if (m.complete) finish();
      }
    });
    l.pc.onconnectionstatechange = () => {
      if (l.pc.connectionState === "connecting") lWifi.set("wait", "connecting");
      if (l.pc.connectionState === "failed") lWifi.set("off", "not same network");
    };
  }

  function stopLink() {
    signalChunks = undefined;
    link?.close();
    link = undefined;
    lWifi.set("off", "off");
  }

  if (wifiEnabled()) startLink();
  else lWifi.set("off", "off");

  // ---- sound back-channel ----
  const reasm = new Reassembler();
  const listener = new SoundListener((pkt) => {
    const { type } = parseHeader(pkt.header);
    if (type === MsgType.Ack) {
      const a = parseAck(pkt.payload);
      if (!a || a.fileIdLow !== (fileId & 0xffff)) return;
      lSound.set("on", "receiver heard");
      sched.onAck(a.ack);
      onAck();
      return;
    }
    const msg = reasm.push(pkt);
    if (msg?.type === MsgType.Answer && link) {
      const ans = decodeAnswer(msg.bytes);
      if (ans) {
        lWifi.set("wait", "connecting");
        link.accept(ans).catch(() => lWifi.set("off", "failed"));
      }
    }
  });
  listener
    .start()
    .then(() => lSound.set("wait", "listening"))
    .catch(() => lSound.set("off", "mic off"));

  // Auto density: hill-climb on measured goodput (catch rate × raw rate of the
  // level). A phone that can't keep up with a dense stream still gets more
  // bytes from it, so the catch rate alone is the wrong thing to chase.
  const goodput = new Map<number, number>();
  let ceiling = { idx: LADDER.length, until: 0 };
  function onAck() {
    if (sched.finished) return finish();
    if (!auto) return;
    const now = performance.now();
    if (now - lastLevelChange < 5000 || sched.rateSamples < 1) return;
    const g = sched.rate * levelRate(level, stageAspect());
    goodput.set(levelIdx, g);
    const below = goodput.get(levelIdx - 1);
    if (below !== undefined && g < below * 0.9) {
      ceiling = { idx: levelIdx, until: now + 60000 };
      return setLevel(levelIdx - 1);
    }
    const blocked = levelIdx + 1 >= ceiling.idx && now < ceiling.until;
    if (levelIdx + 1 < LADDER.length && !blocked && sched.rate > 0.15) return setLevel(levelIdx + 1);
    if (sched.rate < 0.05 && levelIdx > 0) setLevel(levelIdx - 1);
  }

  function finish() {
    if (finished) return;
    finished = true;
    lLight.set("off", "done");
    wifiOverlay.hidden = true;
    doneOverlay.hidden = false;
    bar.textContent = asciiBar(1, 18);
    stat.textContent = `Delivered ${formatBytes(file.size)}.`;
    wantAwake(false);
  }

  // ---- frame production ----
  let pending: Awaited<ReturnType<Scheduler["nextBatch"]>> = [];
  async function nextData() {
    if (!pending.length) pending = await sched.nextBatch();
    return pending.shift();
  }

  /** Blocks for one frame: META first, the Wi-Fi offer every few frames, then data. */
  async function buildFrame(): Promise<{ W: number; H: number; grid: Uint8Array } | null> {
    const { W, H } = grid;
    if (!W) return null;
    const n = layout(W, H).blocks;
    const blocks: Uint8Array[] = [encodeMeta(fileId, file.size, file.name, file.type)];
    frameNo++;
    if (signalChunks && link && !wifiOpen && frameNo % 3 === 0) {
      const offerId = link.offerId;
      signalChunks.forEach((c, i, all) => blocks.push(encodeSignal(fileId, offerId, i, all.length, c)));
    }
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
    updateStats();
    if (wifiOpen || finished) return;
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
    const interval = 1000 / level.fps;
    nextAt = now - nextAt > interval * 2 ? now + interval : nextAt + interval;
  }

  let lastStats = 0;
  function updateStats() {
    const now = performance.now();
    if (now - lastStats < 250 || finished) return;
    lastStats = now;
    const heard = sched.lastAckAt > 0;
    const confirmed = Math.max(sched.ackedBytes, wifiOpen ? wifiBytes : 0);
    rate.push(confirmed);
    const pct = confirmed / Math.max(1, file.size);
    bar.textContent = asciiBar(pct, 18);
    if (wifiOpen) {
      stat.textContent = `${formatBytes(rate.rate)}/s over Wi-Fi · ${formatDuration((file.size - confirmed) / rate.rate)} left`;
    } else if (heard) {
      stat.textContent = `${formatBytes(rate.rate)}/s confirmed · receiver catches ${Math.round(sched.rate * 100)}% of blocks`;
    } else {
      stat.textContent = "Streaming. Point the receiver's camera at the pattern.";
    }
    if (heard && now - sched.lastAckAt > 12000) lSound.set("wait", "listening");
  }

  wantAwake(true);
  requestAnimationFrame(() => {
    setLevel(levelIdx);
    requestAnimationFrame(tick);
  });

  return {
    el,
    dispose() {
      disposed = true;
      ro.disconnect();
      listener.stop();
      link?.close();
      wantAwake(false);
    },
  };
}
