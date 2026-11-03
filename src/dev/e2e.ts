// Dev harness: the real receive screen, with its camera replaced by a 1280×720
// stream in which the sender's canvas is drawn small (like a screen seen from
// across a desk). Exercises the receiver's grab loop, crop tracking and UI.
import "../style.css";
import { sendView } from "../ui/send";
import { receiveView } from "../ui/receive";

window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 8) as unknown as number;
delete (HTMLVideoElement.prototype as any).requestVideoFrameCallback;

const size = Number(new URLSearchParams(location.search).get("size") ?? 1_000_000);
const level = new URLSearchParams(location.search).get("level");
const bytes = new Uint8Array(size);
for (let i = 0; i < size; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
const file = new File([bytes], `e2e-${size}.bin`, { lastModified: Date.now() });

const senderBox = document.createElement("div");
senderBox.style.cssText = "position:fixed;left:0;top:0;width:700px;height:520px;overflow:hidden;opacity:0.01;pointer-events:none";
document.body.append(senderBox);
const s = sendView(file, () => {});
senderBox.append(s.el);
if (level) {
  const sel = s.el.querySelector("select") as HTMLSelectElement;
  sel.value = level;
  sel.dispatchEvent(new Event("change"));
}
const qr = s.el.querySelector("canvas.qr") as HTMLCanvasElement;

const cam = document.createElement("canvas");
cam.width = 1280;
cam.height = 720;
const cx = cam.getContext("2d")!;
setInterval(() => {
  cx.fillStyle = "#555";
  cx.fillRect(0, 0, 1280, 720);
  if (!qr.width) return;
  const scale = Math.min(560 / qr.width, 560 / qr.height);
  cx.imageSmoothingEnabled = true; // blurry like a camera
  cx.drawImage(qr, 420, 80, qr.width * scale, qr.height * scale);
}, 1000 / 30);
const stream = cam.captureStream(30);
navigator.mediaDevices.getUserMedia = async () => stream;

const r = receiveView(() => {});
document.getElementById("app")!.append(r.el);
const t0 = performance.now();
(window as any).e2e = () => ({
  secs: (performance.now() - t0) / 1000,
  pct: r.el.querySelector(".pct")?.textContent,
  diag: r.el.querySelector(".diag")?.textContent,
  sub: r.el.querySelector(".sheet .muted")?.textContent,
  done: !r.el.querySelector(".result")?.hasAttribute("hidden"),
  sender: s.el.querySelector(".row")?.textContent,
});
