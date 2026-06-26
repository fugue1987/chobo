import { join } from "node:path";
import { appendFile, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import type { ChoboConfig } from "./config.js";
import type { ChoboEvent } from "./event.js";

export interface TransportStats {
  enqueued: number;
  sent: number;
  spilled: number;
  dropped: number;
  postFailures: number;
}

/**
 * Never-blocking delivery: in-memory buffer -> interval/size-triggered flush -> batch POST.
 * Disk spill + backoff are added in the resilience task; bounded shutdown in the shutdown task.
 */
export class Transport {
  private buffer: ChoboEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  protected closed = false;
  private readonly fetchImpl: typeof fetch;
  protected readonly spoolPath: string;
  readonly stats: TransportStats = { enqueued: 0, sent: 0, spilled: 0, dropped: 0, postFailures: 0 };
  /** Serializes all spool-file operations (the Node analogue of a lock). */
  private spoolChain: Promise<unknown> = Promise.resolve();

  /** Best-effort flush on natural process drain (safe: does not hijack signals or prevent exit). */
  private readonly onBeforeExit = (): void => {
    void this.flush();
  };

  constructor(protected readonly cfg: ChoboConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.spoolPath = join(cfg.spoolDir, `events-${process.pid}.jsonl`);
    this.timer = setInterval(() => { void this.flush(); }, cfg.flushIntervalMs);
    this.timer.unref();
    process.on("beforeExit", this.onBeforeExit);
  }

  /** Producer side — must be instant (no network/disk on this path). */
  enqueue(event: ChoboEvent): void {
    if (this.closed) return;
    this.stats.enqueued++;
    this.buffer.push(event);
    if (this.buffer.length > this.cfg.bufferMax) {
      const overflow = this.buffer.splice(0, this.buffer.length - this.cfg.bufferMax);
      void this.spill(overflow); // spill oldest to disk (async, non-blocking)
    }
    if (this.buffer.length >= this.cfg.flushAt) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.buffer.length > 0) {
        const batch = this.buffer.splice(0, this.cfg.batchMax);
        const ok = await this.post(batch);
        if (!ok) {
          this.stats.postFailures++;
          await this.spill(batch); // failed in-memory batch -> disk, retry next pass
          break;
        }
      }
      await this.drainSpool();
    } finally {
      this.flushing = false;
    }
  }

  protected async post(events: ChoboEvent[]): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await this.fetchImpl(this.cfg.ingestUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.cfg.ingestSecret ? { "x-chobo-secret": this.cfg.ingestSecret } : {}),
        },
        body: JSON.stringify({ events }),
        signal: controller.signal,
      });
      if (res.ok) {
        this.stats.sent += events.length;
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private withSpoolLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.spoolChain.then(fn, fn);
    this.spoolChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async spill(events: ChoboEvent[]): Promise<void> {
    try {
      await this.withSpoolLock(async () => {
        await mkdir(this.cfg.spoolDir, { recursive: true });
        const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
        await appendFile(this.spoolPath, lines, "utf8");
        this.stats.spilled += events.length;
        await this.enforceSpoolCap();
      });
    } catch {
      this.stats.dropped += events.length; // disk problem — counted, never silent
    }
  }

  private async enforceSpoolCap(): Promise<void> {
    // caller holds the spool lock
    let size: number;
    try { size = (await stat(this.spoolPath)).size; } catch { return; }
    if (size <= this.cfg.maxSpoolBytes) return;
    const content = await readFile(this.spoolPath, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    let bytes = Buffer.byteLength(lines.join("\n") + "\n", "utf8");
    while (lines.length && bytes > this.cfg.maxSpoolBytes) {
      lines.shift(); // drop oldest
      this.stats.dropped++;
      bytes = Buffer.byteLength(lines.length ? lines.join("\n") + "\n" : "", "utf8");
    }
    await writeFile(this.spoolPath, lines.length ? lines.join("\n") + "\n" : "", "utf8");
  }

  protected async spoolNonEmpty(): Promise<boolean> {
    try { return (await stat(this.spoolPath)).size > 0; } catch { return false; }
  }

  private async drainSpool(): Promise<void> {
    // Wrapped so a spool fs error (file removed mid-drain, permissions, etc.) can never escape as
    // an unhandled rejection from the background flusher (which could crash the host process).
    // The next flush cycle retries from whatever remains on disk. Mirrors spill()'s defensive catch.
    try {
      let lines: string[] = [];
      await this.withSpoolLock(async () => {
        let size = 0;
        try { size = (await stat(this.spoolPath)).size; } catch { return; }
        if (size === 0) return;
        const content = await readFile(this.spoolPath, "utf8");
        lines = content.split("\n").filter((l) => l.length > 0);
        await writeFile(this.spoolPath, "", "utf8"); // consume now
      });
      if (lines.length === 0) return;
      let i = 0;
      while (i < lines.length) {
        const chunk = lines.slice(i, i + this.cfg.batchMax);
        let events: ChoboEvent[];
        try { events = chunk.map((l) => JSON.parse(l) as ChoboEvent); }
        catch { i += chunk.length; continue; } // skip corrupt lines
        const ok = await this.post(events);
        if (ok) i += chunk.length;
        else break; // backoff: stop, retry next pass
      }
      const leftover = lines.slice(i);
      if (leftover.length) {
        await this.withSpoolLock(async () => {
          await appendFile(this.spoolPath, leftover.join("\n") + "\n", "utf8");
        });
      }
    } catch {
      this.stats.postFailures++; // spool fs error; swallow + count, retry next cycle
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    process.removeListener("beforeExit", this.onBeforeExit);
    // Best-effort bounded drain: stop when fully drained, or when a pass makes no progress
    // (CRM down) — in which case events remain persisted on disk, not lost.
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = this.stats.sent;
      await this.flush();
      const drained = this.buffer.length === 0 && !(await this.spoolNonEmpty());
      if (drained) return;
      if (this.stats.sent === before) break; // no progress -> stop (events are on disk)
    }
  }
}
