import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startPg, type PgHandle } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { loadPriceTable } from "../src/pricing.js";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../src/types.js";

const CFG: ServerConfig = { databaseUrl: "", host: "0.0.0.0", port: 0, ingestSecret: null, payloadMode: "metadata", payloadMaxBytes: 8192, priceSeedPath: null };
const ev = (id: string, user: string, inTok: number, outTok: number) => ({
  event_id: id, user_id: user, org_id: "school1", project: "goal_generation",
  identity_source: "header", start_time: 1750000000000, end_time: 1750000001000,
  service: "python-lesson-parser", provider: "doubao", operation: "chat",
  request_model: "doubao-seed-2-0-pro-260215",  // 带版本 id —— 经别名归一后算价
  input_tokens: inTok, output_tokens: outTok, total_tokens: inTok + outTok, cached_tokens: 0,
  usage_source: "measured", status: "success", sdk_lang: "python", sdk_version: "0.1.0",
});

let pg: PgHandle; let app: FastifyInstance;
beforeAll(async () => {
  pg = await startPg();
  await pg.sql`INSERT INTO price_table (version,provider,model,operation,input_tier_max,input_per_mtok,output_per_mtok,cache_read_per_mtok,currency) VALUES
    ('e2e','doubao','doubao-seed-2.0-pro','chat',32000,3.2,16,0.64,'CNY')`;
  await pg.sql`INSERT INTO model_aliases (provider,alias,canonical) VALUES ('doubao','doubao-seed-2-0-pro-260215','doubao-seed-2.0-pro')`;
  const priceTable = await loadPriceTable(pg.sql);
  app = buildApp({ sql: pg.sql, cfg: CFG, priceTable: () => priceTable });
  await app.ready();
});
afterAll(async () => { await app.close(); await pg.stop(); });

describe("end-to-end", () => {
  it("ingests dated-id events (priced via alias) then stats reflect it", async () => {
    const post = await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev("x1", "teacherA", 10000, 1000), ev("x2", "teacherA", 20000, 2000), ev("x3", "teacherB", 5000, 500)] } });
    expect(post.json()).toEqual({ accepted: 3, duplicates: 0, rejected: 0 });

    const ov = (await app.inject({ method: "GET", url: "/v1/stats/overview" })).json();
    expect(ov.totals.events).toBe(3);
    expect(ov.totals.total_tokens).toBe(38500);
    // New shape: cost_by_currency (no cross-currency scalar); all events are CNY doubao
    expect(ov.totals.cost_by_currency).toHaveLength(1);
    expect(ov.totals.cost_by_currency[0]).toMatchObject({ currency: "CNY", total_cost: "0.16800000" }); // 归一化算价端到端验证

    const byUser = (await app.inject({ method: "GET", url: "/v1/stats/by-user" })).json();
    expect(byUser.rows[0].key).toBe("teacherA"); expect(byUser.rows[0].events).toBe(2);

    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ ok: true });
  });
});
