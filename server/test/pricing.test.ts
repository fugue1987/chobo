import { describe, it, expect } from "vitest";
import { computeCost } from "../src/pricing.js";
import type { PriceTable } from "../src/types.js";

const rows = (input_tier_max: number, i: number, o: number, c: number) => ({
  version: "t", provider: "doubao", model: "doubao-seed-2.0-pro", operation: "chat",
  input_tier_max, input_per_mtok: i, output_per_mtok: o, cache_read_per_mtok: c,
  reasoning_per_mtok: null, per_image: null, text_input_per_mtok: null, currency: "CNY",
});
const TABLE: PriceTable = {
  version: "t", aliases: {},
  rows: [rows(32000, 3.2, 16, 0.64), rows(128000, 4.8, 24, 0.96), rows(256000, 9.6, 48, 1.92)],
};
const base = { provider: "doubao", model: "doubao-seed-2.0-pro", operation: "chat" as const };

// gpt-image-2 token 计价价表(USD): 图像输入 $8、图像输出 $30、文本输入 $5;cached 不可观测故 null
const IMG_TABLE: PriceTable = { version: "2026-06-25a", aliases: {}, rows: [{
  version: "2026-06-25a", provider: "newapi", model: "gpt-image-2", operation: "image", input_tier_max: 0,
  input_per_mtok: 8, output_per_mtok: 30, text_input_per_mtok: 5,
  cache_read_per_mtok: null, reasoning_per_mtok: null, per_image: null, currency: "USD",
}] };

