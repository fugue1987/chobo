import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { startPg, truncateAll, type PgHandle } from "./helpers.js";
import { registerIngest } from "../src/ingest.js";
import { makeEventValidator } from "../src/validator.js";
import type { PriceTable } from "../src/types.js";

const TABLE: PriceTable = { version: "t", aliases: {}, rows: [] };
const ev = (id: string) => ({ event_id: id, identity_source: "header", start_time: 1750000000000, service: "s", provider: "doubao", operation: "chat", request_model: "m", usage_source: "measured", status: "success", sdk_lang: "node", sdk_version: "0.1.0" });

let pg: PgHandle; let app: FastifyInstance;
beforeAll(async () => { pg = await startPg(); app = Fastify(); registerIngest(app, { sql: pg.sql, validateEvent: makeEventValidator(), priceTable: () => TABLE, payloadMode: "metadata", payloadMaxBytes: 8192 }); await app.ready(); });
afterAll(async () => { await app.close(); await pg.stop(); });
beforeEach(async () => { await truncateAll(pg.sql); });

describe("idempotency", () => {
  it("same event_id twice -> one row", async () => {
    expect((await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev("dup")] } })).json()).toEqual({ accepted: 1, duplicates: 0, rejected: 0 });
    expect((await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev("dup")] } })).json()).toEqual({ accepted: 0, duplicates: 1, rejected: 0 });
    const [{ count }] = await pg.sql<{ count: string }[]>`SELECT count(*) FROM usage_events WHERE event_id='dup'`;
    expect(count).toBe("1");
  });
  it("mixed new + dup in one batch", async () => {
    await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev("a")] } });
    expect((await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev("a"), ev("b")] } })).json()).toEqual({ accepted: 1, duplicates: 1, rejected: 0 });
  });
});
