import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Sql } from "postgres";
import type { ValidateFunction } from "ajv";
import { envelopeSchema } from "./validator.js";
import { computeCost } from "./pricing.js";
import type { EventInput, Cost, PayloadMode, PriceTable } from "./types.js";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface IngestDeps {
  sql: Sql;
  validateEvent: ValidateFunction<EventInput>;
  priceTable: () => PriceTable;
  payloadMode: PayloadMode;
  payloadMaxBytes: number;
  guard?: PreHandler;            // ingest 路由级密钥闸门;undefined=开放
}

const CHUNK = 1000;
const msToIso = (ms: number | null | undefined): string | null => (ms == null ? null : new Date(ms).toISOString());

// C1/I1: per-event storability gate — guards PG integer overflow and JS Date range errors
// before the event reaches pricing or INSERT, so one bad event can never 500 the batch.
const INT_MAX = 2147483647;   // PG integer upper bound
const MS_MAX = 8.64e15;       // JS Date valid range (±ms from epoch)

function storabilityError(e: EventInput): string | null {
  for (const [name, v] of [
    ["input_tokens", e.input_tokens], ["output_tokens", e.output_tokens], ["total_tokens", e.total_tokens],
    ["cached_tokens", e.cached_tokens], ["reasoning_tokens", e.reasoning_tokens], ["image_count", e.image_count],
    ["latency_ms", e.latency_ms],
  ] as const) {
    if (v == null) continue;
    if (!Number.isInteger(v) || v < 0 || v > INT_MAX) return `${name} out of storable range`;
  }
  for (const [name, v] of [["start_time", e.start_time], ["end_time", e.end_time]] as const) {
    if (v == null) continue;
    if (!Number.isFinite(v) || Math.abs(v) > MS_MAX) return `${name} not a valid timestamp`;
  }
  return null;
}

const ROW_COLS = [
  "event_id","request_id","parent_id","user_id","org_id","project","account","identity_source",
  "start_time","end_time","latency_ms","service","provider","operation","request_model","response_model",
  "input_tokens","output_tokens","total_tokens","cached_tokens","reasoning_tokens","image_count","input_text_tokens","input_image_tokens","usage_source",
  "input_cost","output_cost","cache_cost","total_cost","currency","price_table_version","cost_breakdown",
  "status","error_type","finish_reason","sdk_lang","sdk_version",
] as const;

function toRow(sql: Sql, e: EventInput, c: Cost): Record<string, unknown> {
  type JV = Parameters<typeof sql.json>[0];
  return {
    event_id: e.event_id, request_id: e.request_id ?? null, parent_id: e.parent_id ?? null,
    user_id: e.user_id ?? null, org_id: e.org_id ?? null, project: e.project ?? null, account: e.account ?? null, identity_source: e.identity_source,
    start_time: msToIso(e.start_time), end_time: msToIso(e.end_time), latency_ms: e.latency_ms ?? null,
    service: e.service, provider: e.provider, operation: e.operation,
    request_model: e.request_model, response_model: e.response_model ?? null,
    input_tokens: e.input_tokens ?? null, output_tokens: e.output_tokens ?? null, total_tokens: e.total_tokens ?? null,
    cached_tokens: e.cached_tokens ?? null, reasoning_tokens: e.reasoning_tokens ?? null, image_count: e.image_count ?? null,
    input_text_tokens: e.input_text_tokens ?? null, input_image_tokens: e.input_image_tokens ?? null,
    usage_source: e.usage_source,
    input_cost: c.input_cost, output_cost: c.output_cost, cache_cost: c.cache_cost, total_cost: c.total_cost,
    currency: c.currency ?? "CNY", price_table_version: c.price_table_version,
    cost_breakdown: c.cost_breakdown ? sql.json(c.cost_breakdown as unknown as JV) : null,
    status: e.status, error_type: e.error_type ?? null, finish_reason: e.finish_reason ?? null,
    sdk_lang: e.sdk_lang, sdk_version: e.sdk_version,
  };
}

