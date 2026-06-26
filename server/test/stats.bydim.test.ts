import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { startPg, truncateAll, type PgHandle } from "./helpers.js";
import { registerStats } from "../src/stats.js";

let pg: PgHandle; let app: FastifyInstance;
beforeAll(async () => { pg = await startPg(); app = Fastify(); registerStats(app, { sql: pg.sql }); await app.ready(); });
afterAll(async () => { await app.close(); await pg.stop(); });
beforeEach(async () => {
  await truncateAll(pg.sql);
  await pg.sql`INSERT INTO usage_events (event_id, identity_source, start_time, service, provider, operation, request_model, usage_source, status, user_id, total_tokens, total_cost, currency, created_at) VALUES
    ('u1','header',now(),'s','doubao','chat','m','measured','success','teacherA',100,0.10,'CNY',now()),
    ('u2','header',now(),'s','doubao','chat','m','measured','success','teacherA',300,0.30,'CNY',now()),
    ('u3','header',now(),'s','doubao','chat','m','measured','success','teacherB', 50,0.05,'CNY',now())`;
});

describe("GET /v1/stats/by-user", () => {
  it("aggregates per user, ordered by tokens desc (pure CNY)", async () => {
    const rows = (await app.inject({ method: "GET", url: "/v1/stats/by-user" })).json().rows;
    // New shape: cost_by_currency, no scalar total_cost, no top-level currency
    expect(rows[0]).toMatchObject({ key: "teacherA", events: 2, total_tokens: 400 });
    expect(rows[0].cost_by_currency).toHaveLength(1);
    expect(rows[0].cost_by_currency[0]).toMatchObject({ currency: "CNY", total_cost: "0.40000000" });
    expect(rows[0]).not.toHaveProperty("total_cost");
    expect(rows[1]).toMatchObject({ key: "teacherB", events: 1, total_tokens: 50 });
    expect(rows[1].cost_by_currency).toHaveLength(1);
  });

  it("no top-level currency field on by-dim endpoints", async () => {
    const body = (await app.inject({ method: "GET", url: "/v1/stats/by-user" })).json();
    expect(body).not.toHaveProperty("currency");
  });

  it("by-org returns null key for rows without org_id, and by-project shares the impl", async () => {
    // Seed data has no org_id → the group key must be null, not missing
    const body = (await app.inject({ method: "GET", url: "/v1/stats/by-org" })).json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].key).toBeNull();
    expect(body.rows[0].events).toBeGreaterThan(0);
    // null key row still has cost_by_currency
    expect(body.rows[0]).toHaveProperty("cost_by_currency");
    expect(body.rows[0]).not.toHaveProperty("total_cost");
    expect((await app.inject({ method: "GET", url: "/v1/stats/by-project" })).statusCode).toBe(200);
  });

  it("mixed CNY+USD for same user → cost_by_currency has both currencies", async () => {
    await truncateAll(pg.sql);
    await pg.sql`INSERT INTO usage_events (event_id, identity_source, start_time, service, provider, operation, request_model, usage_source, status, user_id, total_tokens, total_cost, currency, created_at) VALUES
      ('mx1','header',now(),'s','doubao','chat','m','measured','success','teacher1',100,0.10,'CNY',now()),
      ('mx2','header',now(),'s','newapi','image','gpt-image-2','measured','success','teacher1',500,0.04,'USD',now()),
      ('mx3','header',now(),'s','doubao','chat','m','measured','success','teacher2', 50,0.05,'CNY',now())`;
    const rows = (await app.inject({ method: "GET", url: "/v1/stats/by-user" })).json().rows;
    // teacher1 has both CNY and USD
    const t1 = rows.find((r: any) => r.key === "teacher1");
    expect(t1).toBeDefined();
    const cbc = t1.cost_by_currency as Array<{ currency: string; total_cost: string }>;
    expect(cbc).toHaveLength(2);
    expect(cbc.find((e) => e.currency === "CNY")).toMatchObject({ currency: "CNY", total_cost: "0.10000000" });
    expect(cbc.find((e) => e.currency === "USD")).toMatchObject({ currency: "USD", total_cost: "0.04000000" });
    // Must not have a summed scalar
    expect(t1).not.toHaveProperty("total_cost");
    // teacher2 has only CNY
    const t2 = rows.find((r: any) => r.key === "teacher2");
    expect(t2.cost_by_currency).toHaveLength(1);
    expect(t2.cost_by_currency[0].currency).toBe("CNY");
  });

  it("null dim key with mixed currencies correctly merges cost_by_currency", async () => {
    await truncateAll(pg.sql);
    // org_id is null for all — tests null-key handling in the cost merge Map
    await pg.sql`INSERT INTO usage_events (event_id, identity_source, start_time, service, provider, operation, request_model, usage_source, status, total_tokens, total_cost, currency, created_at) VALUES
      ('nk1','header',now(),'s','doubao','chat','m','measured','success',100,0.10,'CNY',now()),
      ('nk2','header',now(),'s','newapi','image','gpt-image-2','measured','success',500,0.04,'USD',now())`;
    const body = (await app.inject({ method: "GET", url: "/v1/stats/by-org" })).json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].key).toBeNull();
    const cbc = body.rows[0].cost_by_currency as Array<{ currency: string; total_cost: string }>;
    expect(cbc).toHaveLength(2);
    expect(cbc.find((e) => e.currency === "CNY")).toBeDefined();
    expect(cbc.find((e) => e.currency === "USD")).toBeDefined();
  });
});
