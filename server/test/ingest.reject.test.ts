import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { startPg, truncateAll, type PgHandle } from "./helpers.js";
import { registerIngest } from "../src/ingest.js";
import { makeEventValidator } from "../src/validator.js";
import type { PriceTable } from "../src/types.js";

const TABLE: PriceTable = { version: "t", aliases: {}, rows: [] };
const good = { event_id: "ok", identity_source: "header", start_time: 1750000000000, service: "s", provider: "doubao", operation: "chat", request_model: "m", usage_source: "measured", status: "success", sdk_lang: "node", sdk_version: "0.1.0" };
const bad = { event_id: "bad", operation: "translate" };

let pg: PgHandle; let app: FastifyInstance;
beforeAll(async () => { pg = await startPg(); app = Fastify({ logger: false }); registerIngest(app, { sql: pg.sql, validateEvent: makeEventValidator(), priceTable: () => TABLE, payloadMode: "metadata", payloadMaxBytes: 8192 }); await app.ready(); });
afterAll(async () => { await app.close(); await pg.stop(); });
beforeEach(async () => { await truncateAll(pg.sql); });

describe("lenient partial accept", () => {
  it("inserts valid, counts invalid, returns 200 (no poison-batch)", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/events", payload: { events: [good, bad] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 1, duplicates: 0, rejected: 1 });
    const rows = await pg.sql`SELECT event_id FROM usage_events`;
    expect(rows.map((r) => r.event_id)).toEqual(["ok"]);
  });
});
