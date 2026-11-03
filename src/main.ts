import "./style.css";
import { pickFileView, sendView } from "./ui/send";
import { receiveView } from "./ui/receive";
import { deleteSaved, doneFraction, listSaved, opfs, type SavedTransfer } from "./storage/store";
import { formatBytes, h, icons, svg } from "./ui/util";

const app = document.getElementById("app")!;
let dispose: (() => void) | undefined;

function show(el: HTMLElement, cleanup?: () => void) {
  dispose?.();
  dispose = cleanup;
  app.replaceChildren(el);
}

function home() {
  const sendCard = h(
    "button",
    { class: "card send-card" },
    svg(icons.send, "icon lg"),
    h("strong", {}, "Send"),
    h("span", {}, "Show a file as moving codes"),
  );
  const recvCard = h(
    "button",
    { class: "card recv-card" },
    svg(icons.receive, "icon lg"),
    h("strong", {}, "Receive"),
    h("span", {}, "Point your camera at the codes"),
  );
  sendCard.onclick = () => (location.hash = "#send");
  recvCard.onclick = () => (location.hash = "#receive");

  const saved = h("section", { class: "saved" });
  const el = h(
    "div",
    { class: "page home" },
    h("div", { class: "brand" }, h("img", { src: `${import.meta.env.BASE_URL}icon.svg`, alt: "", width: "40", height: "40" }), h("h1", {}, "Lightdrop")),
    h("p", { class: "tagline" }, "Move files between any two devices with a screen and a camera. No pairing, no cables, no internet."),
    h("div", { class: "cards" }, sendCard, recvCard),
    saved,
    h(
      "ul",
      { class: "how" },
      h("li", {}, svg(icons.light), h("span", {}, h("b", {}, "Light"), " carries the file, frame by frame.")),
      h("li", {}, svg(icons.sound), h("span", {}, h("b", {}, "Sound"), " lets the receiver report back, so nothing is sent twice.")),
      h("li", {}, svg(icons.wifi), h("span", {}, h("b", {}, "Wi-Fi"), " takes over automatically when both are on the same network.")),
    ),
  );
  // Desktop: drop anywhere on the home screen to send.
  el.addEventListener("dragover", (e) => e.preventDefault());
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files[0];
    if (f) startSend(f);
  });
  show(el);
  void renderSaved(saved);
}

async function renderSaved(into: HTMLElement) {
  let items: SavedTransfer[] = [];
  try {
    items = await listSaved();
  } catch {}
  if (!items.length) return;
  const list = h("ul", { class: "saved-list" });
  for (const t of items.slice(0, 8)) {
    const frac = doneFraction(t);
    const done = frac >= 1;
    const del = h("button", { class: "icon-btn small", "aria-label": "Delete" }, svg(icons.close));
    del.onclick = async () => {
      await deleteSaved(t.fileId);
      li.remove();
    };
    const action = done ? h("button", { class: "btn small" }, "Save") : h("button", { class: "btn small" }, "Resume");
    action.onclick = async () => {
      if (!done) return void (location.hash = "#receive");
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("incoming");
      const raw = await (await dir.getFileHandle(`${(t.fileId >>> 0).toString(16).padStart(8, "0")}.part`)).getFile();
      const file = new File([raw.slice(0, t.totalSize)], t.name, { type: t.mime });
      const a = h("a", { href: URL.createObjectURL(file), download: t.name });
      a.click();
    };
    const li = h(
      "li",
      {},
      svg(icons.file),
      h(
        "div",
        { class: "file-meta" },
        h("strong", { class: "ellipsis" }, t.name || "Unnamed file"),
        h("span", { class: "muted" }, done ? `${formatBytes(t.totalSize)} · received` : `${Math.floor(frac * 100)}% of ${formatBytes(t.totalSize)} · paused`),
      ),
      action,
      del,
    );
    list.append(li);
  }
  into.replaceChildren(h("h3", {}, "On this device"), list);
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
      return show(v.el, v.dispose);
    }
    return show(pickFileView(startSend, back));
  }
  if (location.hash === "#receive") {
    const v = receiveView(back);
    return show(v.el, v.dispose);
  }
  home();
}

window.addEventListener("hashchange", route);
// Opening #receive cold (bookmark, reload) has no user gesture for audio;
// route through home so the Receive tap unlocks it.
if (location.hash === "#receive") history.replaceState(null, "", location.pathname);
route();
void opfs();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
}
