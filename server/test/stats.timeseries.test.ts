import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { startPg, truncateAll, type PgHandle } from "./helpers.js";
import { registerStats } from "../src/stats.js";

let pg: PgHandle; let app: FastifyInstance;
beforeAll(async () => { pg = await startPg(); app = Fastify(); registerStats(app, { sql: pg.sql }); await app.ready(); });
afterAll(async () => { await app.close(); await pg.stop(); });
beforeEach(async () => {
  await truncateAll(pg.sql);
  // Asymmetric data: June-01 → 150 tokens / 0.15 cost CNY; June-02 → 450 tokens / 0.45 cost CNY.
  // Symmetric totals (300/300) would hide row-order bugs and leave ts un-assertable.
  await pg.sql`INSERT INTO usage_events (event_id, identity_source, start_time, service, provider, operation, request_model, usage_source, status, total_tokens, total_cost, currency, created_at) VALUES
    ('d1','header', now(),'s','doubao','chat','m','measured','success',  50, 0.05,'CNY','2026-06-01T10:00:00Z'),
    ('d2','header', now(),'s','doubao','chat','m','measured','success', 100, 0.10,'CNY','2026-06-01T11:00:00Z'),
    ('d3','header', now(),'s','doubao','chat','m','measured','success', 450, 0.45,'CNY','2026-06-02T09:00:00Z')`;
});

describe("GET /v1/stats/timeseries", () => {
  it("buckets by day, returns correct asymmetric totals and ordered ts (pure CNY)", async () => {
    const s = (await app.inject({ method: "GET", url: "/v1/stats/timeseries?bucket=day&from=2026-06-01T00:00:00Z&to=2026-06-03T00:00:00Z" })).json().series;
    expect(s).toHaveLength(2);
    // Bucket order: June-01 first, June-02 second
    expect(s[0].ts).toContain("2026-06-01");
    expect(s[0].total_tokens).toBe(150);
    // New shape: cost_by_currency, no scalar total_cost
    expect(s[0].cost_by_currency).toHaveLength(1);
    expect(s[0].cost_by_currency[0]).toMatchObject({ currency: "CNY", total_cost: "0.15000000" });
    expect(s[0]).not.toHaveProperty("total_cost");

    expect(s[1].ts).toContain("2026-06-02");
    expect(s[1].total_tokens).toBe(450);
    expect(s[1].cost_by_currency).toHaveLength(1);
    expect(s[1].cost_by_currency[0]).toMatchObject({ currency: "CNY", total_cost: "0.45000000" });
    expect(s[1]).not.toHaveProperty("total_cost");
  });

  it("rejects an invalid bucket", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/stats/timeseries?bucket=fortnight" })).statusCode).toBe(400);
  });

  it("mixed CNY+USD in same bucket → both in cost_by_currency, no top-level currency", async () => {
    await truncateAll(pg.sql);
    await pg.sql`INSERT INTO usage_events (event_id, identity_source, start_time, service, provider, operation, request_model, usage_source, status, total_tokens, total_cost, currency, created_at) VALUES
      ('x1','header', now(),'s','doubao','chat','m','measured','success', 100, 0.10,'CNY','2026-06-01T10:00:00Z'),
      ('x2','header', now(),'s','newapi','image','gpt-image-2','measured','success', 500, 0.04,'USD','2026-06-01T12:00:00Z')`;
    const res = (await app.inject({ method: "GET", url: "/v1/stats/timeseries?bucket=day&from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z" })).json();
    expect(res).not.toHaveProperty("currency");
    const s = res.series;
    expect(s).toHaveLength(1);
    const cbc = s[0].cost_by_currency as Array<{ currency: string; total_cost: string }>;
    expect(cbc).toHaveLength(2);
    expect(cbc.find((e) => e.currency === "CNY")).toMatchObject({ currency: "CNY", total_cost: "0.10000000" });
    expect(cbc.find((e) => e.currency === "USD")).toMatchObject({ currency: "USD", total_cost: "0.04000000" });
    expect(s[0]).not.toHaveProperty("total_cost");
  });

  it("bucket with no priced rows → cost_by_currency is empty array", async () => {
    await truncateAll(pg.sql);
    await pg.sql`INSERT INTO usage_events (event_id, identity_source, start_time, service, provider, operation, request_model, usage_source, status, total_tokens, total_cost, currency, created_at) VALUES
      ('n1','header', now(),'s','doubao','chat','m','measured','success', 100, NULL, NULL, '2026-06-01T10:00:00Z')`;
    const s = (await app.inject({ method: "GET", url: "/v1/stats/timeseries?bucket=day&from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z" })).json().series;
    expect(s).toHaveLength(1);
    expect(s[0].cost_by_currency).toEqual([]);
  });
});
