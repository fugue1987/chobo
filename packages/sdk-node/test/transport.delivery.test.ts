import { describe, it, expect, afterEach } from "vitest";
import { Transport } from "../src/transport.js";
import { ingestStub, type IngestStub } from "./stub.js";
import { ev, cfg } from "./helpers.js";

describe("transport delivery", () => {
  let stub: IngestStub;
  afterEach(async () => { await stub?.stop(); });

  it("delivers enqueued events", async () => {
    stub = await ingestStub();
    const t = new Transport(cfg(stub.url, { batchMax: 10, flushIntervalMs: 30 }));
    for (let i = 0; i < 5; i++) t.enqueue(ev(i));
    await t.flush();
    await t.shutdown();
    const ids = stub.received.map((e: any) => e.event_id).sort();
    expect(ids).toEqual(["e0", "e1", "e2", "e3", "e4"]);
    expect(t.stats.sent).toBe(5);
  });

  it("batches multiple events", async () => {
    stub = await ingestStub();
    const t = new Transport(cfg(stub.url, { batchMax: 100 }));
    for (let i = 0; i < 20; i++) t.enqueue(ev(i));
    await t.flush();
    await t.shutdown();
    expect(stub.received.length).toBe(20);
  });
});
