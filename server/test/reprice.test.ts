import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { startPg, truncateAll, type PgHandle } from "./helpers.js";
import { registerIngest } from "../src/ingest.js";
import { makeEventValidator } from "../src/validator.js";
import { loadPriceTable } from "../src/pricing.js";
import { reprice } from "../src/reprice.js";
import type { PriceTable } from "../src/types.js";

const ev = (id: string, inTok: number, outTok: number) => ({
  event_id: id, identity_source: "header", start_time: 1750000000000, service: "s",
  provider: "doubao", operation: "chat", request_model: "doubao-seed-2.0-pro",
  input_tokens: inTok, output_tokens: outTok, cached_tokens: 0,
  usage_source: "measured", status: "success", sdk_lang: "node", sdk_version: "0.1.0",
});

let pg: PgHandle; let app: FastifyInstance;
let table: PriceTable = { version: "", rows: [], aliases: {} };
beforeAll(async () => {
  pg = await startPg(); app = Fastify({ logger: false });
  registerIngest(app, { sql: pg.sql, validateEvent: makeEventValidator(), priceTable: () => table, payloadMode: "metadata", payloadMaxBytes: 8192 });
  await app.ready();
});
afterAll(async () => { await app.close(); await pg.stop(); });
beforeEach(async () => { table = { version: "", rows: [], aliases: {} }; await truncateAll(pg.sql); await pg.sql`DELETE FROM price_table`; });

describe("reprice — 先用后配回填", () => {
  it("fills NULL costs after prices are configured later", async () => {
    await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev("a", 10000, 1000)] } });
    let [row] = await pg.sql`SELECT total_cost FROM usage_events WHERE event_id='a'`;
    expect(row.total_cost).toBeNull();                              // 价未配 → NULL

    await pg.sql`INSERT INTO price_table (version,provider,model,operation,input_tier_max,input_per_mtok,output_per_mtok,cache_read_per_mtok,currency)
                 VALUES ('v1','doubao','doubao-seed-2.0-pro','chat',32000,3.2,16,0.64,'CNY')`;
    expect(await reprice(pg.sql, await loadPriceTable(pg.sql))).toBe(1);   // 后配价 + 回填
    [row] = await pg.sql`SELECT total_cost, price_table_version FROM usage_events WHERE event_id='a'`;
    expect(row.total_cost).toBe("0.04800000"); expect(row.price_table_version).toBe("v1");

    expect(await reprice(pg.sql, await loadPriceTable(pg.sql))).toBe(0);   // 再跑只补 NULL → 0
  });

  it("--all preserves existing snapshot when model absent from new price table", async () => {
    // seed v1 with doubao-seed-2.0-pro
    await pg.sql`INSERT INTO price_table (version,provider,model,operation,input_tier_max,input_per_mtok,output_per_mtok,cache_read_per_mtok,currency)
                 VALUES ('v1','doubao','doubao-seed-2.0-pro','chat',32000,3.2,16,0.64,'CNY')`;
    table = await loadPriceTable(pg.sql);
    // ingest event — priced at write time
    await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev("c", 10000, 0)] } });
    let [row] = await pg.sql`SELECT total_cost, price_table_version FROM usage_events WHERE event_id='c'`;
    expect(row.total_cost).toBe("0.03200000");
    expect(row.price_table_version).toBe("v1");

    // seed v2 that does NOT contain doubao-seed-2.0-pro (only a different model)
    await pg.sql`INSERT INTO price_table (version,provider,model,operation,input_tier_max,input_per_mtok,output_per_mtok,cache_read_per_mtok,currency)
                 VALUES ('v2','doubao','some-other-model','chat',32000,1.0,2.0,0.2,'CNY')`;
    // reprice --all with the new table (v2 has no price for doubao-seed-2.0-pro)
    const repriced = await reprice(pg.sql, await loadPriceTable(pg.sql), { all: true });
    // should be 0: the event was not repriced (model absent) — existing snapshot preserved
    expect(repriced).toBe(0);
    [row] = await pg.sql`SELECT total_cost, price_table_version FROM usage_events WHERE event_id='c'`;
    // C1 fix: original snapshot must NOT be nulled
    expect(row.total_cost).toBe("0.03200000");
    expect(row.price_table_version).toBe("v1");
  });

  it("--all re-prices everything (rate correction)", async () => {
    await pg.sql`INSERT INTO price_table (version,provider,model,operation,input_tier_max,input_per_mtok,output_per_mtok,cache_read_per_mtok,currency)
                 VALUES ('v1','doubao','doubao-seed-2.0-pro','chat',32000,3.2,16,0.64,'CNY')`;
    table = await loadPriceTable(pg.sql);
    await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev("b", 10000, 0)] } });
    let [row] = await pg.sql`SELECT total_cost FROM usage_events WHERE event_id='b'`;
    expect(row.total_cost).toBe("0.03200000");                     // 写时按 v1 算

    await pg.sql`INSERT INTO price_table (version,provider,model,operation,input_tier_max,input_per_mtok,output_per_mtok,cache_read_per_mtok,currency)
                 VALUES ('v2','doubao','doubao-seed-2.0-pro','chat',32000,6.4,32,1.28,'CNY')`;
    expect(await reprice(pg.sql, await loadPriceTable(pg.sql), { all: true })).toBe(1);
    [row] = await pg.sql`SELECT total_cost, price_table_version FROM usage_events WHERE event_id='b'`;
    expect(row.total_cost).toBe("0.06400000"); expect(row.price_table_version).toBe("v2");  // v2 重算
  });

  it("backfills gpt-image-2 token pricing with cost_breakdown", async () => {
    // Insert a gpt-image-2 event with NULL cost (no price at ingest time)
    await pg.sql`
      INSERT INTO usage_events
        (event_id, identity_source, start_time, service, provider, operation, request_model,
         input_text_tokens, input_image_tokens, output_tokens,
         usage_source, status, sdk_lang, sdk_version)
      VALUES
        ('img1', 'header', '2026-06-25T00:00:00Z', 's', 'newapi', 'image', 'gpt-image-2',
         100, 2000, 3000,
         'measured', 'success', 'node', '0.1.3')`;

    let [row] = await pg.sql`SELECT total_cost FROM usage_events WHERE event_id='img1'`;
    expect(row.total_cost).toBeNull(); // 价未配 → NULL

    // Seed the gpt-image-2 price row
    await pg.sql`
      INSERT INTO price_table
        (version, provider, model, operation, input_tier_max,
         input_per_mtok, output_per_mtok, text_input_per_mtok, currency)
      VALUES
        ('v1', 'newapi', 'gpt-image-2', 'image', 0,
         8, 30, 5, 'USD')`;

    const repriced = await reprice(pg.sql, await loadPriceTable(pg.sql));
    expect(repriced).toBe(1);

    [row] = await pg.sql`SELECT total_cost, currency, cost_breakdown FROM usage_events WHERE event_id='img1'`;
    // total = (100/1e6)*5 + (2000/1e6)*8 + (3000/1e6)*30 = 0.0005 + 0.016 + 0.09 = 0.1065
    expect(row.total_cost).toBe("0.10650000");
    expect(row.currency).toBe("USD");
    expect(row.cost_breakdown).not.toBeNull();
    expect(Array.isArray(row.cost_breakdown.lines)).toBe(true);
    expect(row.cost_breakdown.lines).toHaveLength(3);
  });
});
