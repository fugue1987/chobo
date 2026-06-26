import type { Sql, Fragment } from "postgres";
import { computeCost } from "./pricing.js";
import type { PriceTable } from "./types.js";

const BATCH = 500;
export interface RepriceOpts { all?: boolean; }

type RepriceRow = { event_id: string; provider: string; request_model: string; operation: string; input_tokens: number | null; output_tokens: number | null; cached_tokens: number | null; reasoning_tokens: number | null; image_count: number | null; input_text_tokens: number | null; input_image_tokens: number | null };

/** 用给定价格表重算并回填 usage_events 的 cost。默认只补 total_cost IS NULL 的行(先用后配);
 *  all=true 重算全部(费率更正);对当前价表没有匹配行的 (provider,model,operation) 三元组,
 *  跳过 UPDATE——不会用 NULL 覆盖已有历史快照。keyset 游标分批(按 event_id),每批一事务。返回成功定价(priced)的行数。 */
export async function reprice(sql: Sql, table: PriceTable, opts: RepriceOpts = {}): Promise<number> {
  let priced = 0;
  let cursorId: string | null = null;
  // C1: warn once per unique (provider, model, operation) triple — do NOT write NULL over existing snapshot
  const warnedTriples = new Set<string>();

  for (;;) {
    // C5: unified query — compose scope + cursor predicates instead of 4 duplicated branches
    const scope: Fragment = opts.all ? sql`true` : sql`total_cost IS NULL`;
    const after: Fragment = cursorId === null ? sql`true` : sql`event_id > ${cursorId}`;
    const rows = await sql<RepriceRow[]>`
      SELECT event_id, provider, request_model, operation,
             input_tokens, output_tokens, cached_tokens, reasoning_tokens, image_count,
             input_text_tokens::integer AS input_text_tokens, input_image_tokens::integer AS input_image_tokens
      FROM usage_events
      WHERE ${scope} AND ${after}
      ORDER BY event_id LIMIT ${BATCH}`;

    if (rows.length === 0) break;

    await sql.begin(async (tx) => {
      for (const r of rows) {
        const c = computeCost({ provider: r.provider, model: r.request_model, operation: r.operation, input_tokens: r.input_tokens, output_tokens: r.output_tokens, cached_tokens: r.cached_tokens, reasoning_tokens: r.reasoning_tokens, image_count: r.image_count, input_text_tokens: r.input_text_tokens, input_image_tokens: r.input_image_tokens }, table);

        // C1: if model not in current price table, skip UPDATE to preserve existing snapshot
        if (!c.priced) {
          const key = `${r.provider}\0${r.request_model}\0${r.operation}`;
          if (!warnedTriples.has(key)) {
            warnedTriples.add(key);
            console.warn(`chobo reprice: no price for ${r.provider}/${r.request_model} (${r.operation}) — left unchanged`);
          }
          continue;
        }

        type JV = Parameters<typeof sql.json>[0];
        await tx`UPDATE usage_events SET input_cost=${c.input_cost}, output_cost=${c.output_cost}, cache_cost=${c.cache_cost}, total_cost=${c.total_cost}, currency=${c.currency ?? "CNY"}, price_table_version=${c.price_table_version}, cost_breakdown=${c.cost_breakdown ? sql.json(c.cost_breakdown as unknown as JV) : null} WHERE event_id=${r.event_id}`;
        priced++;
      }
    });

    cursorId = rows[rows.length - 1].event_id;  // 游标单调推进,每行只扫一次
  }
  return priced;
}
