# Plan 4 — 看板 web/ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 chobo 最小看板 `web/` —— 一个纯读 CRM 聚合 API 的 React 前端,由 CRM 同源托管,忠实呈现 per-end-user 计费。

**Architecture:** 新建独立包 `web/`(React+TS+Vite,不进 workspace)。前端零运行时依赖(除 react/react-dom):手写 SVG 图表 + 自写 `useFetch`。CRM(`@chobo/server`)新增 `@fastify/static` 同源发 `web/dist` + API,零 CORS;ingest 密钥从全局收窄到只守 `/v1/events`,stats/页面开放靠网络隔离。开发期 Vite proxy 把 `/v1` 转发本地 CRM,对真 API 开发。

**Tech Stack:** React 18 + TypeScript 5 + Vite 5 + vitest + @testing-library/react(jsdom);server 侧 `@fastify/static`。

**权威 spec:** [`docs/superpowers/specs/2026-06-24-dashboard-web-design.md`](../specs/2026-06-24-dashboard-web-design.md)。行为有出入以 spec 为准。

---

## 文件结构(决策已锁定)

**server/(改动 @chobo/server):**
- Modify `server/src/types.ts` — `ServerConfig` 加 `webDir: string | null`。
- Modify `server/src/config.ts` — 解析 `CHOBO_WEB_DIR`。
- Modify `server/src/ingest.ts` — `IngestDeps` 加可选 `guard`,挂到 `/v1/events` 路由级 `preHandler`。
- Modify `server/src/app.ts` — 不再全局挂 guard;guard 传给 `registerIngest`;按 `cfg.webDir` 条件挂静态。
- Create `server/src/static.ts` — `registerStatic(app, webDir)`:@fastify/static + SPA 回退。
- Modify `server/src/server.ts` — boot 时把 `cfg.webDir` 透传(已经过 buildApp,无需改动逻辑,仅确认)。
- Create `server/src/seed-events.ts` — `buildSampleEvents()` 生成器 + `seedEvents()` POST 循环。
- Create `server/scripts/seed-events-cli.ts` — CLI 入口;`package.json` 加 `seed:events` 脚本。
- Modify `server/test/auth.test.ts` — 断言新鉴权姿态(ingest 守、其它开)。
- Create `server/test/static.test.ts`、`server/test/seed-events.test.ts`。
- Modify `server/package.json` — dep `@fastify/static`;script `seed:events`。

**web/(全新):**
```
web/
  package.json  vite.config.ts  tsconfig.json  tsconfig.node.json  index.html  .gitignore
  src/
    main.tsx  App.tsx
    api/types.ts  api/format.ts  api/useFetch.ts
    components/ FilterBar.tsx KpiCards.tsx TimeseriesChart.tsx
                DimensionRanking.tsx EventsTable.tsx ErrorBanner.tsx EmptyState.tsx
    styles/ tokens.css  app.css
  test/ setup.ts format.test.tsx useFetch.test.tsx kpicards.test.tsx
        timeseries.test.tsx ranking.test.tsx events.test.tsx filterbar.test.tsx
```

---

## Task 1: 收窄 ingest 密钥闸门到 ingest 路由

**Files:**
- Modify: `server/src/ingest.ts`
- Modify: `server/src/app.ts`
- Modify: `server/test/auth.test.ts`

- [ ] **Step 1: 改写 auth 测试,断言新姿态**

把 `server/test/auth.test.ts` 整体替换为(镜像 app.ts 的新接线:guard 走路由级、另有一条开放路由):

```ts
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { secretGuard } from "../src/auth.js";

// 镜像 app.ts 的新接线:guard 只挂在 ingest 路由上,stats 路由开放
function appWith(secret: string | null) {
  const app = Fastify();
  const guard = secretGuard(secret);
  app.post("/v1/events", { preHandler: guard }, async () => ({ ok: true }));
  app.get("/v1/stats/overview", async () => ({ open: true }));
  return app;
}

describe("ingest-scoped secretGuard", () => {
  it("open when no secret", async () => {
    const app = appWith(null);
    expect((await app.inject({ method: "POST", url: "/v1/events", payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/stats/overview" })).statusCode).toBe(200);
  });
  it("ingest 401 when secret set but header missing/wrong", async () => {
    const app = appWith("s3cret");
    expect((await app.inject({ method: "POST", url: "/v1/events", payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/events", headers: { "x-chobo-secret": "nope" }, payload: {} })).statusCode).toBe(401);
  });
  it("ingest 200 when header matches", async () => {
    const app = appWith("s3cret");
    expect((await app.inject({ method: "POST", url: "/v1/events", headers: { "x-chobo-secret": "s3cret" }, payload: {} })).statusCode).toBe(200);
  });
  it("stats stays OPEN even when secret set (no header)", async () => {
    const app = appWith("s3cret");
    expect((await app.inject({ method: "GET", url: "/v1/stats/overview" })).statusCode).toBe(200);
  });
});
```

注意 Fastify 路由选项接受 `preHandler: undefined`(无 secret 时 `secretGuard` 返回 `undefined`)—— 等价于无 hook。

- [ ] **Step 2: 跑测试,确认 stats-open 用例失败(旧 app.ts 仍全局拦)**

Run: `cd server && npx vitest run test/auth.test.ts`
Expected: 新增的 "stats stays OPEN" 用例 FAIL(当前 app.ts 是全局 hook,但此测试用的是本地 `appWith`,实际上本测试自洽 —— 真正的回归保护在 Step 3 改 app.ts)。若全绿则说明镜像已对,直接进 Step 3。

- [ ] **Step 3: ingest 接受并挂载 guard**

`server/src/ingest.ts` —— 在 `IngestDeps` 加 `guard`,并把路由选项加上 `preHandler`:

```ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
// ...existing imports...
type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface IngestDeps {
  sql: Sql;
  validateEvent: ValidateFunction<EventInput>;
  priceTable: () => PriceTable;
  payloadMode: PayloadMode;
  payloadMaxBytes: number;
  guard?: PreHandler;            // ingest 路由级密钥闸门;undefined=开放
}
```

把 `registerIngest` 内的路由注册改为(在 `const { ... } = deps;` 加上 `guard`):

```ts
export function registerIngest(app: FastifyInstance, deps: IngestDeps): void {
  const { sql, validateEvent, priceTable, payloadMode, payloadMaxBytes, guard } = deps;

  app.post("/v1/events", { schema: { body: envelopeSchema() }, preHandler: guard }, async (req, reply) => {
    // ...handler 体保持不变...
```

- [ ] **Step 4: app.ts 不再全局挂 guard,改为传给 ingest**

`server/src/app.ts` —— 删除全局 hook,把 guard 传进 ingest:

```ts
  const guard = secretGuard(cfg.ingestSecret);
  // 不再 app.addHook("preHandler", guard) —— 收窄到只守 ingest 路由

  app.get("/healthz", async () => ({ ok: true }));
  registerIngest(app, { sql, validateEvent: makeEventValidator(ajv), priceTable, payloadMode: cfg.payloadMode, payloadMaxBytes: cfg.payloadMaxBytes, guard });
  registerStats(app, { sql });
```

- [ ] **Step 5: 全量回归**

Run: `cd server && npx vitest run && npx tsc --noEmit`
Expected: 全绿(51 测试基线 + 改写后的 auth 用例),tsc 干净。

- [ ] **Step 6: Commit**

```bash
git add server/src/ingest.ts server/src/app.ts server/test/auth.test.ts
git commit -m "fix(server): ingest 密钥闸门从全局收窄到只守 /v1/events(看板需要 stats 开放)"
```

---

## Task 2: @fastify/static 同源托管 SPA(非破坏)

**Files:**
- Modify: `server/package.json`
- Modify: `server/src/types.ts`
- Modify: `server/src/config.ts`
- Create: `server/src/static.ts`
- Modify: `server/src/app.ts`
- Create: `server/test/static.test.ts`
- Modify: `server/test/config.test.ts`

