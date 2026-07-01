import { readFile } from "node:fs/promises";
import type { Sql } from "postgres";

/**
 * Version-additive price-seed sync (idempotent). Inserts the seed file's `version` IFF that exact
 * version is not already in `price_table`. It NEVER overwrites an existing version's rows — manual
 * price edits to an already-seeded version are preserved; the auditable way to change a price is to
 * bump the seed `version`, which this auto-introduces on the next boot. `loadPriceTable()` reads the
 * MAX version, so a newly-synced version takes effect immediately once this runs at boot.
 *
 *   empty DB                 → first version inserted
 *   new image, newer version → new version inserted (no manual SQL; the deploy's restart IS the reload)
 *   same version re-run       → no-op
 *
 * Returns `{ version, inserted }` for boot logging (or `null` when no seed path configured).
 */
export async function syncPriceSeed(sql: Sql, seedPath: string | null): Promise<{ version: string; inserted: boolean } | null> {
  if (!seedPath) return null;
  const seed = JSON.parse(await readFile(seedPath, "utf8")) as { version: string; rows: Record<string, unknown>[]; aliases?: { provider: string; alias: string; canonical: string }[] };
  if (typeof seed.version !== "string" || seed.version === "") {
    throw new Error(`chobo seed: top-level "version" missing or invalid in ${seedPath}`);
  }
  // Gate on THIS version (not total count): a new version is introduced even into a populated table,
  // an already-present version is left untouched (idempotent + preserves manual edits).
  const [{ count }] = await sql<{ count: string }[]>`SELECT count(*) FROM price_table WHERE version = ${seed.version}`;
  if (Number(count) > 0) return { version: seed.version, inserted: false };
  type SeedRow = { version: string; provider: string; model: string; operation: string; input_tier_max: number; input_per_mtok: number | null; output_per_mtok: number | null; cache_read_per_mtok: number | null; reasoning_per_mtok: number | null; per_image: number | null; text_input_per_mtok: number | null; currency: string };
  const rows: SeedRow[] = seed.rows.map((r, idx) => {
    // C6: validate required string fields — raw `as string` cast silently produces undefined on malformed JSON
    for (const field of ["provider", "model", "operation"] as const) {
      if (typeof r[field] !== "string" || r[field] === "") {
        throw new Error(`chobo seed: row[${idx}] missing or invalid field "${field}" in ${seedPath}`);
      }
    }
    const base: SeedRow = { version: seed.version, input_tier_max: 0, input_per_mtok: null, output_per_mtok: null, cache_read_per_mtok: null, reasoning_per_mtok: null, per_image: null, text_input_per_mtok: null, currency: "CNY", provider: r["provider"] as string, model: r["model"] as string, operation: r["operation"] as string };
    if (r["input_per_mtok"] != null) base.input_per_mtok = r["input_per_mtok"] as number;
    if (r["output_per_mtok"] != null) base.output_per_mtok = r["output_per_mtok"] as number;
    if (r["cache_read_per_mtok"] != null) base.cache_read_per_mtok = r["cache_read_per_mtok"] as number;
    if (r["reasoning_per_mtok"] != null) base.reasoning_per_mtok = r["reasoning_per_mtok"] as number;
    if (r["per_image"] != null) base.per_image = r["per_image"] as number;
    if (r["text_input_per_mtok"] != null) base.text_input_per_mtok = r["text_input_per_mtok"] as number;
    if (r["input_tier_max"] != null) base.input_tier_max = r["input_tier_max"] as number;
    if (r["currency"] != null) base.currency = r["currency"] as string;
    return base;
  });
  await sql`INSERT INTO price_table ${sql(rows, "version","provider","model","operation","input_tier_max","input_per_mtok","output_per_mtok","cache_read_per_mtok","reasoning_per_mtok","per_image","text_input_per_mtok","currency")} ON CONFLICT DO NOTHING`;
  if (seed.aliases?.length) await sql`INSERT INTO model_aliases ${sql(seed.aliases, "provider","alias","canonical")} ON CONFLICT DO NOTHING`;
  return { version: seed.version, inserted: true };
}
