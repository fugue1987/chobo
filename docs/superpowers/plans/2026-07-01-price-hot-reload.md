# 价目表运行时热更新 + 接入方自助加模型 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让运行中的 chobo CRM 无需重启即可拾取新价目版本,接入方(自建 CRM)以后加任何模型 = 改 `price-seed.json` + 一条命令,约 60s 自动生效。

**Architecture:** 价目表从"启动读一次的 `const`"改为**可变持有器 + 轮询刷新器**(`price-store.ts`);把 `syncPriceSeed` 抽成独立纯模块供 server 与新 `seed-cli` 共用;裸 Node 交付包加 `update-prices.sh` 一键(写价 + 回填)。纯 CRM + 打包 + 文档,**不改任何 SDK / 契约**。

**Tech Stack:** Node 20 + TypeScript(ESM,NodeNext,`.js` import 后缀)、Fastify 5、postgres.js、vitest + `@testcontainers/postgresql`(测试需本机 Docker 可用)。

**上位 spec:** `docs/superpowers/specs/2026-07-01-price-hot-reload-design.md`。

**设计细化(相对 spec 的一处接口收敛):** `createPriceStore` 的签名用**注入加载函数**而非直接吃 `sql` —— `createPriceStore(load: () => Promise<PriceTable>, initial, log?)`。行为与 spec 完全一致,但让持有器与 `sql`/`pricing` 解耦、单元测试可注入桩。server 侧 `createPriceStore(() => loadPriceTable(sql), initial)`。

**每个任务前提:** 命令都在 `C:\Code\chobo\server` 下跑(除 Task 6/7/8 打包/文档在仓库根)。当前分支 `feature/price-hot-reload`。

---

### Task 1: config 加 `CHOBO_PRICE_REFRESH_SEC`

**Files:**
- Modify: `server/src/types.ts`(`ServerConfig` 加一字段)
- Modify: `server/src/config.ts`(解析 + 校验 + 返回)
- Test: `server/test/config.test.ts`

- [ ] **Step 1: 写失败测试** — 在 `server/test/config.test.ts` 的 `describe("resolveConfig", ...)` 内、最后一个 `it(...)` 之后加入:

```ts
  it("priceRefreshSec defaults to 60, reads CHOBO_PRICE_REFRESH_SEC, 0 disables", () => {
    expect(resolveConfig({ CHOBO_DATABASE_URL: "postgres://x" }).priceRefreshSec).toBe(60);
    expect(resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_PRICE_REFRESH_SEC: "0" }).priceRefreshSec).toBe(0);
    expect(resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_PRICE_REFRESH_SEC: "15" }).priceRefreshSec).toBe(15);
  });
  it("rejects invalid CHOBO_PRICE_REFRESH_SEC", () => {
    expect(() => resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_PRICE_REFRESH_SEC: "-1" })).toThrow(/CHOBO_PRICE_REFRESH_SEC/);
    expect(() => resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_PRICE_REFRESH_SEC: "abc" })).toThrow(/CHOBO_PRICE_REFRESH_SEC/);
    expect(() => resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_PRICE_REFRESH_SEC: "1.5" })).toThrow(/CHOBO_PRICE_REFRESH_SEC/);
  });
```

- [ ] **Step 2: 运行,确认失败**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL(`priceRefreshSec` 为 `undefined`;`resolveConfig` 尚未认此 env)。

- [ ] **Step 3: 加字段到类型** — `server/src/types.ts` 的 `ServerConfig` 接口,在 `webDir: string | null;` 之后加一行:

```ts
  priceRefreshSec: number;      // 价目表轮询热载间隔(秒);0=关闭,退回仅开机加载
```

- [ ] **Step 4: 解析 + 校验** — `server/src/config.ts`,在 `bodyLimit` 校验之后、`return {` 之前插入:

```ts
  const priceRefreshSec = Number(env.CHOBO_PRICE_REFRESH_SEC ?? "60");
  if (!Number.isInteger(priceRefreshSec) || priceRefreshSec < 0)
    throw new Error("chobo: CHOBO_PRICE_REFRESH_SEC must be a non-negative integer");
```

并在 `return { ... }` 对象里、`webDir: env.CHOBO_WEB_DIR ?? null,` 之后加一行:

```ts
    priceRefreshSec,
```

- [ ] **Step 5: 运行,确认通过**

Run: `npx vitest run test/config.test.ts`
Expected: PASS(全部 config 用例,含新增 2 条)。

- [ ] **Step 6: Commit**

```bash
git add server/src/types.ts server/src/config.ts server/test/config.test.ts
git commit -m "feat(server): CHOBO_PRICE_REFRESH_SEC 配置(默认60,0=关闭)"
```

---

### Task 2: 抽出 `syncPriceSeed` 为独立纯模块 `price-seed.ts`(重构,保持全绿)

`syncPriceSeed` 现在写在 `server/src/server.ts` 里,`seed-cli` 需要它但不该 import 服务入口。原样搬到新文件。

**Files:**
- Create: `server/src/price-seed.ts`
- Modify: `server/src/server.ts`(删函数 + 改 import)
- Modify: `server/test/seed.test.ts`(改 import 路径)

- [ ] **Step 1: 建 `server/src/price-seed.ts`**(把函数连同文档注释**原样**移入):

