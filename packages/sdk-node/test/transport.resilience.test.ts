import { describe, it, expect, afterEach } from "vitest";
import { Transport } from "../src/transport.js";
import { ingestStub, type IngestStub } from "./stub.js";
import { ev, cfg, spoolDir, readSpool } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("transport resilience", () => {
  let stub: IngestStub;
  afterEach(async () => { await stub?.stop(); });

  it("CRM down then recovers — no loss", async () => {
    stub = await ingestStub();
    stub.setStatus(503);
    const t = new Transport(cfg(stub.url, { bufferMax: 100, batchMax: 10, flushIntervalMs: 30 }));
    for (let i = 0; i < 8; i++) t.enqueue(ev(i));
    await sleep(400);
    expect(stub.received.length).toBe(0);
    stub.setStatus(200);
    await t.flush();
    await t.shutdown();
    const ids = stub.received.map((e: any) => e.event_id).sort();
    expect(ids).toEqual(["e0", "e1", "e2", "e3", "e4", "e5", "e6", "e7"]);
  });

  it("overflow spills to disk and is recovered", async () => {
    stub = await ingestStub();
    stub.setStatus(503);
    const dir = spoolDir();
    const t = new Transport(cfg(stub.url, { bufferMax: 3, batchMax: 3, spoolDir: dir }));
    for (let i = 0; i < 20; i++) t.enqueue(ev(i));
    await sleep(150);
    expect(t.stats.spilled).toBeGreaterThan(0);
    stub.setStatus(200);
    await t.flush();
    await t.shutdown();
    const ids = stub.received.map((e: any) => Number(e.event_id.slice(1))).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it("concurrent spill during drain is not lost (atomic consume)", async () => {
    stub = await ingestStub();
    const dir = spoolDir();
    const t = new Transport(cfg(stub.url, { batchMax: 10, spoolDir: dir }));
    // Pre-load the spool with 5 events as if previously overflowed.
    await (t as any).spill([0, 1, 2, 3, 4].map(ev));
    // Patch post so the FIRST call simulates a producer spilling during the POST window.
    const realPost = (t as any).post.bind(t);
    let first = true;
    (t as any).post = async (events: any[]) => {
      if (first) { first = false; await (t as any).spill([ev(999)]); }
      return realPost(events);
    };
    await (t as any).drainSpool();
    const delivered = new Set(stub.received.map((e: any) => e.event_id));
    const remaining = new Set(readSpool(dir).map((e: any) => e.event_id));
    const all = new Set([...delivered, ...remaining]);
    for (let i = 0; i < 5; i++) expect(all.has(`e${i}`)).toBe(true);
    expect(all.has("e999")).toBe(true); // concurrently-spilled event survived (not erased)
    await t.shutdown();
  });
});
