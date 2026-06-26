import type { Sql } from "postgres";
import type { Cost, CostLine, PriceRow, PriceTable } from "./types.js";

export interface Priceable {
  provider: string; model: string; operation: string;
  input_tokens?: number | null; output_tokens?: number | null;
  cached_tokens?: number | null; reasoning_tokens?: number | null; image_count?: number | null;
  input_text_tokens?: number | null; input_image_tokens?: number | null;
}

const round8 = (n: number): number => Math.round(n * 1e8) / 1e8;
const perM = (tokens: number, rate: number | null): number | null => (rate == null ? null : round8((tokens / 1_000_000) * rate));
const num = (v: string | null): number | null => (v == null ? null : Number(v));
const finite = (v: number | null | undefined): number => (Number.isFinite(v as number) ? (v as number) : 0);

// 明细行成本字符串:与 round8 同精度(8 位)定点,确保逐行求和 == 落库 total_cost(无漂移)。
const s8 = (n: number): string => (Math.round(n * 1e8) / 1e8).toFixed(8);
function line(component: "input" | "output" | "cache", modality: "text" | "image" | null, tokens: number, rate: number): CostLine {
  return { component, modality, tokens, rate_per_mtok: String(rate), cost: s8((tokens / 1_000_000) * rate) };
}

/** 从 DB 读当前价格表(最大 version) + 别名表。 */
export async function loadPriceTable(sql: Sql): Promise<PriceTable> {
  const aliasRows = await sql<{ provider: string; alias: string; canonical: string }[]>`SELECT provider, alias, canonical FROM model_aliases`;
  const aliases: Record<string, string> = {};
  for (const a of aliasRows) aliases[`${a.provider}::${a.alias}`] = a.canonical;

  const versions = await sql<{ version: string }[]>`SELECT version FROM price_table ORDER BY version DESC LIMIT 1`;
  if (versions.length === 0) return { version: "", rows: [], aliases };
  const version = versions[0].version;
  const raw = await sql<PriceRow[]>`
    SELECT version, provider, model, operation, input_tier_max,
           input_per_mtok, output_per_mtok, cache_read_per_mtok, reasoning_per_mtok, per_image, text_input_per_mtok, currency
    FROM price_table WHERE version = ${version}`;
  const rows = raw.map((r) => ({
    ...r, input_tier_max: Number(r.input_tier_max),
    input_per_mtok: num(r.input_per_mtok as unknown as string | null),
    output_per_mtok: num(r.output_per_mtok as unknown as string | null),
    cache_read_per_mtok: num(r.cache_read_per_mtok as unknown as string | null),
    reasoning_per_mtok: num(r.reasoning_per_mtok as unknown as string | null),
    per_image: num(r.per_image as unknown as string | null),
    text_input_per_mtok: num(r.text_input_per_mtok as unknown as string | null),
  }));
  return { version, rows, aliases };
}

/** 选档:先按别名归一 model,再按 (provider, model, operation) 取候选;分档按输入 token 选最小满足档。 */
function selectRow(table: PriceTable, p: Priceable): PriceRow | null {
  const model = table.aliases[`${p.provider}::${p.model}`] ?? p.model;
  const cands = table.rows.filter((r) => r.provider === p.provider && r.model === model && r.operation === p.operation);
  if (cands.length === 0) return null;
  const tiered = cands.filter((r) => r.input_tier_max > 0).sort((a, b) => a.input_tier_max - b.input_tier_max);
  const untiered = cands.find((r) => r.input_tier_max === 0) ?? null;
  if (tiered.length === 0) return untiered;
  const input = p.input_tokens ?? 0;
  return tiered.find((r) => input <= r.input_tier_max) ?? tiered[tiered.length - 1] ?? untiered;
}