```ts
import { readFile } from "node:fs/promises";
import type { Sql } from "postgres";

/**
 * Version-additive price-seed sync (idempotent). Inserts the seed file's `version` IFF that exact
 * version is not already in `price_table`. It NEVER overwrites an existing version's rows — manual
 * price edits to an already-seeded version are preserved; the auditable way to change a price is to
 * bump the seed `version`, which this auto-introduces on the next boot. `loadPriceTable()` reads the
 * MAX version, so a newly-synced version takes effect immediately once this runs at boot.
 *
 *   empty DB                 → first version inserted
 *   new image, newer version → new version inserted (no manual SQL; the deploy's restart IS the reload)
 *   same version re-run       → no-op
 *
 * Returns `{ version, inserted }` for boot logging (or `null` when no seed path configured).
 */
export async function syncPriceSeed(sql: Sql, seedPath: string | null): Promise<{ version: string; inserted: boolean } | null> {
  if (!seedPath) return null;
  const seed = JSON.parse(await readFile(seedPath, "utf8")) as { version: string; rows: Record<string, unknown>[]; aliases?: { provider: string; alias: string; canonical: string }[] };
  if (typeof seed.version !== "string" || seed.version === "") {
    throw new Error(`chobo seed: top-level "version" missing or invalid in ${seedPath}`);
  }
  // Gate on THIS version (not total count): a new version is introduced even into a populated table,
  // an already-present version is left untouched (idempotent + preserves manual edits).
  const [{ count }] = await sql<{ count: string }[]>`SELECT count(*) FROM price_table WHERE version = ${seed.version}`;
  if (Number(count) > 0) return { version: seed.version, inserted: false };
  type SeedRow = { version: string; provider: string; model: string; operation: string; input_tier_max: number; input_per_mtok: number | null; output_per_mtok: number | null; cache_read_per_mtok: number | null; reasoning_per_mtok: number | null; per_image: number | null; text_input_per_mtok: number | null; currency: string };
  const rows: SeedRow[] = seed.rows.map((r, idx) => {
    // C6: validate required string fields — raw `as string` cast silently produces undefined on malformed JSON
    for (const field of ["provider", "model", "operation"] as const) {
      if (typeof r[field] !== "string" || r[field] === "") {
        throw new Error(`chobo seed: row[${idx}] missing or invalid field "${field}" in ${seedPath}`);
      }
    }
    const base: SeedRow = { version: seed.version, input_tier_max: 0, input_per_mtok: null, output_per_mtok: null, cache_read_per_mtok: null, reasoning_per_mtok: null, per_image: null, text_input_per_mtok: null, currency: "CNY", provider: r["provider"] as string, model: r["model"] as string, operation: r["operation"] as string };
    if (r["input_per_mtok"] != null) base.input_per_mtok = r["input_per_mtok"] as number;
    if (r["output_per_mtok"] != null) base.output_per_mtok = r["output_per_mtok"] as number;
    if (r["cache_read_per_mtok"] != null) base.cache_read_per_mtok = r["cache_read_per_mtok"] as number;
    if (r["reasoning_per_mtok"] != null) base.reasoning_per_mtok = r["reasoning_per_mtok"] as number;
    if (r["per_image"] != null) base.per_image = r["per_image"] as number;
    if (r["text_input_per_mtok"] != null) base.text_input_per_mtok = r["text_input_per_mtok"] as number;
    if (r["input_tier_max"] != null) base.input_tier_max = r["input_tier_max"] as number;
    if (r["currency"] != null) base.currency = r["currency"] as string;
    return base;
  });
  await sql`INSERT INTO price_table ${sql(rows, "version","provider","model","operation","input_tier_max","input_per_mtok","output_per_mtok","cache_read_per_mtok","reasoning_per_mtok","per_image","text_input_per_mtok","currency")} ON CONFLICT DO NOTHING`;
  if (seed.aliases?.length) await sql`INSERT INTO model_aliases ${sql(seed.aliases, "provider","alias","canonical")} ON CONFLICT DO NOTHING`;
  return { version: seed.version, inserted: true };
}
```

- [ ] **Step 2: 从 `server.ts` 删掉该函数并改 import** — 在 `server/src/server.ts`:
  1. 删除顶部 `import { readFile } from "node:fs/promises";`。
  2. 删除整个 `export async function syncPriceSeed(...) { ... }`(含其上方文档注释块)。
  3. 在其它 import 旁新增:`import { syncPriceSeed } from "./price-seed.js";`

（`main()` 里对 `syncPriceSeed(sql, cfg.priceSeedPath)` 的调用**不变**。）

- [ ] **Step 3: 改测试 import 路径** — `server/test/seed.test.ts` 第 7 行:

```ts
import { syncPriceSeed } from "../src/server.js";
```
改为:
```ts
import { syncPriceSeed } from "../src/price-seed.js";
```

- [ ] **Step 4: 运行 seed 测试 + 构建,确认全绿**

Run: `npx vitest run test/seed.test.ts && npm run build`
Expected: PASS(5+1 用例全过);`tsc` 无报错(证明 server.ts 删干净、无悬空引用)。

- [ ] **Step 5: Commit**

```bash
git add server/src/price-seed.ts server/src/server.ts server/test/seed.test.ts
git commit -m "refactor(server): syncPriceSeed 抽成独立纯模块 price-seed.ts(供 server 与 seed-cli 共用)"
```