describe("computeCost", () => {
  it("picks [0,32K] tier", () => {
    const c = computeCost({ ...base, input_tokens: 10_000, output_tokens: 1_000, cached_tokens: 0 }, TABLE);
    expect(c.input_cost).toBe(0.032); expect(c.output_cost).toBe(0.016);
    expect(c.total_cost).toBe(0.048); expect(c.currency).toBe("CNY"); expect(c.price_table_version).toBe("t");
  });
  it("picks (32K,128K] at the 128K boundary", () => {
    expect(computeCost({ ...base, input_tokens: 128_000, output_tokens: 0 }, TABLE).input_cost).toBe(0.6144);
  });
  it("splits cached tokens to cache_read rate", () => {
    const c = computeCost({ ...base, input_tokens: 10_000, output_tokens: 0, cached_tokens: 4_000 }, TABLE);
    expect(c.input_cost).toBe(0.0192); expect(c.cache_cost).toBe(0.00256); expect(c.total_cost).toBe(0.02176);
  });
  it("normalizes a dated doubao endpoint id via alias", () => {
    const t: PriceTable = { ...TABLE, aliases: { "doubao::doubao-seed-2-0-pro-260215": "doubao-seed-2.0-pro" } };
    const c = computeCost({ provider: "doubao", model: "doubao-seed-2-0-pro-260215", operation: "chat", input_tokens: 10_000, output_tokens: 1_000 }, t);
    expect(c.total_cost).toBe(0.048);
  });
  it("prices images by count × per_image", () => {
    const t: PriceTable = { version: "t", aliases: {}, rows: [{ version: "t", provider: "example-gateway", model: "gpt-image-2", operation: "image", input_tier_max: 0, input_per_mtok: null, output_per_mtok: null, cache_read_per_mtok: null, reasoning_per_mtok: null, per_image: 0.25, text_input_per_mtok: null, currency: "CNY" }] };
    const c = computeCost({ provider: "example-gateway", model: "gpt-image-2", operation: "image", image_count: 3 }, t);
    expect(c.total_cost).toBe(0.75); expect(c.output_cost).toBe(0.75);
  });
  it("returns null + unpriced for unknown model", () => {
    const c = computeCost({ ...base, model: "nope", input_tokens: 100 }, TABLE);
    expect(c.priced).toBe(false); expect(c.total_cost).toBeNull();
  });
  it("uses the largest tier when input exceeds all brackets", () => {
    expect(computeCost({ ...base, input_tokens: 999_999, output_tokens: 0 }, TABLE).input_cost).toBe(9.5999904);
  });
  it("dedicated reasoning rate adds into output_cost", () => {
    const t: PriceTable = {
      version: "t", aliases: {},
      rows: [{ version: "t", provider: "doubao", model: "r1-pro", operation: "chat", input_tier_max: 0, input_per_mtok: 4.0, output_per_mtok: 16.0, cache_read_per_mtok: null, reasoning_per_mtok: 5.0, per_image: null, text_input_per_mtok: null, currency: "CNY" }],
    };
    const c = computeCost({ provider: "doubao", model: "r1-pro", operation: "chat", input_tokens: 1_000_000, output_tokens: 0, reasoning_tokens: 500 }, t);
    // input: 1e6/1e6*4 = 4.0; reasoning: 500/1e6*5 = 0.0025; output base: 0
    expect(c.output_cost).toBe(0.0025);
    expect(c.total_cost).toBe(round8(4.0 + 0.0025));
    expect(c.priced).toBe(true);
  });
  it("image with null per_image returns unpriced (not total_cost=0)", () => {
    const t: PriceTable = {
      version: "t", aliases: {},
      rows: [{ version: "t", provider: "example-gateway", model: "gpt-image-2", operation: "image", input_tier_max: 0, input_per_mtok: null, output_per_mtok: null, cache_read_per_mtok: null, reasoning_per_mtok: null, per_image: null, text_input_per_mtok: null, currency: "CNY" }],
    };
    const c = computeCost({ provider: "example-gateway", model: "gpt-image-2", operation: "image", image_count: 2 }, t);
    expect(c.priced).toBe(false);
    expect(c.total_cost).toBeNull();
    expect(c.currency).toBe("CNY");
    expect(c.price_table_version).toBe("t");
  });

  // ── gpt-image-2 逐模态 token 计价(USD) + cost_breakdown ──
  it("prices gpt-image-2 by modality tokens (USD) + emits cost_breakdown", () => {
    const c = computeCost({ provider: "newapi", model: "gpt-image-2", operation: "image",
      input_text_tokens: 100, input_image_tokens: 2000, output_tokens: 3000 } as any, IMG_TABLE);
    expect(c.priced).toBe(true);
    expect(c.currency).toBe("USD");
    expect(c.total_cost).toBeCloseTo(0.1065, 8);       // 0.0005 + 0.016 + 0.09
    expect(c.input_cost).toBeCloseTo(0.0165, 8);        // text 0.0005 + image 0.016
    expect(c.output_cost).toBeCloseTo(0.09, 8);
    expect(c.cache_cost).toBeNull();                    // cached 观测不到,永不出现
    expect(c.cost_breakdown!.lines).toHaveLength(3);
    expect(c.cost_breakdown!.lines.map((l) => l.cost)).toEqual(["0.00050000", "0.01600000", "0.09000000"]);
  });

  it("leaves gpt-image-2 NULL when modality split is missing (no silent estimate)", () => {
    const c = computeCost({ provider: "newapi", model: "gpt-image-2", operation: "image",
      input_tokens: 2100, output_tokens: 3000 } as any, IMG_TABLE); // 无 text/image 拆分
    expect(c.priced).toBe(false);
    expect(c.total_cost).toBeNull();
    expect(c.cost_breakdown).toBeNull();
  });

  it("still flat-prices image via per_image when text_input_per_mtok absent (back-compat)", () => {
    const FLAT: PriceTable = { version: "v", aliases: {}, rows: [{ version: "v", provider: "x", model: "m",
      operation: "image", input_tier_max: 0, input_per_mtok: null, output_per_mtok: null, text_input_per_mtok: null,
      cache_read_per_mtok: null, reasoning_per_mtok: null, per_image: 0.5, currency: "CNY" }] };
    const c = computeCost({ provider: "x", model: "m", operation: "image", image_count: 2 } as any, FLAT);
    expect(c.total_cost).toBeCloseTo(1.0, 8);
  });

  it("emits cost_breakdown for priced chat events too (modality:null lines)", () => {
    const c = computeCost({ ...base, input_tokens: 10_000, output_tokens: 1_000, cached_tokens: 4_000 }, TABLE);
    // [0,32K] 档: input 3.2/M, output 16/M, cache 0.64/M; non-cached input = 6000
    expect(c.priced).toBe(true);
    const bd = c.cost_breakdown!;
    expect(bd.currency).toBe("CNY");
    // 有缓存 → 三行(输入/缓存/输出),全 modality:null
    expect(bd.lines.map((l) => [l.component, l.modality])).toEqual([
      ["input", null], ["cache", null], ["output", null],
    ]);
    // breakdown 逐行成本对齐: 6000×3.2/M=0.0192, 4000×0.64/M=0.00256, 1000×16/M=0.016
    expect(bd.lines.map((l) => l.cost)).toEqual(["0.01920000", "0.00256000", "0.01600000"]);
    // 铁律: 明细各行求和必须等于落库 total_cost(无漂移)
    const sum = bd.lines.reduce((acc, l) => acc + Number(l.cost), 0);
    expect(round8(sum)).toBe(c.total_cost);
  });

  it("chat breakdown omits the cache line when no cached tokens", () => {
    const c = computeCost({ ...base, input_tokens: 10_000, output_tokens: 1_000, cached_tokens: 0 }, TABLE);
    const bd = c.cost_breakdown!;
    expect(bd.lines.map((l) => l.component)).toEqual(["input", "output"]); // 无缓存 → 无 cache 行
  });

  // ── AdopterA: newapi 文本模型 USD 计价(gpt-5.5 / gemini-3.5-flash, via example-gateway 网关) ──
  const TEXT_TABLE: PriceTable = { version: "2026-06-26a", aliases: {}, rows: [
    { version: "2026-06-26a", provider: "newapi", model: "gpt-5.5", operation: "chat", input_tier_max: 0,
      input_per_mtok: 5, output_per_mtok: 30, cache_read_per_mtok: 0.5,
      reasoning_per_mtok: null, per_image: null, text_input_per_mtok: null, currency: "USD" },
    { version: "2026-06-26a", provider: "newapi", model: "gemini-3.5-flash", operation: "chat", input_tier_max: 0,
      input_per_mtok: 1.5, output_per_mtok: 9, cache_read_per_mtok: 0.15,
      reasoning_per_mtok: 9, per_image: null, text_input_per_mtok: null, currency: "USD" },
  ] };

  it("prices gpt-5.5 in USD with cached split", () => {
    const c = computeCost({ provider: "newapi", model: "gpt-5.5", operation: "chat",
      input_tokens: 10_000, output_tokens: 1_000, cached_tokens: 2_000 }, TEXT_TABLE);
    expect(c.currency).toBe("USD");
    expect(c.input_cost).toBe(0.04);    // (10000-2000)/1e6*5
    expect(c.cache_cost).toBe(0.001);   // 2000/1e6*0.5
    expect(c.output_cost).toBe(0.03);   // 1000/1e6*30
    expect(c.total_cost).toBe(0.071);
  });

  it("does NOT double-bill gpt-5.5 reasoning (OpenAI completion_tokens already includes it)", () => {
    const c = computeCost({ provider: "newapi", model: "gpt-5.5", operation: "chat",
      input_tokens: 10_000, output_tokens: 1_000, reasoning_tokens: 500, cached_tokens: 0 }, TEXT_TABLE);
    // reasoning_per_mtok=null → reasoning 不单算(已含在 output=completion_tokens 计费里)
    expect(c.output_cost).toBe(0.03);
    expect(c.total_cost).toBe(0.08);    // input 0.05 + output 0.03
  });

  it("bills gemini thoughts at the output rate (reasoning_per_mtok set; Google '$9 incl. thinking')", () => {
    const c = computeCost({ provider: "newapi", model: "gemini-3.5-flash", operation: "chat",
      input_tokens: 10_000, output_tokens: 2_000, reasoning_tokens: 500, cached_tokens: 0 }, TEXT_TABLE);
    expect(c.currency).toBe("USD");
    expect(c.input_cost).toBe(0.015);    // 10000/1e6*1.5
    expect(c.output_cost).toBe(0.0225);  // candidates 2000@9 (0.018) + thoughts 500@9 (0.0045)
    expect(c.total_cost).toBe(0.0375);
    const sum = c.cost_breakdown!.lines.reduce((a, l) => a + Number(l.cost), 0);
    expect(round8(sum)).toBe(c.total_cost); // 铁律:逐行求和 == total
  });

  it("splits gemini cached input to cache_read rate (USD)", () => {
    const c = computeCost({ provider: "newapi", model: "gemini-3.5-flash", operation: "chat",
      input_tokens: 10_000, output_tokens: 0, cached_tokens: 4_000 }, TEXT_TABLE);
    expect(c.input_cost).toBe(0.009);    // 6000/1e6*1.5
    expect(c.cache_cost).toBe(0.0006);   // 4000/1e6*0.15
    expect(c.total_cost).toBe(0.0096);
  });
});

// helper used in test assertions only
const round8 = (n: number): number => Math.round(n * 1e8) / 1e8;
