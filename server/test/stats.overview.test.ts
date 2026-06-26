import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { startPg, truncateAll, type PgHandle } from "./helpers.js";
import { registerStats } from "../src/stats.js";

async function seed(sql: PgHandle["sql"]) {
  await sql`INSERT INTO usage_events (event_id, identity_source, start_time, service, provider, operation, request_model, usage_source, status, input_tokens, output_tokens, total_tokens, total_cost, currency, created_at) VALUES
    ('a','header', now(),'s','doubao','chat','m','measured','success', 100, 50, 150, 0.05,'CNY', now()),
    ('b','header', now(),'s','doubao','chat','m','measured','failure', 10, 0, 10, 0.01,'CNY', now()),
    ('c','header', now(),'s','example-gateway','chat','g','measured','success', 200, 80, 280, 0.20,'CNY', now())`;
}

async function seedMixed(sql: PgHandle["sql"]) {
  // CNY doubao event + USD gpt-image-2 event (mixed currencies)
  await sql`INSERT INTO usage_events (event_id, identity_source, start_time, service, provider, operation, request_model, usage_source, status, input_tokens, output_tokens, total_tokens, total_cost, currency, created_at) VALUES
    ('m1','header', now(),'s','doubao','chat','doubao-pro','measured','success', 100, 50, 150, 0.05,'CNY', now()),
    ('m2','header', now(),'s','newapi','image','gpt-image-2','measured','success', 500, 0, 500, 0.04,'USD', now())`;
}

let pg: PgHandle; let app: FastifyInstance;
beforeAll(async () => { pg = await startPg(); app = Fastify(); registerStats(app, { sql: pg.sql }); await app.ready(); });
afterAll(async () => { await app.close(); await pg.stop(); });
beforeEach(async () => { await truncateAll(pg.sql); await seed(pg.sql); });

describe("GET /v1/stats/overview", () => {
  it("totals events/tokens by-status + cost_by_currency (pure CNY)", async () => {
    const body = (await app.inject({ method: "GET", url: "/v1/stats/overview" })).json();
    expect(body.totals.events).toBe(3);
    expect(body.totals.total_tokens).toBe(440);
    // New shape: cost_by_currency array, no scalar total_cost, no top-level currency
    expect(body.totals.cost_by_currency).toHaveLength(1);
    expect(body.totals.cost_by_currency[0]).toMatchObject({ currency: "CNY", total_cost: "0.26000000" });
    expect(body.totals).not.toHaveProperty("total_cost");
    expect(body).not.toHaveProperty("currency");
    expect(body.totals.by_status).toEqual({ success: 2, failure: 1 });
  });

  it("applies a provider filter", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/stats/overview?provider=example-gateway" })).json().totals.events).toBe(1);
  });

  it("mixed CNY+USD: cost_by_currency has two entries, no cross-currency sum", async () => {
    await truncateAll(pg.sql);
    await seedMixed(pg.sql);
    const body = (await app.inject({ method: "GET", url: "/v1/stats/overview" })).json();
    expect(body.totals.events).toBe(2);
    // Must have two separate currency buckets
    const cbc = body.totals.cost_by_currency as Array<{ currency: string; total_cost: string }>;
    expect(cbc).toHaveLength(2);
    const cny = cbc.find((e) => e.currency === "CNY");
    const usd = cbc.find((e) => e.currency === "USD");
    expect(cny).toBeDefined();
    expect(usd).toBeDefined();
    expect(cny!.total_cost).toBe("0.05000000");
    expect(usd!.total_cost).toBe("0.04000000");
    // Absolutely no field that adds them together
    expect(body.totals).not.toHaveProperty("total_cost");
    expect(body).not.toHaveProperty("currency");
  });

  it("no priced rows → cost_by_currency is empty array", async () => {
    await truncateAll(pg.sql);
    await pg.sql`INSERT INTO usage_events (event_id, identity_source, start_time, service, provider, operation, request_model, usage_source, status, total_tokens, total_cost, currency, created_at) VALUES
      ('n1','header', now(),'s','doubao','chat','m','measured','success', 100, NULL, NULL, now())`;
    const body = (await app.inject({ method: "GET", url: "/v1/stats/overview" })).json();
    expect(body.totals.cost_by_currency).toEqual([]);
    expect(body.totals).not.toHaveProperty("total_cost");
  });
});
