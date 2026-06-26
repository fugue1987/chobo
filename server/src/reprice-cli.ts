import { resolveConfig } from "./config.js";
import { createSql } from "./db.js";
import { loadPriceTable } from "./pricing.js";
import { reprice } from "./reprice.js";

const cfg = resolveConfig(process.env);
const sql = createSql(cfg.databaseUrl);
try {
  const table = await loadPriceTable(sql);
  const all = process.argv.includes("--all");
  const n = await reprice(sql, table, { all });
  console.log(`chobo reprice: priced ${n} rows (version=${table.version || "<none>"}, all=${all})`);
} finally {
  await sql.end({ timeout: 5 });
}