- [ ] **Step 1: 装 @fastify/static**

Run: `cd server && npm install @fastify/static@^8.0.0`
Expected: `package.json` dependencies 多出 `@fastify/static`。

- [ ] **Step 2: 写静态服务的失败测试**

`server/test/static.test.ts` —— 用临时目录放 `index.html` + 一个资源,断言 SPA 回退且 `/v1` 不被吞:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerStatic } from "../src/static.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "chobo-web-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>chobo</title><div id=root></div>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log('hi')");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function app() {
  const a = Fastify();
  a.get("/v1/ping", async () => ({ pong: true }));   // 代表 API 路由
  registerStatic(a, dir);
  return a;
}

describe("registerStatic", () => {
  it("serves index.html at /", async () => {
    const r = await app().inject({ method: "GET", url: "/" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("id=root");
  });
  it("serves a built asset", async () => {
    const r = await app().inject({ method: "GET", url: "/assets/app.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("hi");
  });
  it("SPA fallback: unknown GET → index.html", async () => {
    const r = await app().inject({ method: "GET", url: "/audit" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("id=root");
  });
  it("does NOT swallow /v1 API routes", async () => {
    const r = await app().inject({ method: "GET", url: "/v1/ping" });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ pong: true });
  });
  it("unknown /v1 path → 404 JSON, not index", async () => {
    const r = await app().inject({ method: "GET", url: "/v1/nope" });
    expect(r.statusCode).toBe(404);
    expect(r.headers["content-type"]).toContain("application/json");
  });
});
```

- [ ] **Step 3: 跑测试,确认失败(模块不存在)**

Run: `cd server && npx vitest run test/static.test.ts`
Expected: FAIL —— `Cannot find module '../src/static.js'`。

- [ ] **Step 4: 实现 registerStatic**

`server/src/static.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/**
 * 同源托管已打包的看板:web/dist 下的静态资源 + SPA 回退。
 * - 真实文件(/assets/*, /favicon 等)由 @fastify/static 直发。
 * - 未命中的 GET 且非 /v1 → 回 index.html(供前端 in-app 路由 / 刷新)。
 * - /v1 未命中 → 404 JSON(不污染 API 语义)。
 * 仅当 webDir 存在 index.html 时由 app.ts 调用;无产物则不挂,CRM 退回纯 API。
 */
export function registerStatic(app: FastifyInstance, webDir: string): void {
  const indexHtml = readFileSync(join(webDir, "index.html"), "utf8");
  app.register(fastifyStatic, { root: webDir, prefix: "/", wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/v1")) {
      reply.type("text/html").send(indexHtml);
      return;
    }
    reply.code(404).send({ error: "not found" });
  });
}
```

- [ ] **Step 5: 跑测试,确认通过**

Run: `cd server && npx vitest run test/static.test.ts`
Expected: PASS(5 用例)。

- [ ] **Step 6: config 加 webDir + 测试**

`server/src/types.ts` —— `ServerConfig` 末尾加字段:

```ts
  priceSeedPath: string | null;
  webDir: string | null;        // 看板静态产物目录(web/dist);null=纯 API
```

`server/src/config.ts` —— `return {...}` 里加(在 `priceSeedPath` 后):

```ts
    priceSeedPath: env.CHOBO_PRICE_SEED ?? null,
    webDir: env.CHOBO_WEB_DIR ?? null,
```

`server/test/config.test.ts` —— 追加一个用例(在现有 describe 内):

```ts
  it("webDir defaults to null, reads CHOBO_WEB_DIR", () => {
    expect(resolveConfig({ CHOBO_DATABASE_URL: "postgres://x" }).webDir).toBeNull();
    expect(resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_WEB_DIR: "/srv/web" }).webDir).toBe("/srv/web");
  });
```

- [ ] **Step 7: app.ts 条件挂载静态**

`server/src/app.ts` —— 顶部加 import,函数末尾(`registerStats` 之后、`return app` 之前)条件挂载:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { registerStatic } from "./static.js";
// ...
  registerStats(app, { sql });
  if (cfg.webDir && existsSync(join(cfg.webDir, "index.html"))) {
    registerStatic(app, cfg.webDir);
    app.log.info({ webDir: cfg.webDir }, "chobo: serving dashboard");
  }
  return app;
```

- [ ] **Step 8: 全量回归 + 类型检查**

Run: `cd server && npx vitest run && npx tsc --noEmit`
Expected: 全绿,tsc 干净。

- [ ] **Step 9: Commit**

```bash
git add server/package.json server/package-lock.json server/src/types.ts server/src/config.ts server/src/static.ts server/src/app.ts server/test/static.test.ts server/test/config.test.ts
git commit -m "feat(server): @fastify/static 同源托管看板 SPA(CHOBO_WEB_DIR,非破坏:无产物退回纯 API)"
```

---

## Task 3: seed-events 仿真数据脚本

**Files:**
- Create: `server/src/seed-events.ts`
- Create: `server/scripts/seed-events-cli.ts`
- Modify: `server/package.json`
- Create: `server/test/seed-events.test.ts`

- [ ] **Step 1: 写生成器的失败测试**

`server/test/seed-events.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildSampleEvents } from "../src/seed-events.js";

describe("buildSampleEvents", () => {
  const evs = buildSampleEvents({ count: 200, days: 14, seed: 1 });

  it("produces the requested count", () => {
    expect(evs).toHaveLength(200);
  });
  it("every event has the contract-required fields", () => {
    for (const e of evs) {
      for (const f of ["event_id","identity_source","start_time","service","provider","operation","request_model","usage_source","status","sdk_lang","sdk_version"]) {
        expect(e[f as keyof typeof e]).toBeDefined();
      }
      expect(typeof e.start_time).toBe("number");
    }
  });
  it("event_ids are unique (idempotent re-seed dedupes, but generator itself is unique)", () => {
    expect(new Set(evs.map((e) => e.event_id)).size).toBe(200);
  });
  it("includes at least one UNPRICED model (so 看板 renders 未定价)", () => {
    expect(evs.some((e) => e.request_model === "gpt-image-2" || e.request_model === "gemini-3.5-flash")).toBe(true);
  });
  it("spreads start_time across the requested window (not all identical)", () => {
    expect(new Set(evs.map((e) => e.start_time)).size).toBeGreaterThan(10);
  });
  it("is deterministic for a given seed", () => {
    expect(buildSampleEvents({ count: 50, days: 7, seed: 42 })[0].event_id)
      .toBe(buildSampleEvents({ count: 50, days: 7, seed: 42 })[0].event_id);
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd server && npx vitest run test/seed-events.test.ts`
Expected: FAIL —— `Cannot find module '../src/seed-events.js'`。

- [ ] **Step 3: 实现生成器 + POST 循环**

`server/src/seed-events.ts`:

```ts
import type { EventInput } from "./types.js";

// 确定性 PRNG(mulberry32)—— 禁用 Math.random,保证 seed 可复现
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const USERS = ["teacher-0420", "teacher-1187", "teacher-3302", "teacher-0091"];
const ORGS = ["school-hz-3", "school-sh-1", "school-bj-7"];
const PROJECTS = ["lesson-parse", "chat-tutor", "image-gen"];
// 含已定价(doubao)与未定价(example-gateway 三项待价)模型 —— 后者落 total_cost=NULL
const MODELS: Array<{ provider: string; model: string; operation: EventInput["operation"] }> = [
  { provider: "doubao", model: "doubao-seed-2.0-pro", operation: "chat" },
  { provider: "doubao", model: "doubao-seed-2.0-pro", operation: "chat" },
  { provider: "example-gateway", model: "gpt-5.5", operation: "chat" },
  { provider: "example-gateway", model: "gemini-3.5-flash", operation: "chat" },
  { provider: "example-gateway", model: "gpt-image-2", operation: "image" },
];

export interface SampleOpts { count: number; days: number; seed: number; nowMs?: number; }

export function buildSampleEvents(opts: SampleOpts): EventInput[] {
  const { count, days, seed, nowMs = 1_750_000_000_000 } = opts;
  const r = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const out: EventInput[] = [];
  for (let i = 0; i < count; i++) {
    const m = pick(MODELS);
    const start = nowMs - Math.floor(r() * days * 86_400_000);
    const inTok = m.operation === "image" ? 0 : 200 + Math.floor(r() * 4000);
    const outTok = m.operation === "image" ? 0 : 50 + Math.floor(r() * 1500);
    const fail = r() < 0.012;
    out.push({
      event_id: `seed-${seed}-${i}`,
      identity_source: "header",
      start_time: start,
      end_time: start + 200 + Math.floor(r() * 1800),
      latency_ms: 200 + Math.floor(r() * 1800),
      service: "node-ai-proxy",
      provider: m.provider,
      operation: m.operation,
      request_model: m.model,
      user_id: pick(USERS), org_id: pick(ORGS), project: pick(PROJECTS),
      input_tokens: inTok || null, output_tokens: outTok || null,
      total_tokens: (inTok + outTok) || null,
      image_count: m.operation === "image" ? 1 : null,
      usage_source: "measured",
      status: fail ? "failure" : "success",
      error_type: fail ? "upstream_timeout" : null,
      sdk_lang: "node", sdk_version: "0.1.0",
    });
  }
  return out;
}

/** 把仿真事件分批 POST 到运行中的 CRM /v1/events(走真 ingest+去重+算价)。 */
export async function seedEvents(baseUrl: string, events: EventInput[], secret?: string): Promise<{ accepted: number; duplicates: number; rejected: number }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers["x-chobo-secret"] = secret;
  const agg = { accepted: 0, duplicates: 0, rejected: 0 };
  for (let i = 0; i < events.length; i += 500) {
    const batch = events.slice(i, i + 500);
    const res = await fetch(`${baseUrl}/v1/events`, { method: "POST", headers, body: JSON.stringify({ events: batch }) });
    if (!res.ok) throw new Error(`seed POST failed: HTTP ${res.status} ${await res.text()}`);
    const r = (await res.json()) as { accepted: number; duplicates: number; rejected: number };
    agg.accepted += r.accepted; agg.duplicates += r.duplicates; agg.rejected += r.rejected;
  }
  return agg;
}
```

`server/scripts/seed-events-cli.ts`:

```ts
import { buildSampleEvents, seedEvents } from "../src/seed-events.js";

const base = process.env.CHOBO_BASE_URL ?? "http://localhost:8787";
const count = Number(process.env.SEED_COUNT ?? "500");
const days = Number(process.env.SEED_DAYS ?? "30");
const secret = process.env.CHOBO_INGEST_SECRET?.trim() || undefined;

const events = buildSampleEvents({ count, days, seed: 7 });
seedEvents(base, events, secret)
  .then((r) => { console.log(`chobo seed → ${base}:`, r); process.exit(0); })
  .catch((e) => { console.error("chobo seed failed:", e); process.exit(1); });
```

- [ ] **Step 4: package.json 加脚本**

`server/package.json` scripts 加一行:

```json
    "seed:events": "node --import tsx scripts/seed-events-cli.ts",
```

- [ ] **Step 5: 跑测试,确认通过 + 类型检查**

Run: `cd server && npx vitest run test/seed-events.test.ts && npx tsc --noEmit`
Expected: PASS(6 用例),tsc 干净。

- [ ] **Step 6: Commit**

```bash
git add server/src/seed-events.ts server/scripts/seed-events-cli.ts server/package.json server/test/seed-events.test.ts
git commit -m "feat(server): seed-events 仿真数据脚本(确定性生成器,含未定价模型,POST 真 ingest)"
```

---

## Task 4: 脚手架 web/ 包

**Files:**
- Create: `web/package.json` `web/vite.config.ts` `web/tsconfig.json` `web/tsconfig.node.json` `web/index.html` `web/.gitignore`
- Create: `web/src/main.tsx` `web/src/App.tsx`
- Create: `web/test/setup.ts`

- [ ] **Step 1: 写 package.json**

`web/package.json`:

```json
{
  "name": "@chobo/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.8.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0",
    "jsdom": "^25.0.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/jest-dom": "^6.5.0",
    "@testing-library/user-event": "^14.5.0"
  }
}
```

- [ ] **Step 2: 写配置文件**

`web/vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/v1": "http://localhost:8787" },   // 开发期把 API 转给本地 CRM
  },
  build: { outDir: "dist" },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
  } as unknown as never,   // vitest 配置合并进 vite config;类型用 vitest/config 时可去掉断言
});
```

> 实现注意:更干净的写法是 `import { defineConfig } from "vitest/config"`,即可原生带 `test` 字段、去掉 `as unknown as never`。实现者二选一,保证 `npm test` 与 `vite build` 都跑通即可。

`web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "test"]
}
```

`web/tsconfig.node.json`:

```json
{
  "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler", "strict": true, "skipLibCheck": true },
  "include": ["vite.config.ts"]
}
```

`web/.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
```

`web/index.html`:

```html
<!doctype html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>帳簿 chobo · 用量看板</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: 写 setup + 最小 App + 入口**

`web/test/setup.ts`:

```ts
import "@testing-library/jest-dom";
```

`web/src/App.tsx`:

```tsx
export default function App() {
  return <h1>帳簿 chobo</h1>;
}
```

`web/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>,
);
```

- [ ] **Step 4: 写冒烟测试**

`web/test/smoke.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import App from "../src/App.js";

