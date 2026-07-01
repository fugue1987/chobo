import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveConfig } from "./config.js";
import { createSql, migrate } from "./db.js";
import { loadPriceTable } from "./pricing.js";
import { buildApp } from "./app.js";
import { syncPriceSeed } from "./price-seed.js";

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const cfg = resolveConfig(process.env);
  const sql = createSql(cfg.databaseUrl);
  await migrate(sql, join(here, "..", "migrations"));
  const seeded = await syncPriceSeed(sql, cfg.priceSeedPath);

  const priceTable = await loadPriceTable(sql);
  const app = buildApp({ sql, cfg, priceTable: () => priceTable });

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ sig }, "chobo: shutting down");
    try {
      await app.close();
      await sql.end({ timeout: 5 });
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "chobo: error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: cfg.host, port: cfg.port });
  app.log.info(
    { priceVersion: priceTable.version, seedVersion: seeded?.version ?? null, seedInserted: seeded?.inserted ?? false, rows: priceTable.rows.length, aliases: Object.keys(priceTable.aliases).length },
    "chobo CRM up",
  );
}

// Only run main() when this file is the direct entrypoint, not when imported for exports (e.g. tests).
const isMain = process.argv[1] && fileURLToPath(import.meta.url).replace(/\\/g, "/") === process.argv[1].replace(/\\/g, "/");
if (isMain) main().catch((err) => { console.error("chobo: fatal", err); process.exit(1); });
