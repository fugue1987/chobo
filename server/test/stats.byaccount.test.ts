import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { startPg, truncateAll, type PgHandle } from "./helpers.js";
import { registerStats } from "../src/stats.js";

let pg: PgHandle; let app: FastifyInstance;
beforeAll(async () => { pg = await startPg(); app = Fastify(); registerStats(app, { sql: pg.sql }); await app.ready(); });
afterAll(async () => { await app.close(); await pg.stop(); });
beforeEach(async () => {
  await truncateAll(pg.sql);
  await pg.sql`INSERT INTO usage_events (event_id, identity_source, start_time, service, provider, operation, request_model, usage_source, status, user_id, account, total_tokens, total_cost, currency, created_at) VALUES
    ('a1','header',now(),'s','doubao','chat','m','measured','success','teacherA','five-elements',100,0.10,'CNY',now()),
    ('a2','header',now(),'s','doubao','chat','m','measured','success','teacherA','five-elements',300,0.30,'CNY',now()),
    ('a3','header',now(),'s','doubao','chat','m','measured','success','teacherB','other-account', 50,0.05,'CNY',now())`;
});

describe("GET /v1/stats/by-account", () => {
  it("aggregates per account", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/stats/by-account" });
    expect(res.statusCode).toBe(200);
    const rows = res.json().rows;
    expect(rows.find((r: any) => r.key === "five-elements")).toBeTruthy();
  });

  it("aggregates correctly: five-elements has 2 events, 400 tokens, cost_by_currency CNY 0.40", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/stats/by-account" });
    const rows = res.json().rows;
    const fe = rows.find((r: any) => r.key === "five-elements");
    // New shape: cost_by_currency instead of scalar total_cost
    expect(fe).toMatchObject({ key: "five-elements", events: 2, total_tokens: 400 });
    expect(fe).not.toHaveProperty("total_cost");
    expect(fe.cost_by_currency).toHaveLength(1);
    expect(fe.cost_by_currency[0]).toMatchObject({ currency: "CNY", total_cost: "0.40000000" });
  });

  it("?account=X narrows results", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/stats/by-user?account=five-elements" });
    expect(res.statusCode).toBe(200);
    // only rows with account=five-elements are counted — teacherA has 2 rows, teacherB is filtered out
    const rows = res.json().rows;
    expect(rows.find((r: any) => r.key === "teacherA")).toBeTruthy();
    expect(rows.find((r: any) => r.key === "teacherB")).toBeFalsy();
  });

  it("no top-level currency field on by-account", async () => {
    const body = (await app.inject({ method: "GET", url: "/v1/stats/by-account" })).json();
    expect(body).not.toHaveProperty("currency");
  });

  it("mixed CNY+USD for same account → cost_by_currency has both", async () => {
    await truncateAll(pg.sql);
    await pg.sql`INSERT INTO usage_events (event_id, identity_source, start_time, service, provider, operation, request_model, usage_source, status, account, total_tokens, total_cost, currency, created_at) VALUES
      ('ac1','header',now(),'s','doubao','chat','m','measured','success','acme',200,0.20,'CNY',now()),
      ('ac2','header',now(),'s','newapi','image','gpt-image-2','measured','success','acme',500,0.08,'USD',now())`;
    const rows = (await app.inject({ method: "GET", url: "/v1/stats/by-account" })).json().rows;
    const acme = rows.find((r: any) => r.key === "acme");
    expect(acme).toBeDefined();
    const cbc = acme.cost_by_currency as Array<{ currency: string; total_cost: string }>;
    expect(cbc).toHaveLength(2);
    expect(cbc.find((e) => e.currency === "CNY")).toMatchObject({ total_cost: "0.20000000" });
    expect(cbc.find((e) => e.currency === "USD")).toMatchObject({ total_cost: "0.08000000" });
    expect(acme).not.toHaveProperty("total_cost");
  });
});
