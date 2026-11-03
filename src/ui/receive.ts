import { Receiver, type TransferInfo } from "../core/receiver";
import { SoundTalker, audioContext } from "../audio/io";
import { MsgType, ackPacket, fragmentPackets } from "../audio/messages";
import { ReceiverLink } from "../net/rtc";
import { WireReceiver } from "../net/wire";
import { FileSink } from "../storage/store";
import { WorkerPool } from "../workers/pool";
import { backButton } from "./send";
import { RateMeter, chip, formatBytes, formatDuration, h, icons, svg, wantAwake } from "./util";

interface DecodeRes {
  id: number;
  codes: Uint8Array[];
  boxes: number[][][];
  w: number;
  h: number;
  error?: string;
}

const ACK_EVERY_MS = 2500;

export function receiveView(onBack: () => void): { el: HTMLElement; dispose: () => void } {
  // Called from the tap that opened this view: unlocks audio on iOS.
  audioContext();
  let disposed = false;
  let stream: MediaStream | undefined;
  let wire: WireReceiver | undefined;
  let rtc: ReceiverLink | undefined;
  let answerPackets: Uint8Array[] | undefined;
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
  const reticle = h("div", { class: "reticle" }, h("i"), h("i"), h("i"), h("i"));
  const hintEl = h("div", { class: "aim-hint" }, "Point the camera at the codes on the other screen");
  const cam = h("div", { class: "camera-wrap" }, video, overlay, reticle, hintEl);

  const ring = h("div", { class: "ring" }, h("span", { class: "pct" }, "0%"));
  const pctEl = ring.firstElementChild as HTMLElement;
  const nameEl = h("strong", { class: "ellipsis" }, "Looking for a stream…");
  const subEl = h("span", { class: "muted" }, "");
  const cLight = chip(icons.light, "Light");
  const cSound = chip(icons.sound, "Sound");
  const cWifi = chip(icons.wifi, "Wi-Fi");
  const soundToggle = h("button", { class: "link-btn" }, "Mute sound link");
  let soundOn = true;
  soundToggle.onclick = () => {
    soundOn = !soundOn;
    soundToggle.textContent = soundOn ? "Mute sound link" : "Unmute sound link";
    cSound.set(soundOn ? "wait" : "off", soundOn ? "Talking" : "Muted");
  };
  const sheet = h(
    "aside",
    { class: "sheet" },
    h("div", { class: "sheet-main" }, ring, h("div", { class: "file-meta" }, nameEl, subEl)),
    h("div", { class: "chips" }, cLight.el, cSound.el, cWifi.el),
    soundToggle,
  );
  const result = h("div", { class: "result", hidden: true });
  const el = h("div", { class: "page receive" }, h("header", { class: "bar overlay" }, backButton(onBack)), cam, sheet, result);

  // ---- transfer state ----
  const rx = new Receiver(sink, {
    onLock(info) {
      nameEl.textContent = "Receiving…";
      subEl.textContent = formatBytes(info.totalSize);
      hintEl.hidden = true;
      cLight.set("on", "Reading");
    },
    onMeta(info) {
      nameEl.textContent = info.name;
    },
    onOffer(offerId, deflated) {
      if (rtc) return;
      rtc = new ReceiverLink();
      rtc.onChannel = (dc) => {
        dc.onopen = () => onWifi(dc);
        if (dc.readyState === "open") onWifi(dc);
      };
      rtc.pc.onconnectionstatechange = () => {
        const s = rtc?.pc.connectionState;
        if (s === "connecting") cWifi.set("wait", "Connecting…");
        if (s === "failed") {
          cWifi.set("off", "Not on same Wi-Fi");
          answerPackets = undefined;
        }
      };
      rtc
        .answer(offerId, deflated)
        .then((bytes) => {
          answerPackets = fragmentPackets(MsgType.Answer, offerId & 0xff, bytes);
          cWifi.set("wait", "Offering…");
        })
        .catch(() => cWifi.set("off", "Wi-Fi unavailable"));
    },
    onComplete(info) {
      void showResult(info);
    },
  });

  function onWifi(dc: RTCDataChannel) {
    if (wire) return;
    wifiOpen = true;
    cWifi.set("on", "Wi-Fi connected");
    cSound.set("off", "Not needed");
    wire = new WireReceiver(dc, rx, () => {});
    const progressTimer = setInterval(() => {
      if (dc.readyState !== "open") return clearInterval(progressTimer);
      dc.send(JSON.stringify({ t: "progress", bytes: rx.bytesDone, ack: rx.ack(), complete: rx.completed }));
      if (rx.completed) clearInterval(progressTimer);
    }, 500);
    dc.onclose = () => {
      wifiOpen = false;
      wire?.stop();
      wire = undefined;
      cWifi.set("off", "Wi-Fi lost");
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
        if (answerPackets) packets.push(...answerPackets);
        cSound.set("on", "Talking");
        await talker.say(packets);
      }
      await new Promise((r) => setTimeout(r, Math.max(400, ACK_EVERY_MS - (performance.now() - started))));
    }
  }

  // ---- camera ----
  const decoders = new WorkerPool<object, DecodeRes>(
    () => new Worker(new URL("../workers/qr-decode.worker.ts", import.meta.url), { type: "module" }),
    Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)),
  );

  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
      });
    } catch (err) {
      hintEl.textContent = "Camera access is needed to receive. Allow it in your browser settings and try again.";
      hintEl.classList.add("error");
      return;
    }
    if (disposed) return stream.getTracks().forEach((t) => t.stop());
    video.srcObject = stream;
    await video.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    // Continuous focus where the platform lets us ask for it.
    const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { focusMode?: string[] };
    if (caps.focusMode?.includes("continuous")) {
      await track!.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => {});
    }
    grabLoop();
  }

  function grabLoop() {
    const onFrame = () => {
      if (disposed) return;
      schedule();
      if (rx.completed || video.readyState < 2 || decoders.idle === 0) return;
      const p = createImageBitmap(video);
      void p.then((bitmap) => {
        const job = decoders.tryRun({ bitmap, maxSymbols: 6 }, [bitmap]);
        if (!job) return bitmap.close();
        void job.then(onDecoded);
      });
    };
    const schedule = () => {
      if ("requestVideoFrameCallback" in video) video.requestVideoFrameCallback(onFrame);
      else requestAnimationFrame(onFrame);
    };
    schedule();
  }

  function onDecoded(r: DecodeRes) {
    if (disposed) return;
    for (const c of r.codes) rx.onFrame(c);
    if (r.codes.length) lastDecodeAt = performance.now();
    drawBoxes(r);
  }

  function drawBoxes(r: DecodeRes) {
    const rect = video.getBoundingClientRect();
    if (overlay.width !== rect.width || overlay.height !== rect.height) {
      overlay.width = rect.width;
      overlay.height = rect.height;
    }
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (!r.w) return;
    // object-fit: cover mapping
    const s = Math.max(rect.width / r.w, rect.height / r.h);
    const dx = (rect.width - r.w * s) / 2;
    const dy = (rect.height - r.h * s) / 2;
    octx.strokeStyle = "rgba(34, 211, 238, 0.9)";
    octx.lineWidth = 3;
    for (const box of r.boxes) {
      octx.beginPath();
      box.forEach(([x, y], i) => (i ? octx.lineTo(x! * s + dx, y! * s + dy) : octx.moveTo(x! * s + dx, y! * s + dy)));
      octx.closePath();
      octx.stroke();
    }
  }

  // ---- stats ----
  const statsTimer = setInterval(() => {
    if (!rx.info || rx.completed) return;
    meter.push(rx.bytesDone);
    const pct = rx.progress;
    pctEl.textContent = `${Math.floor(pct * 100)}%`;
    ring.style.setProperty("--p", String(pct));
    const r = meter.rate;
    const left = (rx.info.totalSize - rx.bytesDone) / r;
    subEl.textContent = `${formatBytes(rx.bytesDone)} of ${formatBytes(rx.info.totalSize)}${r > 0 ? ` · ${formatBytes(r)}/s · ${formatDuration(left)} left` : ""}`;
    const seeing = performance.now() - lastDecodeAt < 1000;
    reticle.classList.toggle("locked", seeing);
    if (!wifiOpen) cLight.set(seeing ? "on" : "wait", seeing ? "Reading" : "Searching");
    else cLight.set("off", "Paused");
  }, 250);

  async function showResult(info: TransferInfo) {
    reticle.classList.add("locked");
    pctEl.textContent = "100%";
    ring.style.setProperty("--p", "1");
    stream?.getTracks().forEach((t) => t.stop());
    wantAwake(false);
    const file = await sink.file();
    const url = URL.createObjectURL(file);
    const save = h("a", { class: "btn primary", href: url, download: info.name }, "Save file");
    const share = h("button", { class: "btn" }, "Share…");
    share.onclick = () => navigator.share?.({ files: [file] }).catch(() => {});
    const canShare = !!navigator.canShare?.({ files: [file] });
    const preview = file.type.startsWith("image/")
      ? h("img", { class: "preview", src: url, alt: "" })
      : file.type.startsWith("video/")
        ? h("video", { class: "preview", src: url, controls: true, playsinline: true })
        : svg(icons.file, "icon xl");
    const again = h("button", { class: "btn ghost" }, "Receive another");
    again.onclick = onBack;
    result.replaceChildren(
      h(
        "div",
        { class: "result-card" },
        svg(icons.check, "icon xl ok"),
        preview,
        h("strong", { class: "ellipsis" }, info.name),
        h("span", { class: "muted" }, `${formatBytes(info.totalSize)} · verified`),
        h("div", { class: "actions" }, save, canShare ? share : null, again),
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
