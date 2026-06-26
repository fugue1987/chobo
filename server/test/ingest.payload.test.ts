import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { startPg, truncateAll, type PgHandle } from "./helpers.js";
import { registerIngest } from "../src/ingest.js";
import { makeEventValidator } from "../src/validator.js";
import type { PriceTable } from "../src/types.js";

const TABLE: PriceTable = { version: "t", aliases: {}, rows: [] };

const base = {
  identity_source: "header" as const,
  start_time: 1750000000000,
  service: "s",
  provider: "doubao",
  operation: "chat" as const,
  request_model: "m",
  usage_source: "measured" as const,
  status: "success" as const,
  sdk_lang: "node" as const,
  sdk_version: "0.1.0",
};

let pg: PgHandle;
let app: FastifyInstance;

beforeAll(async () => {
  pg = await startPg();
  app = Fastify({ logger: false });
  // payloadMode: "truncated", payloadMaxBytes: 20
  registerIngest(app, { sql: pg.sql, validateEvent: makeEventValidator(), priceTable: () => TABLE, payloadMode: "truncated", payloadMaxBytes: 20 });
  await app.ready();
});
afterAll(async () => { await app.close(); await pg.stop(); });
beforeEach(async () => { await truncateAll(pg.sql); });

describe("payload truncation path", () => {
  it("stores truncated=true, redacted=true, and bounded request_payload when payload is large", async () => {
    const largeRequest = { message: "A".repeat(500), context: "B".repeat(500), data: [1, 2, 3, 4, 5] };
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        events: [{
          ...base,
          event_id: "trunc-1",
          payload: { request: largeRequest, redacted: true },
        }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(1);

    const [row] = await pg.sql<{ truncated: boolean; redacted: boolean; request_payload: unknown }[]>`
      SELECT truncated, redacted, request_payload FROM event_payloads WHERE event_id = 'trunc-1'
    `;
    expect(row).toBeDefined();
    expect(row.truncated).toBe(true);
    expect(row.redacted).toBe(true);
    // The serialized stored value must be within a small constant of the 20-byte cap
    const storedSize = Buffer.byteLength(JSON.stringify(row.request_payload), "utf8");
    // The _truncated wrapper adds overhead: {"_truncated":"..."} = ~16 chars overhead, plus the bounded inner string
    expect(storedSize).toBeLessThanOrEqual(20 + 32);
  });

  it("stores truncated=false and payload intact when payload is under the cap", async () => {
    const tinyRequest = { x: 1 };
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        events: [{
          ...base,
          event_id: "tiny-1",
          payload: { request: tinyRequest },
        }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(1);

    const [row] = await pg.sql<{ truncated: boolean; redacted: boolean; request_payload: unknown }[]>`
      SELECT truncated, redacted, request_payload FROM event_payloads WHERE event_id = 'tiny-1'
    `;
    expect(row).toBeDefined();
    expect(row.truncated).toBe(false);
    expect(row.redacted).toBe(false);
    // Payload stored intact
    expect(row.request_payload).toEqual(tinyRequest);
  });
});
