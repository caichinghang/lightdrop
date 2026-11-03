import { crc32 } from "../core/crc";
import { LADDER, frameLenFor, type Level } from "../core/density";
import { DATA_HEADER, encodeData, encodeMeta, encodeSignal, signalChunkCapacity } from "../core/frame";
import { Scheduler } from "../core/scheduler";
import { SoundListener } from "../audio/io";
import { MsgType, parseAck, parseHeader, Reassembler } from "../audio/messages";
import { SenderLink, decodeAnswer } from "../net/rtc";
import { WireSender } from "../net/wire";
import { WorkerPool } from "../workers/pool";
import { RateMeter, chip, formatBytes, formatDuration, h, icons, isTouch, svg, wantAwake, wifiEnabled, wifiToggle } from "./util";

const QUIET = 3;

interface EncodeRes {
  id: number;
  size: number;
  modules: Uint8Array[];
  error?: string;
}

interface Screen {
  level: Level;
  res?: EncodeRes;
}

export function fileIdFor(f: File): number {
  return crc32(new TextEncoder().encode(`${f.name}|${f.size}|${f.lastModified}`)) || 1;
}

export function pickFileView(onFile: (f: File) => void, onBack: () => void): HTMLElement {
  const input = h("input", { type: "file", hidden: true }) as HTMLInputElement;
  input.onchange = () => input.files?.[0] && onFile(input.files[0]);
  const zone = h(
    "button",
    { class: "dropzone" },
    svg(icons.file, "icon xl"),
    h("strong", {}, isTouch() ? "Choose a file" : "Drop a file here"),
    h("span", { class: "muted" }, isTouch() ? "Photos, videos, documents — any size" : "or click to browse · any size"),
  );
  zone.onclick = () => input.click();
  const view = h(
    "div",
    { class: "page pick" },
    h("header", { class: "bar" }, backButton(onBack), h("h2", {}, "Send")),
    zone,
    input,
    h(
      "p",
      { class: "hint" },
      "The other device opens this page, taps ",
      h("b", {}, "Receive"),
      " and points its camera here. Nothing needs to be paired or connected.",
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

export function backButton(onBack: () => void): HTMLElement {
  const b = h("button", { class: "icon-btn", "aria-label": "Back" }, svg(icons.close));
  b.onclick = onBack;
  return b;
}

/** The streaming screen. Returns the view and a cleanup function. */
export function sendView(file: File, onBack: () => void): { el: HTMLElement; dispose: () => void } {
  const fileId = fileIdFor(file);
  // Start conservative; with sound ACKs, Auto climbs within seconds.
  let levelIdx = isTouch() ? 2 : 3;
  let auto = true;
  let level = LADDER[levelIdx]!;
  let frameLen = frameLenFor(level.version);
  const sched = new Scheduler(file, fileId, frameLen - DATA_HEADER);
  const encoders = new WorkerPool<object, EncodeRes>(
    () => new Worker(new URL("../workers/qr-encode.worker.ts", import.meta.url), { type: "module" }),
    Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)),
  );
  let disposed = false;
  let frameCounter = 0;
  let lastLevelChange = performance.now();
  let finished = false;
  let wire: WireSender | undefined;
  let wifiBytes = 0;
  let wifiOpen = false;
  const rate = new RateMeter(4000);

  // ---- view ----
  const canvas = h("canvas", { class: "qr" }) as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;
  const stage = h("div", { class: "stage" }, canvas);
  const wifiOverlay = h(
    "div",
    { class: "wifi-overlay", hidden: true },
    svg(icons.wifi, "icon xl"),
    h("strong", {}, "Sending over Wi-Fi"),
    h("span", { class: "muted" }, "You can put the devices down."),
  );
  stage.append(wifiOverlay);
  const doneOverlay = h(
    "div",
    { class: "done-overlay", hidden: true },
    svg(icons.check, "icon xl ok"),
    h("strong", {}, "Delivered"),
    h("span", { class: "muted" }, `${file.name} arrived safely.`),
  );
  stage.append(doneOverlay);

  const cLight = chip(icons.light, "Light");
  const cSound = chip(icons.sound, "Sound");
  const cWifi = chip(icons.wifi, "Wi-Fi");
  cLight.set("on", "Streaming");
  const bar = h("div", { class: "progress" }, h("div", { class: "fill" }));
  const fill = bar.firstElementChild as HTMLElement;
  const stat = h("div", { class: "stat" }, "Waiting for a receiver…");
  const levelLabel = h("span", { class: "muted" });

  const levelSel = h("select", { class: "select" }) as HTMLSelectElement;
  levelSel.append(h("option", { value: "auto" }, "Auto"));
  LADDER.forEach((l, i) => levelSel.append(h("option", { value: String(i) }, `${l.label} — ${l.codes}× V${l.version} @ ${l.fps} fps`)));
  levelSel.onchange = () => {
    auto = levelSel.value === "auto";
    if (!auto) setLevel(Number(levelSel.value));
  };
  const settings = h(
    "details",
    { class: "settings" },
    h("summary", {}, svg(icons.gear), "Stream density"),
    h("label", {}, levelSel),
    h("p", { class: "muted small" }, "Auto speeds up while the receiver keeps up (it reports back by sound), and slows down when it struggles."),
    wifiToggle((on) => (on ? startLink() : stopLink())),
  );

  const fsBtn = h("button", { class: "icon-btn", "aria-label": "Fullscreen" }, svg(icons.expand));
  fsBtn.onclick = () => (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.()).catch?.(() => {});

  const panel = h(
    "aside",
    { class: "panel" },
    h(
      "div",
      { class: "file-row" },
      svg(icons.file),
      h("div", { class: "file-meta" }, h("strong", { class: "ellipsis" }, file.name), h("span", { class: "muted" }, formatBytes(file.size))),
    ),
    bar,
    stat,
    h("div", { class: "chips" }, cLight.el, cSound.el, cWifi.el),
    h("div", { class: "row" }, levelLabel),
    settings,
  );
  const el = h(
    "div",
    { class: "page send" },
    h("header", { class: "bar overlay" }, backButton(onBack), h("span", { class: "spacer" }), fsBtn),
    stage,
    panel,
  );

  function setLevel(i: number) {
    levelIdx = Math.max(0, Math.min(LADDER.length - 1, i));
    level = LADDER[levelIdx]!;
    const fl = frameLenFor(level.version);
    if (fl !== frameLen) {
      frameLen = fl;
      sched.setBlockLen(frameLen - DATA_HEADER);
    }
    queue.length = 0;
    lastLevelChange = performance.now();
    levelLabel.textContent = `${auto ? "Auto · " : ""}${level.label} — ${level.codes}× QR v${level.version} at ${level.fps} fps`;
  }

  // ---- signalling: offer frames (optional Wi-Fi upgrade) + sound back-channel ----
  let link: SenderLink | undefined;
  let signalFrames: { chunks: Uint8Array[] } | undefined;

  function startLink() {
    if (link) return;
    const l = (link = new SenderLink());
    cWifi.set("wait", "Offering…");
    l.offer()
      .then((deflated) => {
        if (link !== l) return;
        const cap = signalChunkCapacity(frameLenFor(15));
        const chunks: Uint8Array[] = [];
        for (let o = 0; o < deflated.length; o += cap) chunks.push(deflated.subarray(o, o + cap));
        signalFrames = { chunks };
      })
      .catch(() => cWifi.set("off", "Wi-Fi unavailable"));
    l.dc.onopen = () => {
      wifiOpen = true;
      cWifi.set("on", "Wi-Fi connected");
      cLight.set("off", "Paused");
      wifiOverlay.hidden = false;
      wire = new WireSender(l.dc, sched, { t: "meta", fileId, size: file.size, name: file.name, mime: file.type }, () => {});
    };
    l.dc.onclose = () => {
      wifiOpen = false;
      if (link === l) cWifi.set("off", "Wi-Fi lost");
      cLight.set("on", "Streaming");
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
      if (l.pc.connectionState === "connecting") cWifi.set("wait", "Connecting…");
      if (l.pc.connectionState === "failed") cWifi.set("off", "Not on same network");
    };
  }

  function stopLink() {
    signalFrames = undefined;
    link?.close();
    link = undefined;
    cWifi.set("off", "Wi-Fi off");
  }

  if (wifiEnabled()) startLink();
  else cWifi.set("off", "Wi-Fi off");

  const reasm = new Reassembler();
  const listener = new SoundListener((pkt) => {
    const { type } = parseHeader(pkt.header);
    if (type === MsgType.Ack) {
      const a = parseAck(pkt.payload);
      if (!a || a.fileIdLow !== (fileId & 0xffff)) return;
      cSound.set("on", "Receiver heard");
      sched.onAck(a.ack);
      onAck();
      return;
    }
    const msg = reasm.push(pkt);
    if (msg?.type === MsgType.Answer) {
      const ans = decodeAnswer(msg.bytes);
      if (ans) {
        if (!link) return;
        cWifi.set("wait", "Connecting…");
        link.accept(ans).catch(() => cWifi.set("off", "Wi-Fi failed"));
      }
    }
  });
  listener
    .start()
    .then(() => cSound.set("wait", "Listening"))
    .catch(() => cSound.set("off", "Mic off — no feedback"));

  function onAck() {
    if (sched.finished) return finish();
    if (!auto) return;
    const since = performance.now() - lastLevelChange;
    if (sched.rate > 0.8 && since > 8000 && levelIdx < LADDER.length - 1) setLevel(levelIdx + 1);
    else if (sched.rate < 0.35 && since > 5000 && levelIdx > 0) setLevel(levelIdx - 1);
  }

  function finish() {
    if (finished) return;
    finished = true;
    cLight.set("off", "Done");
    wifiOverlay.hidden = true;
    doneOverlay.hidden = false;
    fill.style.width = "100%";
    stat.textContent = `Delivered ${formatBytes(file.size)}`;
    wantAwake(false);
  }

  // ---- frame production ----
  const queue: Screen[] = [];
  const QUEUE_DEPTH = 6;
  let producing = false;

  async function nextFrames(n: number): Promise<Uint8Array[]> {
    const out: Uint8Array[] = [];
    while (out.length < n) {
      frameCounter++;
      if (frameCounter % 17 === 0) {
        out.push(encodeMeta(frameLen, fileId, file.size, file.name, file.type));
        continue;
      }
      if (signalFrames && link && !wifiOpen && frameCounter % 9 === 0) {
        const parts = signalFrames.chunks;
        const part = Math.floor(frameCounter / 9) % parts.length;
        out.push(encodeSignal(frameLen, fileId, link.offerId, part, parts.length, parts[part]!));
        continue;
      }
      const batch = await nextBatchCached();
      if (!batch) {
        out.push(encodeMeta(frameLen, fileId, file.size, file.name, file.type));
        continue;
      }
      out.push(encodeData(frameLen, fileId, batch.seg, batch.seq, batch.crc, file.size, batch.payload));
    }
    return out;
  }

  let pending: Awaited<ReturnType<Scheduler["nextBatch"]>> = [];
  async function nextBatchCached() {
    if (!pending.length) pending = await sched.nextBatch();
    return pending.shift();
  }

  async function produce() {
    if (producing) return;
    producing = true;
    try {
      while (!disposed && queue.length < QUEUE_DEPTH && !wifiOpen && !finished) {
        const lvl = level;
        const frames = await nextFrames(lvl.codes);
        if (lvl !== level) continue; // density changed while we were reading
        const buffers = frames.map((f) => f.buffer as ArrayBuffer);
        const screen: Screen = { level: lvl };
        queue.push(screen);
        void encoders.run({ frames: buffers, ecc: "L", version: lvl.version }, buffers).then((r) => (screen.res = r));
      }
    } finally {
      producing = false;
    }
  }

  function draw(res: EncodeRes) {
    const portrait = stage.clientHeight > stage.clientWidth * 1.15;
    const n = res.modules.length;
    const cols = n === 1 ? 1 : n === 2 ? (portrait ? 1 : 2) : 2;
    const rows = Math.ceil(n / cols);
    const cell = res.size + QUIET * 2;
    const w = cols * cell;
    const hgt = rows * cell;
    if (canvas.width !== w || canvas.height !== hgt) {
      canvas.width = w;
      canvas.height = hgt;
    }
    const img = ctx.createImageData(w, hgt);
    const px = new Uint32Array(img.data.buffer);
    px.fill(0xffffffff);
    res.modules.forEach((m, i) => {
      const ox = (i % cols) * cell + QUIET;
      const oy = Math.floor(i / cols) * cell + QUIET;
      for (let y = 0; y < res.size; y++) {
        const row = (oy + y) * w + ox;
        for (let x = 0; x < res.size; x++) if (m[y * res.size + x]) px[row + x] = 0xff000000;
      }
    });
    ctx.putImageData(img, 0, 0);
    // Fit the stage, keeping square modules.
    const scale = Math.min(stage.clientWidth / w, stage.clientHeight / hgt);
    canvas.style.width = `${Math.floor(w * scale)}px`;
    canvas.style.height = `${Math.floor(hgt * scale)}px`;
  }

  let nextAt = 0;
  function tick(now: number) {
    if (disposed) return;
    requestAnimationFrame(tick);
    void produce();
    updateStats();
    if (wifiOpen || finished || now < nextAt) return;
    const head = queue[0];
    if (!head) return;
    // Only show a screen once it's encoded; never block the render loop.
    const res = head.res;
    if (!res) return;
    queue.shift();
    if (!res.error && head.level === level) draw(res);
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
    fill.style.width = `${(pct * 100).toFixed(1)}%`;
    if (wifiOpen) {
      stat.textContent = `${Math.round(pct * 100)}% · ${formatBytes(rate.rate)}/s over Wi-Fi · ${formatDuration((file.size - confirmed) / rate.rate)} left`;
    } else if (heard) {
      const catchPct = Math.round(sched.rate * 100);
      stat.textContent = `${Math.round(pct * 100)}% confirmed · ${formatBytes(rate.rate)}/s · receiver catches ${catchPct}% of codes`;
    } else {
      stat.textContent = `Streaming ${formatBytes(file.size)} — point the receiver's camera at the codes`;
    }
    if (heard && now - sched.lastAckAt > 12000) cSound.set("wait", "Listening");
  }

  setLevel(levelIdx);
  wantAwake(true);
  requestAnimationFrame(tick);

  return {
    el,
    dispose() {
      disposed = true;
      encoders.terminate();
      listener.stop();
      link?.close();
      wantAwake(false);
    },
  };
}
