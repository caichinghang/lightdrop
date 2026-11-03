// A fixed set of workers, one job each at a time. `tryRun` refuses instead of
// queueing, which is what a camera pipeline wants: a stale frame is worthless.

export class WorkerPool<Req extends object, Res> {
  private workers: { w: Worker; busy: boolean }[] = [];
  private next = 1;
  private waiting = new Map<number, (r: Res) => void>();

  constructor(make: () => Worker, size: number) {
    for (let i = 0; i < size; i++) {
      const w = make();
      const slot = { w, busy: false };
      w.onmessage = (e) => {
        slot.busy = false;
        const cb = this.waiting.get(e.data.id);
        this.waiting.delete(e.data.id);
        cb?.(e.data as Res);
      };
      this.workers.push(slot);
    }
  }

  get idle(): number {
    return this.workers.filter((s) => !s.busy).length;
  }

  tryRun(req: Req, transfer: Transferable[] = []): Promise<Res> | null {
    const slot = this.workers.find((s) => !s.busy);
    if (!slot) return null;
    return this.dispatch(slot, req, transfer);
  }

  /** Waits for a free worker. */
  async run(req: Req, transfer: Transferable[] = []): Promise<Res> {
    for (;;) {
      const slot = this.workers.find((s) => !s.busy);
      if (slot) return this.dispatch(slot, req, transfer);
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  private dispatch(slot: { w: Worker; busy: boolean }, req: Req, transfer: Transferable[]): Promise<Res> {
    slot.busy = true;
    const id = this.next++;
    return new Promise<Res>((resolve) => {
      this.waiting.set(id, resolve);
      slot.w.postMessage({ id, ...req }, transfer);
    });
  }

  terminate() {
    for (const s of this.workers) s.w.terminate();
  }
}