export function computeCost(p: Priceable, table: PriceTable): Cost {
  const row = selectRow(table, p);
  if (!row) return { input_cost: null, output_cost: null, cache_cost: null, total_cost: null, cost_breakdown: null, currency: null, price_table_version: null, priced: false };

  if (p.operation === "image") {
    const txt = p.input_text_tokens, img = p.input_image_tokens;
    // token 计价:价表列了 text_input_per_mtok ⇒ 走逐模态;此时必须有拆分,缺则 NULL(不静默近似)。
    if (row.text_input_per_mtok != null) {
      if (txt == null || img == null) {
        return { input_cost: null, cache_cost: null, output_cost: null, total_cost: null, cost_breakdown: null,
                 currency: row.currency, price_table_version: row.version, priced: false };
      }
      const tIn = Math.max(0, finite(txt)), iIn = Math.max(0, finite(img)), out = Math.max(0, finite(p.output_tokens));
      const text_input_cost = perM(tIn, row.text_input_per_mtok) ?? 0;
      const image_input_cost = perM(iIn, row.input_per_mtok) ?? 0;
      const output_cost = perM(out, row.output_per_mtok) ?? 0;
      // cached 在图像接口观测不到(无 usage 字段)→ 永不出现 cache 行,只按全价 input 计。
      const lines: CostLine[] = [
        line("input", "text", tIn, row.text_input_per_mtok),
        line("input", "image", iIn, row.input_per_mtok ?? 0),
        line("output", "image", out, row.output_per_mtok ?? 0),
      ];
      return { input_cost: round8(text_input_cost + image_input_cost), cache_cost: null, output_cost: round8(output_cost),
               total_cost: round8(text_input_cost + image_input_cost + output_cost),
               cost_breakdown: { currency: row.currency, price_table_version: row.version, lines },
               currency: row.currency, price_table_version: row.version, priced: true };
    }
    // 旧平价分支(向后兼容):按张数 × per_image。
    if (row.per_image == null) {
      return { input_cost: null, cache_cost: null, output_cost: null, total_cost: null, cost_breakdown: null, currency: row.currency, price_table_version: row.version, priced: false };
    }
    const img2 = round8(finite(p.image_count) * row.per_image);
    return { input_cost: null, cache_cost: null, output_cost: img2, total_cost: img2,
             cost_breakdown: { currency: row.currency, price_table_version: row.version,
               lines: [{ component: "output", modality: "image", tokens: finite(p.image_count), rate_per_mtok: String(row.per_image), cost: s8(img2) }] },
             currency: row.currency, price_table_version: row.version, priced: true };
  }

  // defense-in-depth: clamp to ≥0 so a stray negative token count can never yield negative cost
  const inTok = Math.max(0, finite(p.input_tokens));
  const cached = Math.min(Math.max(0, finite(p.cached_tokens)), inTok);
  const outTok = Math.max(0, finite(p.output_tokens));
  const reasoning = Math.max(0, finite(p.reasoning_tokens));
  const input_cost = perM(inTok - cached, row.input_per_mtok) ?? 0;
  const cache_cost = perM(cached, row.cache_read_per_mtok) ?? 0;
  // reasoning:仅当价目单列 reasoning 费率时单算,否则视为已含在 output 计费里。
  const output_cost = round8((perM(outTok, row.output_per_mtok) ?? 0) + (row.reasoning_per_mtok != null ? perM(reasoning, row.reasoning_per_mtok)! : 0));

  // 全站统一明细(D6):chat 也写 cost_breakdown(modality:null)。逐行成本与上面同口径,求和 == total_cost。
  const lines: CostLine[] = [line("input", null, inTok - cached, row.input_per_mtok ?? 0)];
  if (row.cache_read_per_mtok != null && cached > 0) lines.push(line("cache", null, cached, row.cache_read_per_mtok));
  lines.push(line("output", null, outTok, row.output_per_mtok ?? 0));
  // 仅当价目单列 reasoning 费率才单列 reasoning 行(与 output_cost 的单算口径一致,保证求和不漂移)。
  if (row.reasoning_per_mtok != null && reasoning > 0) lines.push(line("output", null, reasoning, row.reasoning_per_mtok));

  return { input_cost, cache_cost, output_cost, total_cost: round8(input_cost + cache_cost + output_cost),
           cost_breakdown: { currency: row.currency, price_table_version: row.version, lines },
           currency: row.currency, price_table_version: row.version, priced: true };
}
