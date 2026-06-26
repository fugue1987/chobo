import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startPg, MIGRATIONS_DIR, type PgHandle } from "./helpers.js";
import { migrate } from "../src/db.js";

let pg: PgHandle;
beforeAll(async () => { pg = await startPg(); });
afterAll(async () => { await pg.stop(); });

describe("migrate", () => {
  it("created the four tables", async () => {
    const rows = await pg.sql<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname='public'`;
    expect(rows.map((r) => r.tablename)).toEqual(expect.arrayContaining(["usage_events", "event_payloads", "price_table", "model_aliases", "schema_migrations"]));
  });
  it("is idempotent — second run applies nothing", async () => {
    expect(await migrate(pg.sql, MIGRATIONS_DIR)).toEqual([]);
  });
  it("enforces numeric(18,8) — why we use real PG not pg-mem", async () => {
    await pg.sql`INSERT INTO price_table (version,provider,model,operation,input_tier_max,input_per_mtok) VALUES ('t','p','m','chat',0,1.123456789)`;
    const [r] = await pg.sql<{ input_per_mtok: string }[]>`SELECT input_per_mtok FROM price_table WHERE version='t'`;
    expect(r.input_per_mtok).toBe("1.12345679");
    await pg.sql`DELETE FROM price_table WHERE version='t'`;
  });
});
