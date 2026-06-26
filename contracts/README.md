# chobo contracts

The single coupling point between SDKs and the CRM. SDK and CRM both conform to these files.

## Event (`event.schema.json`)
One LLM call = one event. `cost_*` fields are **computed by the CRM**, never sent by the SDK,
and so are absent from the event schema. See spec §4.

## Wire envelope — `POST /v1/events`
Request body:
```json
{ "events": [ <event>, <event>, ... ] }
```
- `events` is always an array (a batch of 1+). The SDK batches.
- Response `200`/`2xx`: `{ "accepted": <int>, "duplicates": <int> }`.
- Idempotency: CRM dedups by `event_id`. At-least-once delivery from the SDK must never double-bill.
- Any non-2xx (or unreachable) → SDK treats the whole batch as undelivered and retries/spills.

## Price table (`price-table.schema.json`)
Structure only. Actual price numbers are looked up from official pricing pages and seeded by
the CRM (Plan 2) — never fabricated here.