it("renders brand", () => {
  render(<App />);
  expect(screen.getByText("帳簿 chobo")).toBeInTheDocument();
});
```

- [ ] **Step 5: 装依赖 + 跑测试 + 构建**

Run: `cd web && npm install && npm test && npm run build`
Expected: install 成功;1 测试 PASS;`vite build` 产出 `web/dist/index.html`。

- [ ] **Step 6: Commit**

```bash
git add web/
git commit -m "feat(web): 脚手架 @chobo/web(React+TS+Vite+vitest,dev proxy /v1→CRM)"
```

---

## Task 5: 设计令牌 + App 壳(导航 + 页面状态)

**Files:**
- Create: `web/src/styles/tokens.css` `web/src/styles/app.css`
- Modify: `web/src/App.tsx` `web/src/main.tsx`

- [ ] **Step 1: 写令牌(清亮分析型,锁定自 spec §9)**

`web/src/styles/tokens.css`:

```css
:root{
  --bg:#f8fafc; --surface:#ffffff; --text:#0f172a; --muted:#64748b;
  --border:#e2e8f0; --accent:#4f46e5; --accent-soft:#eef2ff;
  --success:#16a34a; --danger:#dc2626;
  --radius:12px; --shadow:0 1px 2px rgba(0,0,0,.04);
  --font: ui-sans-serif, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
*{box-sizing:border-box;}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);}
```

`web/src/styles/app.css`:

```css
.topbar{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;background:var(--surface);border-bottom:1px solid var(--border);}
.brand{font-weight:700;letter-spacing:.5px;}
.nav{display:flex;gap:18px;}
.nav button{background:none;border:none;font-size:14px;color:var(--muted);cursor:pointer;padding:8px 0;border-bottom:2px solid transparent;}
.nav button.active{color:var(--text);font-weight:600;border-bottom-color:var(--text);}
.page{padding:20px;max-width:1100px;margin:0 auto;display:flex;flex-direction:column;gap:18px;}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:14px;}
.label{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);}
.unpriced{color:var(--muted);font-style:italic;}
```

- [ ] **Step 2: App 壳:导航 + 页面切换(in-app state,零路由依赖)**

`web/src/App.tsx`:

```tsx
import { useState } from "react";
import "./styles/tokens.css";
import "./styles/app.css";

type Page = "overview" | "audit";

