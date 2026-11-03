// Received segments go straight to the Origin Private File System through a
// synchronous access handle (worker-only API, but supported by every current
// engine including Safari). Memory use stays flat whatever the file size.
// A small JSON manifest next to each file records which segments are done,
// so an interrupted transfer resumes where it stopped.

interface Manifest {
  fileId: number;
  totalSize: number;
  name: string;
  mime: string;
  done: string; // base64 bitmap, one byte per segment
  updatedAt: number;
}

const handles = new Map<number, FileSystemSyncAccessHandle>();
const manifests = new Map<number, Manifest>();
const lastSaved = new Map<number, number>();

async function dir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("incoming", { create: true });
}

const hex = (id: number) => (id >>> 0).toString(16).padStart(8, "0");

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function readManifest(id: number): Promise<Manifest | undefined> {
  try {
    const f = await (await (await dir()).getFileHandle(`${hex(id)}.json`)).getFile();
    return JSON.parse(await f.text()) as Manifest;
  } catch {
    return undefined;
  }
}

async function saveManifest(m: Manifest) {
  m.updatedAt = Date.now();
  const h = await (await (await dir()).getFileHandle(`${hex(m.fileId)}.json`, { create: true })).createSyncAccessHandle();
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(m));
    h.truncate(0);
    h.write(bytes, { at: 0 });
    h.flush();
  } finally {
    h.close();
  }
}

async function handle(msg: any): Promise<unknown> {
  switch (msg.op) {
    case "probe": {
      await dir();
      return true;
    }
    case "open": {
      const { fileId, totalSize, name, mime } = msg.info;
      if (!handles.has(fileId)) {
        const fh = await (await dir()).getFileHandle(`${hex(fileId)}.part`, { create: true });
        handles.set(fileId, await fh.createSyncAccessHandle());
      }
      const prev = await readManifest(fileId);
      const resume = prev && prev.totalSize === totalSize ? Uint8Array.from(atob(prev.done), (c) => c.charCodeAt(0)) : undefined;
      manifests.set(fileId, { fileId, totalSize, name, mime, done: prev?.done ?? "", updatedAt: Date.now() });
      return resume;
    }
    case "write": {
      const h = handles.get(msg.fileId);
      const m = manifests.get(msg.fileId);
      if (!h || !m) throw new Error("not open");
      h.write(new Uint8Array(msg.bytes), { at: msg.offset });
      m.done = b64(new Uint8Array(msg.done));
      const now = Date.now();
      if (msg.final || now - (lastSaved.get(msg.fileId) ?? 0) > 1000) {
        h.flush();
        await saveManifest(m);
        lastSaved.set(msg.fileId, now);
      }
      return true;
    }
    case "close": {
      const h = handles.get(msg.fileId);
      if (h) {
        h.flush();
        h.close();
        handles.delete(msg.fileId);
      }
      const m = manifests.get(msg.fileId);
      if (m) await saveManifest(m);
      return true;
    }
    case "list": {
      const out: Manifest[] = [];
      for await (const [name, h] of (await dir()) as any) {
        if (!name.endsWith(".json") || h.kind !== "file") continue;
        try {
          out.push(JSON.parse(await (await h.getFile()).text()));
        } catch {}
      }
      return out;
    }
    case "delete": {
      const d = await dir();
      const h = handles.get(msg.fileId);
      if (h) {
        h.close();
        handles.delete(msg.fileId);
      }
      for (const ext of [".part", ".json"]) await d.removeEntry(hex(msg.fileId) + ext).catch(() => {});
      return true;
    }
  }
  throw new Error(`unknown op ${msg.op}`);
}

self.onmessage = async (e: MessageEvent) => {
  const { id, ...msg } = e.data;
  try {
    const result = await handle(msg);
    (self as unknown as Worker).postMessage({ id, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
