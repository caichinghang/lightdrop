import "@fontsource/vt323";
import "@fontsource/silkscreen";
import "./style.css";
import { pickFileView, sendView } from "./ui/send";
import { receiveView } from "./ui/receive";
import { deleteSaved, doneFraction, listSaved, opfs, type SavedTransfer } from "./storage/store";
import { asciiBar, beam, sprite } from "./ui/pixels";
import { formatBytes, h, win } from "./ui/util";

const app = document.getElementById("app")!;
let dispose: (() => void) | undefined;

function menubar(): HTMLElement {
  const clock = h("span", { class: "mb-clock" });
  const tick = () => (clock.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  tick();
  setInterval(tick, 15000);
  const home = h("button", { class: "mb-brand" }, "◆ LIGHTDROP");
  home.onclick = () => (location.hash = "");
  return h("nav", { class: "menubar" }, home, h("span", { class: "mb-item" }, "FILE"), h("span", { class: "mb-item" }, "HELP"), h("span", { class: "spacer" }), clock);
}
const bar = menubar();

function show(el: HTMLElement, cleanup?: () => void, withBar = true) {
  dispose?.();
  dispose = cleanup;
  app.replaceChildren(...(withBar ? [bar, el] : [el]));
}

function home() {
  const b = beam(window.innerWidth < 520 ? 8 : 16);
  const hero = h("div", { class: "hero" }, sprite("computer", window.innerWidth < 520 ? 4 : 5), b.el, sprite("phone", window.innerWidth < 520 ? 4 : 5));

  const sendBtn = h("button", { class: "big-btn" }, sprite("floppy", 4), h("span", {}, h("strong", {}, "SEND"), h("small", {}, "show a file as light")));
  const recvBtn = h("button", { class: "big-btn" }, sprite("camera", 4), h("span", {}, h("strong", {}, "RECEIVE"), h("small", {}, "point your camera")));
  sendBtn.onclick = () => (location.hash = "#send");
  recvBtn.onclick = () => (location.hash = "#receive");

  const main = win(
    "LIGHTDROP",
    { cls: "win-main" },
    hero,
    h("h1", { class: "title" }, "LIGHTDROP"),
    h("p", { class: "tagline" }, "Files through the air. Screen to camera.", h("br"), "No pairing. No cables. No internet."),
    h("div", { class: "big-btns" }, sendBtn, recvBtn),
  );
  const how = win(
    "HOW IT WORKS",
    { cls: "win-how" },
    h(
      "ul",
      { class: "how" },
      h("li", {}, sprite("sun", 3), h("span", {}, h("b", {}, "LIGHT"), " carries the file as moving black and white squares.")),
      h("li", {}, sprite("camera", 3), h("span", {}, h("b", {}, "ANY CAMERA"), " reads it: phone or laptop webcam. Missed frames don't matter.")),
      h("li", {}, sprite("check", 3), h("span", {}, h("b", {}, "NOTHING TO CONNECT."), " No Wi-Fi, no Bluetooth, no internet. Works in airplane mode.")),
    ),
  );
  const saved = h("div", { class: "saved-slot" });
  const side = h("div", { class: "side" }, saved, how);
  const el = h("div", { class: "desk home" }, main, side);
  // Desktop: drop a file anywhere on the home screen to send it.
  el.addEventListener("dragover", (e) => e.preventDefault());
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files[0];
    if (f) startSend(f);
  });
  show(el, () => b.stop());
  void renderSaved(saved);
}

async function renderSaved(into: HTMLElement) {
  let items: SavedTransfer[] = [];
  try {
    items = await listSaved();
  } catch {}
  if (!items.length) return;
  const list = h("ul", { class: "files" });
  for (const t of items.slice(0, 5)) {
    const frac = doneFraction(t);
    const done = frac >= 1;
    const del = h("button", { class: "linkish", "aria-label": "Delete" }, "[X]");
    const action = h("button", { class: "btn small" }, done ? "SAVE" : "RESUME");
    const li = h(
      "li",
      {},
      sprite("file", 2),
      h(
        "div",
        { class: "file-meta" },
        h("strong", { class: "ellipsis" }, t.name || "UNNAMED"),
        h("span", {}, done ? `${formatBytes(t.totalSize)} · received` : `${asciiBar(frac, 8)} paused`),
      ),
      action,
      del,
    );
    del.onclick = async () => {
      await deleteSaved(t.fileId);
      li.remove();
    };
    action.onclick = async () => {
      if (!done) return void (location.hash = "#receive");
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("incoming");
      const raw = await (await dir.getFileHandle(`${(t.fileId >>> 0).toString(16).padStart(8, "0")}.part`)).getFile();
      const file = new File([raw.slice(0, t.totalSize)], t.name, { type: t.mime });
      h("a", { href: URL.createObjectURL(file), download: t.name }).click();
    };
    list.append(li);
  }
  into.replaceChildren(win("ON THIS DEVICE", { cls: "win-files" }, list));
}

let pendingFile: File | undefined;
function startSend(f: File) {
  pendingFile = f;
  if (location.hash === "#send") route();
  else location.hash = "#send";
}

function route() {
  const back = () => {
    pendingFile = undefined;
    location.hash = "";
  };
  if (location.hash === "#send") {
    if (pendingFile) {
      const v = sendView(pendingFile, back);
      return show(v.el, v.dispose, false);
    }
    return show(pickFileView(startSend, back));
  }
  if (location.hash === "#receive") {
    const v = receiveView(back);
    return show(v.el, v.dispose, false);
  }
  home();
}

window.addEventListener("hashchange", route);
route();
void opfs();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
}