---

### Task 3: `price-store.ts` — 可变持有器 + 轮询刷新器(唯一新增运行时逻辑)

**Files:**
- Create: `server/src/price-store.ts`
- Test: `server/test/price-store.test.ts`

- [ ] **Step 1: 写失败测试(单元 + 集成两块)** — 建 `server/test/price-store.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPriceStore } from "../src/price-store.js";
import { startPg, type PgHandle } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { loadPriceTable } from "../src/pricing.js";
import type { FastifyInstance } from "fastify";
import type { PriceTable, ServerConfig } from "../src/types.js";

const silent = { info: () => {}, warn: () => {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 造一个价目表桩(供注入式单元测试)
const T = (version: string, models: string[]): PriceTable => ({
  version,
  rows: models.map((m) => ({
    version, provider: "newapi", model: m, operation: "chat", input_tier_max: 0,
    input_per_mtok: 1, output_per_mtok: 1, cache_read_per_mtok: null,
    reasoning_per_mtok: null, per_image: null, text_input_per_mtok: null, currency: "USD",
  })),
  aliases: {},
});

describe("createPriceStore (injected loader)", () => {
  it("refreshNow swaps to a newer table and reports changed", async () => {
    const next = T("v2", ["a", "b"]);
    const store = createPriceStore(async () => next, T("v1", ["a"]), silent);
    expect(store.current().version).toBe("v1");
    expect(await store.refreshNow()).toBe(true);
    expect(store.current().version).toBe("v2");
    expect(store.current().rows).toHaveLength(2);
  });

  it("keeps last-good and returns false when the loader throws", async () => {
    const store = createPriceStore(async () => { throw new Error("db down"); }, T("v1", ["a"]), silent);
    expect(await store.refreshNow()).toBe(false);
    expect(store.current().version).toBe("v1"); // 未被清空
  });

  it("empty-table guard: keeps last-good when loader returns an empty table", async () => {
    const empty: PriceTable = { version: "", rows: [], aliases: {} };
    const store = createPriceStore(async () => empty, T("v1", ["a"]), silent);
    expect(await store.refreshNow()).toBe(false);
    expect(store.current().version).toBe("v1");
  });

  it("start polls until stop", async () => {
    let calls = 0;
    const store = createPriceStore(async () => { calls++; return T("v1", ["a"]); }, T("v1", ["a"]), silent);
    store.start(5);
    await sleep(40);
    const afterStart = calls;
    store.stop();
    expect(afterStart).toBeGreaterThanOrEqual(2);
    await sleep(40);
    expect(calls).toBe(afterStart); // stop 后不再刷新
  });
});

// 集成:证明 写库 → refreshNow → 经真实 HTTP ingest 路径定价 的整环
const CFG: ServerConfig = {
  databaseUrl: "", host: "0.0.0.0", port: 0, ingestSecret: null,
  payloadMode: "metadata", payloadMaxBytes: 8192, bodyLimit: 16 * 1024 * 1024,
  priceSeedPath: null, webDir: null, priceRefreshSec: 0,
};
const sonnetEv = (id: string) => ({
  event_id: id, user_id: "u1", org_id: "o1", project: "p1",
  identity_source: "header", start_time: 1750000000000, end_time: 1750000001000,
  service: "svc", provider: "newapi", operation: "chat",
  request_model: "claude-sonnet-5",
  input_tokens: 1000000, output_tokens: 0, total_tokens: 1000000, cached_tokens: 0,
  usage_source: "measured", status: "success", sdk_lang: "node", sdk_version: "0.1.0",
});

describe("createPriceStore + ingest (runtime hot reload)", () => {
  let pg: PgHandle; let app: FastifyInstance;
  let store: ReturnType<typeof createPriceStore>;
  beforeAll(async () => {
    pg = await startPg();
    // 初始版本 v1:只有 doubao,没有 claude-sonnet-5
    await pg.sql`INSERT INTO price_table (version,provider,model,operation,input_tier_max,input_per_mtok,output_per_mtok,currency)
      VALUES ('v1','doubao','doubao-seed-2.0-pro','chat',0,3.2,16,'CNY')`;
    const initial = await loadPriceTable(pg.sql);
    store = createPriceStore(() => loadPriceTable(pg.sql), initial, silent);
    app = buildApp({ sql: pg.sql, cfg: CFG, priceTable: store.current });
    await app.ready();
  });
  afterAll(async () => { store.stop(); await app.close(); await pg.stop(); });

  it("new model = NULL before its price exists, non-NULL after runtime insert + refreshNow", async () => {
    // 1) 补价前:新模型事件落库,total_cost = NULL(诚实)
    const before = await app.inject({ method: "POST", url: "/v1/events", payload: { events: [sonnetEv("sonnet-before")] } });
    expect(before.json()).toMatchObject({ accepted: 1 });
    const [b] = await pg.sql<{ total_cost: string | null }[]>`SELECT total_cost FROM usage_events WHERE event_id='sonnet-before'`;
    expect(b.total_cost).toBeNull();

    // 2) 运行中插入含 claude-sonnet-5 的【更高】版本(整版快照:doubao + 新模型)
    await pg.sql`INSERT INTO price_table (version,provider,model,operation,input_tier_max,input_per_mtok,output_per_mtok,currency) VALUES
      ('v2','doubao','doubao-seed-2.0-pro','chat',0,3.2,16,'CNY'),
      ('v2','newapi','claude-sonnet-5','chat',0,3,15,'USD')`;

    // 3) 热载
    expect(await store.refreshNow()).toBe(true);
    expect(store.current().version).toBe("v2");

    // 4) 补价后:同款新模型事件 → total_cost 非 NULL(输入 1e6 tok × $3/Mtok = 3.00000000 USD)
    const after = await app.inject({ method: "POST", url: "/v1/events", payload: { events: [sonnetEv("sonnet-after")] } });
    expect(after.json()).toMatchObject({ accepted: 1 });
    const [a] = await pg.sql<{ total_cost: string | null; currency: string }[]>`SELECT total_cost, currency FROM usage_events WHERE event_id='sonnet-after'`;
    expect(a.total_cost).toBe("3.00000000");
    expect(a.currency).toBe("USD");
  });
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `npx vitest run test/price-store.test.ts`
Expected: FAIL(`../src/price-store.js` 不存在 / `createPriceStore` 未定义)。

- [ ] **Step 3: 实现 `server/src/price-store.ts`**:

```ts
import type { PriceTable } from "./types.js";

