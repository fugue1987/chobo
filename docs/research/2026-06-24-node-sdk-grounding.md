# Node SDK grounding (verified facts + citations)

> Produced 2026-06-24 by a fan-out research workflow (scan node-ai-proxy + verify OpenAI/Gemini/Node specs),
> each external claim independently fact-checked against official docs. This is the factual basis for the
> Plan 3 (Node SDK) implementation plan. Per 铁律 §1/§5: facts here are verified with links, not memory.

## 1. node-ai-proxy chokepoint map (the first Node adopter — wiring is Plan 5, not Plan 3)

`C:\Code\adopter-a\node-ai-proxy` is **ESM** (`"type":"module"`), `@google/genai` **v1.52**, Express 4.22, **no `openai` SDK** (hand-rolled `http`/`https` + global `fetch`), **no `engines` pin** (needs Node ≥18 in practice: uses `node:async_hooks`, global `fetch`, `TextDecoder`, `AbortController`).

**Three LLM transports (a generic Node SDK must be able to wrap all three):**

| # | Mechanism | File:line | Streaming? | Usage today |
|---|-----------|-----------|-----------|-------------|
| (a) | OpenAI-compatible raw http/https — `requestStreamingResponse({url,headers,body,timeoutMs,signal})` | `lib/openaiClient.js:112` | 4 streaming + 1 buffered (`callLLMForJSON`), all in `routes/resource.js` (`:266/:482/:615/:756/:823`) | **none** |
| (b) | Global `fetch` wrapper — `traceFetch(input, init)` | `lib/traceContext.js:37` | 1 buffered LLM caller `reportActionCards.js:61` | **none** |
| (c) | Gemini native `@google/genai` — `generateContent` (×3, `routes/gemini.js:36/59/93`) + `generateContentStream` (`lib/googleStreamClient.js:90`) | — | 3 buffered + 1 streaming | **none** |

- **Token usage is captured at ZERO call sites today.** The SSE chunk parser `extractTextFromModelChunk` (`openaiClient.js:175`) reads only `choices[0].delta.content` and **ignores `usage` entirely**. Buffered responses (`callLLMForJSON`, `reportActionCards`, Gemini `generateContent`) all have `usage`/`usageMetadata` on the resolved object, unread.
- **AsyncLocalStorage already exists:** `traceStorage = new AsyncLocalStorage()` (`lib/traceContext.js:7`), carries only `{ traceId }`. Established in `traceMiddleware` (`:44`, mounted `server.js:116`), resolved from `X-Trace-Id`/`X-Request-Id`. To add identity: extend `traceMiddleware` to `traceStorage.run({ traceId, userId, orgId, projectId }, next)` and add a `getMeterContext()` reader. This is the one place every request passes through.
- **Provider base-URL traps (matters for Plan 5/pricing, not the generic extractors):** Zhipu GLM `…/api/paas/v4` (NOT `/v1`), Volcengine Ark `https://ark.cn-beijing.volces.com/api/v3`, MiniMax `…/v1`. Re-appending `/v1` to Zhipu/Volcengine → 404. Doubao `model` is a user-created Endpoint ID.

## 2. OpenAI-compatible streaming usage — VERIFIED

