import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startPg, type PgHandle } from "./helpers.js";
import { syncPriceSeed } from "../src/price-seed.js";
import { loadPriceTable } from "../src/pricing.js";

const here = dirname(fileURLToPath(import.meta.url));

async function writeSeed(data: unknown): Promise<string> {
  const p = join(tmpdir(), `chobo-seed-${Date.now()}-${Math.round(performance.now())}.json`);
  await writeFile(p, JSON.stringify(data), "utf8");
  return p;
}

const V25 = {
  version: "v-2026-06-25",
  rows: [
    { provider: "doubao", model: "doubao-seed-2.0-pro", operation: "chat", input_tier_max: 32000, input_per_mtok: 3.2, output_per_mtok: 16, cache_read_per_mtok: 0.64, currency: "CNY" },
    { provider: "newapi", model: "gpt-image-2", operation: "image", input_tier_max: 0, input_per_mtok: 8, output_per_mtok: 30, text_input_per_mtok: 5, currency: "USD" },
  ],
};
const V26 = {
  version: "v-2026-06-26",
  rows: [
    { provider: "newapi", model: "gpt-5.5", operation: "chat", input_tier_max: 0, input_per_mtok: 5, output_per_mtok: 30, cache_read_per_mtok: 0.5, currency: "USD" },
  ],
};

let pg: PgHandle;
beforeAll(async () => { pg = await startPg(); });
afterAll(async () => { await pg.stop(); });

describe("syncPriceSeed — version-additive upsert", () => {
  it("seeds the first version into an empty table (incl. text_input_per_mtok)", async () => {
    const seedPath = await writeSeed(V25);
    try {
      const r = await syncPriceSeed(pg.sql, seedPath);
      expect(r).toEqual({ version: "v-2026-06-25", inserted: true });

      const table = await loadPriceTable(pg.sql);
      const imgRow = table.rows.find((x) => x.provider === "newapi" && x.model === "gpt-image-2");
      expect(imgRow).toBeDefined();
      expect(imgRow!.text_input_per_mtok).toBe(5);
      expect(imgRow!.input_per_mtok).toBe(8);
      expect(imgRow!.currency).toBe("USD");
      const doubaoRow = table.rows.find((x) => x.provider === "doubao");
      expect(doubaoRow!.text_input_per_mtok).toBeNull();
    } finally { await unlink(seedPath).catch(() => {}); }
  });

  it("inserts a NEW version even when the table is already populated, and loadPriceTable picks it (max version)", async () => {
    // 这是本特性的核心:升级镜像带新价目版本 → boot 自动引入,无需手动 INSERT。
    const seedPath = await writeSeed(V26);
    try {
      const r = await syncPriceSeed(pg.sql, seedPath);
      expect(r).toEqual({ version: "v-2026-06-26", inserted: true });

      const table = await loadPriceTable(pg.sql);
      expect(table.version).toBe("v-2026-06-26"); // 取最大 version
      const gpt = table.rows.find((x) => x.provider === "newapi" && x.model === "gpt-5.5");
      expect(gpt).toBeDefined();
      expect(gpt!.input_per_mtok).toBe(5);
      expect(gpt!.output_per_mtok).toBe(30);
      // 旧版本 v-2026-06-25 的行仍在库(只是不是 max,不被 loadPriceTable 返回)
      const [{ count }] = await pg.sql<{ count: string }[]>`SELECT count(*) FROM price_table WHERE version='v-2026-06-25'`;
      expect(Number(count)).toBe(2);
    } finally { await unlink(seedPath).catch(() => {}); }
  });

  it("is idempotent: re-syncing an already-present version inserts nothing", async () => {
    const seedPath = await writeSeed(V26);
    try {
      const r = await syncPriceSeed(pg.sql, seedPath);
      expect(r).toEqual({ version: "v-2026-06-26", inserted: false });
      const [{ count }] = await pg.sql<{ count: string }[]>`SELECT count(*) FROM price_table WHERE version='v-2026-06-26'`;
      expect(Number(count)).toBe(1); // 未重复插入
    } finally { await unlink(seedPath).catch(() => {}); }
  });

  it("preserves manual edits to an already-seeded version (never overwrites)", async () => {
    // 人工把 v-2026-06-26 的 gpt-5.5 价改成 7.77,再次 sync 同版本 → 不被 seed 原值(5)覆盖。
    await pg.sql`UPDATE price_table SET input_per_mtok = 7.77 WHERE version='v-2026-06-26' AND model='gpt-5.5'`;
    const seedPath = await writeSeed(V26);
    try {
      await syncPriceSeed(pg.sql, seedPath);
      const [row] = await pg.sql<{ input_per_mtok: string }[]>`SELECT input_per_mtok FROM price_table WHERE version='v-2026-06-26' AND model='gpt-5.5'`;
      expect(Number(row.input_per_mtok)).toBe(7.77); // 人工调价存活
    } finally { await unlink(seedPath).catch(() => {}); }
  });

  it("returns null when no seed path is configured", async () => {
    expect(await syncPriceSeed(pg.sql, null)).toBeNull();
  });
});

describe("syncPriceSeed — 2026-06-26a snapshot (from price-seed.example.json)", () => {
  let pg2: PgHandle;
  beforeAll(async () => { pg2 = await startPg(); });
  afterAll(async () => { await pg2.stop(); });

  it("version === 2026-06-26a; doubao tier + gpt-image-2 + gpt-5.5 + gemini rows present", async () => {
    const examplePath = join(here, "../price-seed.example.json");
    await syncPriceSeed(pg2.sql, examplePath);

    const table = await loadPriceTable(pg2.sql);
    expect(table.version).toBe("2026-06-26a");

    const doubaoRow = table.rows.find((r) => r.provider === "doubao" && r.input_tier_max === 32000);
    expect(doubaoRow).toBeDefined();
    expect(doubaoRow!.input_per_mtok).toBe(3.2);
    expect(doubaoRow!.output_per_mtok).toBe(16.0);
    expect(doubaoRow!.currency).toBe("CNY");

    const imgRow = table.rows.find((r) => r.provider === "newapi" && r.model === "gpt-image-2");
    expect(imgRow).toBeDefined();
    expect(imgRow!.text_input_per_mtok).toBe(5);
    expect(imgRow!.input_per_mtok).toBe(8.0);
    expect(imgRow!.currency).toBe("USD");

    const gpt = table.rows.find((r) => r.provider === "newapi" && r.model === "gpt-5.5");
    expect(gpt).toBeDefined();
    expect(gpt!.input_per_mtok).toBe(5.0);
    expect(gpt!.output_per_mtok).toBe(30.0);
    expect(gpt!.cache_read_per_mtok).toBe(0.5);
    expect(gpt!.currency).toBe("USD");

    const gem = table.rows.find((r) => r.provider === "newapi" && r.model === "gemini-3.5-flash");
    expect(gem).toBeDefined();
    expect(gem!.input_per_mtok).toBe(1.5);
    expect(gem!.output_per_mtok).toBe(9.0);
    expect(gem!.reasoning_per_mtok).toBe(9.0);
    expect(gem!.currency).toBe("USD");
  });
});
