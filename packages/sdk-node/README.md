# chobo — Node SDK (`@chobo/sdk`)

> **接入请以权威手册为准：[`docs/SDK_MANUAL.md`](../../docs/SDK_MANUAL.md)**（Node + Python 统一、完整无二义）。
> 本文件是包内开发速记。

Low-intrusion LLM usage metering for Node/TypeScript — the Node twin of the Python SDK, conforming to
the same [event contract](../../contracts/event.schema.json) (`sdk_lang: "node"`).

- **Runtime:** Node ≥18, **zero runtime deps** (`node:async_hooks`, `node:crypto`, `node:fs/promises`, global `fetch`). Ships **ESM + CJS** (dual build).
- **Never blocks, never silently loses:** in-memory buffer → disk spill → backoff retry → awaitable `shutdown()`. The SDK does NOT compute cost (the CRM prices events).

## Install (dev, in the monorepo)
```bash
cd packages/sdk-node
npm install
npm test        # vitest
npm run build   # tsup -> dist (ESM + CJS + d.ts)
```

## Quickstart
```ts
import * as chobo from "@chobo/sdk";

chobo.init({
  ingestUrl: "http://localhost:4000/v1/events",
  service: "node-ai-proxy",
  flushIntervalMs: 2000,
  spoolDir: "./.chobo-spool",
});

// At the HTTP request boundary (extend node-ai-proxy's traceMiddleware):
app.use((req, res, next) =>
  chobo.runWithIdentity(
    { user_id: req.header("X-Chobo-User"), org_id: req.header("X-Chobo-Org"), project: req.header("X-Chobo-Project") },
    next,
  ),
);

// Buffered call:
const resp = await chobo.meter(
  { operation: "chat", provider: "minimax", requestModel: model, extract: chobo.extractors.openaiChatUsage },
  () => callUpstream(...),
);

// Streaming call (passthrough — iterate the returned generator as usual):
for await (const chunk of chobo.meterStream(
  { operation: "chat", provider: "minimax", requestModel: model, extractChunkUsage: chobo.extractors.openaiStreamChunkUsage },
  upstreamChunks,
)) {
  forwardToClient(chunk);
}

// On graceful shutdown (SIGTERM handler), guarantee a final drain:
process.once("SIGTERM", async () => { await chobo.shutdown(); process.exit(0); });
```

## Config
| Field | Default | Meaning |
|---|---|---|
| `ingestUrl` | — | CRM `POST /v1/events` URL |
| `service` | — | host service name in events |
| `ingestSecret` | — | 可选;配置后每次 ingest POST 带 `x-chobo-secret` 头,对接设了 `CHOBO_INGEST_SECRET` 的 CRM |
| `bufferMax` | 10000 | in-memory cap before spilling to disk |
| `batchMax` | 100 | max events per POST |
| `flushAt` | 20 | buffer-size flush trigger |
| `flushIntervalMs` | 2000 | interval flush trigger (timer is `unref`'d) |
| `spoolDir` | `./.chobo-spool` | per-process JSONL overflow file (`events-<pid>.jsonl`) |
| `maxSpoolBytes` | 50 MiB | spool cap; over cap drops OLDEST + counts (never silent) |
| `timeoutMs` | 5000 | POST timeout |
| `fetchImpl` | global `fetch` | injection seam (tests / patched runtimes) |

`chobo.getStats()` → `{ enqueued, sent, spilled, dropped, postFailures }`.

## Exit semantics (Node-specific — see grounding doc §4)
`'exit'` listeners are synchronous-only (async is abandoned) and `'beforeExit'` does not fire on
`process.exit()`. The SDK registers a best-effort `beforeExit` flush and exposes an **awaitable
`shutdown()`** — the only guarantee of a final drain is calling `await chobo.shutdown()` in your
shutdown path. The SDK does NOT hijack process signals.

**Streaming completion limitation:** `meterStream` emits its event on **full stream completion**.
If the consumer breaks out early (e.g. a client disconnect mid-stream), no event is emitted — a
known v1 limitation (the correct billing semantics for a cut stream are provider-dependent and are
revisited in Plan 5).

## AdopterA integration recipe (first adopter — applied in Plan 5, not here)
`node-ai-proxy` has three LLM transports (see `docs/research/2026-06-24-node-sdk-grounding.md`):
- OpenAI-compatible raw http (`lib/openaiClient.js:requestStreamingResponse`, 5 sites in `routes/resource.js`) → wrap streaming sites with `meterStream` + `extractors.openaiStreamChunkUsage` (send `stream_options:{include_usage:true}`); wrap `callLLMForJSON` with `meter` + `openaiChatUsage`.
- `traceFetch` buffered (`reportActionCards.js`) → `meter` + `openaiChatUsage`.
- Gemini `@google/genai` (`routes/gemini.js` buffered, `lib/googleStreamClient.js` streaming) → `meter`/`meterStream` + `geminiUsage`/`geminiStreamChunkUsage`.

Set identity by extending `traceMiddleware` (`lib/traceContext.js`) to `runWithIdentity(...)` and call `chobo.shutdown()` on the server's shutdown signal. Exact header names + live response shapes are confirmed during Plan 5.
