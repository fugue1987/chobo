import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { parseFilters, whereFragment } from "./filters.js";

export interface StatsDeps { sql: Sql; }

// Sentinel used in Maps to represent a SQL NULL dimension key without colliding with the
// string "null" (which could legitimately be a user-supplied value).  We use a module-scoped
// Symbol so it's always the same reference even though the per-request Map is recreated.
const NULL_KEY = Symbol("NULL_DIM_KEY");

export function registerStats(app: FastifyInstance, deps: StatsDeps): void {
  const { sql } = deps;

  // Task 9: overview
  app.get("/v1/stats/overview", async (req) => {
    const f = parseFilters(req.query as Record<string, string | undefined>);
    const where = whereFragment(sql, f);

    // Main aggregation — no total_cost here (cross-currency sum would be meaningless)
    const [t] = await sql<{ events: string; input_tokens: string | null; output_tokens: string | null; total_tokens: string | null; success: string; failure: string }[]>`
      SELECT count(*) AS events,
             sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens, sum(total_tokens) AS total_tokens,
             count(*) FILTER (WHERE status='success') AS success,
             count(*) FILTER (WHERE status='failure') AS failure
      FROM usage_events WHERE ${where}`;

    // Per-currency cost aggregation — GROUP BY currency, only priced rows
    const costRows = await sql<{ currency: string; total_cost: string }[]>`
      SELECT currency, sum(total_cost) AS total_cost
      FROM usage_events
      WHERE ${where} AND total_cost IS NOT NULL
      GROUP BY currency
      ORDER BY currency`;

    return {
      filters: f,
      totals: {
        events: Number(t.events),
        input_tokens: Number(t.input_tokens ?? 0),
        output_tokens: Number(t.output_tokens ?? 0),
        total_tokens: Number(t.total_tokens ?? 0),
        cost_by_currency: costRows.map((r) => ({ currency: r.currency, total_cost: r.total_cost })),
        by_status: { success: Number(t.success), failure: Number(t.failure) },
      },
    };
  });

  // Task 10: timeseries
  const BUCKETS = new Set(["hour", "day", "week", "month"]);

  app.get("/v1/stats/timeseries", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const bucket = q.bucket ?? "day";
    if (!BUCKETS.has(bucket)) return reply.code(400).send({ error: "bucket must be hour|day|week|month" });
    const f = parseFilters(q);
    const where = whereFragment(sql, f);

    // Main aggregation: events + tokens per time bucket
    const rows = await sql<{ ts: Date; events: string; total_tokens: string | null }[]>`
      SELECT date_trunc(${bucket}, created_at) AS ts, count(*) AS events,
             sum(total_tokens) AS total_tokens
      FROM usage_events WHERE ${where}
      GROUP BY ts ORDER BY ts`;

    // Per-currency cost aggregation per time bucket — only priced rows
    const costRows = await sql<{ ts: Date; currency: string; total_cost: string }[]>`
      SELECT date_trunc(${bucket}, created_at) AS ts, currency, sum(total_cost) AS total_cost
      FROM usage_events
      WHERE ${where} AND total_cost IS NOT NULL
      GROUP BY ts, currency
      ORDER BY ts, currency`;

    // Build Map<isoTs → {currency, total_cost}[]> for O(1) merge
    const costByTs = new Map<string, Array<{ currency: string; total_cost: string }>>();
    for (const cr of costRows) {
      const key = cr.ts.toISOString();
      let arr = costByTs.get(key);
      if (!arr) { arr = []; costByTs.set(key, arr); }
      arr.push({ currency: cr.currency, total_cost: cr.total_cost });
    }

    return {
      bucket,
      series: rows.map((r) => {
        const isoTs = r.ts.toISOString();
        return {
          ts: isoTs,
          events: Number(r.events),
          total_tokens: Number(r.total_tokens ?? 0),
          cost_by_currency: costByTs.get(isoTs) ?? [],
        };
      }),
    };
  });

  // Task 11: by-dim (by-user / by-org / by-project / by-account)
  const DIM_COL: Record<string, string> = { "by-user": "user_id", "by-org": "org_id", "by-project": "project", "by-account": "account" };

  for (const [path, col] of Object.entries(DIM_COL)) {
    app.get(`/v1/stats/${path}`, async (req) => {
      const q = req.query as Record<string, string | undefined>;
      const where = whereFragment(sql, parseFilters(q));
      const rawLimit = Number(q.limit ?? "50");
      const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, 500) : 50;
      const dim = sql(col); // whitelisted column — key comes from DIM_COL, never from user input

      // Main aggregation: events + tokens per dim key (determines ordering and LIMIT)
      const rows = await sql<{ key: string | null; events: string; total_tokens: string | null }[]>`
        SELECT ${dim} AS key, count(*) AS events, sum(total_tokens) AS total_tokens
        FROM usage_events WHERE ${where}
        GROUP BY ${dim} ORDER BY sum(total_tokens) DESC NULLS LAST LIMIT ${limit}`;

      // Per-currency cost for the same dimension — only priced rows, no LIMIT
      // (We only merge costs for keys that already appear in the main result above.)
      const costRows = await sql<{ key: string | null; currency: string; total_cost: string }[]>`
        SELECT ${dim} AS key, currency, sum(total_cost) AS total_cost
        FROM usage_events
        WHERE ${where} AND total_cost IS NOT NULL
        GROUP BY ${dim}, currency
        ORDER BY ${dim}, currency`;

      // Build Map keyed by dim value; NULL keys use a Symbol sentinel so they don't collide
      // with the literal string "null" that a user might pass as project/org/account name.
      const costByKey = new Map<string | typeof NULL_KEY, Array<{ currency: string; total_cost: string }>>();
      for (const cr of costRows) {
        const mapKey: string | typeof NULL_KEY = cr.key === null ? NULL_KEY : cr.key;
        let arr = costByKey.get(mapKey);
        if (!arr) { arr = []; costByKey.set(mapKey, arr); }
        arr.push({ currency: cr.currency, total_cost: cr.total_cost });
      }

      return {
        dimension: col,
        rows: rows.map((r) => {
          const mapKey: string | typeof NULL_KEY = r.key === null ? NULL_KEY : r.key;
          return {
            key: r.key,
            events: Number(r.events),
            total_tokens: Number(r.total_tokens ?? 0),
            cost_by_currency: costByKey.get(mapKey) ?? [],
          };
        }),
      };
    });
  }

  // Task 12: /v1/events detail audit (keyset pagination, optional payload merge)
  //
  // Cursor format: base64url( `${cursor_us}|${event_id}` )
  //   cursor_us = (extract(epoch from created_at)*1000000)::bigint — full microsecond integer
  //   The token is base64url-encoded so it's opaque to callers and URL-safe.
  //
  // Why not plain `created_at.toISOString()|event_id`:
  //   Postgres DEFAULT now() is the TRANSACTION timestamp — every row in one bulk INSERT
  //   gets an IDENTICAL microsecond created_at.  JS Date.toISOString() truncates to ms, so
  //   the cursor timestamp lands strictly BEFORE the stored microsecond value; the keyset
  //   condition `(created_at, event_id) < (cursor_ts, id)` is FALSE for every remaining row
  //   in that batch → page 2 returns empty and rows are silently lost.
  //
  //   Using epoch-microsecond bigint avoids all text→timestamptz parsing and JS Date rounding:
  //   bigint parameters are compared exactly in Postgres with no precision loss.
  app.get("/v1/events", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const where = whereFragment(sql, parseFilters(q));
    const rawLimit = Number(q.limit ?? "50");
    const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, 500) : 50;
    const withPayload = q.include_payload === "true";

    let cursorCond = sql`true`;
    if (q.cursor) {
      let inner: string;
      try {
        inner = Buffer.from(q.cursor, "base64url").toString("utf8");
      } catch {
        return reply.code(400).send({ error: "invalid cursor" });
      }
      const pipe = inner.indexOf("|");
      if (pipe === -1) return reply.code(400).send({ error: "invalid cursor" });
      const usStr = inner.slice(0, pipe), id = inner.slice(pipe + 1);
      // Both must be non-empty; usStr must be a valid integer string
      if (!usStr || !id || !/^\d+$/.test(usStr)) return reply.code(400).send({ error: "invalid cursor" });
      // Pass usStr as a text param and cast to bigint in SQL — bigint is not a postgres.js Serializable type
      // Compare via epoch-microsecond bigint — exact, no floating-point or ms-truncation issues
      cursorCond = sql`((extract(epoch from created_at)*1000000)::bigint, event_id) < (${usStr}::bigint, ${id})`;
    }

    // Select epoch-microseconds bigint cursor alongside the row (returned as string by postgres.js)
    const rows = await sql<Array<Record<string, unknown> & { cursor_us: string; event_id: string }>>`
      SELECT *, (extract(epoch from created_at)*1000000)::bigint AS cursor_us
      FROM usage_events WHERE ${where} AND ${cursorCond}
      ORDER BY created_at DESC, event_id DESC LIMIT ${limit}`;

    if (withPayload && rows.length) {
      const ids = rows.map((r) => r.event_id);
      const pls = await sql<Array<{ event_id: string; request_payload: unknown; response_payload: unknown; truncated: boolean; redacted: boolean }>>`
        SELECT event_id, request_payload, response_payload, truncated, redacted FROM event_payloads WHERE event_id IN ${sql(ids)}`;
      const byId = new Map(pls.map((p) => [p.event_id, p]));
      for (const r of rows) {
        const p = byId.get(r.event_id);
        if (p) { r.request_payload = p.request_payload; r.response_payload = p.response_payload; r.truncated = p.truncated; r.redacted = p.redacted; }
      }
    }
    const last = rows[rows.length - 1];
    const next_cursor = rows.length === limit && last
      ? Buffer.from(`${last.cursor_us}|${last.event_id}`).toString("base64url")
      : null;
    return { events: rows, next_cursor };
  });
}
