/**
 * Regression test for billing-integrity bugs:
 *   - input_tokens: 3000000000 (> PG integer max) would 500 the whole batch
 *   - start_time: 99999999999999999 (out of JS Date range) would 500 the whole batch
 *   - input_tokens: -5 (negative) would produce negative cost
 * After the fix: all three bad events go to rejected=3, good event is accepted=1, no 500.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { startPg, truncateAll, type PgHandle } from "./helpers.js";
import { registerIngest } from "../src/ingest.js";
import { makeEventValidator } from "../src/validator.js";
import type { PriceTable } from "../src/types.js";

// A minimal price table with a real row so the good event gets priced
const TABLE: PriceTable = {
  version: "test-v1",
  aliases: {},
  rows: [
    {
      version: "test-v1", provider: "doubao", model: "m", operation: "chat",
      input_tier_max: 0,
      input_per_mtok: 0.8, output_per_mtok: 3.2,
      cache_read_per_mtok: null, reasoning_per_mtok: null, per_image: null,
      currency: "CNY",
    },
  ],
};

const goodEvent = {
  event_id: "good-1",
  identity_source: "header",
  start_time: 1750000000000,
  service: "test",
  provider: "doubao",
  operation: "chat",
  request_model: "m",
  usage_source: "measured",
  status: "success",
  sdk_lang: "node",
  sdk_version: "0.1.0",
  input_tokens: 100,
  output_tokens: 50,
};

// Passes JSON-schema (input_tokens is a number) but exceeds PG integer max
const overflowTokensEvent = {
  event_id: "bad-overflow",
  identity_source: "header",
  start_time: 1750000000000,
  service: "test",
  provider: "doubao",
  operation: "chat",
  request_model: "m",
  usage_source: "measured",
  status: "success",
  sdk_lang: "node",
  sdk_version: "0.1.0",
  input_tokens: 3_000_000_000,   // > INT_MAX(2147483647) → would cause PG 22003
};

// Passes JSON-schema but timestamp is outside JS Date valid range → toISOString() throws
const badTimestampEvent = {
  event_id: "bad-timestamp",
  identity_source: "header",
  start_time: 99_999_999_999_999_999,   // > 8.64e15 → new Date(...).toISOString() throws RangeError
  service: "test",
  provider: "doubao",
  operation: "chat",
  request_model: "m",
  usage_source: "measured",
  status: "success",
  sdk_lang: "node",
  sdk_version: "0.1.0",
};

// Passes JSON-schema but negative tokens would yield negative cost
const negativeTokensEvent = {
  event_id: "bad-negative",
  identity_source: "header",
  start_time: 1750000000000,
  service: "test",
  provider: "doubao",
  operation: "chat",
  request_model: "m",
  usage_source: "measured",
  status: "success",
  sdk_lang: "node",
  sdk_version: "0.1.0",
  input_tokens: -5,   // negative → rejected by storability gate
};

let pg: PgHandle;
let app: FastifyInstance;

beforeAll(async () => {
  pg = await startPg();
  app = Fastify({ logger: false });
  registerIngest(app, {
    sql: pg.sql,
    validateEvent: makeEventValidator(),
    priceTable: () => TABLE,
    payloadMode: "metadata",
    payloadMaxBytes: 8192,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pg.stop();
});

beforeEach(async () => {
  await truncateAll(pg.sql);
});

describe("storability gate — unstorable events rejected, batch never 500s", () => {
  it("batch with 1 good + 3 unstorable: 200, accepted=1, rejected=3", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        events: [goodEvent, overflowTokensEvent, badTimestampEvent, negativeTokensEvent],
      },
    });

    // Must be 200 (not 500) — one bad event must never kill the batch
    expect(res.statusCode).toBe(200);

    const body = res.json<{ accepted: number; duplicates: number; rejected: number }>();
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(3);
    expect(body.duplicates).toBe(0);
  });

  it("only the good event's row exists in usage_events", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        events: [goodEvent, overflowTokensEvent, badTimestampEvent, negativeTokensEvent],
      },
    });

    const rows = await pg.sql<{ event_id: string }[]>`SELECT event_id FROM usage_events`;
    expect(rows.map((r) => r.event_id)).toEqual(["good-1"]);
  });

  it("no row has negative total_cost (sanity check)", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        events: [goodEvent, overflowTokensEvent, badTimestampEvent, negativeTokensEvent],
      },
    });

    const rows = await pg.sql<{ total_cost: string | null }[]>`
      SELECT total_cost FROM usage_events WHERE total_cost IS NOT NULL
    `;
    for (const r of rows) {
      expect(Number(r.total_cost)).toBeGreaterThanOrEqual(0);
    }
  });
});
