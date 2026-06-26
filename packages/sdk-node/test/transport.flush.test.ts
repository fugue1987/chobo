import { describe, it, expect, afterEach, vi } from "vitest";
import { Transport } from "../src/transport.js";
import { ingestStub, type IngestStub } from "./stub.js";
import { ev, cfg } from "./helpers.js";

describe("transport flush triggers", () => {
  let stub: IngestStub;
  afterEach(async () => { await stub?.stop(); });

  it("auto-flushes when the buffer reaches flushAt", async () => {
    stub = await ingestStub();
    // Long interval so ONLY the size threshold can trigger delivery.
    const t = new Transport(cfg(stub.url, { flushAt: 5, flushIntervalMs: 30000 }));
    for (let i = 0; i < 5; i++) t.enqueue(ev(i));
    await vi.waitFor(() => expect(stub.received.length).toBe(5), { timeout: 2000 });
    await t.shutdown();
  });

  it("flush() drains on demand under a long interval", async () => {
    stub = await ingestStub();
    const t = new Transport(cfg(stub.url, { flushAt: 1000, flushIntervalMs: 30000 }));
    for (let i = 0; i < 10; i++) t.enqueue(ev(i));
    await t.flush();
    expect(stub.received.length).toBe(10);
    await t.shutdown();
  });
});