export default function App() {
  const [page, setPage] = useState<Page>("overview");
  return (
    <>
      <header className="topbar">
        <span className="brand">帳簿 chobo</span>
        <nav className="nav">
          <button className={page === "overview" ? "active" : ""} onClick={() => setPage("overview")}>概览</button>
          <button className={page === "audit" ? "active" : ""} onClick={() => setPage("audit")}>审计明细</button>
        </nav>
      </header>
      <main className="page">
        {page === "overview" ? <p>概览页(待装组件)</p> : <p>审计页(待装组件)</p>}
      </main>
    </>
  );
}
```

`web/src/main.tsx` 无需改(仍渲染 App)。

- [ ] **Step 3: 改冒烟测试,断言导航切换**

`web/test/smoke.test.tsx` 替换为:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../src/App.js";

it("renders brand and switches pages", async () => {
  render(<App />);
  expect(screen.getByText("帳簿 chobo")).toBeInTheDocument();
  expect(screen.getByText(/概览页/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "审计明细" }));
  expect(screen.getByText(/审计页/)).toBeInTheDocument();
});
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS;tsc 干净。

- [ ] **Step 5: Commit**

```bash
git add web/
git commit -m "feat(web): 设计令牌(清亮分析型)+ App 壳(概览/审计 导航,零路由依赖)"
```

---

## Task 6: api/types.ts + api/format.ts(计费铁律的渲染层)

**Files:**
- Create: `web/src/api/types.ts` `web/src/api/format.ts`
- Create: `web/test/format.test.tsx`

- [ ] **Step 1: 写响应体类型(锚定 Plan 2 实际 stats 响应)**

`web/src/api/types.ts`:

```ts
export interface Filters {
  from?: string; to?: string;
  user_id?: string; org_id?: string; project?: string;
  provider?: string; service?: string; request_model?: string; status?: string;
}
export interface Overview {
  currency: string;
  totals: {
    events: number; input_tokens: number; output_tokens: number; total_tokens: number;
    total_cost: string | null;
    by_status: { success: number; failure: number };
  };
}
export type Bucket = "hour" | "day" | "week" | "month";
export interface TimeseriesPoint { ts: string; events: number; total_tokens: number; total_cost: string | null; }
export interface Timeseries { bucket: Bucket; currency: string; series: TimeseriesPoint[]; }
export interface DimRow { key: string | null; events: number; total_tokens: number; total_cost: string | null; }
export interface DimRanking { dimension: string; currency: string; rows: DimRow[]; }
export interface EventRow {
  event_id: string; created_at: string;
  user_id: string | null; org_id: string | null; project: string | null;
  provider: string; service: string; request_model: string; operation: string; status: string;
  input_tokens: number | null; output_tokens: number | null; total_tokens: number | null;
  total_cost: string | null; currency: string | null;
  request_payload?: unknown; response_payload?: unknown; truncated?: boolean; redacted?: boolean;
  [k: string]: unknown;
}
export interface EventsPage { events: EventRow[]; next_cursor: string | null; }
export type Dimension = "by-user" | "by-org" | "by-project";
```

- [ ] **Step 2: 写 format 的失败测试(钉死铁律)**

`web/test/format.test.tsx`:

```tsx
import { formatCost, formatCount, formatCompact, isUnpriced } from "../src/api/format.js";

describe("formatCost — 计费铁律", () => {
  it("null → 未定价(绝不 ¥0)", () => {
    expect(formatCost(null)).toBe("未定价");
    expect(isUnpriced(null)).toBe(true);
  });
  it("保留完整精度字符串,不经 JS number", () => {
    expect(formatCost("0.04800000")).toBe("¥0.04800000");
  });
  it("千分位分组(字符串级)", () => {
    expect(formatCost("1284.07")).toBe("¥1,284.07");
    expect(formatCost("31600000")).toBe("¥31,600,000");
  });
  it("整数无小数部分", () => {
    expect(formatCost("500")).toBe("¥500");
  });
});

describe("formatCount / formatCompact", () => {
  it("count 千分位", () => { expect(formatCount(48210)).toBe("48,210"); });
  it("compact 大数", () => {
    expect(formatCompact(31_600_000)).toBe("31.6M");
    expect(formatCompact(9_200)).toBe("9.2K");
    expect(formatCompact(310)).toBe("310");
  });
});
```

- [ ] **Step 3: 跑测试,确认失败**

Run: `cd web && npx vitest run test/format.test.tsx`
Expected: FAIL —— `Cannot find module '../src/api/format.js'`。

- [ ] **Step 4: 实现 format**

`web/src/api/format.ts`:

```ts
// 钱永远以服务端给的 numeric 字符串呈现 —— 绝不转 JS number(精度坏账),缺价显「未定价」绝不 ¥0。
export function groupThousands(intPart: string): string {
  const neg = intPart.startsWith("-");
  const digits = neg ? intPart.slice(1) : intPart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return neg ? "-" + grouped : grouped;
}

export function isUnpriced(cost: string | null): boolean {
  return cost == null;
}

export function formatCost(cost: string | null): string {
  if (cost == null) return "未定价";
  const dot = cost.indexOf(".");
  if (dot === -1) return "¥" + groupThousands(cost);
  return "¥" + groupThousands(cost.slice(0, dot)) + cost.slice(dot);
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatCompact(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
```

- [ ] **Step 5: 跑测试,确认通过**

Run: `cd web && npx vitest run test/format.test.tsx`
Expected: PASS(6 用例)。

- [ ] **Step 6: Commit**

```bash
git add web/src/api/types.ts web/src/api/format.ts web/test/format.test.tsx
git commit -m "feat(web): api 类型 + format(钱保字符串精度、缺价显未定价的渲染铁律)"
```

---

## Task 7: api/useFetch.ts + ErrorBanner + EmptyState

**Files:**
- Create: `web/src/api/useFetch.ts`
- Create: `web/src/components/ErrorBanner.tsx` `web/src/components/EmptyState.tsx`
- Create: `web/test/useFetch.test.tsx`

- [ ] **Step 1: 写 useFetch 的失败测试(mock fetch)**

`web/test/useFetch.test.tsx`:

```tsx
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { useFetch, toQuery } from "../src/api/useFetch.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("toQuery", () => {
  it("跳过 undefined/null/空串,拼非空查询串", () => {
    expect(toQuery({ a: "1", b: undefined, c: "", d: 2 })).toBe("?a=1&d=2");
    expect(toQuery({})).toBe("");
  });
});