export interface PriceStore {
  current: () => PriceTable;          // 传给 buildApp;ingest 每请求读一次
  refreshNow: () => Promise<boolean>; // 从库重读并原子热替换;返回"是否变化"
  start: (intervalMs: number) => void;
  stop: () => void;
}

export interface PriceStoreLogger {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}
const consoleLogger: PriceStoreLogger = {
  info: (o, m) => console.log(m, o),
  warn: (o, m) => console.warn(m, o),
};

// 变更签名:版本 + 行数。仅用于"要不要打日志",赋值是无条件的。
const sig = (t: PriceTable): string => `${t.version}::${t.rows.length}`;

/**
 * 持有当前价目表的可变引用,并可定时从 `load()` 重读做原子热替换。
 * - 崩溃安全:load 抛错 → 保留上一版、warn、不抛、下拍重试。
 * - 防清空:load 返回空表(version==="")而当前有版本 → 判异常,保留上一版。
 * - 原子:单次赋值热替换;ingest 每请求 `current()` 读到的永远是某个完整快照。
 */
export function createPriceStore(
  load: () => Promise<PriceTable>,
  initial: PriceTable,
  log: PriceStoreLogger = consoleLogger,
): PriceStore {
  let table = initial;
  let timer: NodeJS.Timeout | null = null;

  async function refreshNow(): Promise<boolean> {
    let next: PriceTable;
    try {
      next = await load();
    } catch (err) {
      log.warn({ err }, "chobo: price refresh failed, keeping last-good");
      return false;
    }
    if (next.version === "" && table.version !== "") {
      log.warn({ current: table.version }, "chobo: price refresh returned empty table, keeping last-good");
      return false;
    }
    const changed = sig(next) !== sig(table);
    const from = table.version;
    table = next; // 单次赋值热替换
    if (changed) log.info({ from, to: table.version, rows: table.rows.length }, "chobo: price table reloaded");
    return changed;
  }

  return {
    current: () => table,
    refreshNow,
    start(intervalMs: number): void {
      if (timer) return;
      timer = setInterval(() => void refreshNow(), intervalMs);
      timer.unref();
    },
    stop(): void {
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `npx vitest run test/price-store.test.ts`
Expected: PASS(4 单元 + 1 集成用例;集成用例需本机 Docker 起 PG)。

- [ ] **Step 5: Commit**

```bash
git add server/src/price-store.ts server/test/price-store.test.ts
git commit -m "feat(server): price-store 可变持有器 + 轮询热载(崩溃安全/防清空/原子替换)"
```

---

### Task 4: `server.ts` 装配 price-store + 优雅停机

**Files:**
- Modify: `server/src/server.ts`(`main()` + `shutdown()` + 启动日志)

- [ ] **Step 1: 改 `main()`** — 在 `server/src/server.ts`,把从 `const seeded = await syncPriceSeed(...)` 到 `const app = buildApp(...)` 一段改为:

```ts
  const seeded = await syncPriceSeed(sql, cfg.priceSeedPath);

  const initial = await loadPriceTable(sql);
  const store = createPriceStore(() => loadPriceTable(sql), initial);
  const app = buildApp({ sql, cfg, priceTable: store.current });
  if (cfg.priceRefreshSec > 0) store.start(cfg.priceRefreshSec * 1000);
```

顶部加 import:
```ts
import { createPriceStore } from "./price-store.js";
```
（`loadPriceTable` 已在 import 之列,保持。）

- [ ] **Step 2: 停机时停轮询** — 在 `shutdown()` 里,`await app.close();` 之前加一行 `store.stop();`。改后片段:

```ts
    try {
      store.stop();
      await app.close();
      await sql.end({ timeout: 5 });
      process.exit(0);
```

（`store` 在 `main()` 作用域内、`shutdown` 是 `main()` 内的闭包,可直接引用。）

- [ ] **Step 3: 启动日志加间隔** — 把 `app.log.info({ priceVersion: ... }, "chobo CRM up")` 的对象里加上 `priceRefreshSec: cfg.priceRefreshSec`:

```ts
  app.log.info(
    { priceVersion: priceTable_version_placeholder },
    "chobo CRM up",
  );
```
具体:把现有那行的字面对象改成(注意变量已从 `priceTable` 改为 `store.current()`):

```ts
  const active = store.current();
  app.log.info(
    { priceVersion: active.version, priceRefreshSec: cfg.priceRefreshSec, seedVersion: seeded?.version ?? null, seedInserted: seeded?.inserted ?? false, rows: active.rows.length, aliases: Object.keys(active.aliases).length },
    "chobo CRM up",
  );
```
（删除原先直接引用 `priceTable.version`/`priceTable.rows` 的写法 —— 现在没有 `priceTable` 变量了,改用 `active = store.current()`。）

- [ ] **Step 4: 构建 + 跑全量测试,确认无回归**

Run: `npm run build && npm test`
Expected: PASS(全部现有 + 新增测试;`tsc` 无报错)。`main()` 是进程入口不单测,由 Task 3 的"buildApp + store.current 经真实 HTTP 定价"集成用例覆盖同款装配路径,Task 8 再做容器端到端实证。

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts
git commit -m "feat(server): 装配 price-store(轮询热载 + 停机停轮询 + 启动日志)"
```

---

### Task 5: `seed-cli` — 授权侧把 seed 写库(自助加价的机器)

**Files:**
- Create: `server/src/seed-cli.ts`
- Modify: `server/package.json`(加 `seed:prices` 脚本)

- [ ] **Step 1: 建 `server/src/seed-cli.ts`**(镜像 `reprice-cli.ts` 的引导):

```ts
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveConfig } from "./config.js";
import { createSql, migrate } from "./db.js";
import { syncPriceSeed } from "./price-seed.js";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = resolveConfig(process.env);
const sql = createSql(cfg.databaseUrl);
try {
  await migrate(sql, join(here, "..", "migrations")); // 幂等,保证 price_table 存在(可独立跑)
  const seedPath = process.argv[2] ?? cfg.priceSeedPath; // 位置参数优先,回落 CHOBO_PRICE_SEED
  if (!seedPath) throw new Error("chobo seed-cli: 需要 seed 文件路径(位置参数或 CHOBO_PRICE_SEED)");
  const r = await syncPriceSeed(sql, seedPath);
  console.log(
    r?.inserted
      ? `chobo seed: inserted version ${r.version}`
      : `chobo seed: version ${r?.version ?? "<none>"} 已在库,无改动(要改动请 bump price-seed.json 的 version)`,
  );
} finally {
  await sql.end({ timeout: 5 });
}
```

- [ ] **Step 2: 加 npm 脚本** — `server/package.json` 的 `scripts` 里,`"reprice": "node dist/reprice-cli.js",` 之后加:

```json
    "seed:prices": "node dist/seed-cli.js",
```

- [ ] **Step 3: 构建,确认产物存在**

Run: `npm run build && node -e "require('fs').accessSync('dist/seed-cli.js')" && echo OK`
Expected: 打印 `OK`(`dist/seed-cli.js` 已生成;`tsc` 无报错)。

- [ ] **Step 4: 冒烟(需本机 Docker 起一次性 PG)** — 起一个临时库、用示例 seed 跑一遍 CLI,应报 inserted 一次、再跑报"已在库":

```bash
CID=$(docker run -d -e POSTGRES_PASSWORD=p -e POSTGRES_USER=chobo -e POSTGRES_DB=chobo -p 55433:5432 postgres:16-alpine)
sleep 4
export CHOBO_DATABASE_URL="postgres://chobo:p@127.0.0.1:55433/chobo"
node dist/seed-cli.js price-seed.example.json    # 期望: inserted version 2026-06-26a
node dist/seed-cli.js price-seed.example.json    # 期望: 已在库,无改动
docker rm -f "$CID"
```
Expected: 第一次 `inserted version 2026-06-26a`,第二次 `... 已在库,无改动`。

（`seed-cli` 核心逻辑 `syncPriceSeed` 已由 `test/seed.test.ts` 全面覆盖;此处只冒烟 CLI 包装与路径。）

- [ ] **Step 5: Commit**

```bash
git add server/src/seed-cli.ts server/package.json
git commit -m "feat(server): seed-cli 命令行把 price-seed 版本增量写库(复用 syncPriceSeed)"
```

---

### Task 6: 裸 Node 交付包加 `update-prices.sh` 一键(写价 + 回填)

**Files:**
- Create: `deploy/customer/bare-node/update-prices.sh`
- Modify: `deploy/customer/bare-node/package-crm-bare.sh`(打包时拷入 + `chmod +x`)
- Modify: `deploy/customer/bare-node/chobo-crm.env.example`(加注释项)

- [ ] **Step 1: 建 `deploy/customer/bare-node/update-prices.sh`**(与 `start.sh` 同款 env 读取):

```bash
#!/usr/bin/env bash
# chobo:新增/更新模型价格(运行中的 CRM 无需重启)。
# 用法:改好 price-seed.json 里的 version(并追加/修改价目行)后,跑 ./update-prices.sh
#   1) 把新版本【版本增量】写进你的库(幂等,绝不覆盖已有版本/人工调价);
#   2) 回填"补价之前就已落库、当时算 NULL"的历史事件(幂等,默认只碰 NULL 行);
# 运行中的 CRM 会在 ≤ CHOBO_PRICE_REFRESH_SEC 秒内自动拾取新价(默认 60s)。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${CHOBO_ENV_FILE:-$ROOT/chobo-crm.env}"

if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key val; do
    key="${key%$'\r'}"; val="${val%$'\r'}"
    case "$key" in ''|'#'*) continue ;; esac
    export "$key=$val"
  done < "$ENV_FILE"
fi
export CHOBO_PRICE_SEED="${CHOBO_PRICE_SEED:-$ROOT/price-seed.json}"

if [ -z "${CHOBO_DATABASE_URL:-}" ]; then
  echo "✗ 未设置 CHOBO_DATABASE_URL(在 $ENV_FILE 里填好你自己的 Postgres 连接串)。" >&2
  exit 1
fi
NODE_BIN="${NODE_BIN:-node}"
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "✗ 找不到 node。本工具需要 Node.js ≥ 20。" >&2
  exit 1
fi

echo "→ [1/2] 写入价目(版本增量,幂等)…"
"$NODE_BIN" "$ROOT/server/dist/seed-cli.js" "$CHOBO_PRICE_SEED"
echo "→ [2/2] 回填补价前的 NULL 事件(幂等)…"
"$NODE_BIN" "$ROOT/server/dist/reprice-cli.js"
echo "✅ 完成。运行中的 CRM 将在 ≤ CHOBO_PRICE_REFRESH_SEC 秒内自动生效(默认 60s),无需重启。"
```

- [ ] **Step 2: 打包脚本拷入该文件** — `deploy/customer/bare-node/package-crm-bare.sh`,在 `cp "$SRC_DIR/交付指南.md" "$STAGE/交付指南.md"` 之后加一行:

```bash
cp "$SRC_DIR/update-prices.sh"       "$STAGE/update-prices.sh"
```
并把紧随其后的 `chmod +x "$STAGE/start.sh"` 改为同时授权两个脚本:

```bash
chmod +x "$STAGE/start.sh" "$STAGE/update-prices.sh"
```

- [ ] **Step 3: env 样例加注释项** — 在 `deploy/customer/bare-node/chobo-crm.env.example` 末尾追加:

```bash

# （可选）价目热载轮询间隔(秒)。默认 60:改价后运行中的 CRM 最迟 60s 自动生效。
# 设 0 关闭轮询(退回"仅开机加载一次",改价需重启进程)。
# CHOBO_PRICE_REFRESH_SEC=60
```

- [ ] **Step 4: 语法自检**

Run: `bash -n deploy/customer/bare-node/update-prices.sh && bash -n deploy/customer/bare-node/package-crm-bare.sh && echo OK`
Expected: 打印 `OK`(两脚本 shell 语法无误)。

- [ ] **Step 5: Commit**

```bash
git add deploy/customer/bare-node/update-prices.sh deploy/customer/bare-node/package-crm-bare.sh deploy/customer/bare-node/chobo-crm.env.example
git commit -m "feat(deploy): 裸 Node 包 update-prices.sh 一键(写价+回填)+ 打包拷入 + env 样例"
```

---

### Task 7: 文档 — 接入方自助加模型 + 团队侧同步

**Files:**
- Modify: `deploy/customer/bare-node/交付指南.md`(新增"自助加模型"章节)
- Modify: `deploy/customer/bare-node/README.md`(§7 升级补无重启路径)
- Modify: `deploy/customer/README.md`(turnkey Docker:`docker exec` 加价 + seed 挂载 + `CHOBO_PRICE_REFRESH_SEC`)
- Modify: `deploy/customer/chobo-crm.env.example`(turnkey:加注释项)
- Modify: `CLAUDE.md`、`docs/dev-log.md`(状态同步)

- [ ] **Step 1: `交付指南.md` 加新章节** — 在其"Part 2 字段字典"之后,追加一个新顶层章节:

```markdown
## 以后新增模型价格(自助,无需联系我们)

模型频繁出新。给一个新模型计价,**不需要重启 CRM、不需要我们介入**,三步:

1. 编辑 `price-seed.json`:把顶层 `version` **改成一个更大的新版本号**(如 `2026-07-01a`),
   并在 `rows` 里**追加**这个新模型的价目行(保留原有全部行 —— 新版本是"整版快照")。
2. 跑 `./update-prices.sh`(写库 + 回填,幂等安全)。
3. 完。运行中的 CRM 会在 ≤ `CHOBO_PRICE_REFRESH_SEC` 秒内自动生效(默认 60s)。

### 价目行字段(单位:每百万 token 的价 = per-mtok)

| 字段 | 含义 |
|------|------|
| `provider` | 计价渠道(**不是厂商**):经网关中转填网关名(如 `newapi`),直连填直连标识 |
| `model` | 规范模型名(与事件里 `request_model` 对齐;带版本后缀的用下方 `aliases` 归一) |
| `operation` | `chat` / `image` / `video` / `embedding` |
| `input_tier_max` | 输入分档上界;`0` = 不分档/兜底 |
| `input_per_mtok` / `output_per_mtok` | 输入 / 输出单价 |
| `cache_read_per_mtok` | 命中缓存的输入单价(可省) |
| `reasoning_per_mtok` | 单列的推理 token 单价(仅当上游把 reasoning 单独计费时填) |
| `text_input_per_mtok` | 仅图像 token 计价用(文本输入单价);此时 `input_per_mtok` 表图像输入单价 |
| `per_image` | 旧"按张"平价(有 token 计价就不用) |
| `currency` | 币种,如 `CNY` / `USD`。**看板永不跨币种相加**;按上游真实计价单位填 |

一个 chat 模型样例行(**价格数字请以上游官方价为准,不要照抄**):

​```json
{ "provider": "newapi", "model": "claude-sonnet-5", "operation": "chat",
  "input_tier_max": 0, "input_per_mtok": 3.0, "output_per_mtok": 15.0,
  "cache_read_per_mtok": 0.3, "currency": "USD" }
​```

### 怎么找准 `(provider, model, operation)` 三元组(最易错)

定价是**精确匹配**这三元组。别猜 —— 直接查你自己的库,看事件真实带的是什么:

​```sql
SELECT DISTINCT provider, request_model, operation, currency
FROM usage_events
WHERE request_model LIKE '%你的新模型关键词%';
​```

按查出来的 `provider` / `request_model` / `operation` 去配价。若 `request_model` 带版本后缀
(如 `xxx-260215`),在 `price-seed.json` 的 `aliases` 里加一条归一:
`{ "provider": "...", "alias": "带后缀的名", "canonical": "你在 rows 里用的规范名" }`。

> 提醒:`version` 不 bump 就是 no-op(`update-prices.sh` 会明确提示"已在库,无改动")。
```

- [ ] **Step 2: `bare-node/README.md` §7 升级** — 把 `## 7. 升级` 一节末尾补一段(在现有"价目表"说明之后):

```markdown

- **只加/改模型价格、不想动整包**:无需换包、无需重启 —— 改 `price-seed.json` 的 `version`
  并追加价目行,跑 `./update-prices.sh`,运行中的 CRM 会在 ≤ `CHOBO_PRICE_REFRESH_SEC` 秒内
  自动生效(默认 60s)。详见「交付指南.md → 以后新增模型价格(自助)」。
```

- [ ] **Step 3: turnkey Docker 文档** — `deploy/customer/README.md` 加一小节(标题 `## 新增模型价格(不重启)`):

```markdown
## 新增模型价格(不重启)

镜像已含 `seed-cli` / `reprice-cli`。把 `price-seed.json` 作为卷挂载(host 可编辑),改好 `version` 后:

​```bash
docker exec chobo-crm node dist/seed-cli.js /app/price-seed.json   # 版本增量写库
docker exec chobo-crm node dist/reprice-cli.js                     # 回填补价前的 NULL
​```

运行中的容器会在 ≤ `CHOBO_PRICE_REFRESH_SEC` 秒内自动拾取新价(默认 60s,在 compose env 里可调)。
```

并在 `deploy/customer/chobo-crm.env.example` 末尾追加:

```bash

# （可选）价目热载轮询间隔(秒),默认 60;0=关闭(改价需重启容器)。
# CHOBO_PRICE_REFRESH_SEC=60
```

- [ ] **Step 4: 团队文档同步** — 在 `docs/dev-log.md` 顶部追加一条当日条目(概述:价目运行时热载 + seed-cli + update-prices.sh + 自助文档;纯 CRM+打包+文档,不改 SDK/契约;价目版本机制不变);并在 `CLAUDE.md` 的「状态」区补一条同义要点(一两句,含 `CHOBO_PRICE_REFRESH_SEC` 默认 60)。**不写入任何真实客户名/IP/域名**(本仓为公开仓)。

- [ ] **Step 5: Commit**

```bash
git add deploy/customer/bare-node/交付指南.md deploy/customer/bare-node/README.md deploy/customer/README.md deploy/customer/chobo-crm.env.example CLAUDE.md docs/dev-log.md
git commit -m "docs: 接入方自助加模型章节(价目行格式+三元组自查)+ turnkey/团队文档同步"
```

---

### Task 8: 重打裸 Node 包 + `node:20` 容器端到端实证(无重启加价整环)

**Files:**
- 无源码改动;产物 `dist/chobo-crm-bare-<日期>.tar.gz` + 一次容器实证。

- [ ] **Step 1: 全量测试基线**

Run(在 `server/`):`npm test`
Expected: PASS(全部 CRM 测试:现有 102 + 本计划新增 config 2 / price-store 5 = 约 109;数量以实际为准,**必须全绿**)。

- [ ] **Step 2: 重打包**

Run(在仓库根):`bash deploy/customer/bare-node/package-crm-bare.sh`
Expected: 打印 `✅ 交付件就绪:dist/chobo-crm-bare-<日期>.tar.gz`;包内应含 `server/dist/seed-cli.js` 与顶层 `update-prices.sh`。

- [ ] **Step 3: 容器端到端实证"无重启加价"** — 用 `node:20` 跑解压件,设短轮询间隔便于观测:

```bash
# 起一次性 PG
CID=$(docker run -d -e POSTGRES_PASSWORD=p -e POSTGRES_USER=chobo -e POSTGRES_DB=chobo --name chobo-verify-pg postgres:16-alpine)
# 解压交付件到临时目录
TARBALL=$(ls -t dist/chobo-crm-bare-*.tar.gz | head -1)
WORK=$(mktemp -d); tar xzf "$TARBALL" -C "$WORK"
# 在 node:20 容器里:填 env(短轮询)→ start.sh 起 CRM → 改价 → update-prices.sh → 观察自动生效
docker run --rm --link chobo-verify-pg -v "$WORK/chobo-crm:/app" -w /app node:20 bash -c '
  set -e
  cat > chobo-crm.env <<EOF
CHOBO_DATABASE_URL=postgres://chobo:p@chobo-verify-pg:5432/chobo
CHOBO_INGEST_SECRET=verify-secret
CHOBO_PRICE_REFRESH_SEC=3
EOF
  ./start.sh & SRV=$!; sleep 6
  # 改价:bump 版本 + 追加一个新模型行(用 jq 生成一个新版本快照)
  node -e "const fs=require(\"fs\");const s=JSON.parse(fs.readFileSync(\"price-seed.json\"));s.version=\"verify-hotreload\";s.rows.push({provider:\"newapi\",model:\"claude-sonnet-5\",operation:\"chat\",input_tier_max:0,input_per_mtok:3,output_per_mtok:15,currency:\"USD\"});fs.writeFileSync(\"price-seed.json\",JSON.stringify(s));"
  ./update-prices.sh
  sleep 5   # > CHOBO_PRICE_REFRESH_SEC,等运行中的 CRM 轮询拾取
  # 投一条新模型事件,断言被定价(非 NULL)
  curl -s -X POST localhost:8787/v1/events -H "content-type: application/json" -H "x-chobo-secret: verify-secret" \
    -d "{\"events\":[{\"event_id\":\"vr1\",\"identity_source\":\"header\",\"start_time\":1750000000000,\"service\":\"v\",\"provider\":\"newapi\",\"operation\":\"chat\",\"request_model\":\"claude-sonnet-5\",\"input_tokens\":1000000,\"output_tokens\":0,\"usage_source\":\"measured\",\"status\":\"success\",\"sdk_lang\":\"node\",\"sdk_version\":\"0.0.0\"}]}"
  echo; sleep 1
  node -e "const p=require(\"postgres\")(\"postgres://chobo:p@chobo-verify-pg:5432/chobo\");p\`SELECT total_cost,currency FROM usage_events WHERE event_id=\${\"vr1\"}\`.then(r=>{console.log(\"RESULT\",r[0]);return p.end();})"
  kill $SRV 2>/dev/null || true
'
docker rm -f chobo-verify-pg; rm -rf "$WORK"
```
Expected: 末尾打印 `RESULT { total_cost: '3.00000000', currency: 'USD' }` —— 证明**改价后未重启、CRM 在 3s 轮询内自动拾取新价并对新模型计价**。若打印 `total_cost: null`,说明轮询未生效,查启动日志的 `price table reloaded`。

- [ ] **Step 4: Commit(产物不入库,仅记录已验证)**

`.tar.gz` 已被 `.gitignore` 的 `dist/` 覆盖,不提交。本步无需 commit;在最终报告里记录"容器端到端实证通过 + 打包产物路径"。

---

## Self-Review(已过)

**1. Spec 覆盖:** config(Task 1)/`price-seed.ts` 抽出(Task 2)/`price-store.ts` 持有器+刷新器+崩溃安全+防清空+原子(Task 3)/server 装配+停机+日志(Task 4)/`seed-cli`+脚本(Task 5)/裸 Node `update-prices.sh`+打包+env(Task 6)/turnkey Docker+接入方自助文档+团队文档(Task 7)/重打包+容器实证(Task 8)。spec §4–§9 全部有对应任务。

**2. 接口一致性:** `createPriceStore(load, initial, log?)` 在 Task 3 定义、Task 4 调用一致(`() => loadPriceTable(sql)`);`PriceStore.current` 传给 `buildApp({ priceTable })`(`app.ts`/`ingest.ts` 现有签名 `priceTable: () => PriceTable`,零改动);`syncPriceSeed(sql, seedPath)` 签名跨 Task 2/5 一致;`ServerConfig.priceRefreshSec` Task 1 定义、Task 4 使用一致。

**3. 无占位符:** 每个改代码的步骤都给了完整代码与确切命令/期望输出。

**4. spec 偏差(已在抬头注明):** `createPriceStore` 用注入 `load` 而非吃 `sql`(更好测试,行为等价);spec §8 的"e2e.test.ts 新增用例"改由 `price-store.test.ts` 的集成用例覆盖(经真实 HTTP `app.inject` 定价,同等甚至更强),避免改动 e2e 夹具。

**5. 铁律守护点:** 崩溃保留上一版 + 防清空守卫(Task 3 用例覆盖);历史 NULL 靠 `reprice`(`update-prices.sh` 第二步);版本不可变/不覆盖人工调价(`syncPriceSeed` 原逻辑,`seed.test.ts` 覆盖);默认开轮询但可 `=0` 退回(Task 1 用例覆盖)。

---

## 执行说明

- 测试含 testcontainers 用例,需本机 **Docker 可用**(Windows Docker Desktop running)。
- 全程在 `feature/price-hot-reload` 分支;**不 push**(公开仓,由 fugue 决定何时推)。
- 完成后交由 fugue 复审 → 再走「先自有共享 CRM dogfood → 后交付自建接入方」的上线顺序(见 spec §9)。
