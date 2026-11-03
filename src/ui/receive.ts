import { Receiver, type TransferInfo } from "../core/receiver";
import { SoundTalker, audioContext } from "../audio/io";
import { MsgType, ackPacket, fragmentPackets } from "../audio/messages";
import { ReceiverLink } from "../net/rtc";
import { WireReceiver } from "../net/wire";
import { FileSink } from "../storage/store";
import { WorkerPool } from "../workers/pool";
import { asciiBar, sprite } from "./pixels";
import { RateMeter, formatBytes, formatDuration, h, isTouch, setWifiEnabled, statusLine, wantAwake, wifiEnabled, win } from "./util";

interface DecodeRes {
  id: number;
  blocks: Uint8Array[];
  total: number;
  quad: [number, number][] | null;
  grid?: string;
  w?: number;
  h?: number;
  ms: number;
  error?: string;
}

const ACK_EVERY_MS = 2500;
/** Give up offering Wi-Fi after this long (networks that block peers never connect). */
const WIFI_GIVE_UP_MS = 30000;
/** Scans per second: full speed with the pattern in view, slow while searching.
 *  This, plus two workers on phones, keeps the phone from heating up. */
const SCAN_FPS_LOCKED = 30;
const SCAN_FPS_SEARCHING = 6;

export function receiveView(onBack: () => void): { el: HTMLElement; dispose: () => void } {
  // Called from the tap that opened this view: unlocks audio on iOS.
  audioContext();
  let disposed = false;
  let stream: MediaStream | undefined;
  let wire: WireReceiver | undefined;
  let rtc: ReceiverLink | undefined;
  let answerPackets: Uint8Array[] | undefined;
  let answerSince = 0;
  let useWifi = wifiEnabled();
  let wifiOpen = false;
  let lastDecodeAt = 0;
  const talker = new SoundTalker();
  const sink = new FileSink();
  const meter = new RateMeter(4000);

  // ---- view ----
  const video = h("video", { class: "camera", playsinline: true, muted: true, autoplay: true }) as HTMLVideoElement;
  video.muted = true;
  const overlay = h("canvas", { class: "camera-overlay" }) as HTMLCanvasElement;
  const octx = overlay.getContext("2d")!;
  // The camera is shown as our own 1-bit dithered rendering, not the colour
  // video (CSS filters on <video> aren't honoured everywhere). The whole frame
  // is decoded, so there is no aiming box: the pattern can be anywhere.
  const preview = h("canvas", { class: "camera-preview" }) as HTMLCanvasElement;
  const hintEl = h("div", { class: "aim-hint" }, "POINT THE CAMERA AT THE PATTERN. ANYWHERE IN VIEW WORKS.");
  const closeBtn = h("button", { class: "btn cam-close" }, "< BACK");
  closeBtn.onclick = onBack;
  const cam = h("div", { class: "camera-wrap" }, video, preview, overlay, closeBtn, hintEl);

  const nameEl = h("strong", { class: "ellipsis" }, "SEARCHING...");
  const subEl = h("span", {}, "");
  const bar = h("pre", { class: "bar" }, asciiBar(0, 18));
  const lLight = statusLine("LIGHT");
  const lSound = statusLine("SOUND");
  const lWifi = statusLine("WI-FI");
  lLight.el.classList.add("compact");
  lSound.el.classList.add("compact");
  lWifi.el.classList.add("compact");
  lLight.set("wait", "searching");
  lSound.set("wait", "ready");
  const diag = h("div", { class: "diag" }, "starting camera...");

  let soundOn = true;
  const soundBtn = h("button", { class: "linkish" }, "[MUTE SOUND]");
  soundBtn.onclick = () => {
    soundOn = !soundOn;
    soundBtn.textContent = soundOn ? "[MUTE SOUND]" : "[UNMUTE SOUND]";
    lSound.set(soundOn ? "wait" : "off", soundOn ? "ready" : "muted");
  };
  const wifiBtn = h("button", { class: "linkish" });
  const syncWifi = () => {
    wifiBtn.textContent = useWifi ? "[WI-FI OFF]" : "[WI-FI ON]";
    if (!useWifi) lWifi.set("off", "off");
    else if (!rtc) lWifi.set("wait", "waiting");
  };
  wifiBtn.onclick = () => {
    useWifi = !useWifi;
    setWifiEnabled(useWifi);
    if (!useWifi) {
      answerPackets = undefined;
      if (!wifiOpen) {
        rtc?.close();
        rtc = undefined;
      }
    }
    syncWifi();
  };
  syncWifi();

  const sheet = win(
    "RECEIVING",
    { cls: "win-sheet" },
    h("div", { class: "file-row" }, sprite("file", 3), h("div", { class: "file-meta" }, nameEl, subEl)),
    bar,
    h("div", { class: "lines row" }, lLight.el, lSound.el, lWifi.el),
    diag,
    h("div", { class: "row-links" }, soundBtn, wifiBtn),
  );
  const result = h("div", { class: "result", hidden: true });
  const el = h("div", { class: "receive-layout" }, cam, sheet, result);

  // ---- transfer state ----
  const rx = new Receiver(sink, {
    onLock(info) {
      nameEl.textContent = "RECEIVING...";
      subEl.textContent = formatBytes(info.totalSize);
      hintEl.hidden = true;
      lLight.set("on", "reading");
    },
    onMeta(info) {
      nameEl.textContent = info.name;
    },
    onOffer(offerId, deflated) {
      if (rtc || !useWifi) return;
      rtc = new ReceiverLink();
      rtc.onChannel = (dc) => {
        dc.onopen = () => onWifi(dc);
        if (dc.readyState === "open") onWifi(dc);
      };
      rtc.pc.onconnectionstatechange = () => {
        const s = rtc?.pc.connectionState;
        if (s === "connecting") lWifi.set("wait", "connecting");
        if (s === "failed") {
          lWifi.set("off", "not same network");
          answerPackets = undefined;
        }
      };
      rtc
        .answer(offerId, deflated)
        .then((bytes) => {
          if (!useWifi) return;
          answerPackets = fragmentPackets(MsgType.Answer, offerId & 0xff, bytes);
          answerSince = performance.now();
          lWifi.set("wait", "offering");
        })
        .catch(() => lWifi.set("off", "unavailable"));
    },
    onComplete(info) {
      void showResult(info);
    },
  });

  function onWifi(dc: RTCDataChannel) {
    if (wire) return;
    wifiOpen = true;
    lWifi.set("on", "connected");
    lSound.set("off", "not needed");
    wire = new WireReceiver(dc, rx, () => {});
    const timer = setInterval(() => {
      if (dc.readyState !== "open") return clearInterval(timer);
      dc.send(JSON.stringify({ t: "progress", bytes: rx.bytesDone, ack: rx.ack(), complete: rx.completed }));
      if (rx.completed) clearInterval(timer);
    }, 500);
    dc.onclose = () => {
      wifiOpen = false;
      wire?.stop();
      wire = undefined;
      lWifi.set("off", "lost");
    };
  }

  // ---- sound back-channel ----
  let finalAcks = 0;
  async function talkLoop() {
    while (!disposed) {
      const started = performance.now();
      const ack = rx.ack();
      if (soundOn && !wifiOpen && rx.info && ack && (!rx.completed || finalAcks < 3)) {
        if (rx.completed) finalAcks++;
        const packets = [ackPacket(rx.info.fileId, ack)];
        if (answerPackets && performance.now() - answerSince > WIFI_GIVE_UP_MS) {
          // Never connected: this network keeps devices apart. Stop spending sound on it.
          answerPackets = undefined;
          lWifi.set("off", "not same network");
        }
        if (answerPackets) packets.push(...answerPackets);
        lSound.set("on", "talking");
        await talker.say(packets);
      }
      await new Promise((r) => setTimeout(r, Math.max(400, ACK_EVERY_MS - (performance.now() - started))));
    }
  }

  // ---- camera ----
  const decoders = new WorkerPool<object, DecodeRes>(
    () => new Worker(new URL("../workers/optical-decode.worker.ts", import.meta.url), { type: "module" }),
    isTouch() ? 2 : 3,
  );
  let camInfo = "";
  let scans = 0;
  let blocksSeen = 0;
  let blocksTotal = 0;
  let decodeMs = 0;
  let gridSeen = "";
  let grabError = "";

  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      });
    } catch {
      hintEl.textContent = "CAMERA ACCESS IS NEEDED. ALLOW IT IN YOUR BROWSER SETTINGS AND TRY AGAIN.";
      hintEl.classList.add("error");
      return;
    }
    if (disposed) return stream.getTracks().forEach((t) => t.stop());
    video.srcObject = stream;
    await video.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    const st = track?.getSettings();
    camInfo = st ? `${st.width}x${st.height}@${Math.round(st.frameRate ?? 0)}` : "";
    const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { focusMode?: string[] };
    if (caps.focusMode?.includes("continuous")) {
      await track!.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => {});
    }
    grabLoop();
    previewLoop();
  }

  // ---- 1-bit preview ----
  const pctx = preview.getContext("2d", { willReadFrequently: true })!;
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
  function previewLoop() {
    let last = 0;
    const draw = (now: number) => {
      if (disposed || rx.completed) return;
      requestAnimationFrame(draw);
      if (now - last < 66 || video.readyState < 2) return; // ~15 fps is plenty for aiming
      last = now;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const cw = cam.clientWidth;
      const ch = cam.clientHeight;
      if (!vw || !cw) return;
      // Chunky pixels: one preview pixel per 2 CSS pixels.
      const pw = Math.max(1, Math.round(cw / 2));
      const ph = Math.max(1, Math.round(ch / 2));
      if (preview.width !== pw || preview.height !== ph) {
        preview.width = pw;
        preview.height = ph;
      }
      // object-fit: cover, the same mapping the quad overlay uses
      const s = Math.max(cw / vw, ch / vh);
      const sw = cw / s;
      const sh = ch / s;
      pctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, pw, ph);
      const img = pctx.getImageData(0, 0, pw, ph);
      const d = img.data;
      let lo = 255;
      let hi = 0;
      for (let i = 0; i < d.length; i += 16) {
        const g = (d[i]! + 2 * d[i + 1]! + d[i + 2]!) >> 2;
        if (g < lo) lo = g;
        if (g > hi) hi = g;
      }
      const span = Math.max(24, hi - lo);
      for (let y = 0, i = 0; y < ph; y++) {
        for (let x = 0; x < pw; x++, i += 4) {
          const g = ((d[i]! + 2 * d[i + 1]! + d[i + 2]!) >> 2) - lo;
          const v = g / span > BAYER[((y & 3) << 2) | (x & 3)]! ? 255 : 0;
          d[i] = d[i + 1] = d[i + 2] = v;
          d[i + 3] = 255;
        }
      }
      pctx.putImageData(img, 0, 0);
    };
    requestAnimationFrame(draw);
  }

  // Frames go to the workers as ImageBitmaps when the browser can make them
  // from a <video>; otherwise as raw RGBA read back through a canvas.
  let bitmapOk = typeof createImageBitmap === "function";
  const grabCanvas = document.createElement("canvas");
  const grabCtx = grabCanvas.getContext("2d", { willReadFrequently: true })!;

  async function grabFrame(): Promise<{ msg: object; transfer: Transferable[] } | null> {
    if (bitmapOk) {
      try {
        const bitmap = await createImageBitmap(video);
        return { msg: { bitmap }, transfer: [bitmap] };
      } catch {
        bitmapOk = false;
      }
    }
    const w = video.videoWidth;
    const hh = video.videoHeight;
    if (!w || !hh) return null;
    if (grabCanvas.width !== w || grabCanvas.height !== hh) {
      grabCanvas.width = w;
      grabCanvas.height = hh;
    }
    grabCtx.drawImage(video, 0, 0);
    const buf = grabCtx.getImageData(0, 0, w, hh).data.buffer;
    return { msg: { buf, w, h: hh }, transfer: [buf] };
  }

  function grabLoop() {
    let lastGrab = 0;
    let grabbing = false;
    const onFrame = () => {
      if (disposed) return;
      schedule();
      if (rx.completed || video.readyState < 2 || grabbing || decoders.idle === 0) return;
      const now = performance.now();
      const locked = now - lastDecodeAt < 1500;
      if (now - lastGrab < 1000 / (locked ? SCAN_FPS_LOCKED : SCAN_FPS_SEARCHING)) return;
      lastGrab = now;
      grabbing = true;
      grabFrame()
        .then((f) => {
          if (!f) return;
          const job = decoders.tryRun(f.msg, f.transfer);
          if (!job) return (f.msg as { bitmap?: ImageBitmap }).bitmap?.close();
          scans++;
          void job.then(onDecoded);
        })
        .catch((e) => (grabError = String(e)))
        .finally(() => (grabbing = false));
    };
    const schedule = () => {
      if ("requestVideoFrameCallback" in video) video.requestVideoFrameCallback(onFrame);
      else requestAnimationFrame(onFrame);
    };
    schedule();
  }

  function onDecoded(r: DecodeRes) {
    if (disposed) return;
    if (r.error) grabError = r.error;
    decodeMs = decodeMs ? decodeMs * 0.8 + r.ms * 0.2 : r.ms;
    blocksSeen += r.blocks.length;
    blocksTotal += r.total;
    if (r.grid) gridSeen = r.grid;
    for (const b of r.blocks) rx.onFrame(b);
    if (r.blocks.length) lastDecodeAt = performance.now();
    drawQuad(r);
  }

  function drawQuad(r: DecodeRes) {
    const rect = cam.getBoundingClientRect();
    if (overlay.width !== Math.round(rect.width) || overlay.height !== Math.round(rect.height)) {
      overlay.width = Math.round(rect.width);
      overlay.height = Math.round(rect.height);
    }
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (!r.quad || !r.w || !r.h) return;
    const s = Math.max(rect.width / r.w, rect.height / r.h); // object-fit: cover
    const dx = (rect.width - r.w * s) / 2;
    const dy = (rect.height - r.h * s) / 2;
    // Marching-ants outline: black under white dashes, visible on any dither.
    octx.beginPath();
    r.quad.forEach(([x, y], i) => (i ? octx.lineTo(x * s + dx, y * s + dy) : octx.moveTo(x * s + dx, y * s + dy)));
    octx.closePath();
    octx.setLineDash([]);
    octx.lineWidth = 6;
    octx.strokeStyle = "#000";
    octx.stroke();
    octx.setLineDash(r.blocks.length ? [10, 6] : [3, 9]);
    octx.lineWidth = 3;
    octx.strokeStyle = "#fff";
    octx.stroke();
  }

  // ---- stats ----
  let lastDiagAt = performance.now();
  let lastScans = 0;
  let lastBlocks = 0;
  let lastTotal = 0;
  const statsTimer = setInterval(() => {
    const t = performance.now();
    if (t - lastDiagAt >= 1000) {
      const dt = (t - lastDiagAt) / 1000;
      const scanRate = (scans - lastScans) / dt;
      const okDelta = blocksSeen - lastBlocks;
      const totDelta = blocksTotal - lastTotal;
      lastDiagAt = t;
      lastScans = scans;
      lastBlocks = blocksSeen;
      lastTotal = blocksTotal;
      diag.textContent = [
        camInfo && `cam ${camInfo}`,
        `${scanRate.toFixed(0)} scan/s ${decodeMs.toFixed(0)}ms`,
        gridSeen && `grid ${gridSeen}`,
        `${(okDelta / dt).toFixed(0)} blk/s${totDelta ? ` ${Math.round((okDelta / totDelta) * 100)}% ok` : ""}`,
        bitmapOk ? "" : "readback",
        grabError && `err: ${grabError.slice(0, 60)}`,
      ]
        .filter(Boolean)
        .join(" | ");
    }
    if (!rx.info && scans > 60 && blocksSeen === 0 && !hintEl.classList.contains("error")) {
      hintEl.textContent = "NOTHING READ YET. MOVE CLOSER SO THE PATTERN FILLS THE BRACKETS, HOLD STEADY, OR LOWER THE DENSITY ON THE SENDER.";
    }
    if (!rx.info || rx.completed) return;
    const pct = rx.smoothProgress;
    const doneBytes = pct * rx.info.totalSize;
    meter.push(doneBytes);
    bar.textContent = asciiBar(pct, 18);
    const r = meter.rate;
    const left = (rx.info.totalSize - doneBytes) / r;
    subEl.textContent = `${formatBytes(doneBytes)} / ${formatBytes(rx.info.totalSize)}${r > 0 ? ` · ${formatBytes(r)}/s · ${formatDuration(left)} left` : ""}`;
    const seeing = performance.now() - lastDecodeAt < 1000;
    if (!wifiOpen) lLight.set(seeing ? "on" : "wait", seeing ? "reading" : "searching");
    else lLight.set("off", "paused");
  }, 250);

  async function showResult(info: TransferInfo) {
    bar.textContent = asciiBar(1, 18);
    stream?.getTracks().forEach((t) => t.stop());
    wantAwake(false);
    const file = await sink.file();
    const url = URL.createObjectURL(file);
    const save = h("a", { class: "btn primary", href: url, download: info.name }, "SAVE FILE");
    const share = h("button", { class: "btn" }, "SHARE...");
    share.onclick = () => navigator.share?.({ files: [file] }).catch(() => {});
    const canShare = !!navigator.canShare?.({ files: [file] });
    const preview = file.type.startsWith("image/")
      ? h("img", { class: "preview", src: url, alt: "" })
      : file.type.startsWith("video/")
        ? h("video", { class: "preview", src: url, controls: true, playsinline: true })
        : sprite("floppy", 6);
    const again = h("button", { class: "btn" }, "RECEIVE ANOTHER");
    again.onclick = onBack;
    result.replaceChildren(
      win(
        "TRANSFER COMPLETE",
        { onClose: onBack, cls: "win-result" },
        h("div", { class: "result-art" }, sprite("face", 5), preview),
        h("strong", { class: "ellipsis center" }, info.name),
        h("span", { class: "center" }, `${formatBytes(info.totalSize)} · verified`),
        h("div", { class: "col-btns" }, save, canShare ? share : null, again),
      ),
    );
    result.hidden = false;
    sheet.hidden = true;
  }

  wantAwake(true);
  void startCamera();
  void talkLoop();

  return {
    el,
    dispose() {
      disposed = true;
      clearInterval(statsTimer);
      stream?.getTracks().forEach((t) => t.stop());
      decoders.terminate();
      wire?.stop();
      rtc?.close();
      wantAwake(false);
    },
  };
}
