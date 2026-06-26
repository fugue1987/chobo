import { describe, it, expect } from "vitest";
import * as chobo from "../src/index.js";

describe("public API surface", () => {
  it("exposes the documented functions", () => {
    for (const name of [
      "init", "runWithIdentity", "getIdentity", "updateIdentity",
      "meter", "meterStream", "meterManual", "flush", "shutdown", "getStats", "getConfig",
    ]) {
      expect(typeof (chobo as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it("exposes the extractors namespace", () => {
    expect(typeof chobo.extractors.openaiChatUsage).toBe("function");
    expect(typeof chobo.extractors.openaiStreamChunkUsage).toBe("function");
    expect(typeof chobo.extractors.geminiStreamChunkUsage).toBe("function");
  });

  it("exposes VERSION", () => {
    expect(chobo.VERSION).toBe("0.1.5");
  });
});
