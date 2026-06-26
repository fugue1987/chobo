# Plan 2 (CRM) prerequisites — gather while Plan 3 builds

> ⚠ 已落地(2026-06-24):下列 6 项决策均已与 fugue 拍板并写入计划
> [`docs/superpowers/plans/2026-06-24-crm-server.md`](../superpowers/plans/2026-06-24-crm-server.md) 的「背景」表;
> 价目范围修正(GLM/MiniMax/seedream 移出、全 CNY、`doubao`/`example-gateway` 两计费路由)见
> [`plan2-pricing-draft.md`](2026-06-24-plan2-pricing-draft.md)。本工作表留作过程记录。

Plan 2 = chobo's CRM backend: `POST /v1/events` ingest → dedup → **price** → store Postgres
(`usage_events` / `event_payloads` / `price_table`) → `/v1/stats/*` read API. The pricing piece
is the only hard blocker that needs YOUR input (real numbers + which models are live).

## A. Decisions I need (just reply in chat)

1. **CRM stack** — Fastify (my rec: lightweight, fits a focused ingest+stats service) vs NestJS. **Query layer** — `postgres.js` (my rec) vs `pg` vs a light ORM.
2. **Postgres for chobo** — reuse the remote adopter-a PG (`198.51.100.10`) with chobo-owned tables (e.g. a `chobo` schema or `cb_*` prefix), or a separate DB/instance? Give me the connection target you want chobo to use.
3. **Ingest auth** — require a shared-secret header on `POST /v1/events` (my rec, even for local), or leave it open for v1?
4. **payload capture default** — `off` / `metadata-only` (spec default) / `truncated-plaintext`; if any plaintext, the size cap + redaction rules.
5. **Currency/precision** — `CNY`, `numeric(18,8)` ok?
6. **new-api reconciliation** — confirm it stays deferred (v1 does NOT build it; we only keep `request_id` + reserved columns).

## B. Pricing worksheet — the data to gather (units: 元 per 1M tokens; 元 per 张 for images)

Fill a row per model **actually in production**. For Doubao text, fill the 3 tiered rows (input-length brackets).
A background agent of mine is drafting the public numbers with citations — you can verify those and add contracted rates.

| provider | model | operation | input_tier_max | input_per_mtok | output_per_mtok | cache_read_per_mtok | reasoning_per_mtok | per_image | currency |
|----------|-------|-----------|----------------|----------------|-----------------|---------------------|--------------------|-----------|----------|
| doubao | doubao-seed-… | chat | 32000  | ? | ? | ? | ? |   | CNY |
| doubao | doubao-seed-… | chat | 128000 | ? | ? | ? | ? |   | CNY |
| doubao | doubao-seed-… | chat | 256000 | ? | ? | ? | ? |   | CNY |
| doubao | seedream-…    | image |        |   |   |   |   | ? | CNY |
| zhipu      | glm-5.1       | chat  |        | ? | ? | ? | ? |   | CNY |
| minimax    | MiniMax-M2.5  | chat  |        | ? | ? |   |   |   | CNY |
| google     | gemini-2.5-pro| chat  |        | ? | ? | ? | ? |   | (CNY/USD?) |

> `input_tier_max` = upper bound of the input-length bracket (Doubao: 32K/128K/256K → 32000/128000/256000).
> Leave blank for models with no tiering. Leave cells blank where a model has no cache/reasoning/image component.

**Official pricing pages** (I'm auto-drafting from these; verify against your console):
- 火山方舟 / 豆包(Doubao + Seedream): 控制台计费页 + https://www.volcengine.com/docs/82379
- 智谱 GLM: https://open.bigmodel.cn/pricing
- MiniMax: https://platform.minimaxi.com (定价/计费)
- Gemini: https://ai.google.dev/pricing

## C. Environment / live-state

- **Which providers+models are LIVE right now** (so I seed only real rows, not the whole menu).
- **Any contracted/discounted rates** different from public list price — only you have these.
- Confirm the price table is seeded once and **versioned** (`price_table_version`), so later rate changes are a new version, not an in-place edit.
