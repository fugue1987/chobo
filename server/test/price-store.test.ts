import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPriceStore } from "../src/price-store.js";
import { startPg, type PgHandle } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { loadPriceTable } from "../src/pricing.js";
import type { FastifyInstance } from "fastify";
import type { PriceTable, ServerConfig } from "../src/types.js";

const silent = { info: () => {}, warn: () => {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 造一个价目表桩(供注入式单元测试)
const T = (version: string, models: string[]): PriceTable => ({
  version,
  rows: models.map((m) => ({
    version, provider: "newapi", model: m, operation: "chat", input_tier_max: 0,
    input_per_mtok: 1, output_per_mtok: 1, cache_read_per_mtok: null,
    reasoning_per_mtok: null, per_image: null, text_input_per_mtok: null, currency: "USD",
  })),
  aliases: {},
});

describe("createPriceStore (injected loader)", () => {
  it("refreshNow swaps to a newer table and reports changed", async () => {
    const next = T("v2", ["a", "b"]);
    const store = createPriceStore(async () => next, T("v1", ["a"]), silent);
    expect(store.current().version).toBe("v1");
    expect(await store.refreshNow()).toBe(true);
    expect(store.current().version).toBe("v2");
    expect(store.current().rows).toHaveLength(2);
  });

  it("keeps last-good and returns false when the loader throws", async () => {
    const store = createPriceStore(async () => { throw new Error("db down"); }, T("v1", ["a"]), silent);
    expect(await store.refreshNow()).toBe(false);
    expect(store.current().version).toBe("v1"); // 未被清空
  });

  it("empty-table guard: keeps last-good when loader returns an empty table", async () => {
    const empty: PriceTable = { version: "", rows: [], aliases: {} };
    const store = createPriceStore(async () => empty, T("v1", ["a"]), silent);
    expect(await store.refreshNow()).toBe(false);
    expect(store.current().version).toBe("v1");
  });

  it("start polls until stop", async () => {
    let calls = 0;
    const store = createPriceStore(async () => { calls++; return T("v1", ["a"]); }, T("v1", ["a"]), silent);
    store.start(5);
    await sleep(40);
    const afterStart = calls;
    store.stop();
    expect(afterStart).toBeGreaterThanOrEqual(2);
    await sleep(40);
    expect(calls).toBe(afterStart); // stop 后不再刷新
  });
});

// 集成:证明 写库 → refreshNow → 经真实 HTTP ingest 路径定价 的整环
const CFG: ServerConfig = {
  databaseUrl: "", host: "0.0.0.0", port: 0, ingestSecret: null,
  payloadMode: "metadata", payloadMaxBytes: 8192, bodyLimit: 16 * 1024 * 1024,
  priceSeedPath: null, webDir: null, priceRefreshSec: 0,
};
const sonnetEv = (id: string) => ({
  event_id: id, user_id: "u1", org_id: "o1", project: "p1",
  identity_source: "header", start_time: 1750000000000, end_time: 1750000001000,
  service: "svc", provider: "newapi", operation: "chat",
  request_model: "claude-sonnet-5",
  input_tokens: 1000000, output_tokens: 0, total_tokens: 1000000, cached_tokens: 0,
  usage_source: "measured", status: "success", sdk_lang: "node", sdk_version: "0.1.0",
});

describe("createPriceStore + ingest (runtime hot reload)", () => {
  let pg: PgHandle; let app: FastifyInstance;
  let store: ReturnType<typeof createPriceStore>;
  beforeAll(async () => {
    pg = await startPg();
    // 初始版本 v1:只有 doubao,没有 claude-sonnet-5
    await pg.sql`INSERT INTO price_table (version,provider,model,operation,input_tier_max,input_per_mtok,output_per_mtok,currency)
      VALUES ('v1','doubao','doubao-seed-2.0-pro','chat',0,3.2,16,'CNY')`;
    const initial = await loadPriceTable(pg.sql);
    store = createPriceStore(() => loadPriceTable(pg.sql), initial, silent);
    app = buildApp({ sql: pg.sql, cfg: CFG, priceTable: store.current });
    await app.ready();
  });
  afterAll(async () => { store.stop(); await app.close(); await pg.stop(); });

  it("new model = NULL before its price exists, non-NULL after runtime insert + refreshNow", async () => {
    // 1) 补价前:新模型事件落库,total_cost = NULL(诚实)
    const before = await app.inject({ method: "POST", url: "/v1/events", payload: { events: [sonnetEv("sonnet-before")] } });
    expect(before.json()).toMatchObject({ accepted: 1 });
    const [b] = await pg.sql<{ total_cost: string | null }[]>`SELECT total_cost FROM usage_events WHERE event_id='sonnet-before'`;
    expect(b.total_cost).toBeNull();

    // 2) 运行中插入含 claude-sonnet-5 的【更高】版本(整版快照:doubao + 新模型)
    await pg.sql`INSERT INTO price_table (version,provider,model,operation,input_tier_max,input_per_mtok,output_per_mtok,currency) VALUES
      ('v2','doubao','doubao-seed-2.0-pro','chat',0,3.2,16,'CNY'),
      ('v2','newapi','claude-sonnet-5','chat',0,3,15,'USD')`;

    // 3) 热载
    expect(await store.refreshNow()).toBe(true);
    expect(store.current().version).toBe("v2");

    // 4) 补价后:同款新模型事件 → total_cost 非 NULL(输入 1e6 tok × $3/Mtok = 3.00000000 USD)
    const after = await app.inject({ method: "POST", url: "/v1/events", payload: { events: [sonnetEv("sonnet-after")] } });
    expect(after.json()).toMatchObject({ accepted: 1 });
    const [a] = await pg.sql<{ total_cost: string | null; currency: string }[]>`SELECT total_cost, currency FROM usage_events WHERE event_id='sonnet-after'`;
    expect(a.total_cost).toBe("3.00000000");
    expect(a.currency).toBe("USD");
  });
});
