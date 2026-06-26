import { describe, it, expect } from "vitest";
import { buildSampleEvents } from "../src/seed-events.js";

describe("buildSampleEvents", () => {
  const evs = buildSampleEvents({ count: 200, days: 14, seed: 1 });

  it("produces the requested count", () => {
    expect(evs).toHaveLength(200);
  });
  it("every event has the contract-required fields", () => {
    for (const e of evs) {
      for (const f of ["event_id","identity_source","start_time","service","provider","operation","request_model","usage_source","status","sdk_lang","sdk_version"]) {
        expect(e[f as keyof typeof e]).toBeDefined();
      }
      expect(typeof e.start_time).toBe("number");
    }
  });
  it("event_ids are unique", () => {
    expect(new Set(evs.map((e) => e.event_id)).size).toBe(200);
  });
  it("includes at least one UNPRICED model (so 看板 renders 未定价)", () => {
    expect(evs.some((e) => e.request_model === "gpt-image-2" || e.request_model === "gemini-3.5-flash")).toBe(true);
  });
  it("spreads start_time across the requested window (not all identical)", () => {
    expect(new Set(evs.map((e) => e.start_time)).size).toBeGreaterThan(10);
  });
  it("is deterministic for a given seed (PRNG-derived fields match)", () => {
    const run1 = buildSampleEvents({ count: 50, days: 7, seed: 42 });
    const run2 = buildSampleEvents({ count: 50, days: 7, seed: 42 });
    expect(run1[0].start_time).toBe(run2[0].start_time);
    expect(run1[0].input_tokens).toBe(run2[0].input_tokens);
    expect(run1.map((e) => e.start_time)).toEqual(run2.map((e) => e.start_time));
  });
  it("image events have null tokens and image_count=1", () => {
    const imgs = evs.filter((e) => e.operation === "image");
    expect(imgs.length).toBeGreaterThan(0);
    for (const e of imgs) {
      expect(e.input_tokens).toBeNull();
      expect(e.output_tokens).toBeNull();
      expect(e.total_tokens).toBeNull();
      expect(e.image_count).toBe(1);
    }
  });
});
