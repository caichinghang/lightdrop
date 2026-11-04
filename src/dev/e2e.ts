// Dev harness: the real receive screen, with its camera replaced by a 1280×720
// stream in which the sender's canvas is drawn small (like a screen seen from
// across a desk). Exercises the receiver's grab loop, crop tracking and UI.
import "../style.css";
import { sendView } from "../ui/send";
import { receiveView } from "../ui/receive";

window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 8) as unknown as number;
delete (HTMLVideoElement.prototype as any).requestVideoFrameCallback;

const size = Number(new URLSearchParams(location.search).get("size") ?? 1_000_000);
// ?grid=<index into GRIDS>&fps=<index into FPS> (desktop sender settings)
const q = new URLSearchParams(location.search);
if (q.get("grid")) localStorage.setItem("lightdrop.grid.desk", q.get("grid")!);
if (q.get("fps")) localStorage.setItem("lightdrop.fps.desk", q.get("fps")!);
const bytes = new Uint8Array(size);
for (let i = 0; i < size; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
const file = new File([bytes], `e2e-${size}.bin`, { lastModified: Date.now() });

const senderBox = document.createElement("div");
senderBox.style.cssText = "position:fixed;left:0;top:0;width:1400px;height:820px;overflow:hidden;opacity:0.01;pointer-events:none";
document.body.append(senderBox);
const s = sendView(file, () => {});
s.el.style.height = "820px"; // the preview pane may be hidden, where 100dvh is 0
senderBox.append(s.el);
const qr = s.el.querySelector("canvas.code") as HTMLCanvasElement;

const cam = document.createElement("canvas");
cam.width = 1280;
cam.height = 720;
const cx = cam.getContext("2d")!;
setInterval(() => {
  cx.fillStyle = "#555";
  cx.fillRect(0, 0, 1280, 720);
  if (!qr.width) return;
  // Fill most of the frame, slightly rotated and soft, like a hand-held phone.
  const scale = Math.min(1100 / qr.width, 640 / qr.height);
  cx.save();
  cx.translate(640, 360);
  cx.rotate(0.03);
  cx.imageSmoothingEnabled = true;
  cx.filter = "blur(0.6px)";
  cx.drawImage(qr, (-qr.width * scale) / 2, (-qr.height * scale) / 2, qr.width * scale, qr.height * scale);
  cx.restore();
}, 1000 / 30);
const stream = cam.captureStream(30);
navigator.mediaDevices.getUserMedia = async () => stream;

const r = receiveView(() => {});
document.getElementById("app")!.append(r.el);
const t0 = performance.now();
(window as any).e2e = () => ({
  secs: (performance.now() - t0) / 1000,
  bar: r.el.querySelector(".bar")?.textContent,
  diag: r.el.querySelector(".diag")?.textContent,
  sub: r.el.querySelector(".file-meta span")?.textContent,
  done: !r.el.querySelector(".result")?.hasAttribute("hidden"),
  sender: s.el.querySelector(".strip")?.textContent,
  hint: r.el.querySelector(".aim-hint")?.textContent,
});
