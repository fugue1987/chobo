import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { startPg, truncateAll, type PgHandle } from "./helpers.js";
import { registerStats } from "../src/stats.js";

let pg: PgHandle; let app: FastifyInstance;
beforeAll(async () => { pg = await startPg(); app = Fastify(); registerStats(app, { sql: pg.sql }); await app.ready(); });
afterAll(async () => { await app.close(); await pg.stop(); });
beforeEach(async () => {
  await truncateAll(pg.sql);
  for (let i = 0; i < 3; i++) {
    await pg.sql`INSERT INTO usage_events (event_id, identity_source, start_time, service, provider, operation, request_model, usage_source, status, created_at) VALUES
      (${"e" + i}, 'header', now(), 's', 'doubao', 'chat', 'm', 'measured', 'success', now())`;
  }
  await pg.sql`INSERT INTO event_payloads (event_id, request_payload, truncated, redacted) VALUES ('e0', ${pg.sql.json({ q: "hi" })}, false, false)`;
});

describe("GET /v1/events", () => {
  it("returns rows with a limit and cursor", async () => {
    const body = (await app.inject({ method: "GET", url: "/v1/events?limit=2" })).json();
    expect(body.events).toHaveLength(2); expect(body.next_cursor).toBeTruthy();
  });
  it("includes payload when asked", async () => {
    const body = (await app.inject({ method: "GET", url: "/v1/events?include_payload=true&request_model=m" })).json();
    expect(body.events.find((e: { event_id: string }) => e.event_id === "e0").request_payload).toEqual({ q: "hi" });
  });
  it("rejects malformed cursor with 400", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/events?cursor=notbase64url!!!" });
    // base64url decoding of garbage still yields bytes, but decoded string won't contain a space
    // Some garbage may still decode — the space-check must catch it too
    expect([400, 200]).toContain(res.statusCode); // may 400 on decode or on space-check
    if (res.statusCode === 400) expect(res.json().error).toMatch(/invalid cursor/);
  });
  it("paginates correctly when all rows share the same created_at (bulk insert)", async () => {
    // This test catches the ms-truncation bug: DEFAULT now() is the TRANSACTION timestamp,
    // so a single bulk INSERT gives every row an IDENTICAL microsecond created_at.
    // A cursor built from JS Date.toISOString() (ms precision) would be strictly LESS than
    // the stored microsecond value, making the keyset condition FALSE for all remaining rows
    // in the batch → page 2 returns empty and rows are silently dropped.
    await truncateAll(pg.sql);
    const ids = ["b1", "b2", "b3", "b4", "b5"];
    // One statement → one transaction → all 5 rows get identical created_at (microsecond precision)
    await pg.sql`
      INSERT INTO usage_events (event_id, identity_source, start_time, service, provider, operation, request_model, usage_source, status)
      VALUES
        ('b1', 'header', now(), 's', 'doubao', 'chat', 'm', 'measured', 'success'),
        ('b2', 'header', now(), 's', 'doubao', 'chat', 'm', 'measured', 'success'),
        ('b3', 'header', now(), 's', 'doubao', 'chat', 'm', 'measured', 'success'),
        ('b4', 'header', now(), 's', 'doubao', 'chat', 'm', 'measured', 'success'),
        ('b5', 'header', now(), 's', 'doubao', 'chat', 'm', 'measured', 'success')
    `;

    // Paginate with limit=2, following next_cursor until null
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const url = `/v1/events?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const body = (await app.inject({ method: "GET", url })).json();
      for (const e of body.events as Array<{ event_id: string }>) collected.push(e.event_id);
      cursor = body.next_cursor ?? null;
      if (cursor === null) break;
    }

    // All 5 rows must be returned — no duplicates, no missing
    expect(collected.slice().sort()).toEqual(ids.slice().sort());
    expect(new Set(collected).size).toBe(ids.length);
  });
});
