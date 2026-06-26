import { describe, it, expect, afterEach } from "vitest";
import * as chobo from "../src/runtime.js";
import { ingestStub, type IngestStub } from "./stub.js";
import { ev, spoolDir } from "./helpers.js";

describe("runtime singleton", () => {
  let stub: IngestStub;
  afterEach(async () => { await chobo.reset(); await stub?.stop(); });

  it("init wires a transport; emit -> flush delivers", async () => {
    stub = await ingestStub();
    chobo.init({ ingestUrl: stub.url, service: "node-ai-proxy", flushIntervalMs: 30000, spoolDir: spoolDir() });
    for (let i = 0; i < 3; i++) chobo.emit(ev(i));
    await chobo.flush();
    expect(stub.received.length).toBe(3);
    expect(chobo.getStats().sent).toBe(3);
  });

  it("lifecycle helpers are safe before init", async () => {
    await chobo.reset();
    await expect(chobo.flush()).resolves.toBeUndefined();
    await expect(chobo.shutdown()).resolves.toBeUndefined();
    expect(chobo.getStats()).toEqual({});
    expect(chobo.getConfig()).toBeNull();
  });

  it("re-init tears down the previous transport", async () => {
    stub = await ingestStub();
    chobo.init({ ingestUrl: stub.url, service: "s", flushIntervalMs: 30000, spoolDir: spoolDir() });
    chobo.init({ ingestUrl: stub.url, service: "s2", flushIntervalMs: 30000, spoolDir: spoolDir() });
    expect(chobo.getConfig()!.service).toBe("s2");
  });
});
