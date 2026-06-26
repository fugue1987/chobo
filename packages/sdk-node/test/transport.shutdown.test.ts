import { describe, it, expect, afterEach } from "vitest";
import { Transport } from "../src/transport.js";
import { ingestStub, type IngestStub } from "./stub.js";
import { ev, cfg } from "./helpers.js";

describe("transport shutdown", () => {
  let stub: IngestStub;
  afterEach(async () => { await stub?.stop(); });

  it("shutdown drains remaining buffer + spool", async () => {
    stub = await ingestStub();
    const t = new Transport(cfg(stub.url, { flushAt: 1000, flushIntervalMs: 30000 }));
    for (let i = 0; i < 7; i++) t.enqueue(ev(i));
    await t.shutdown(); // must drain even without an explicit flush
    expect(stub.received.length).toBe(7);
    expect(t.stats.sent).toBe(7);
  });

  it("shutdown terminates (does not hang) when CRM is permanently down", async () => {
    stub = await ingestStub();
    stub.setStatus(503);
    const t = new Transport(cfg(stub.url, { flushAt: 1000, flushIntervalMs: 30000, timeoutMs: 500 }));
    for (let i = 0; i < 3; i++) t.enqueue(ev(i));
    const start = Date.now();
    await t.shutdown(); // bounded — returns even though nothing can be delivered
    expect(Date.now() - start).toBeLessThan(10000);
    expect(stub.received.length).toBe(0);
    // events are persisted on disk (not silently dropped) — spilled was counted
    expect(t.stats.spilled).toBeGreaterThan(0);
  });
});
