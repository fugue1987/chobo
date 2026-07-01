import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveConfig } from "./config.js";
import { createSql, migrate } from "./db.js";
import { syncPriceSeed } from "./price-seed.js";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = resolveConfig(process.env);
const sql = createSql(cfg.databaseUrl);
try {
  await migrate(sql, join(here, "..", "migrations")); // 幂等,保证 price_table 存在(可独立跑)
  const seedPath = process.argv[2] ?? cfg.priceSeedPath; // 位置参数优先,回落 CHOBO_PRICE_SEED
  if (!seedPath) throw new Error("chobo seed-cli: 需要 seed 文件路径(位置参数或 CHOBO_PRICE_SEED)");
  const r = await syncPriceSeed(sql, seedPath);
  console.log(
    r?.inserted
      ? `chobo seed: inserted version ${r.version}`
      : `chobo seed: version ${r?.version ?? "<none>"} 已在库,无改动(要改动请 bump price-seed.json 的 version)`,
  );
} finally {
  await sql.end({ timeout: 5 });
}
