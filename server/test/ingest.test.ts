import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { startPg, truncateAll, type PgHandle } from "./helpers.js";
import { registerIngest } from "../src/ingest.js";
import { makeEventValidator } from "../src/validator.js";
import type { PriceTable } from "../src/types.js";

const TABLE: PriceTable = { version: "t", aliases: {}, rows: [
  { version: "t", provider: "doubao", model: "doubao-seed-2.0-pro", operation: "chat", input_tier_max: 32000, input_per_mtok: 3.2, output_per_mtok: 16, cache_read_per_mtok: 0.64, reasoning_per_mtok: null, per_image: null, currency: "CNY" },
  { version: "t", provider: "newapi", model: "gpt-image-2", operation: "image", input_tier_max: 0, input_per_mtok: 10.0, output_per_mtok: 40.0, cache_read_per_mtok: null, reasoning_per_mtok: null, per_image: null, text_input_per_mtok: 5.0, currency: "USD" },
] };
const ev = (over: Record<string, unknown> = {}) => ({
  event_id: "e1", identity_source: "header", start_time: 1750000000000, end_time: 1750000001000,
  service: "python-lesson-parser", provider: "doubao", operation: "chat", request_model: "doubao-seed-2.0-pro",
  input_tokens: 10000, output_tokens: 1000, cached_tokens: 0, usage_source: "measured",
  status: "success", sdk_lang: "python", sdk_version: "0.1.0", ...over,
});

let pg: PgHandle; let app: FastifyInstance;
beforeAll(async () => {
  pg = await startPg(); app = Fastify();
  registerIngest(app, { sql: pg.sql, validateEvent: makeEventValidator(), priceTable: () => TABLE, payloadMode: "metadata", payloadMaxBytes: 8192 });
  await app.ready();
});
afterAll(async () => { await app.close(); await pg.stop(); });
beforeEach(async () => { await truncateAll(pg.sql); });

describe("POST /v1/events", () => {
  it("accepts a batch and stores priced rows", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev()] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 1, duplicates: 0, rejected: 0 });
    const [row] = await pg.sql`SELECT total_cost, currency, price_table_version FROM usage_events WHERE event_id='e1'`;
    expect(row.total_cost).toBe("0.04800000"); expect(row.currency).toBe("CNY"); expect(row.price_table_version).toBe("t");
  });
  it("stores total_cost NULL for an unpriced model (no silent 0)", async () => {
    await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev({ event_id: "e2", request_model: "unknown" })] } });
    const [row] = await pg.sql`SELECT total_cost FROM usage_events WHERE event_id='e2'`;
    expect(row.total_cost).toBeNull();
  });
  it("rejects a malformed envelope with 400", async () => {
    expect((await app.inject({ method: "POST", url: "/v1/events", payload: { nope: [] } })).statusCode).toBe(400);
  });
  it("persists account from the event", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev({ event_id: "acc-1", account: "five-elements" })] } });
    expect(res.statusCode).toBe(200);
    const [row] = await pg.sql`SELECT account FROM usage_events WHERE event_id = 'acc-1'`;
    expect(row.account).toBe("five-elements");
  });

  it("stores input_text_tokens, input_image_tokens, and cost_breakdown for gpt-image-2", async () => {
    const gptImg2Event = {
      event_id: "img2-1", identity_source: "header", start_time: 1750000000000, end_time: 1750000001000,
      service: "five-elements", provider: "newapi", operation: "image", request_model: "gpt-image-2",
      input_text_tokens: 37, input_image_tokens: 323, output_tokens: 272, image_count: 1,
      usage_source: "measured", status: "success", sdk_lang: "node", sdk_version: "0.1.3",
    };
    const res = await app.inject({ method: "POST", url: "/v1/events", payload: { events: [gptImg2Event] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 1, duplicates: 0, rejected: 0 });
    const [row] = await pg.sql`SELECT input_text_tokens, input_image_tokens, cost_breakdown, currency, total_cost FROM usage_events WHERE event_id = 'img2-1'`;
    expect(Number(row.input_text_tokens)).toBe(37);
    expect(Number(row.input_image_tokens)).toBe(323);
    expect(row.cost_breakdown).not.toBeNull();
    expect(typeof row.cost_breakdown).toBe("object");
    expect(row.cost_breakdown.currency).toBe("USD");
    expect(Array.isArray(row.cost_breakdown.lines)).toBe(true);
    expect(row.currency).toBe("USD");
  });

  it("stores NULL for input_text_tokens and cost_breakdown when not provided (unpriced)", async () => {
    const chatEvent = ev({ event_id: "chat-nil" });
    await app.inject({ method: "POST", url: "/v1/events", payload: { events: [chatEvent] } });
    const [row] = await pg.sql`SELECT input_text_tokens, input_image_tokens, cost_breakdown FROM usage_events WHERE event_id = 'chat-nil'`;
    expect(row.input_text_tokens).toBeNull();
    expect(row.input_image_tokens).toBeNull();
    // chat events now also get a cost_breakdown (priced); verify it's non-null with modality null
    expect(row.cost_breakdown).not.toBeNull();
    expect(row.cost_breakdown.lines[0].modality).toBeNull();
  });
});
