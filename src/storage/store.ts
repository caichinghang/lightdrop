// Where received segments land: OPFS on disk when the browser allows it,
// memory otherwise (e.g. some private-browsing modes).

import type { SegmentSink, TransferInfo } from "../core/receiver";
import { SEG_BYTES } from "../core/segments";

export interface SavedTransfer {
  fileId: number;
  totalSize: number;
  name: string;
  mime: string;
  done: string;
  updatedAt: number;
}

const hex = (id: number) => (id >>> 0).toString(16).padStart(8, "0");

class OpfsClient {
  private worker = new Worker(new URL("./opfs.worker.ts", import.meta.url), { type: "module" });
  private next = 1;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker.onmessage = (e) => {
      const w = this.waiting.get(e.data.id);
      if (!w) return;
      this.waiting.delete(e.data.id);
      if (e.data.error) w.reject(new Error(e.data.error));
      else w.resolve(e.data.result);
    };
  }

  call<T>(msg: object, transfer: Transferable[] = []): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...msg }, transfer);
    });
  }
}

let client: Promise<OpfsClient | null> | undefined;

/** The OPFS worker, or null when this browser can't give us one. */
export function opfs(): Promise<OpfsClient | null> {
  client ??= (async () => {
    try {
      const c = new OpfsClient();
      await Promise.race([c.call({ op: "probe" }), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000))]);
      return c;
    } catch {
      return null;
    }
  })();
  return client;
}

export class FileSink implements SegmentSink {
  private memory?: Map<number, Uint8Array>;
  private info?: TransferInfo;

  async open(info: TransferInfo): Promise<Uint8Array | undefined> {
    this.info = info;
    const c = await opfs();
    if (!c) {
      this.memory = new Map();
      return undefined;
    }
    return c.call<Uint8Array | undefined>({ op: "open", info });
  }

  async write(seg: number, bytes: Uint8Array, done: Uint8Array): Promise<void> {
    if (this.memory) {
      this.memory.set(seg, bytes);
      return;
    }
    const c = (await opfs())!;
    const final = done.every((d) => d === 1);
    const copy = bytes.slice();
    await c.call({ op: "write", fileId: this.info!.fileId, offset: seg * SEG_BYTES, bytes: copy.buffer, done: done.slice().buffer, final }, [copy.buffer]);
  }

  /** The finished file, disk-backed where possible. */
  async file(): Promise<File> {
    const info = this.info!;
    if (this.memory) {
      const parts = [...this.memory.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b as BlobPart);
      return new File(parts, info.name, { type: info.mime });
    }
    const c = (await opfs())!;
    await c.call({ op: "close", fileId: info.fileId });
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle("incoming");
    const raw = await (await d.getFileHandle(`${hex(info.fileId)}.part`)).getFile();
    return new File([raw.slice(0, info.totalSize)], info.name, { type: info.mime });
  }
}

export async function listSaved(): Promise<SavedTransfer[]> {
  const c = await opfs();
  if (!c) return [];
  return (await c.call<SavedTransfer[]>({ op: "list" })).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteSaved(fileId: number) {
  await (await opfs())?.call({ op: "delete", fileId });
}

export function doneFraction(t: SavedTransfer): number {
  if (!t.done) return 0;
  const bits = atob(t.done);
  let n = 0;
  for (let i = 0; i < bits.length; i++) n += bits.charCodeAt(i);
  return n / Math.max(1, bits.length);
}