- Send `stream_options: { include_usage: true }` on streaming requests. Default off → no usage in stream.
- Usage rides **one extra final chunk** before `data: [DONE]`; all earlier chunks have `usage: null`. The usage chunk is identified by **`choices.length === 0`** (empty array) — never index `choices[0]` on it.
- Fields off `chunk.usage`: `prompt_tokens`, `completion_tokens`, `total_tokens`; nested optional `prompt_tokens_details.{cached_tokens, audio_tokens}` and `completion_tokens_details.{reasoning_tokens, accepted_prediction_tokens, audio_tokens, rejected_prediction_tokens}`. **Null-guard all nested fields** (provider-variable).
- **Tolerate a missing usage chunk** (interrupted/cancelled stream → it may never arrive).
- Non-streaming: `usage` on the response body; treat as possibly-absent (null-guard) though present in practice.
- MiniMax: documents `include_usage` (default `false`), usage "only returned in the last chunk". Doubao/Zhipu honor `include_usage`; their nested `*_details.*` on streaming are **undocumented → verify empirically**.
- Citations: [OpenAI announcement](https://community.openai.com/t/usage-stats-now-available-when-using-streaming-with-the-chat-completions-api-or-completions-api/738156) · [OpenAI streaming-events ref](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events) · [MiniMax](https://platform.minimax.io/docs/api-reference/text-chat-openai) · [Zhipu OpenAI-compat](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)

## 3. Gemini `@google/genai` usage — VERIFIED against SDK source (`googleapis/js-genai` `src/types.ts` 3415–3470)

- `response.usageMetadata` (optional — always optional-chain). Members: `promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`, `cachedContentTokenCount`, `thoughtsTokenCount` (reasoning), `toolUsePromptTokenCount`, and details arrays `promptTokensDetails`/`candidatesTokensDetails`/`cacheTokensDetails`/`toolUsePromptTokensDetails`, `trafficType`.
- `totalTokenCount` already includes `toolUsePromptTokenCount` + `thoughtsTokenCount` (cached is a subset of prompt). For billing read: `promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`, `cachedContentTokenCount` (+ `thoughtsTokenCount` if reasoning billed separately).
- **Streaming** `generateContentStream` returns `Promise<AsyncGenerator<GenerateContentResponse>>`; each chunk is a full response. Capture `chunk.usageMetadata` with **last-non-null wins; NEVER sum across chunks**. "Usage only on final chunk / cumulative" is observed-but-undocumented → last-write-wins is robust to either. Handle `usage === undefined` after the loop (real for some older preview models).
- Do not confuse with `ai.models.countTokens(...)` → `CountTokensResponse.totalTokens` (no `Count` suffix, no `usageMetadata` wrapper).
- Citations: [SDK type source](https://raw.githubusercontent.com/googleapis/js-genai/main/src/types.ts) · [models.ts (stream return type)](https://raw.githubusercontent.com/googleapis/js-genai/main/src/models.ts) · [TypeDoc](https://googleapis.github.io/js-genai/release_docs/classes/types.GenerateContentResponseUsageMetadata.html) · [REST ref](https://ai.google.dev/api/generate-content) · [staff: use chunk.usageMetadata](https://discuss.ai.google.dev/t/how-do-you-get-the-usagemetadata-when-using-a-content-stream/80591)

## 4. Node library packaging + non-blocking delivery — VERIFIED (2 corrections applied)

**Dual ESM+CJS (target Node ≥18):** build with tsup `format:['esm','cjs'], dts:true`. `package.json` `exports` map with **`"types"` listed FIRST** in each `import`/`require` condition (TS stops at first match), separate `.d.ts` (ESM) and `.d.cts` (CJS), `main → ./dist/index.cjs`, `engines.node >=18`, `files:["dist"]`, `sideEffects:false`. Validate before relying on it: `publint` + `@arethetypeswrong/cli`, plus an `import` and a `require()` smoke test. **Dual-package hazard:** import+require loading → two instances with separate module-scope state → keep the singleton on `globalThis` (or keep module scope stateless). Node 18 cannot `require()` ESM, so dual publishing is correct here. ([packages.html](https://nodejs.org/api/packages.html) · [tsup+attw](https://johnnyreilly.com/dual-publishing-esm-cjs-modules-with-tsup-and-are-the-types-wrong) · [TS ESM/CJS 2025](https://lirantal.com/blog/typescript-in-2025-with-esm-and-cjs-npm-publishing))

**AsyncLocalStorage (`node:async_hooks`):** one ALS instance for the SDK. `run(store, cb, …args)` runs `cb` **synchronously**, returns its value; store visible to async work it spawns, `undefined` outside. Prefer `run()` over `enterWith()` (enterWith leaks into caller/subsequent event handlers). `withScope()` is v25.9.0 — **not on Node 18**. ([async_context](https://nodejs.org/api/async_context.html))

**Background delivery loop:** in-memory buffer; `enqueue` pushes and returns immediately (never one-POST-per-event). Flush on **size OR interval** (single-flight `flushing` guard — one flush sends one batch, not a guaranteed full drain). `setInterval(flush, intervalMs).unref()` so the loop never keeps the process alive. global `fetch` exists on Node 18+ (experimental in 18) → **expose a `fetch` injection seam**. Backpressure: drop/stop when unbounded (never grow memory without bound). ([PostHog Node](https://posthog.com/docs/libraries/node) · [Segment Node](https://segment.com/docs/connections/sources/catalog/libraries/server/node/) · [timers — unref](https://nodejs.org/api/timers.html))

**Exit flushing (the hard part) — VERIFIED VERBATIM:** `'exit'` listeners must be **synchronous**; queued async work is **abandoned** → cannot `await fetch` in `'exit'`. `'beforeExit'` CAN do async work but is **NOT emitted on `process.exit()` or uncaught exceptions** (only natural drain). `process.exit()` truncates buffered stdout/stderr. **Pattern:** hook `SIGTERM`/`SIGINT` for an async best-effort flush (installing a listener removes Node's default exit, so async work gets to run) bounded by an `unref()`'d force-exit timer; expose an **awaitable `shutdown()`** that loops `flush()` until drained (the only real guarantee is a consumer-invoked `await shutdown()`); `'exit'` only counts/logs unflushed loss. ([process.html](https://nodejs.org/api/process.html))

**Two verifier corrections to apply:**
1. The folk claim "`unref()` creates an internal waker / perf cost with thousands" is **NOT in the Node timers docs** — do not repeat it; `unref()`'s documented behavior (process may exit before the timer fires) is all we rely on.
2. `require(esm)` is unflagged since **v20.19 / v22.12 / v23.0** (not "Node 23+" only) — immaterial here since we target Node 18 (dual build correct), just don't overstate.