// I1: bound by UTF-8 bytes using Buffer — guards against multibyte-heavy payloads exceeding maxBytes
// and prevents lone surrogates (from mid-surrogate UTF-16 slice) that Postgres JSONB rejects.
// Buffer.toString("utf8") replaces any cut trailing multibyte sequence with U+FFFD (valid UTF-8).
// Note: maxBytes applies to the inner content string; the small JSON wrapper overhead is acceptable.
function truncateJson(value: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  if (value == null) return { value: null, truncated: false };
  const s = JSON.stringify(value);
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return { value, truncated: false };
  const bounded = Buffer.from(s, "utf8").subarray(0, maxBytes).toString("utf8");
  return { value: { _truncated: bounded }, truncated: true };
}

async function storePayloads(sql: Sql, events: EventInput[], maxBytes: number): Promise<void> {
  for (const e of events) {
    if (!e.payload) continue;
    const rq = truncateJson(e.payload.request, maxBytes);
    const rs = truncateJson(e.payload.response, maxBytes);
    const truncated = rq.truncated || rs.truncated;
    const redacted = e.payload.redacted ?? false;
    // m1: write SQL NULL when there is no payload value — sql.json(null) writes the JSON value
    // `null` (not SQL NULL), so WHERE request_payload IS NULL would never match.
    type JV = Parameters<typeof sql.json>[0];
    await sql`
      INSERT INTO event_payloads (event_id, request_payload, response_payload, truncated, redacted)
      VALUES (${e.event_id}, ${rq.value == null ? null : sql.json(rq.value as JV)}, ${rs.value == null ? null : sql.json(rs.value as JV)}, ${truncated}, ${redacted})
      ON CONFLICT (event_id) DO NOTHING
    `;
  }
}

export function registerIngest(app: FastifyInstance, deps: IngestDeps): void {
  const { sql, validateEvent, priceTable, payloadMode, payloadMaxBytes, guard } = deps;

  app.post("/v1/events", { schema: { body: envelopeSchema() }, preHandler: guard }, async (req, reply) => {
    const events = (req.body as { events: unknown[] }).events;
    const valid: EventInput[] = [];
    let rejected = 0;
    for (const raw of events) {
      if (!validateEvent(raw)) {
        rejected++;
        req.log.warn({ event_id: (raw as { event_id?: string })?.event_id, errors: validateEvent.errors }, "chobo: rejected invalid event");
        continue;
      }
      const e = raw as EventInput;
      const storErr = storabilityError(e);
      if (storErr !== null) {
        rejected++;
        req.log.warn({ event_id: e.event_id, reason: storErr }, "chobo: rejected unstorable event");
        continue;
      }
      valid.push(e);
    }

    const table = priceTable();
    // m3: dedupe unpriced warnings — warn once per unique (provider, model, operation) triple per request,
    // not once per event (avoids 1000 identical lines for a 1000-event unpriced batch).
    const warnedUnpriced = new Set<string>();
    const rows = valid.map((e) => {
      const cost = computeCost({ provider: e.provider, model: e.request_model, operation: e.operation, input_tokens: e.input_tokens, output_tokens: e.output_tokens, cached_tokens: e.cached_tokens, reasoning_tokens: e.reasoning_tokens, image_count: e.image_count, input_text_tokens: e.input_text_tokens, input_image_tokens: e.input_image_tokens }, table);
      if (!cost.priced) {
        const key = `${e.provider}\0${e.request_model}\0${e.operation}`;
        if (!warnedUnpriced.has(key)) {
          warnedUnpriced.add(key);
          req.log.warn({ provider: e.provider, model: e.request_model, operation: e.operation }, "chobo: no price for model — total_cost=NULL");
        }
      }
      return toRow(sql, e, cost);
    });

    let accepted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const r = await sql`INSERT INTO usage_events ${sql(rows.slice(i, i + CHUNK), ...ROW_COLS)} ON CONFLICT (event_id) DO NOTHING`;
      accepted += Number(r.count);
    }
    const duplicates = valid.length - accepted;
    if (payloadMode === "truncated") await storePayloads(sql, valid, payloadMaxBytes);
    return reply.code(200).send({ accepted, duplicates, rejected });
  });
}