describe("useFetch", () => {
  it("success → data,loading 落定", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ hello: 1 }) })));
    const { result } = renderHook(() => useFetch<{ hello: number }>("/v1/x"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ hello: 1 });
    expect(result.current.error).toBeNull();
  });
  it("非 2xx → error 态(绝不当空成功)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const { result } = renderHook(() => useFetch("/v1/x"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("500");
    expect(result.current.data).toBeNull();
  });
  it("网络错 → error 态", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const { result } = renderHook(() => useFetch("/v1/x"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("network down");
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd web && npx vitest run test/useFetch.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 useFetch**

`web/src/api/useFetch.ts`:

```ts
import { useEffect, useState } from "react";

export type QueryParams = Record<string, string | number | boolean | undefined | null>;
export interface FetchState<T> { data: T | null; error: string | null; loading: boolean; }

export function toQuery(params: QueryParams): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

export function useFetch<T>(path: string, params: QueryParams = {}): FetchState<T> {
  const url = path + toQuery(params);
  const [state, setState] = useState<FetchState<T>>({ data: null, error: null, loading: true });
  useEffect(() => {
    let alive = true;
    setState({ data: null, error: null, loading: true });
    fetch(url)
      .then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return (await r.json()) as T; })
      .then((data) => { if (alive) setState({ data, error: null, loading: false }); })
      .catch((e: unknown) => { if (alive) setState({ data: null, error: e instanceof Error ? e.message : String(e), loading: false }); });
    return () => { alive = false; };
  }, [url]);
  return state;
}
```

- [ ] **Step 4: 实现 ErrorBanner + EmptyState**

`web/src/components/ErrorBanner.tsx`:

```tsx
export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" style={{ background: "#fef2f2", border: "1px solid var(--danger)", color: "var(--danger)", borderRadius: "var(--radius)", padding: "10px 14px", fontSize: 14 }}>
      加载失败:{message}
      {onRetry && <button onClick={onRetry} style={{ marginLeft: 12 }}>重试</button>}
    </div>
  );
}
```

`web/src/components/EmptyState.tsx`:

```tsx
export function EmptyState({ text = "暂无数据" }: { text?: string }) {
  return <div style={{ color: "var(--muted)", textAlign: "center", padding: "28px 0", fontSize: 14 }}>{text}</div>;
}
```

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `cd web && npx vitest run test/useFetch.test.tsx && npm run typecheck`
Expected: PASS(4 用例),tsc 干净。

- [ ] **Step 6: Commit**

```bash
git add web/src/api/useFetch.ts web/src/components/ErrorBanner.tsx web/src/components/EmptyState.tsx web/test/useFetch.test.tsx
git commit -m "feat(web): useFetch(非2xx/网络错→显式 error 态,绝不吞)+ ErrorBanner/EmptyState"
```

---

## Task 8: FilterBar + 全局筛选状态

**Files:**
- Create: `web/src/components/FilterBar.tsx`
- Modify: `web/src/App.tsx`
- Create: `web/test/filterbar.test.tsx`

- [ ] **Step 1: 写 FilterBar 失败测试**

`web/test/filterbar.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { FilterBar } from "../src/components/FilterBar.js";
import type { Filters } from "../src/api/types.js";

function Harness() {
  const [f, setF] = useState<Filters>({});
  return (<><FilterBar filters={f} onChange={setF} /><pre data-testid="state">{JSON.stringify(f)}</pre></>);
}

it("typing a user_id updates filter state", async () => {
  render(<Harness />);
  await userEvent.type(screen.getByPlaceholderText("user_id"), "teacher-1");
  expect(screen.getByTestId("state").textContent).toContain("\"user_id\":\"teacher-1\"");
});

it("clearing resets to empty", async () => {
  render(<Harness />);
  await userEvent.type(screen.getByPlaceholderText("org_id"), "school-x");
  await userEvent.click(screen.getByRole("button", { name: "清空" }));
  expect(screen.getByTestId("state").textContent).toBe("{}");
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd web && npx vitest run test/filterbar.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 FilterBar**

`web/src/components/FilterBar.tsx`:

```tsx
import type { Filters } from "../api/types.js";

const FIELDS: Array<{ key: keyof Filters; ph: string }> = [
  { key: "user_id", ph: "user_id" }, { key: "org_id", ph: "org_id" }, { key: "project", ph: "project" },
  { key: "request_model", ph: "model" }, { key: "status", ph: "status" },
];

export function FilterBar({ filters, onChange }: { filters: Filters; onChange: (f: Filters) => void }) {
  const set = (key: keyof Filters, v: string) => onChange({ ...filters, [key]: v || undefined });
  return (
    <div className="card" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <input type="datetime-local" aria-label="from"
        onChange={(e) => set("from", e.target.value ? String(Date.parse(e.target.value)) : "")} />
      <span style={{ color: "var(--muted)" }}>→</span>
      <input type="datetime-local" aria-label="to"
        onChange={(e) => set("to", e.target.value ? String(Date.parse(e.target.value)) : "")} />
      {FIELDS.map((f) => (
        <input key={f.key} placeholder={f.ph} value={filters[f.key] ?? ""}
          onChange={(e) => set(f.key, e.target.value)}
          style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 8 }} />
      ))}
      <button onClick={() => onChange({})}>清空</button>
    </div>
  );
}
```

- [ ] **Step 4: App 提升筛选状态**

`web/src/App.tsx` —— 引入 `Filters` 状态并传给 FilterBar(页面组件下一任务装入):

```tsx
import { useState } from "react";
import "./styles/tokens.css";
import "./styles/app.css";
import { FilterBar } from "./components/FilterBar.js";
import type { Filters } from "./api/types.js";

type Page = "overview" | "audit";

export default function App() {
  const [page, setPage] = useState<Page>("overview");
  const [filters, setFilters] = useState<Filters>({});
  return (
    <>
      <header className="topbar">
        <span className="brand">帳簿 chobo</span>
        <nav className="nav">
          <button className={page === "overview" ? "active" : ""} onClick={() => setPage("overview")}>概览</button>
          <button className={page === "audit" ? "active" : ""} onClick={() => setPage("audit")}>审计明细</button>
        </nav>
      </header>
      <main className="page">
        <FilterBar filters={filters} onChange={setFilters} />
        {page === "overview" ? <p>概览页(待装组件)</p> : <p>审计页(待装组件)</p>}
      </main>
    </>
  );
}
```

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `cd web && npx vitest run test/filterbar.test.tsx && npm run typecheck`
Expected: PASS(2 用例),tsc 干净。

- [ ] **Step 6: Commit**

```bash
git add web/src/components/FilterBar.tsx web/src/App.tsx web/test/filterbar.test.tsx
git commit -m "feat(web): FilterBar + App 全局筛选状态(驱动所有端点 + 下钻目标)"
```

---

## Task 9: KpiCards(概览卡片)

**Files:**
- Create: `web/src/components/KpiCards.tsx`
- Create: `web/test/kpicards.test.tsx`

- [ ] **Step 1: 写失败测试**

`web/test/kpicards.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { KpiCards } from "../src/components/KpiCards.js";
import type { Overview } from "../src/api/types.js";

const ov: Overview = { currency: "CNY", totals: {
  events: 48210, input_tokens: 22_100_000, output_tokens: 9_500_000, total_tokens: 31_600_000,
  total_cost: "1284.07", by_status: { success: 47900, failure: 310 },
} };

it("renders cost / calls / tokens / failures", () => {
  render(<KpiCards data={ov} />);
  expect(screen.getByText("¥1,284.07")).toBeInTheDocument();
  expect(screen.getByText("48,210")).toBeInTheDocument();
  expect(screen.getByText("31.6M")).toBeInTheDocument();
  expect(screen.getByText("310")).toBeInTheDocument();
});

it("renders 未定价 when total_cost is null (never ¥0)", () => {
  render(<KpiCards data={{ ...ov, totals: { ...ov.totals, total_cost: null } }} />);
  expect(screen.getByText("未定价")).toBeInTheDocument();
  expect(screen.queryByText("¥0")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd web && npx vitest run test/kpicards.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 KpiCards**

`web/src/components/KpiCards.tsx`:

```tsx
import type { Overview } from "../api/types.js";
import { formatCost, formatCount, formatCompact, isUnpriced } from "../api/format.js";

function Card({ label, value, unpriced, danger }: { label: string; value: string; unpriced?: boolean; danger?: boolean }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className={unpriced ? "unpriced" : ""} style={{ fontSize: 26, fontWeight: 700, marginTop: 8, color: danger ? "var(--danger)" : undefined }}>{value}</div>
    </div>
  );
}

export function KpiCards({ data }: { data: Overview }) {
  const t = data.totals;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
      <Card label="总开销 CNY" value={formatCost(t.total_cost)} unpriced={isUnpriced(t.total_cost)} />
      <Card label="调用数" value={formatCount(t.events)} />
      <Card label="Tokens" value={formatCompact(t.total_tokens)} />
      <Card label="失败" value={formatCount(t.by_status.failure)} danger={t.by_status.failure > 0} />
    </div>
  );
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `cd web && npx vitest run test/kpicards.test.tsx`
Expected: PASS(2 用例)。

- [ ] **Step 5: Commit**

```bash
git add web/src/components/KpiCards.tsx web/test/kpicards.test.tsx
git commit -m "feat(web): KpiCards(总开销/调用/tokens/失败;缺价显未定价)"
```

---

## Task 10: TimeseriesChart(手写 SVG + bucket 切换)

**Files:**
- Create: `web/src/components/TimeseriesChart.tsx`
- Create: `web/test/timeseries.test.tsx`

- [ ] **Step 1: 写失败测试**

`web/test/timeseries.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TimeseriesChart } from "../src/components/TimeseriesChart.js";
import type { Timeseries } from "../src/api/types.js";

const ts: Timeseries = { bucket: "day", currency: "CNY", series: [
  { ts: "2026-06-01T00:00:00.000Z", events: 10, total_tokens: 1000, total_cost: "1.50" },
  { ts: "2026-06-02T00:00:00.000Z", events: 20, total_tokens: 3000, total_cost: "4.00" },
  { ts: "2026-06-03T00:00:00.000Z", events: 15, total_tokens: 2000, total_cost: null },
] };

it("draws a polyline with one vertex per point", () => {
  const { container } = render(<TimeseriesChart data={ts} bucket="day" onBucket={() => {}} />);
  const poly = container.querySelector("polyline.line") as SVGPolylineElement;
  expect(poly).toBeTruthy();
  expect(poly.getAttribute("points")!.trim().split(/\s+/)).toHaveLength(3);
});

it("bucket switch fires callback", async () => {
  const onBucket = vi.fn();
  render(<TimeseriesChart data={ts} bucket="day" onBucket={onBucket} />);
  await userEvent.click(screen.getByRole("button", { name: "week" }));
  expect(onBucket).toHaveBeenCalledWith("week");
});

it("empty series → EmptyState, no svg", () => {
  const { container } = render(<TimeseriesChart data={{ ...ts, series: [] }} bucket="day" onBucket={() => {}} />);
  expect(container.querySelector("polyline.line")).toBeNull();
  expect(screen.getByText(/暂无/)).toBeInTheDocument();
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd web && npx vitest run test/timeseries.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 TimeseriesChart**

`web/src/components/TimeseriesChart.tsx`:

```tsx
import type { Timeseries, Bucket } from "../api/types.js";
import { EmptyState } from "./EmptyState.js";

const BUCKETS: Bucket[] = ["hour", "day", "week", "month"];
const W = 640, H = 160, PAD = 8;

// 注意:此处把 total_cost 字符串 parseFloat 仅用于「像素定位」(几何),
// 不是金额展示/合计 —— 展示仍走服务端字符串。null 记为 0 高度。
function costVal(s: string | null): number { return s == null ? 0 : Number(s); }

export function TimeseriesChart({ data, bucket, onBucket }: { data: Timeseries; bucket: Bucket; onBucket: (b: Bucket) => void }) {
  const pts = data.series;
  const vals = pts.map((p) => costVal(p.total_cost));
  const max = Math.max(1, ...vals);
  const stepX = pts.length > 1 ? (W - PAD * 2) / (pts.length - 1) : 0;
  const points = pts.map((p, i) => {
    const x = PAD + i * stepX;
    const y = H - PAD - (costVal(p.total_cost) / max) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span className="label">开销趋势 · 按{bucket}</span>
        <span style={{ display: "flex", gap: 6 }}>
          {BUCKETS.map((b) => (
            <button key={b} onClick={() => onBucket(b)}
              style={{ fontSize: 12, padding: "3px 8px", borderRadius: 6, cursor: "pointer",
                       border: "1px solid var(--border)", background: b === bucket ? "var(--accent-soft)" : "var(--surface)",
                       color: b === bucket ? "var(--accent)" : "var(--muted)" }}>{b}</button>
          ))}
        </span>
      </div>
      {pts.length === 0 ? <EmptyState text="暂无趋势数据" /> : (
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H }}>
          <polyline className="area" fill="var(--accent)" fillOpacity="0.08" stroke="none"
            points={`${points} ${PAD + (pts.length - 1) * stepX},${H - PAD} ${PAD},${H - PAD}`} />
          <polyline className="line" fill="none" stroke="var(--accent)" strokeWidth="2" points={points} />
        </svg>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `cd web && npx vitest run test/timeseries.test.tsx`
Expected: PASS(3 用例)。

- [ ] **Step 5: Commit**

```bash
git add web/src/components/TimeseriesChart.tsx web/test/timeseries.test.tsx
git commit -m "feat(web): TimeseriesChart(零依赖手写 SVG;parseFloat 仅用于几何,展示仍走字符串)"
```

---

## Task 11: DimensionRanking(三 tab + 下钻)

**Files:**
- Create: `web/src/components/DimensionRanking.tsx`
- Create: `web/test/ranking.test.tsx`

- [ ] **Step 1: 写失败测试**

`web/test/ranking.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DimensionRanking } from "../src/components/DimensionRanking.js";
import type { DimRanking } from "../src/api/types.js";

const byUser: DimRanking = { dimension: "user_id", currency: "CNY", rows: [
  { key: "teacher-0420", events: 12004, total_tokens: 9_200_000, total_cost: "412.88" },
  { key: "teacher-1187", events: 8110, total_tokens: 6_100_000, total_cost: null },
] };

it("renders rows with cost and 未定价", () => {
  render(<DimensionRanking data={byUser} dimension="by-user" onTab={() => {}} onDrill={() => {}} />);
  expect(screen.getByText("teacher-0420")).toBeInTheDocument();
  expect(screen.getByText("¥412.88")).toBeInTheDocument();
  expect(screen.getByText("未定价")).toBeInTheDocument();
});

it("tab switch fires onTab with the dimension", async () => {
  const onTab = vi.fn();
  render(<DimensionRanking data={byUser} dimension="by-user" onTab={onTab} onDrill={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "按机构" }));
  expect(onTab).toHaveBeenCalledWith("by-org");
});

it("row click drills down (dimension + key)", async () => {
  const onDrill = vi.fn();
  render(<DimensionRanking data={byUser} dimension="by-user" onTab={() => {}} onDrill={onDrill} />);
  await userEvent.click(screen.getByText("teacher-0420"));
  expect(onDrill).toHaveBeenCalledWith("by-user", "teacher-0420");
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd web && npx vitest run test/ranking.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 DimensionRanking**

`web/src/components/DimensionRanking.tsx`:

```tsx
import type { DimRanking, Dimension } from "../api/types.js";
import { formatCost, formatCount, formatCompact, isUnpriced } from "../api/format.js";

const TABS: Array<{ dim: Dimension; label: string }> = [
  { dim: "by-user", label: "按用户" }, { dim: "by-org", label: "按机构" }, { dim: "by-project", label: "按任务" },
];

export function DimensionRanking({ data, dimension, onTab, onDrill }: {
  data: DimRanking; dimension: Dimension;
  onTab: (d: Dimension) => void; onDrill: (d: Dimension, key: string) => void;
}) {
  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", gap: 14, padding: "10px 14px", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
        {TABS.map((t) => (
          <button key={t.dim} onClick={() => onTab(t.dim)}
            style={{ background: "none", border: "none", cursor: "pointer",
                     color: t.dim === dimension ? "var(--text)" : "var(--muted)", fontWeight: t.dim === dimension ? 600 : 400 }}>
            {t.label}
          </button>
        ))}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ color: "var(--muted)", textAlign: "right" }}>
            <th style={{ textAlign: "left", padding: "8px 14px" }}>键</th>
            <th style={{ padding: "8px 14px" }}>调用</th><th style={{ padding: "8px 14px" }}>tokens</th><th style={{ padding: "8px 14px" }}>开销</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, i) => (
            <tr key={i} onClick={() => r.key != null && onDrill(dimension, r.key)}
                style={{ cursor: r.key != null ? "pointer" : "default", borderTop: "1px solid var(--border)" }}>
              <td style={{ padding: "8px 14px" }}>{r.key ?? <span className="unpriced">(空)</span>}</td>
              <td style={{ padding: "8px 14px", textAlign: "right" }}>{formatCount(r.events)}</td>
              <td style={{ padding: "8px 14px", textAlign: "right" }}>{formatCompact(r.total_tokens)}</td>
              <td style={{ padding: "8px 14px", textAlign: "right" }} className={isUnpriced(r.total_cost) ? "unpriced" : ""}>{formatCost(r.total_cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `cd web && npx vitest run test/ranking.test.tsx`
Expected: PASS(3 用例)。

- [ ] **Step 5: Commit**

```bash
git add web/src/components/DimensionRanking.tsx web/test/ranking.test.tsx
git commit -m "feat(web): DimensionRanking(用户/机构/任务三 tab + 行点击下钻)"
```

---

## Task 12: EventsTable(翻页 + payload 展开)

**Files:**
- Create: `web/src/components/EventsTable.tsx`
- Create: `web/test/events.test.tsx`

- [ ] **Step 1: 写失败测试**

`web/test/events.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";
import { EventsTable } from "../src/components/EventsTable.js";

afterEach(() => vi.restoreAllMocks());

const page1 = { events: [
  { event_id: "e1", created_at: "2026-06-03T10:00:00.000Z", user_id: "teacher-0420", org_id: null, project: "chat", provider: "doubao", service: "node-ai-proxy", request_model: "doubao-seed-2.0-pro", operation: "chat", status: "success", input_tokens: 100, output_tokens: 50, total_tokens: 150, total_cost: "0.04800000", currency: "CNY" },
  { event_id: "e2", created_at: "2026-06-03T09:00:00.000Z", user_id: "teacher-1187", org_id: null, project: "img", provider: "example-gateway", service: "node-ai-proxy", request_model: "gpt-image-2", operation: "image", status: "success", input_tokens: null, output_tokens: null, total_tokens: null, total_cost: null, currency: "CNY" },
], next_cursor: "CURSOR2" };

it("renders rows incl. 未定价, paginates via next_cursor", async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => page1 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<EventsTable filters={{}} />);
  await waitFor(() => expect(screen.getByText("doubao-seed-2.0-pro")).toBeInTheDocument());
  expect(screen.getByText("¥0.04800000")).toBeInTheDocument();
  expect(screen.getByText("未定价")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /加载更多/ }));
  // 第二次请求带 cursor=CURSOR2
  expect((fetchMock.mock.calls.at(-1)![0] as string)).toContain("cursor=CURSOR2");
});

it("error → ErrorBanner", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
  render(<EventsTable filters={{}} />);
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd web && npx vitest run test/events.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 EventsTable**

`web/src/components/EventsTable.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { Filters, EventsPage, EventRow } from "../api/types.js";
import { toQuery } from "../api/useFetch.js";
import { formatCost, formatCompact, isUnpriced } from "../api/format.js";
import { ErrorBanner } from "./ErrorBanner.js";
import { EmptyState } from "./EmptyState.js";

export function EventsTable({ filters }: { filters: Filters }) {
  const [rows, setRows] = useState<EventRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [includePayload, setIncludePayload] = useState(false);

  const filterKey = JSON.stringify(filters);
  useEffect(() => { setRows([]); setCursor(null); setNext(null); setOpen(new Set()); }, [filterKey, includePayload]);

  useEffect(() => {
    let alive = true; setLoading(true); setError(null);
    const url = "/v1/events" + toQuery({ ...filters, limit: 50, cursor: cursor ?? undefined, include_payload: includePayload || undefined });
    fetch(url)
      .then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return (await r.json()) as EventsPage; })
      .then((p) => { if (!alive) return; setRows((prev) => cursor ? [...prev, ...p.events] : p.events); setNext(p.next_cursor); setLoading(false); })
      .catch((e: unknown) => { if (alive) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { alive = false; };
  }, [filterKey, cursor, includePayload]);

  if (error) return <ErrorBanner message={error} onRetry={() => setCursor(null)} />;
  if (!loading && rows.length === 0) return <EmptyState text="暂无事件" />;

  const toggle = (id: string) => {
    if (!includePayload) setIncludePayload(true);   // 首次展开 → 改取带 payload
    setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ color: "var(--muted)", textAlign: "left" }}>
            <th style={{ padding: "8px 12px" }}></th><th style={{ padding: "8px 12px" }}>时间</th><th style={{ padding: "8px 12px" }}>用户</th>
            <th style={{ padding: "8px 12px" }}>provider</th><th style={{ padding: "8px 12px" }}>模型</th><th style={{ padding: "8px 12px" }}>状态</th>
            <th style={{ padding: "8px 12px", textAlign: "right" }}>tokens</th><th style={{ padding: "8px 12px", textAlign: "right" }}>开销</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <>
              <tr key={e.event_id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "8px 12px" }}>
                  <button aria-label="展开" onClick={() => toggle(e.event_id)} style={{ border: "none", background: "none", cursor: "pointer" }}>{open.has(e.event_id) ? "▾" : "▸"}</button>
                </td>
                <td style={{ padding: "8px 12px" }}>{new Date(e.created_at).toLocaleString()}</td>
                <td style={{ padding: "8px 12px" }}>{e.user_id ?? "—"}</td>
                <td style={{ padding: "8px 12px" }}>{e.provider}</td>
                <td style={{ padding: "8px 12px" }}>{e.request_model}</td>
                <td style={{ padding: "8px 12px", color: e.status === "failure" ? "var(--danger)" : undefined }}>{e.status}</td>
                <td style={{ padding: "8px 12px", textAlign: "right" }}>{e.total_tokens == null ? "—" : formatCompact(e.total_tokens)}</td>
                <td style={{ padding: "8px 12px", textAlign: "right" }} className={isUnpriced(e.total_cost) ? "unpriced" : ""}>{formatCost(e.total_cost)}</td>
              </tr>
              {open.has(e.event_id) && (
                <tr key={e.event_id + "-p"}><td colSpan={8} style={{ padding: "8px 12px", background: "var(--bg)" }}>
                  <pre style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap" }}>
                    {includePayload ? JSON.stringify({ request: e.request_payload, response: e.response_payload, truncated: e.truncated, redacted: e.redacted }, null, 2) : "加载 payload 中…"}
                  </pre>
                </td></tr>
              )}
            </>
          ))}
        </tbody>
      </table>
      <div style={{ padding: 12, textAlign: "center" }}>
        {next ? <button onClick={() => setCursor(next)}>加载更多</button> : <span style={{ color: "var(--muted)", fontSize: 13 }}>没有更多了</span>}
      </div>
    </div>
  );
}
```

> 实现注意:`<>...</>` 作为 `map` 的子元素需带 `key`;若 lint 报 fragment-key,改用 `import { Fragment } from "react"` 并 `<Fragment key={e.event_id}>`。功能等价。

- [ ] **Step 4: 跑测试,确认通过 + 类型检查**

Run: `cd web && npx vitest run test/events.test.tsx && npm run typecheck`
Expected: PASS(2 用例),tsc 干净。

- [ ] **Step 5: Commit**

```bash
git add web/src/components/EventsTable.tsx web/test/events.test.tsx
git commit -m "feat(web): EventsTable(keyset 翻页 + 行展开取 payload + 错误/空态)"
```

---

## Task 13: 组装两页 + 端到端联调

**Files:**
- Create: `web/src/pages/OverviewPage.tsx` `web/src/pages/AuditPage.tsx`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: 概览页(组合 KPI + 趋势 + 排行,接 API)**

`web/src/pages/OverviewPage.tsx`:

```tsx
import { useState } from "react";
import type { Filters, Overview, Timeseries, DimRanking, Bucket, Dimension } from "../api/types.js";
import { useFetch } from "../api/useFetch.js";
import { KpiCards } from "../components/KpiCards.js";
import { TimeseriesChart } from "../components/TimeseriesChart.js";
import { DimensionRanking } from "../components/DimensionRanking.js";
import { ErrorBanner } from "../components/ErrorBanner.js";
import { EmptyState } from "../components/EmptyState.js";

export function OverviewPage({ filters, onDrill }: { filters: Filters; onDrill: (d: Dimension, key: string) => void }) {
  const [bucket, setBucket] = useState<Bucket>("day");
  const [dim, setDim] = useState<Dimension>("by-user");
  const ov = useFetch<Overview>("/v1/stats/overview", { ...filters });
  const ts = useFetch<Timeseries>("/v1/stats/timeseries", { ...filters, bucket });
  const rk = useFetch<DimRanking>(`/v1/stats/${dim}`, { ...filters });

  return (
    <>
      {ov.error ? <ErrorBanner message={ov.error} /> : ov.data ? <KpiCards data={ov.data} /> : <EmptyState text="加载中…" />}
      {ts.error ? <ErrorBanner message={ts.error} /> : ts.data ? <TimeseriesChart data={ts.data} bucket={bucket} onBucket={setBucket} /> : <EmptyState text="加载中…" />}
      {rk.error ? <ErrorBanner message={rk.error} /> : rk.data ? <DimensionRanking data={rk.data} dimension={dim} onTab={setDim} onDrill={onDrill} /> : <EmptyState text="加载中…" />}
    </>
  );
}
```

`web/src/pages/AuditPage.tsx`:

```tsx
import type { Filters } from "../api/types.js";
import { EventsTable } from "../components/EventsTable.js";

export function AuditPage({ filters }: { filters: Filters }) {
  return <EventsTable filters={filters} />;
}
```

- [ ] **Step 2: App 组装两页 + 下钻写筛选**

`web/src/App.tsx` 的 `<main>` 部分替换为(导入两页 + Dimension):

```tsx
import { OverviewPage } from "./pages/OverviewPage.js";
import { AuditPage } from "./pages/AuditPage.js";
import type { Filters, Dimension } from "./api/types.js";
// ...
  const drill = (d: Dimension, key: string) => {
    const col = d === "by-user" ? "user_id" : d === "by-org" ? "org_id" : "project";
    setFilters((f) => ({ ...f, [col]: key }));
  };
// ...
      <main className="page">
        <FilterBar filters={filters} onChange={setFilters} />
        {page === "overview" ? <OverviewPage filters={filters} onDrill={drill} /> : <AuditPage filters={filters} />}
      </main>
```

- [ ] **Step 3: 全量前端测试 + 构建**

Run: `cd web && npm test && npm run typecheck && npm run build`
Expected: 全部 PASS;tsc 干净;`web/dist` 产出。

- [ ] **Step 4: 端到端联调(真 PG + seed + CRM 托管)**

```bash
# 1) 起一个本地 PG(Docker)
docker run -d --name chobo-pg -e POSTGRES_PASSWORD=pw -p 5433:5432 postgres:16-alpine
# 2) 起 CRM,指向该库 + 看板产物 + 价目种子
cd server
CHOBO_DATABASE_URL=postgres://postgres:pw@localhost:5433/postgres \
CHOBO_PORT=8787 \
CHOBO_WEB_DIR=../web/dist \
CHOBO_PRICE_SEED=../dev_docs/price-seed.json \
npm run dev &
# 3) 灌仿真事件
CHOBO_BASE_URL=http://localhost:8787 npm run seed:events
# 4) 浏览器打开 http://localhost:8787 —— 看板应显示数据,example-gateway 三模型显示「未定价」
```

Expected:`seed:events` 打印 `{ accepted: >0, duplicates, rejected: 0 }`;浏览器看板概览有数字、趋势图有线、排行有榜;example-gateway 行/卡显示「未定价」而非 ¥0;审计页能翻页、能展开 payload。**若价目种子缺失则全部「未定价」也是正确诚实表现。**

> 用 mcp 预览或手动浏览器核验视觉(清亮分析型基调)。若发现真实问题,回到对应组件任务修复并补回归测试,不要在此步堆补丁。

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/ web/src/App.tsx
git commit -m "feat(web): 组装概览/审计两页 + 下钻写筛选;端到端对真 API 联调通过"
```

---

## Task 14: 文档 + dev-log + 终审

**Files:**
- Create: `web/README.md`
- Modify: `docs/dev-log.md` `CLAUDE.md`

- [ ] **Step 1: 写 web/README.md**

`web/README.md` 覆盖:用途(纯读看板)、开发(`npm run dev` + 需本地 CRM 在 8787)、构建(`npm run build` → dist,由 CRM `CHOBO_WEB_DIR` 托管)、测试、设计基调(清亮分析型)、计费铁律(开销字符串/未定价非 ¥0)、端到端步骤(引用 Task 13 Step 4)。

- [ ] **Step 2: 更新 dev-log**

`docs/dev-log.md` 追加 "## 2026-06-25 — Plan 4(看板 web/)交付" 条目:栈(React+TS+Vite,零运行时依赖手写图表/useFetch)、同源托管(@fastify/static,非破坏)、鉴权收窄(全局→ingest)、seed-events、计费铁律落渲染、测试数、commit 范围;指向 Plan 5。

- [ ] **Step 3: 更新 CLAUDE.md 状态**

`CLAUDE.md`:仓库结构 `web/` 标 ✅;状态段 Plan 4 ✅、下一步指向 Plan 5;技术栈表「看板」行补 Vite/手写图表。

- [ ] **Step 4: 全仓回归(server + web)**

Run: `cd server && npx vitest run && npx tsc --noEmit && cd ../web && npm test && npm run typecheck && npm run build`
Expected:server 全绿 + tsc 干净;web 全绿 + tsc 干净 + 构建成功。

- [ ] **Step 5: 终审(opus)**

派一个 opus 终审 subagent 通读 server 改动 + 整个 web/,重点:鉴权收窄无回归、计费铁律(无前端金额加总、无静默 ¥0)、useFetch 不吞错、SPA 回退不吞 /v1、seed 确定性。抓到问题配回归测试修复。

- [ ] **Step 6: Commit**

```bash
git add web/README.md docs/dev-log.md CLAUDE.md
git commit -m "docs(web): Plan 4 README + dev-log/CLAUDE.md 收尾(看板交付终态)"
```

---

## Self-Review(写完计划的自检)

**Spec 覆盖:**
- §2 同源托管 → Task 2;dev proxy → Task 4。✅
- §3 鉴权收窄 + 测试更新 → Task 1。✅
- §4 数据契约 → Task 6 类型;各端点消费 → Task 9-13。✅
- §5 useFetch 不吞错 → Task 7。✅
- §6 计费铁律(字符串/未定价)→ Task 6 format + 钉死测试,且 Task 9/11/12 各自断言未定价。✅
- §7 页面与组件 → Task 5/8-13。✅
- §8 错误/空态 → Task 7 + 各组件测试。✅
- §9 设计令牌 → Task 5。✅
- §10 seed-events → Task 3。✅
- §11 文件结构 → 全任务覆盖;`server/scripts/seed-events-cli.ts` + `seed:events` → Task 3。✅
- §13 测试策略(web RTL + server auth/static)→ 各任务 TDD。✅
- §14 决策表 → 贯穿。✅

**占位符扫描:** 无 TBD/TODO;每个改代码的步骤都给了完整代码。Task 14 文档步骤给了明确章节清单(非占位)。✅

**类型一致性:** `Filters`/`Overview`/`Timeseries`/`DimRanking`/`EventsPage`/`Bucket`/`Dimension` 在 Task 6 定义,后续 Task 8-13 一致引用;`formatCost/formatCount/formatCompact/isUnpriced` 在 Task 6 定义、后续一致使用;`useFetch/toQuery/QueryParams` 在 Task 7 定义、Task 12/13 一致使用;`registerStatic` 在 Task 2 定义并被 app.ts 调用;`IngestDeps.guard` 在 Task 1 定义并被 app.ts 传入。✅
