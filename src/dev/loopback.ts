// Dev harness: the sender screen's canvas is fed straight into the real
// decode workers and Receiver, so everything except the camera
// is exercised. Also runs the WebRTC compressed-answer handshake in-page.
import "../style.css";
import { sendView } from "../ui/send";
import { Receiver } from "../core/receiver";
import { FileSink } from "../storage/store";
import { WorkerPool } from "../workers/pool";

const log = (s: string) => {
  document.getElementById("log")!.textContent += s + "\n";
  console.log(s);
};
(window as any).loopback = { done: false, ok: false };
// The preview pane may be hidden, which pauses rAF; timers keep the harness going.
window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 8) as unknown as number;

async function main() {
  const size = Number(new URLSearchParams(location.search).get("size") ?? 1_500_000);
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
  const file = new File([bytes], `loopback-${size}.bin`, { type: "application/octet-stream", lastModified: Date.now() });
  const v = sendView(file, () => {});
  document.getElementById("app")!.append(v.el);
  const canvas = v.el.querySelector("canvas.code") as HTMLCanvasElement;
  const sink = new FileSink();
  const t0 = performance.now();
  const rx = new Receiver(sink, {
    async onComplete() {
      const out = new Uint8Array(await (await sink.file()).arrayBuffer());
      const ok = out.length === bytes.length && out.every((b, i) => b === bytes[i]);
      const secs = (performance.now() - t0) / 1000;
      log(`complete in ${secs.toFixed(1)} s, ${(size / 1024 / secs).toFixed(0)} KB/s, match=${ok}, frames ${rx.usefulFrames}/${rx.totalFrames}`);
      Object.assign((window as any).loopback, { done: true, ok, secs });
    },
  });
  (window as any).rx = rx;
  const pool = new WorkerPool<object, { blocks: Uint8Array[] }>(
    () => new Worker(new URL("../workers/optical-decode.worker.ts", import.meta.url), { type: "module" }),
    3,
  );
  let last = "";
  const grab = async () => {
    requestAnimationFrame(grab);
    if (!canvas.width || pool.idle === 0) return;
    // Upscale to ~3 px/module, like a camera would see it.
    const scale = 3;
    const bmp = await createImageBitmap(canvas, { resizeWidth: canvas.width * scale, resizeHeight: canvas.height * scale, resizeQuality: "pixelated" });
    const job = pool.tryRun({ bitmap: bmp }, [bmp]);
    if (!job) return bmp.close();
    const r = await job;
    for (const b of r.blocks) rx.onFrame(b);
    const s = `${Math.floor(rx.progress * 100)}%`;
    if (s !== last) {
      last = s;
      (window as any).loopback.progress = rx.progress;
    }
  };
  grab();
}
void main();
