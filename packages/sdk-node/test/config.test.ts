import { describe, it, expect } from "vitest";
import { resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  it("applies defaults", () => {
    const c = resolveConfig({ ingestUrl: "http://x/v1/events", service: "node-ai-proxy" });
    expect(c.ingestUrl).toBe("http://x/v1/events");
    expect(c.service).toBe("node-ai-proxy");
    expect(c.bufferMax).toBe(10000);
    expect(c.batchMax).toBe(100);
    expect(c.flushAt).toBe(20);
    expect(c.flushIntervalMs).toBe(2000);
    expect(c.maxSpoolBytes).toBe(50 * 1024 * 1024);
    expect(c.timeoutMs).toBe(5000);
  });

  it("honors overrides", () => {
    const c = resolveConfig({
      ingestUrl: "http://x", service: "s",
      bufferMax: 5, batchMax: 2, flushAt: 1, flushIntervalMs: 50, spoolDir: "/tmp/sp",
    });
    expect(c.bufferMax).toBe(5);
    expect(c.flushAt).toBe(1);
    expect(c.spoolDir).toBe("/tmp/sp");
  });
});
