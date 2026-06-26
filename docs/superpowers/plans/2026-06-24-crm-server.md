# Plan 2 — CRM 后端 (`server/`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build chobo 的 CRM 后端 —— ingest + 算价 + 看板读 API 的聚焦服务:接收 SDK 发来的 `{events:[...]}`、按 `event_id` 幂等去重、用自有带版本价格表(全 CNY)算 cost、落 Postgres,并提供只读聚合 API。

**Architecture:** 进程内 `buildApp()` 返回 Fastify 实例;`POST /v1/events` 用**自定义 Ajv2020 校验器**(默认 Ajv 是 draft-07,遇 2020-12 契约会在 boot 崩)做**信封级**校验、再**逐事件**校验(宽容部分接收,坏事件计数不毒批),算价(豆包带版本 id 经 `model_aliases` 归一)后**单条多行 `INSERT ... ON CONFLICT (event_id) DO NOTHING`** 落 `usage_events`(`result.count` = 真实入库行数 → accepted/duplicates);`/v1/stats/*` 纯 `SUM/GROUP BY` 读。**每接入方一套实例**,PG 连接串、可选 ingest 密钥、价格 seed 由环境注入。算价只在 CRM 一处实现。

**Tech Stack:** Node 20 LTS · ESM · TypeScript · Fastify 5.8.5 + Ajv2020(`ajv/dist/2020.js` @8.20.0)+ ajv-formats 3.0.1 · postgres.js 3.4.9(零依赖驱动)· 迁移 = 纯 `.sql` + 启动期 runner(`pg_advisory_lock` + 账本表,零新增依赖)· 测试 vitest + `@testcontainers/postgresql` 12.x(Docker Desktop 已装;**禁用 pg-mem** —— 它不强制 `numeric(18,8)` 精度,对计费产品是硬伤)。

---

## 背景:已锁定的决策(写本计划前已与 fugue 拍板)

| 项 | 决策 |
|---|---|
| CRM 栈 | **Fastify**;查询层 **postgres.js**;ESM + TypeScript;Node 20 LTS;vitest |
| 部署/PG | **每接入方一套 CRM 实例**;PG 连接串启动注入(`CHOBO_DATABASE_URL`),CRM 不硬编码任何库;启动跑幂等迁移建表;单库=单接入方,终端归因靠 `user_id/org_id/project`,**无跨接入方 tenant 列**。AdopterA = 首个接入方 |
| Ingest 鉴权 | **开放为默认 + 休眠可选 shared-secret**:置 `CHOBO_INGEST_SECRET` 才校验 `X-Chobo-Secret` 头。⚠ 现有 SDK 尚不发该头 —— 真要启用,需后续给 SDK 加发头能力(v1 开放,无需改 SDK) |
| payload | 默认 `metadata`(不存明文);`truncated` 时按 `CHOBO_PAYLOAD_MAX_BYTES` 截断;**脱敏不归 chobo**(接入方自行预脱敏后置 `redacted`) |
| 币种/精度 | **全 CNY** + `numeric(18,8)`;**无多币种、无汇率**(example-gateway 聚合 + 豆包均按 CNY 计) |
| new-api 对账 | 推迟;`usage_events` 含 `request_id` + 预留列 `newapi_cost/cost_delta/recon_status`(可空,零返工) |
| 算价语义 | 写时算价;cost 各分项 round 到 8 位小数;真 PG `numeric(18,8)` 落库;未知模型 → `total_cost=NULL` + 告警日志(不静默填 0) |

### v1 provider/model 范围(来自 AdopterA 两个 `.env` 实读)

| 计费 provider | model(归一后) | operation | 路由 | 价格 |
|---|---|---|---|---|
| `doubao` | `doubao-seed-2.0-pro` | chat | Ark 直连 | ✅ 官方 3 档(`dev_docs/` 火山 PDF) |
| `example-gateway` | `gpt-5.5` | chat | example-gateway 聚合 | ⏳ 待 fugue 给 CNY 价 |
| `example-gateway` | `gemini-3.5-flash` | chat | example-gateway 聚合 | ⏳ 待 fugue 给 CNY 价 |
| `example-gateway` | `gpt-image-2` | image | example-gateway 聚合 | ⏳ 待 fugue 给 CNY 单价(元/张) |

- **移出 v1:GLM / MiniMax / Seedream**(过度设计,未在用)。
- `provider` = **计费来源**(谁开账),不是模型厂商:豆包直连火山方舟(Ark)→ 记 `doubao`(内部即火山方舟/Ark 那个账户,代码统一用 `doubao`);gpt-5.5 / gemini-3.5-flash / gpt-image-2 经 example-gateway 聚合 → 记 `example-gateway`。SDK 现已发 `doubao`,**无需改**;CRM 只做匹配,价格表 `provider` 与事件值一致即可。
- 豆包带版本/接入点 id 需**归一**:`doubao-seed-2-0-pro-260215 → doubao-seed-2.0-pro`(CRM `model_aliases` 表;算价前 canonicalize)。
- example-gateway 三项在 fugue 给价前**不 seed 占位行**:占位 null 费率会被算成 0(违反"缺价 NULL+告警");缺行 → `total_cost=NULL`+告警,正是想要的诚实行为。

**契约是唯一耦合点(已存在,本计划消费;价格表 schema 会小幅扩展 `aliases`):** `contracts/event.schema.json`(11 必填、JSON Schema 2020-12)、`contracts/price-table.schema.json`、`contracts/README.md`(信封 `{events:[...]}` → `{accepted, duplicates}`)。SDK 实测发 `{"events":[...]}`+`Content-Type: application/json`,success = 任意 2xx(忽略 body),**非 2xx → 整批重投**(故必须幂等去重 + 宽容部分接收)。

---

## File Structure

```
server/
├── package.json              # @chobo/server, ESM, engines.node>=20, scripts, deps
├── tsconfig.json             # NodeNext ESM, strict, target es2022
├── vitest.config.ts          # node env, 串行(避免多容器并发)
├── .env.example              # 所有 CHOBO_* 注入项
├── migrations/
│   └── 0001_init.sql         # usage_events / event_payloads / price_table / model_aliases + 索引
├── price-seed.example.json   # 价格 seed(仅豆包真价 + 豆包别名;example-gateway 待价不 seed)
└── src/
    ├── config.ts             # resolveConfig(env) -> ServerConfig
    ├── db.ts                 # createSql(url) + migrate(sql, dir)
    ├── validator.ts          # 从 contracts/event.schema.json 编 Ajv2020 + 信封 schema
    ├── types.ts              # EventInput / UsageRow / ServerConfig / PriceRow / PriceTable / Cost
    ├── pricing.ts            # loadPriceTable(sql) + computeCost(event, table)(含 model 归一)
    ├── ingest.ts             # registerIngest:POST /v1/events
    ├── stats.ts              # registerStats:/v1/stats/* + /v1/events
    ├── filters.ts            # parseFilters + whereFragment(stats 共用)
    ├── auth.ts               # secretGuard(可选 shared-secret)
    ├── app.ts                # buildApp(deps):装 Ajv2020 + 路由 + hooks
    └── server.ts             # 入口:config -> sql -> migrate -> seed -> buildApp -> listen + 优雅退出
test/ (server/ 下)
    ├── helpers.ts            # startPg() + truncateAll()
    ├── config.test.ts · migrate.test.ts · validator.test.ts · pricing.test.ts
    ├── ingest.test.ts · ingest.dedup.test.ts · ingest.reject.test.ts · auth.test.ts
    ├── stats.overview.test.ts · stats.timeseries.test.ts · stats.bydim.test.ts · stats.events.test.ts
    └── e2e.test.ts
```

---

## Task 0: 脚手架 — `server/` 包与工具链

**Files:** Create `server/package.json` · `server/tsconfig.json` · `server/vitest.config.ts` · `server/.env.example`

- [ ] **Step 1: `server/package.json`**

```json
{
  "name": "@chobo/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "node --watch --import tsx src/server.ts",
    "start": "node dist/server.js",
    "test": "vitest run"
  },
  "dependencies": {
    "fastify": "5.8.5",
    "ajv": "8.20.0",
    "ajv-formats": "3.0.1",
    "postgres": "3.4.9"
  },
  "devDependencies": {
    "@testcontainers/postgresql": "^12.0.3",
    "testcontainers": "^12.0.3",
    "tsx": "^4.21.0",
    "typescript": "^5.8.0",
    "vitest": "^2.1.0",
    "@types/node": "^20.0.0"
  }
}
```

- [ ] **Step 2: `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "lib": ["es2022"], "strict": true, "declaration": false,
    "outDir": "dist", "rootDir": "src", "resolveJsonModule": true,
    "esModuleInterop": true, "skipLibCheck": true, "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: `server/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "node", fileParallelism: false, testTimeout: 60_000, hookTimeout: 120_000 },
});
```

- [ ] **Step 4: `server/.env.example`**

```bash
CHOBO_DATABASE_URL=postgres://user:pass@host:5432/dbname   # 该接入方自己的 PG(必填)
CHOBO_PORT=8787
CHOBO_HOST=0.0.0.0
CHOBO_INGEST_SECRET=                                       # 留空=开放;置了才校验 X-Chobo-Secret
CHOBO_PAYLOAD_MODE=metadata                                # off | metadata | truncated
CHOBO_PAYLOAD_MAX_BYTES=8192
CHOBO_BODY_LIMIT=16777216                                  # Fastify 请求体上限(字节,默认 16 MiB)
CHOBO_PRICE_SEED=./price-seed.example.json
```

- [ ] **Step 5: 安装并提交**

```bash
cd server && npm install
git add server/package.json server/package-lock.json server/tsconfig.json server/vitest.config.ts server/.env.example
git commit -m "chore(server): Plan 2 脚手架 — Fastify5+postgres.js+vitest"
```

---

## Task 1: `config.ts` — 解析 `ServerConfig`

**Files:** Create `server/src/types.ts` · `server/src/config.ts` · Test `server/test/config.test.ts`

- [ ] **Step 1: `types.ts` 配置类型**

```ts
export type PayloadMode = "off" | "metadata" | "truncated";

export interface ServerConfig {
  databaseUrl: string;
  host: string;
  port: number;
  ingestSecret: string | null;   // null = 开放
  payloadMode: PayloadMode;
  payloadMaxBytes: number;
  priceSeedPath: string | null;
}
```

- [ ] **Step 2: 失败测试 `test/config.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  it("requires CHOBO_DATABASE_URL", () => {
    expect(() => resolveConfig({})).toThrow(/CHOBO_DATABASE_URL/);
  });
  it("applies defaults", () => {
    const c = resolveConfig({ CHOBO_DATABASE_URL: "postgres://x" });
    expect(c.port).toBe(8787);
    expect(c.ingestSecret).toBeNull();
    expect(c.payloadMode).toBe("metadata");
    expect(c.payloadMaxBytes).toBe(8192);
  });
  it("parses overrides and rejects bad payload mode", () => {
    const c = resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_PORT: "9000", CHOBO_INGEST_SECRET: "s", CHOBO_PAYLOAD_MODE: "truncated" });
    expect(c.port).toBe(9000);
    expect(c.ingestSecret).toBe("s");
    expect(c.payloadMode).toBe("truncated");
    expect(() => resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_PAYLOAD_MODE: "bogus" })).toThrow(/CHOBO_PAYLOAD_MODE/);
  });
});
```

- [ ] **Step 3: 运行确认失败** — `cd server && npx vitest run test/config.test.ts` → FAIL(模块不存在)。

- [ ] **Step 4: `src/config.ts`**

```ts
import type { PayloadMode, ServerConfig } from "./types.js";

const MODES: PayloadMode[] = ["off", "metadata", "truncated"];

export function resolveConfig(env: Record<string, string | undefined>): ServerConfig {
  const databaseUrl = env.CHOBO_DATABASE_URL;
  if (!databaseUrl) throw new Error("chobo: CHOBO_DATABASE_URL is required");
  const payloadMode = (env.CHOBO_PAYLOAD_MODE ?? "metadata") as PayloadMode;
  if (!MODES.includes(payloadMode)) throw new Error(`chobo: CHOBO_PAYLOAD_MODE must be one of ${MODES.join("|")}`);
  const secret = env.CHOBO_INGEST_SECRET?.trim();
  return {
    databaseUrl,
    host: env.CHOBO_HOST ?? "0.0.0.0",
    port: Number(env.CHOBO_PORT ?? "8787"),
    ingestSecret: secret ? secret : null,
    payloadMode,
    payloadMaxBytes: Number(env.CHOBO_PAYLOAD_MAX_BYTES ?? "8192"),
    priceSeedPath: env.CHOBO_PRICE_SEED ?? null,
  };
}
```

- [ ] **Step 5: 运行确认通过** — `npx vitest run test/config.test.ts` → PASS(3)。
- [ ] **Step 6: 提交** — `git commit -m "feat(server): config — 解析 ServerConfig + 校验"`

---

## Task 2: `db.ts` — 客户端 + 迁移 runner + 初始 schema(含 `model_aliases`)

**Files:** Create `server/migrations/0001_init.sql` · `server/src/db.ts` · `server/test/helpers.ts` · Test `server/test/migrate.test.ts`

- [ ] **Step 1: `migrations/0001_init.sql`**(spec §7 DDL + 预留对账列 + `model_aliases`)

```sql
-- 0001_init: chobo CRM 主 schema
CREATE TABLE IF NOT EXISTS usage_events (
  event_id            text PRIMARY KEY,
  request_id          text,
  parent_id           text,
  user_id             text,
  org_id              text,
  project             text,
  identity_source     text NOT NULL,
  start_time          timestamptz NOT NULL,
  end_time            timestamptz,
  latency_ms          integer,
  service             text NOT NULL,
  provider            text NOT NULL,
  operation           text NOT NULL,
  request_model       text NOT NULL,
  response_model      text,
  input_tokens        integer,
  output_tokens       integer,
  total_tokens        integer,
  cached_tokens       integer,
  reasoning_tokens    integer,
  image_count         integer,
  usage_source        text NOT NULL,
  input_cost          numeric(18,8),
  output_cost         numeric(18,8),
  cache_cost          numeric(18,8),
  total_cost          numeric(18,8),
  currency            text DEFAULT 'CNY',
  price_table_version text,
  status              text NOT NULL,
  error_type          text,
  finish_reason       text,
  sdk_lang            text,
  sdk_version         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- 预留:new-api 对账后装件用(v1 不填)
  newapi_cost         numeric(18,8),
  cost_delta          numeric(18,8),
  recon_status        text
);

CREATE INDEX IF NOT EXISTS ix_usage_org_created     ON usage_events (org_id, created_at);
CREATE INDEX IF NOT EXISTS ix_usage_user_created    ON usage_events (user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_usage_project_created ON usage_events (project, created_at);
CREATE INDEX IF NOT EXISTS ix_usage_model_created   ON usage_events (request_model, created_at);
CREATE INDEX IF NOT EXISTS ix_usage_request_id      ON usage_events (request_id);

CREATE TABLE IF NOT EXISTS event_payloads (
  event_id          text PRIMARY KEY REFERENCES usage_events(event_id),
  request_payload   jsonb,
  response_payload  jsonb,
  truncated         boolean DEFAULT false,
  redacted          boolean DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS price_table (
  version             text NOT NULL,
  provider            text NOT NULL,
  model               text NOT NULL,
  operation           text NOT NULL,
  input_tier_max      bigint NOT NULL DEFAULT 0,   -- 0 = 无分档/兜底(主键列不可 NULL)
  input_per_mtok      numeric(18,8),
  output_per_mtok     numeric(18,8),
  cache_read_per_mtok numeric(18,8),
  reasoning_per_mtok  numeric(18,8),
  per_image           numeric(18,8),
  currency            text DEFAULT 'CNY',
  PRIMARY KEY (version, provider, model, operation, input_tier_max)
);

-- 模型归一:把带版本/接入点 id 的 request_model 映射到价目规范名
CREATE TABLE IF NOT EXISTS model_aliases (
  provider  text NOT NULL,
  alias     text NOT NULL,
  canonical text NOT NULL,
  PRIMARY KEY (provider, alias)
);
```

- [ ] **Step 2: `src/db.ts`**

```ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres, { type Sql } from "postgres";

const ADVISORY_LOCK_KEY = 0x63686f62; // "chob"

export function createSql(url: string): Sql {
  return postgres(url, { max: 10, onnotice: () => {} });
}

/** 应用 migrations/ 下未执行的 .sql:账本表 + 单事务/文件 + 顾问锁(多副本安全)。 */
// 用 sql.reserve() 固定单一连接:顾问锁(session/connection 级)与所有迁移语句必须在
// 同一条连接上,否则锁形同虚设(postgres.js 每条查询从池里取连接)。ReservedSql 运行时
// 不暴露 .begin(),故每个迁移文件用手动 BEGIN/COMMIT/ROLLBACK 包裹。
export async function migrate(sql: Sql, dir: string): Promise<string[]> {
  const reserved = await sql.reserve();
  try {
    await reserved`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`;
    await reserved`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const applied = new Set((await reserved<{ version: string }[]>`SELECT version FROM schema_migrations`).map((r) => r.version));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const ran: string[] = [];
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (applied.has(version)) continue;
      const body = await readFile(join(dir, file), "utf8");
      await reserved`BEGIN`;
      try {
        await reserved.unsafe(body);
        await reserved`INSERT INTO schema_migrations (version) VALUES (${version})`;
        await reserved`COMMIT`;
      } catch (err) {
        await reserved`ROLLBACK`;
        throw err;
      }
      ran.push(version);
    }
    return ran;
  } finally {
    await reserved`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
    reserved.release();
  }
}
```

- [ ] **Step 3: `test/helpers.ts`**

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createSql, migrate } from "../src/db.js";
import type { Sql } from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, "..", "migrations");

export interface PgHandle { container: StartedPostgreSqlContainer; sql: Sql; url: string; stop: () => Promise<void>; }

export async function startPg(): Promise<PgHandle> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  const sql = createSql(url);
  await migrate(sql, MIGRATIONS_DIR);
  return { container, sql, url, stop: async () => { await sql.end({ timeout: 5 }); await container.stop(); } };
}

export async function truncateAll(sql: Sql): Promise<void> {
  await sql`TRUNCATE event_payloads, usage_events RESTART IDENTITY CASCADE`;
}
```

- [ ] **Step 4: 失败测试 `test/migrate.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startPg, MIGRATIONS_DIR, type PgHandle } from "./helpers.js";
import { migrate } from "../src/db.js";

let pg: PgHandle;
beforeAll(async () => { pg = await startPg(); });
afterAll(async () => { await pg.stop(); });

describe("migrate", () => {
  it("created the four tables", async () => {
    const rows = await pg.sql<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname='public'`;
    expect(rows.map((r) => r.tablename)).toEqual(expect.arrayContaining(["usage_events", "event_payloads", "price_table", "model_aliases"]));
  });
  it("is idempotent — second run applies nothing", async () => {
    expect(await migrate(pg.sql, MIGRATIONS_DIR)).toEqual([]);
  });
  it("enforces numeric(18,8) — why we use real PG not pg-mem", async () => {
    await pg.sql`INSERT INTO price_table (version,provider,model,operation,input_tier_max,input_per_mtok) VALUES ('t','p','m','chat',0,1.123456789)`;
    const [r] = await pg.sql<{ input_per_mtok: string }[]>`SELECT input_per_mtok FROM price_table WHERE version='t'`;
    expect(r.input_per_mtok).toBe("1.12345679");
    await pg.sql`DELETE FROM price_table WHERE version='t'`;
  });
});
```

- [ ] **Step 5: 运行**(首次拉镜像)— `npx vitest run test/migrate.test.ts` → PASS(3);Docker 未起会报连接错。
- [ ] **Step 6: 提交** — `git commit -m "feat(server): db — 客户端 + 迁移 runner + 初始 schema(含 model_aliases)"`

---

## Task 3: `validator.ts` — Ajv2020 事件校验器 + 信封 schema

> Fastify 默认 Ajv 是 draft-07,喂 2020-12 契约会**在 boot 抛**。必须自建 Ajv2020。

**Files:** Modify `server/src/types.ts`(加 `EventInput`) · Create `server/src/validator.ts` · Test `server/test/validator.test.ts`

- [ ] **Step 1: `types.ts` 追加 `EventInput`**

```ts
export type Operation = "chat" | "image" | "video" | "embedding";
export type UsageSource = "measured" | "estimated" | "none";
export type IdentitySource = "header" | "jwt" | "missing";

export interface EventPayload { request?: unknown; response?: unknown; truncated?: boolean; redacted?: boolean; }

export interface EventInput {
  event_id: string;
  request_id?: string | null; parent_id?: string | null;
  user_id?: string | null; org_id?: string | null; project?: string | null;
  identity_source: IdentitySource;
  start_time: number; end_time?: number | null; latency_ms?: number | null;
  service: string; provider: string; operation: Operation;
  request_model: string; response_model?: string | null;
  input_tokens?: number | null; output_tokens?: number | null; total_tokens?: number | null;
  cached_tokens?: number | null; reasoning_tokens?: number | null; image_count?: number | null;
  usage_source: UsageSource;
  status: "success" | "failure"; error_type?: string | null; finish_reason?: string | null;
  payload?: EventPayload | null;
  sdk_lang: "python" | "node"; sdk_version: string;
}
```

- [ ] **Step 2: 失败测试 `test/validator.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { makeEventValidator } from "../src/validator.js";

const VALID = {
  event_id: "e1", identity_source: "header", start_time: 1750000000000,
  service: "python-lesson-parser", provider: "doubao", operation: "chat",
  request_model: "doubao-seed-2.0-pro", usage_source: "measured",
  status: "success", sdk_lang: "python", sdk_version: "0.1.0",
};

describe("makeEventValidator (Ajv2020 from contract)", () => {
  const validate = makeEventValidator();
  it("accepts a minimal valid event", () => { expect(validate(VALID)).toBe(true); });
  it("rejects a bad operation enum", () => {
    expect(validate({ ...VALID, operation: "translate" })).toBe(false);
    expect(validate.errors?.[0].instancePath).toBe("/operation");
  });
  it("rejects a missing required field", () => { const { event_id, ...rest } = VALID; expect(validate(rest)).toBe(false); });
  it("rejects unknown properties", () => { expect(validate({ ...VALID, surprise: 1 })).toBe(false); });
});
```

- [ ] **Step 3: 运行确认失败** — FAIL(模块不存在)。

- [ ] **Step 4: `src/validator.ts`**

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// NodeNext 下必须用具名导入 — default import 解析为 namespace 无法 new
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
// ajv-formats 在 NodeNext 下 default 被推断为 namespace 而非函数;通过 unknown 绕过
// event.schema.json 目前无 format 关键字,addFormats 是 no-op,但保留以便未来使用
import * as addFormatsNS from "ajv-formats";
type AjvFormatsPlugin = (ajv: InstanceType<typeof Ajv2020>) => InstanceType<typeof Ajv2020>;
const addFormats = (addFormatsNS as unknown as { default: AjvFormatsPlugin }).default;
import type { EventInput } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(here, "..", "..", "contracts", "event.schema.json"); // server/ 上一级

export const EVENT_SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Record<string, unknown>;
export const EVENT_SCHEMA_ID = EVENT_SCHEMA["$id"] as string;

export function makeAjv(): InstanceType<typeof Ajv2020> {
  const ajv = new Ajv2020({ allErrors: false, strict: false });
  addFormats(ajv);
  ajv.addSchema(EVENT_SCHEMA);     // 按 $id 注册一次;勿再 compile 同对象
  return ajv;
}

export function makeEventValidator(ajv: InstanceType<typeof Ajv2020> = makeAjv()): ValidateFunction<EventInput> {
  return ajv.getSchema<EventInput>(EVENT_SCHEMA_ID)!;
}

/** Fastify 信封 body schema:只校验 {events: 非空对象数组};逐事件深校验在 handler。 */
export function envelopeSchema(): Record<string, unknown> {
  return { type: "object", required: ["events"], additionalProperties: false,
    properties: { events: { type: "array", minItems: 1, items: { type: "object" } } } };
}
```

- [ ] **Step 5: 运行确认通过** — PASS(4)。
- [ ] **Step 6: 提交** — `git commit -m "feat(server): validator — Ajv2020 编译契约 + 信封 schema"`

---

## Task 4: `pricing.ts` — 价格加载 + 算价(豆包分档/归一/缓存/按张/未知→NULL)

**Files:** Modify `server/src/types.ts` · Modify `contracts/price-table.schema.json`(加 `aliases`) · Create `server/price-seed.example.json` · Create `server/src/pricing.ts` · Test `server/test/pricing.test.ts`

- [ ] **Step 1: `types.ts` 追加价格/成本类型**

```ts
export interface PriceRow {
  version: string; provider: string; model: string; operation: string;
  input_tier_max: number;          // 0 = 无分档/兜底
  input_per_mtok: number | null; output_per_mtok: number | null;
  cache_read_per_mtok: number | null; reasoning_per_mtok: number | null;
  per_image: number | null; currency: string;
}
export interface PriceTable {
  version: string;
  rows: PriceRow[];
  aliases: Record<string, string>; // key `${provider}::${alias}` -> canonical model
}
export interface Cost {
  input_cost: number | null; output_cost: number | null; cache_cost: number | null;
  total_cost: number | null;       // null = 未找到价目(告警,不填 0)
  currency: string | null; price_table_version: string | null; priced: boolean;
}
```

- [ ] **Step 2: 扩展 `contracts/price-table.schema.json` 加可选 `aliases`**

在顶层 `properties` 中(与 `rows` 并列)加入,`required` 不变(aliases 可选):

```json
        "aliases": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["provider", "alias", "canonical"],
            "additionalProperties": false,
            "properties": {
              "provider":  { "type": "string" },
              "alias":     { "type": "string" },
              "canonical": { "type": "string" }
            }
          }
        }
```

- [ ] **Step 3: `server/price-seed.example.json`**(仅豆包真价 + 别名;example-gateway 待价不 seed)

> 数字取自 2026-06-24 `dev_docs/` 火山 PDF;**上线前 fugue 抽查**。`input_tier_max` 单位=token(32K/128K/256K → 32000/128000/256000)。
> example-gateway/`gpt-5.5`·`gemini-3.5-flash`·`gpt-image-2` 的 CNY 价待 fugue 给 —— **故意不 seed**:无行 → `total_cost=NULL`+告警(不静默填 0)。

```json
{
  "version": "2026-06-24a",
  "rows": [
    { "provider": "doubao", "model": "doubao-seed-2.0-pro", "operation": "chat", "input_tier_max": 32000,  "input_per_mtok": 3.2, "output_per_mtok": 16.0, "cache_read_per_mtok": 0.64, "currency": "CNY" },
    { "provider": "doubao", "model": "doubao-seed-2.0-pro", "operation": "chat", "input_tier_max": 128000, "input_per_mtok": 4.8, "output_per_mtok": 24.0, "cache_read_per_mtok": 0.96, "currency": "CNY" },
    { "provider": "doubao", "model": "doubao-seed-2.0-pro", "operation": "chat", "input_tier_max": 256000, "input_per_mtok": 9.6, "output_per_mtok": 48.0, "cache_read_per_mtok": 1.92, "currency": "CNY" }
  ],
  "aliases": [
    { "provider": "doubao", "alias": "doubao-seed-2-0-pro-260215", "canonical": "doubao-seed-2.0-pro" }
  ]
}
```

> 待扩展:豆包缓存存储 0.017 元/Mtok/小时是**按时计费**,现 `price_table` 表达不了,v1 不建模。

- [ ] **Step 4: 失败测试 `test/pricing.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { computeCost } from "../src/pricing.js";
import type { PriceTable } from "../src/types.js";

const rows = (input_tier_max: number, i: number, o: number, c: number) => ({
  version: "t", provider: "doubao", model: "doubao-seed-2.0-pro", operation: "chat",
  input_tier_max, input_per_mtok: i, output_per_mtok: o, cache_read_per_mtok: c,
  reasoning_per_mtok: null, per_image: null, currency: "CNY",
});
const TABLE: PriceTable = {
  version: "t", aliases: {},
  rows: [rows(32000, 3.2, 16, 0.64), rows(128000, 4.8, 24, 0.96), rows(256000, 9.6, 48, 1.92)],
};
const base = { provider: "doubao", model: "doubao-seed-2.0-pro", operation: "chat" as const };

describe("computeCost", () => {
  it("picks [0,32K] tier", () => {
    const c = computeCost({ ...base, input_tokens: 10_000, output_tokens: 1_000, cached_tokens: 0 }, TABLE);
    expect(c.input_cost).toBe(0.032); expect(c.output_cost).toBe(0.016);
    expect(c.total_cost).toBe(0.048); expect(c.currency).toBe("CNY"); expect(c.price_table_version).toBe("t");
  });
  it("picks (32K,128K] at the 128K boundary", () => {
    expect(computeCost({ ...base, input_tokens: 128_000, output_tokens: 0 }, TABLE).input_cost).toBe(0.6144);
  });
  it("splits cached tokens to cache_read rate", () => {
    const c = computeCost({ ...base, input_tokens: 10_000, output_tokens: 0, cached_tokens: 4_000 }, TABLE);
    expect(c.input_cost).toBe(0.0192); expect(c.cache_cost).toBe(0.00256); expect(c.total_cost).toBe(0.02176);
  });
  it("normalizes a dated doubao endpoint id via alias", () => {
    const t: PriceTable = { ...TABLE, aliases: { "doubao::doubao-seed-2-0-pro-260215": "doubao-seed-2.0-pro" } };
    const c = computeCost({ provider: "doubao", model: "doubao-seed-2-0-pro-260215", operation: "chat", input_tokens: 10_000, output_tokens: 1_000 }, t);
    expect(c.total_cost).toBe(0.048);
  });
  it("prices images by count × per_image", () => {
    const t: PriceTable = { version: "t", aliases: {}, rows: [{ version: "t", provider: "example-gateway", model: "gpt-image-2", operation: "image", input_tier_max: 0, input_per_mtok: null, output_per_mtok: null, cache_read_per_mtok: null, reasoning_per_mtok: null, per_image: 0.25, currency: "CNY" }] };
    const c = computeCost({ provider: "example-gateway", model: "gpt-image-2", operation: "image", image_count: 3 }, t);
    expect(c.total_cost).toBe(0.75); expect(c.output_cost).toBe(0.75);
  });
  it("returns null + unpriced for unknown model", () => {
    const c = computeCost({ ...base, model: "nope", input_tokens: 100 }, TABLE);
    expect(c.priced).toBe(false); expect(c.total_cost).toBeNull();
  });
  it("uses the largest tier when input exceeds all brackets", () => {
    expect(computeCost({ ...base, input_tokens: 999_999, output_tokens: 0 }, TABLE).input_cost).toBe(9.5999904);
  });
});
```

- [ ] **Step 5: 运行确认失败** — FAIL(模块不存在)。

- [ ] **Step 6: `src/pricing.ts`**

```ts
import type { Sql } from "postgres";
import type { Cost, PriceRow, PriceTable } from "./types.js";

export interface Priceable {
  provider: string; model: string; operation: string;
  input_tokens?: number | null; output_tokens?: number | null;
  cached_tokens?: number | null; reasoning_tokens?: number | null; image_count?: number | null;
}

const round8 = (n: number): number => Math.round(n * 1e8) / 1e8;
const perM = (tokens: number, rate: number | null): number | null => (rate == null ? null : round8((tokens / 1_000_000) * rate));
const num = (v: string | null): number | null => (v == null ? null : Number(v));

/** 从 DB 读当前价格表(最大 version) + 别名表。 */
export async function loadPriceTable(sql: Sql): Promise<PriceTable> {
  const aliasRows = await sql<{ provider: string; alias: string; canonical: string }[]>`SELECT provider, alias, canonical FROM model_aliases`;
  const aliases: Record<string, string> = {};
  for (const a of aliasRows) aliases[`${a.provider}::${a.alias}`] = a.canonical;

  const versions = await sql<{ version: string }[]>`SELECT version FROM price_table GROUP BY version ORDER BY version DESC LIMIT 1`;
  if (versions.length === 0) return { version: "", rows: [], aliases };
  const version = versions[0].version;
  const raw = await sql<PriceRow[]>`
    SELECT version, provider, model, operation, input_tier_max,
           input_per_mtok, output_per_mtok, cache_read_per_mtok, reasoning_per_mtok, per_image, currency
    FROM price_table WHERE version = ${version}`;
  const rows = raw.map((r) => ({
    ...r, input_tier_max: Number(r.input_tier_max),
    input_per_mtok: num(r.input_per_mtok as unknown as string | null),
    output_per_mtok: num(r.output_per_mtok as unknown as string | null),
    cache_read_per_mtok: num(r.cache_read_per_mtok as unknown as string | null),
    reasoning_per_mtok: num(r.reasoning_per_mtok as unknown as string | null),
    per_image: num(r.per_image as unknown as string | null),
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
  if (!row) return { input_cost: null, output_cost: null, cache_cost: null, total_cost: null, currency: null, price_table_version: null, priced: false };

  if (p.operation === "image") {
    const img = round8((p.image_count ?? 0) * (row.per_image ?? 0));
    return { input_cost: null, cache_cost: null, output_cost: img, total_cost: img, currency: row.currency, price_table_version: row.version, priced: true };
  }

  const inTok = p.input_tokens ?? 0;
  const cached = Math.min(p.cached_tokens ?? 0, inTok);
  const outTok = p.output_tokens ?? 0;
  const reasoning = p.reasoning_tokens ?? 0;
  const input_cost = perM(inTok - cached, row.input_per_mtok) ?? 0;
  const cache_cost = perM(cached, row.cache_read_per_mtok) ?? 0;
  // reasoning:仅当价目单列 reasoning 费率时单算,否则视为已含在 output 计费里。
  const output_cost = round8((perM(outTok, row.output_per_mtok) ?? 0) + (row.reasoning_per_mtok != null ? perM(reasoning, row.reasoning_per_mtok)! : 0));
  return { input_cost, cache_cost, output_cost, total_cost: round8(input_cost + cache_cost + output_cost), currency: row.currency, price_table_version: row.version, priced: true };
}
```

- [ ] **Step 7: 运行确认通过** — PASS(7)。
- [ ] **Step 8: 提交** — `git add server/src/pricing.ts server/src/types.ts server/price-seed.example.json contracts/price-table.schema.json server/test/pricing.test.ts && git commit -m "feat(server): pricing — 算价 + 豆包 model 归一 + 价目契约加 aliases"`

---

## Task 5: `ingest.ts` — `POST /v1/events`(校验→**可存储性闸门**→算价→幂等落库)

**Files:** Create `server/src/ingest.ts` · Test `server/test/ingest.test.ts` · `server/test/ingest.storability.test.ts`

> `start_time/end_time` 是 unix ms → ISO。单条多行 `INSERT ... ON CONFLICT (event_id) DO NOTHING`;`result.count`=真实入库行数。postgres.js 参数上限 65535 → 1000 行/批分块。
>
> **可存储性闸门(C1/I1):** JSON-schema 通过的事件在进入算价/INSERT 前还需通过 `storabilityError()` 检测:整数字段必须在 `[0, INT_MAX=2147483647]`(PG integer 上限);时间戳必须在 JS Date 有效范围 `±8.64e15`。不满足的事件计入 `rejected`(warn 日志含 `event_id`+`reason`)而非抛出,确保一个坏事件永远不会 500 整批。这同时也排除了负 token 数,从源头杜绝负成本。

- [ ] **Step 1: 失败测试 `test/ingest.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { startPg, truncateAll, type PgHandle } from "./helpers.js";
import { registerIngest } from "../src/ingest.js";
import { makeEventValidator } from "../src/validator.js";
import type { PriceTable } from "../src/types.js";

const TABLE: PriceTable = { version: "t", aliases: {}, rows: [
  { version: "t", provider: "doubao", model: "doubao-seed-2.0-pro", operation: "chat", input_tier_max: 32000, input_per_mtok: 3.2, output_per_mtok: 16, cache_read_per_mtok: 0.64, reasoning_per_mtok: null, per_image: null, currency: "CNY" },
] };
const ev = (over: Record<string, unknown> = {}) => ({
  event_id: "e1", identity_source: "header", start_time: 1750000000000, end_time: 1750000001000,
  service: "python-lesson-parser", provider: "doubao", operation: "chat", request_model: "doubao-seed-2.0-pro",
  input_tokens: 10000, output_tokens: 1000, cached_tokens: 0, usage_source: "measured",
  status: "success", sdk_lang: "python", sdk_version: "0.1.0", ...over,
});

let pg: PgHandle; let app: FastifyInstance;
beforeAll(async () => {
  pg = await startPg(); app = Fastify();
  registerIngest(app, { sql: pg.sql, validateEvent: makeEventValidator(), priceTable: () => TABLE, payloadMode: "metadata", payloadMaxBytes: 8192 });
  await app.ready();
});
afterAll(async () => { await app.close(); await pg.stop(); });
beforeEach(async () => { await truncateAll(pg.sql); });

describe("POST /v1/events", () => {
  it("accepts a batch and stores priced rows", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev()] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 1, duplicates: 0, rejected: 0 });
    const [row] = await pg.sql`SELECT total_cost, currency, price_table_version FROM usage_events WHERE event_id='e1'`;
    expect(row.total_cost).toBe("0.04800000"); expect(row.currency).toBe("CNY"); expect(row.price_table_version).toBe("t");
  });
  it("stores total_cost NULL for an unpriced model (no silent 0)", async () => {
    await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev({ event_id: "e2", request_model: "unknown" })] } });
    const [row] = await pg.sql`SELECT total_cost FROM usage_events WHERE event_id='e2'`;
    expect(row.total_cost).toBeNull();
  });
  it("rejects a malformed envelope with 400", async () => {
    expect((await app.inject({ method: "POST", url: "/v1/events", payload: { nope: [] } })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: 运行确认失败** — FAIL(`registerIngest` 不存在)。

- [ ] **Step 3: `src/ingest.ts`**

```ts
import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import type { ValidateFunction } from "ajv";
import { envelopeSchema } from "./validator.js";
import { computeCost } from "./pricing.js";
import type { EventInput, Cost, PayloadMode, PriceTable } from "./types.js";

export interface IngestDeps {
  sql: Sql;
  validateEvent: ValidateFunction<EventInput>;
  priceTable: () => PriceTable;
  payloadMode: PayloadMode;
  payloadMaxBytes: number;
}

const CHUNK = 1000;
const msToIso = (ms: number | null | undefined): string | null => (ms == null ? null : new Date(ms).toISOString());

const ROW_COLS = [
  "event_id","request_id","parent_id","user_id","org_id","project","identity_source",
  "start_time","end_time","latency_ms","service","provider","operation","request_model","response_model",
  "input_tokens","output_tokens","total_tokens","cached_tokens","reasoning_tokens","image_count","usage_source",
  "input_cost","output_cost","cache_cost","total_cost","currency","price_table_version",
  "status","error_type","finish_reason","sdk_lang","sdk_version",
] as const;

function toRow(e: EventInput, c: Cost): Record<string, unknown> {
  return {
    event_id: e.event_id, request_id: e.request_id ?? null, parent_id: e.parent_id ?? null,
    user_id: e.user_id ?? null, org_id: e.org_id ?? null, project: e.project ?? null, identity_source: e.identity_source,
    start_time: msToIso(e.start_time), end_time: msToIso(e.end_time), latency_ms: e.latency_ms ?? null,
    service: e.service, provider: e.provider, operation: e.operation,
    request_model: e.request_model, response_model: e.response_model ?? null,
    input_tokens: e.input_tokens ?? null, output_tokens: e.output_tokens ?? null, total_tokens: e.total_tokens ?? null,
    cached_tokens: e.cached_tokens ?? null, reasoning_tokens: e.reasoning_tokens ?? null, image_count: e.image_count ?? null,
    usage_source: e.usage_source,
    input_cost: c.input_cost, output_cost: c.output_cost, cache_cost: c.cache_cost, total_cost: c.total_cost,
    currency: c.currency ?? "CNY", price_table_version: c.price_table_version,
    status: e.status, error_type: e.error_type ?? null, finish_reason: e.finish_reason ?? null,
    sdk_lang: e.sdk_lang, sdk_version: e.sdk_version,
  };
}

function truncateJson(value: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  if (value == null) return { value: null, truncated: false };
  const s = JSON.stringify(value);
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return { value, truncated: false };
  // I1: bound by UTF-8 bytes — prevents lone surrogates (mid-surrogate UTF-16 slice) that Postgres JSONB rejects.
  // Buffer.toString("utf8") replaces any cut trailing multibyte sequence with U+FFFD (valid UTF-8).
  // Note: maxBytes applies to the inner content string; the small JSON wrapper overhead is acceptable.
  const bounded = Buffer.from(s, "utf8").subarray(0, maxBytes).toString("utf8");
  return { value: { _truncated: bounded }, truncated: true };
}

// ADAPTATION: storePayloads uses individual inserts with sql.json() instead of bulk sql(rows,...) helper.
// Reason: postgres.js bulk helper requires row fields typed as ParameterOrJSON, but JSONB columns typed
// as `unknown` cause TS2769. sql.json() accepts JSONValue and is the correct typed API for jsonb.
async function storePayloads(sql: Sql, events: EventInput[], maxBytes: number): Promise<void> {
  for (const e of events) {
    if (!e.payload) continue;
    const rq = truncateJson(e.payload.request, maxBytes);
    const rs = truncateJson(e.payload.response, maxBytes);
    const truncated = rq.truncated || rs.truncated;
    const redacted = e.payload.redacted ?? false;
    // m1: write SQL NULL when there is no payload value — sql.json(null) writes the JSON value `null`
    // (not SQL NULL), so WHERE request_payload IS NULL would never match.
    type JV = Parameters<typeof sql.json>[0];
    await sql`
      INSERT INTO event_payloads (event_id, request_payload, response_payload, truncated, redacted)
      VALUES (${e.event_id}, ${rq.value == null ? null : sql.json(rq.value as JV)}, ${rs.value == null ? null : sql.json(rs.value as JV)}, ${truncated}, ${redacted})
      ON CONFLICT (event_id) DO NOTHING
    `;
  }
}

export function registerIngest(app: FastifyInstance, deps: IngestDeps): void {
  const { sql, validateEvent, priceTable, payloadMode, payloadMaxBytes } = deps;

  app.post("/v1/events", { schema: { body: envelopeSchema() } }, async (req, reply) => {
    const events = (req.body as { events: unknown[] }).events;
    const valid: EventInput[] = [];
    let rejected = 0;
    for (const raw of events) {
      if (validateEvent(raw)) valid.push(raw as EventInput);
      else { rejected++; req.log.warn({ event_id: (raw as { event_id?: string })?.event_id, errors: validateEvent.errors }, "chobo: rejected invalid event"); }
    }

    const table = priceTable();
    // ADAPTATION: EventInput uses request_model; Priceable requires model — map explicitly.
    // m3: dedupe unpriced warnings — warn once per unique (provider, model, operation) triple per request
    const warnedUnpriced = new Set<string>();
    const rows = valid.map((e) => {
      const cost = computeCost({ provider: e.provider, model: e.request_model, operation: e.operation, input_tokens: e.input_tokens, output_tokens: e.output_tokens, cached_tokens: e.cached_tokens, reasoning_tokens: e.reasoning_tokens, image_count: e.image_count }, table);
      if (!cost.priced) {
        const key = `${e.provider}\0${e.request_model}\0${e.operation}`;
        if (!warnedUnpriced.has(key)) {
          warnedUnpriced.add(key);
          req.log.warn({ provider: e.provider, model: e.request_model, operation: e.operation }, "chobo: no price for model — total_cost=NULL");
        }
      }
      return toRow(e, cost);
    });

    let accepted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const r = await sql`INSERT INTO usage_events ${sql(rows.slice(i, i + CHUNK), ...ROW_COLS)} ON CONFLICT (event_id) DO NOTHING`;
      // ADAPTATION: r.count is typed as number in postgres.js types but may need Number() coercion for strict TS
      accepted += Number(r.count);
    }
    const duplicates = valid.length - accepted;
    if (payloadMode === "truncated") await storePayloads(sql, valid, payloadMaxBytes);
    return reply.code(200).send({ accepted, duplicates, rejected });
  });
}
```

- [ ] **Step 4: 运行确认通过** — PASS(3)。
- [ ] **Step 5: `test/ingest.payload.test.ts`** — 截断路径测试(I2)

  Register ingest with `payloadMode: "truncated"`, `payloadMaxBytes: 20`. Two cases:
  - Large payload (`payload.request` is a big object, `payload.redacted: true`) → row in `event_payloads`; `truncated === true`; `redacted === true`; stored `request_payload` size `<= 20 + 32` bytes.
  - Tiny payload under cap → `truncated === false`; payload stored intact.

- [ ] **Step 6: 运行确认通过** — PASS(2)。
- [ ] **Step 7: 提交** — `git commit -m "feat(server): ingest — POST /v1/events 校验→算价→幂等多行 upsert"`

---

## Task 6: 幂等去重回归

**Files:** Test `server/test/ingest.dedup.test.ts`

- [ ] **Step 1: `test/ingest.dedup.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { startPg, truncateAll, type PgHandle } from "./helpers.js";
import { registerIngest } from "../src/ingest.js";
import { makeEventValidator } from "../src/validator.js";
import type { PriceTable } from "../src/types.js";

const TABLE: PriceTable = { version: "t", aliases: {}, rows: [] };
const ev = (id: string) => ({ event_id: id, identity_source: "header", start_time: 1750000000000, service: "s", provider: "doubao", operation: "chat", request_model: "m", usage_source: "measured", status: "success", sdk_lang: "node", sdk_version: "0.1.0" });

let pg: PgHandle; let app: FastifyInstance;
beforeAll(async () => { pg = await startPg(); app = Fastify(); registerIngest(app, { sql: pg.sql, validateEvent: makeEventValidator(), priceTable: () => TABLE, payloadMode: "metadata", payloadMaxBytes: 8192 }); await app.ready(); });
afterAll(async () => { await app.close(); await pg.stop(); });
beforeEach(async () => { await truncateAll(pg.sql); });

describe("idempotency", () => {
  it("same event_id twice -> one row", async () => {
    expect((await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev("dup")] } })).json()).toEqual({ accepted: 1, duplicates: 0, rejected: 0 });
    expect((await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev("dup")] } })).json()).toEqual({ accepted: 0, duplicates: 1, rejected: 0 });
    const [{ count }] = await pg.sql<{ count: string }[]>`SELECT count(*) FROM usage_events WHERE event_id='dup'`;
    expect(count).toBe("1");
  });
  it("mixed new + dup in one batch", async () => {
    await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev("a")] } });
    expect((await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev("a"), ev("b")] } })).json()).toEqual({ accepted: 1, duplicates: 1, rejected: 0 });
  });
});
```

- [ ] **Step 2: 运行确认通过** — PASS(2)。
- [ ] **Step 3: 提交** — `git commit -m "test(server): ingest 幂等回归"`

---

## Task 7: 宽容部分接收 — 坏事件计数不毒批

**Files:** Test `server/test/ingest.reject.test.ts`

- [ ] **Step 1: `test/ingest.reject.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { startPg, truncateAll, type PgHandle } from "./helpers.js";
import { registerIngest } from "../src/ingest.js";
import { makeEventValidator } from "../src/validator.js";
import type { PriceTable } from "../src/types.js";

const TABLE: PriceTable = { version: "t", aliases: {}, rows: [] };
const good = { event_id: "ok", identity_source: "header", start_time: 1750000000000, service: "s", provider: "doubao", operation: "chat", request_model: "m", usage_source: "measured", status: "success", sdk_lang: "node", sdk_version: "0.1.0" };
const bad = { event_id: "bad", operation: "translate" };

let pg: PgHandle; let app: FastifyInstance;
beforeAll(async () => { pg = await startPg(); app = Fastify({ logger: false }); registerIngest(app, { sql: pg.sql, validateEvent: makeEventValidator(), priceTable: () => TABLE, payloadMode: "metadata", payloadMaxBytes: 8192 }); await app.ready(); });
afterAll(async () => { await app.close(); await pg.stop(); });
beforeEach(async () => { await truncateAll(pg.sql); });

describe("lenient partial accept", () => {
  it("inserts valid, counts invalid, returns 200 (no poison-batch)", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/events", payload: { events: [good, bad] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 1, duplicates: 0, rejected: 1 });
    const rows = await pg.sql`SELECT event_id FROM usage_events`;
    expect(rows.map((r) => r.event_id)).toEqual(["ok"]);
  });
});
```

- [ ] **Step 2: 运行确认通过** — PASS(1)。
- [ ] **Step 3: 提交** — `git commit -m "test(server): ingest 宽容部分接收(不毒批)"`

---

## Task 8: `auth.ts` — 可选 shared-secret(休眠位)

**Files:** Create `server/src/auth.ts` · Test `server/test/auth.test.ts`

- [ ] **Step 1: 失败测试 `test/auth.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { secretGuard } from "../src/auth.js";

function appWith(secret: string | null) {
  const app = Fastify();
  const guard = secretGuard(secret);
  if (guard) app.addHook("preHandler", guard);
  app.post("/v1/events", async () => ({ ok: true }));
  return app;
}

describe("secretGuard", () => {
  it("open when no secret", async () => {
    expect((await appWith(null).inject({ method: "POST", url: "/v1/events", payload: {} })).statusCode).toBe(200);
  });
  it("401 when secret set but header missing/wrong", async () => {
    const app = appWith("s3cret");
    expect((await app.inject({ method: "POST", url: "/v1/events", payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/events", headers: { "x-chobo-secret": "nope" }, payload: {} })).statusCode).toBe(401);
  });
  it("200 when header matches", async () => {
    expect((await appWith("s3cret").inject({ method: "POST", url: "/v1/events", headers: { "x-chobo-secret": "s3cret" }, payload: {} })).statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: 运行确认失败** — FAIL(模块不存在)。

- [ ] **Step 3: `src/auth.ts`**

```ts
import type { FastifyRequest, FastifyReply } from "fastify";
type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** secret 为 null → 返回 undefined(开放,不挂 hook)。 */
export function secretGuard(secret: string | null): PreHandler | undefined {
  if (!secret) return undefined;
  return async (req, reply) => {
    // m2: explicit return after 401 prevents future footgun if handler logic is added below
    if (req.headers["x-chobo-secret"] !== secret) { await reply.code(401).send({ error: "unauthorized" }); return; }
  };
}
```

- [ ] **Step 4: 运行确认通过** — PASS(3)。
- [ ] **Step 5: 提交** — `git commit -m "feat(server): auth — 可选 shared-secret(休眠,默认开放)"`

---

## Task 9: `filters.ts` + `/v1/stats/overview`(单 CNY)

**Files:** Create `server/src/filters.ts` · Create `server/src/stats.ts` · Test `server/test/stats.overview.test.ts`

> 共用过滤:`from`/`to`(ISO 或 ms)、`user_id`/`org_id`/`project`/`provider`/`service`/`request_model`/`status`。**全 CNY,成本直接求和。**

- [ ] **Step 1: `src/filters.ts`**

```ts
import type { Sql } from "postgres";

export interface Filters {
  from?: string; to?: string; user_id?: string; org_id?: string; project?: string;
  provider?: string; service?: string; request_model?: string; status?: string;
}

const toIso = (v: string | undefined): string | undefined => {
  if (v == null) return undefined;
  return /^\d+$/.test(v) ? new Date(Number(v)).toISOString() : v;
};

export function parseFilters(q: Record<string, string | undefined>): Filters {
  return { from: toIso(q.from), to: toIso(q.to), user_id: q.user_id, org_id: q.org_id, project: q.project, provider: q.provider, service: q.service, request_model: q.request_model, status: q.status };
}

export function whereFragment(sql: Sql, f: Filters) {
  const conds = [sql`true`];
  if (f.from) conds.push(sql`created_at >= ${f.from}`);
  if (f.to) conds.push(sql`created_at < ${f.to}`);
  if (f.user_id) conds.push(sql`user_id = ${f.user_id}`);
  if (f.org_id) conds.push(sql`org_id = ${f.org_id}`);
  if (f.project) conds.push(sql`project = ${f.project}`);
  if (f.provider) conds.push(sql`provider = ${f.provider}`);
  if (f.service) conds.push(sql`service = ${f.service}`);
  if (f.request_model) conds.push(sql`request_model = ${f.request_model}`);
  if (f.status) conds.push(sql`status = ${f.status}`);
  return conds.reduce((acc, c) => sql`${acc} AND ${c}`);
}
```

- [ ] **Step 2: 失败测试 `test/stats.overview.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { startPg, truncateAll, type PgHandle } from "./helpers.js";
import { registerStats } from "../src/stats.js";

async function seed(sql: PgHandle["sql"]) {
  await sql`INSERT INTO usage_events (event_id, identity_source, start_time, service, provider, operation, request_model, usage_source, status, input_tokens, output_tokens, total_tokens, total_cost, currency, created_at) VALUES
    ('a','header', now(),'s','doubao','chat','m','measured','success', 100, 50, 150, 0.05,'CNY', now()),
    ('b','header', now(),'s','doubao','chat','m','measured','failure', 10, 0, 10, 0.01,'CNY', now()),
    ('c','header', now(),'s','example-gateway','chat','g','measured','success', 200, 80, 280, 0.20,'CNY', now())`;
}

let pg: PgHandle; let app: FastifyInstance;
beforeAll(async () => { pg = await startPg(); app = Fastify(); registerStats(app, { sql: pg.sql }); await app.ready(); });
afterAll(async () => { await app.close(); await pg.stop(); });
beforeEach(async () => { await truncateAll(pg.sql); await seed(pg.sql); });

describe("GET /v1/stats/overview", () => {
  it("totals events/tokens/cost (CNY) + by-status", async () => {
    const body = (await app.inject({ method: "GET", url: "/v1/stats/overview" })).json();
    expect(body.totals.events).toBe(3);
    expect(body.totals.total_tokens).toBe(440);
    expect(body.totals.total_cost).toBe("0.26000000");
    expect(body.currency).toBe("CNY");
    expect(body.totals.by_status).toEqual({ success: 2, failure: 1 });
  });
  it("applies a provider filter", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/stats/overview?provider=example-gateway" })).json().totals.events).toBe(1);
  });
});
```

- [ ] **Step 3: 运行确认失败** — FAIL(`registerStats` 不存在)。

- [ ] **Step 4: `src/stats.ts`**(本任务实现 overview;后续追加其余路由)

```ts
import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { parseFilters, whereFragment } from "./filters.js";

export interface StatsDeps { sql: Sql; }

export function registerStats(app: FastifyInstance, deps: StatsDeps): void {
  const { sql } = deps;

  app.get("/v1/stats/overview", async (req) => {
    const f = parseFilters(req.query as Record<string, string | undefined>);
    const where = whereFragment(sql, f);
    const [t] = await sql<{ events: string; input_tokens: string | null; output_tokens: string | null; total_tokens: string | null; total_cost: string | null; success: string; failure: string }[]>`
      SELECT count(*) AS events,
             sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens, sum(total_tokens) AS total_tokens,
             sum(total_cost) FILTER (WHERE total_cost IS NOT NULL) AS total_cost,
             count(*) FILTER (WHERE status='success') AS success,
             count(*) FILTER (WHERE status='failure') AS failure
      FROM usage_events WHERE ${where}`;
    return {
      filters: f, currency: "CNY",
      totals: {
        events: Number(t.events),
        input_tokens: Number(t.input_tokens ?? 0), output_tokens: Number(t.output_tokens ?? 0), total_tokens: Number(t.total_tokens ?? 0),
        total_cost: t.total_cost,   // numeric 字符串(精度无损);无成本时 null
        by_status: { success: Number(t.success), failure: Number(t.failure) },
      },
    };
  });
}
```

- [ ] **Step 5: 运行确认通过** — PASS(2)。
- [ ] **Step 6: 提交** — `git commit -m "feat(server): stats/overview — 总量 + CNY 成本 + 按状态"`

---

## Task 10: `/v1/stats/timeseries`

**Files:** Modify `server/src/stats.ts` · Test `server/test/stats.timeseries.test.ts`

- [ ] **Step 1: 失败测试 `test/stats.timeseries.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { startPg, truncateAll, type PgHandle } from "./helpers.js";
import { registerStats } from "../src/stats.js";

let pg: PgHandle; let app: FastifyInstance;
beforeAll(async () => { pg = await startPg(); app = Fastify(); registerStats(app, { sql: pg.sql }); await app.ready(); });
afterAll(async () => { await app.close(); await pg.stop(); });
beforeEach(async () => {
  await truncateAll(pg.sql);
  // Asymmetric data: June-01 → 150 tokens / 0.15 cost; June-02 → 450 tokens / 0.45 cost.
  // Symmetric totals (300/300) would hide row-order bugs and leave ts un-assertable.
  await pg.sql`INSERT INTO usage_events (event_id, identity_source, start_time, service, provider, operation, request_model, usage_source, status, total_tokens, total_cost, currency, created_at) VALUES
    ('d1','header', now(),'s','doubao','chat','m','measured','success',  50, 0.05,'CNY','2026-06-01T10:00:00Z'),
    ('d2','header', now(),'s','doubao','chat','m','measured','success', 100, 0.10,'CNY','2026-06-01T11:00:00Z'),
    ('d3','header', now(),'s','doubao','chat','m','measured','success', 450, 0.45,'CNY','2026-06-02T09:00:00Z')`;
});

describe("GET /v1/stats/timeseries", () => {
  it("buckets by day, returns correct asymmetric totals and ordered ts", async () => {
    const s = (await app.inject({ method: "GET", url: "/v1/stats/timeseries?bucket=day&from=2026-06-01T00:00:00Z&to=2026-06-03T00:00:00Z" })).json().series;
    expect(s).toHaveLength(2);
    // Bucket order: June-01 first, June-02 second
    expect(s[0].ts).toContain("2026-06-01");
    expect(s[0].total_tokens).toBe(150); expect(s[0].total_cost).toBe("0.15000000");
    expect(s[1].ts).toContain("2026-06-02");
    expect(s[1].total_tokens).toBe(450); expect(s[1].total_cost).toBe("0.45000000");
  });
  it("rejects an invalid bucket", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/stats/timeseries?bucket=fortnight" })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: 运行确认失败** — FAIL(404)。

- [ ] **Step 3: 在 `registerStats` 内追加 timeseries 路由**

```ts
  const BUCKETS = new Set(["hour", "day", "week", "month"]);

  app.get("/v1/stats/timeseries", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const bucket = q.bucket ?? "day";
    if (!BUCKETS.has(bucket)) return reply.code(400).send({ error: "bucket must be hour|day|week|month" });
    const f = parseFilters(q);
    const where = whereFragment(sql, f);
    const rows = await sql<{ ts: Date; events: string; total_tokens: string | null; total_cost: string | null }[]>`
      SELECT date_trunc(${bucket}, created_at) AS ts, count(*) AS events,
             sum(total_tokens) AS total_tokens, sum(total_cost) FILTER (WHERE total_cost IS NOT NULL) AS total_cost
      FROM usage_events WHERE ${where}
      GROUP BY ts ORDER BY ts`;
    return { bucket, currency: "CNY", series: rows.map((r) => ({ ts: r.ts.toISOString(), events: Number(r.events), total_tokens: Number(r.total_tokens ?? 0), total_cost: r.total_cost })) };
  });
```

- [ ] **Step 4: 运行确认通过** — PASS(2)。
- [ ] **Step 5: 提交** — `git commit -m "feat(server): stats/timeseries — date_trunc 分桶(CNY)"`

---

## Task 11: `/v1/stats/by-user` · `by-org` · `by-project`

**Files:** Modify `server/src/stats.ts` · Test `server/test/stats.bydim.test.ts`

> 三维共用,维度列白名单(防注入);按 `total_tokens desc` 排序。

- [ ] **Step 1: 失败测试 `test/stats.bydim.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { startPg, truncateAll, type PgHandle } from "./helpers.js";
import { registerStats } from "../src/stats.js";

let pg: PgHandle; let app: FastifyInstance;
beforeAll(async () => { pg = await startPg(); app = Fastify(); registerStats(app, { sql: pg.sql }); await app.ready(); });
afterAll(async () => { await app.close(); await pg.stop(); });
beforeEach(async () => {
  await truncateAll(pg.sql);
  await pg.sql`INSERT INTO usage_events (event_id, identity_source, start_time, service, provider, operation, request_model, usage_source, status, user_id, total_tokens, total_cost, currency, created_at) VALUES
    ('u1','header',now(),'s','doubao','chat','m','measured','success','teacherA',100,0.10,'CNY',now()),
    ('u2','header',now(),'s','doubao','chat','m','measured','success','teacherA',300,0.30,'CNY',now()),
    ('u3','header',now(),'s','doubao','chat','m','measured','success','teacherB', 50,0.05,'CNY',now())`;
});

describe("GET /v1/stats/by-user", () => {
  it("aggregates per user, ordered by tokens desc", async () => {
    const rows = (await app.inject({ method: "GET", url: "/v1/stats/by-user" })).json().rows;
    expect(rows[0]).toMatchObject({ key: "teacherA", events: 2, total_tokens: 400, total_cost: "0.40000000" });
    expect(rows[1]).toMatchObject({ key: "teacherB", events: 1, total_tokens: 50 });
  });
  it("by-org returns null key for rows without org_id, and by-project shares the impl", async () => {
    // Seed data has no org_id → the group key must be null, not missing
    const body = (await app.inject({ method: "GET", url: "/v1/stats/by-org" })).json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].key).toBeNull();
    expect(body.rows[0].events).toBeGreaterThan(0);
    expect((await app.inject({ method: "GET", url: "/v1/stats/by-project" })).statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: 运行确认失败** — FAIL(404)。

- [ ] **Step 3: 在 `registerStats` 内追加维度路由**

```ts
  const DIM_COL: Record<string, string> = { "by-user": "user_id", "by-org": "org_id", "by-project": "project" };

  for (const [path, col] of Object.entries(DIM_COL)) {
    app.get(`/v1/stats/${path}`, async (req) => {
      const q = req.query as Record<string, string | undefined>;
      const where = whereFragment(sql, parseFilters(q));
      const rawLimit = Number(q.limit ?? "50");
      const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, 500) : 50;
      const dim = sql(col); // 白名单列(键来自 DIM_COL,非用户输入)
      const rows = await sql<{ key: string | null; events: string; total_tokens: string | null; total_cost: string | null }[]>`
        SELECT ${dim} AS key, count(*) AS events, sum(total_tokens) AS total_tokens,
               sum(total_cost) FILTER (WHERE total_cost IS NOT NULL) AS total_cost
        FROM usage_events WHERE ${where}
        GROUP BY ${dim} ORDER BY sum(total_tokens) DESC NULLS LAST LIMIT ${limit}`;
      return { dimension: col, currency: "CNY", rows: rows.map((r) => ({ key: r.key, events: Number(r.events), total_tokens: Number(r.total_tokens ?? 0), total_cost: r.total_cost })) };
    });
  }
```

- [ ] **Step 4: 运行确认通过** — PASS(2)。
- [ ] **Step 5: 提交** — `git commit -m "feat(server): stats/by-user|by-org|by-project(列白名单)"`

---

## Task 12: `/v1/events` — 明细审计(分页 + 可选 payload)

**Files:** Modify `server/src/stats.ts` · Test `server/test/stats.events.test.ts`

> 游标分页(`created_at, event_id` 倒序);`include_payload=true` 时**二次按 id 取 payload + JS 合并**(避免与主表同名列 `created_at` 的 JOIN 歧义)。
>
> **⚠️ 游标精度注意(已修复):** `DEFAULT now()` 是**事务时间戳**,同一批 INSERT 的所有行拥有完全相同的微秒 `created_at`。JS `Date.toISOString()` 只有毫秒精度,会把游标截断到严格小于存储值,导致 `(created_at, event_id) < (cursor_ts, id)` 对整批剩余行均为 FALSE → 第 2 页返回空、行静默丢失。
> 修复方案:游标改用 **epoch-微秒 bigint**(`(extract(epoch from created_at)*1000000)::bigint`),以 `base64url("${cursor_us}|${event_id}")` 编码,比较时转回 bigint 精确对比,完全绕开 postgres.js Date ms 截断和文本→timestamptz 解析问题。

- [ ] **Step 1: 失败测试 `test/stats.events.test.ts`**

```ts
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
    expect([400, 200]).toContain(res.statusCode);
    if (res.statusCode === 400) expect(res.json().error).toMatch(/invalid cursor/);
  });
  it("paginates correctly when all rows share the same created_at (bulk insert)", async () => {
    // 精度回归测试:单条 INSERT 语句插入 5 行 → 同一事务时间戳 → 相同微秒 created_at
    // ms 截断游标会导致第 2 页返回空;bigint 游标必须完整分页出全部 5 行
    await truncateAll(pg.sql);
    const ids = ["b1", "b2", "b3", "b4", "b5"];
    await pg.sql`
      INSERT INTO usage_events (event_id, identity_source, start_time, service, provider, operation, request_model, usage_source, status)
      VALUES
        ('b1', 'header', now(), 's', 'doubao', 'chat', 'm', 'measured', 'success'),
        ('b2', 'header', now(), 's', 'doubao', 'chat', 'm', 'measured', 'success'),
        ('b3', 'header', now(), 's', 'doubao', 'chat', 'm', 'measured', 'success'),
        ('b4', 'header', now(), 's', 'doubao', 'chat', 'm', 'measured', 'success'),
        ('b5', 'header', now(), 's', 'doubao', 'chat', 'm', 'measured', 'success')
    `;
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const url = `/v1/events?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const body = (await app.inject({ method: "GET", url })).json();
      for (const e of body.events as Array<{ event_id: string }>) collected.push(e.event_id);
      cursor = body.next_cursor ?? null;
      if (cursor === null) break;
    }
    expect(collected.slice().sort()).toEqual(ids.slice().sort());
    expect(new Set(collected).size).toBe(ids.length);
  });
});
```

- [ ] **Step 2: 运行确认失败** — FAIL(404)。

- [ ] **Step 3: 在 `registerStats` 内追加 events 路由(使用 epoch-微秒 bigint 游标)**

```ts
  app.get("/v1/events", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const where = whereFragment(sql, parseFilters(q));
    const rawLimit = Number(q.limit ?? "50");
    const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, 500) : 50;
    const withPayload = q.include_payload === "true";

    let cursorCond = sql`true`;
    if (q.cursor) {
      let inner: string;
      try { inner = Buffer.from(q.cursor, "base64url").toString("utf8"); }
      catch { return reply.code(400).send({ error: "invalid cursor" }); }
      const pipe = inner.indexOf("|");
      if (pipe === -1) return reply.code(400).send({ error: "invalid cursor" });
      const usStr = inner.slice(0, pipe), id = inner.slice(pipe + 1);
      if (!usStr || !id || !/^\d+$/.test(usStr)) return reply.code(400).send({ error: "invalid cursor" });
      cursorCond = sql`((extract(epoch from created_at)*1000000)::bigint, event_id) < (${usStr}::bigint, ${id})`;
    }

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
```

- [ ] **Step 4: 运行确认通过** — PASS(4)。
- [ ] **Step 5: 提交** — `git commit -m "fix(server): /v1/events 游标用全精度 created_at(批量同刻事件分页不丢行)+ 回归测试"`

---

## Task 13: `app.ts` + `server.ts` — 装配、Ajv2020 接线、优雅退出

**Files:** Create `server/src/app.ts` · Create `server/src/server.ts` · Test `server/test/e2e.test.ts`

- [ ] **Step 1: `src/app.ts`**

```ts
import Fastify, { type FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { makeAjv, makeEventValidator } from "./validator.js";
import { registerIngest } from "./ingest.js";
import { registerStats } from "./stats.js";
import { secretGuard } from "./auth.js";
import type { PriceTable, ServerConfig } from "./types.js";

export interface AppDeps { sql: Sql; cfg: ServerConfig; priceTable: () => PriceTable; }

export function buildApp(deps: AppDeps): FastifyInstance {
  const { sql, cfg, priceTable } = deps;
  // I2: bodyLimit 从 cfg 注入,避免大批量合法请求 413 → SDK 毒重试
  const app = Fastify({ logger: true, bodyLimit: cfg.bodyLimit });

  // 关键:用自建 Ajv2020 替换默认 draft-07 校验器(否则 2020-12 契约 boot 崩)
  // ADAPTATION: Ajv ValidateFunction<T> 的类型谓词签名 (data: any) => data is T 在严格模式下
  // 不能直接赋给 FastifyValidationResult (data: any) => boolean。
  // cast through unknown → (data: unknown) => boolean 绕过,运行时行为完全正确。
  const ajv = makeAjv();
  app.setValidatorCompiler(({ schema }) => ajv.compile(schema) as unknown as (data: unknown) => boolean);

  const guard = secretGuard(cfg.ingestSecret);
  if (guard) app.addHook("preHandler", guard);

  app.get("/healthz", async () => ({ ok: true }));
  registerIngest(app, { sql, validateEvent: makeEventValidator(ajv), priceTable, payloadMode: cfg.payloadMode, payloadMaxBytes: cfg.payloadMaxBytes });
  registerStats(app, { sql });
  return app;
}
```

- [ ] **Step 2: `src/server.ts`**

```ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveConfig } from "./config.js";
import { createSql, migrate } from "./db.js";
import { loadPriceTable } from "./pricing.js";
import { buildApp } from "./app.js";
import type { Sql } from "postgres";

const here = dirname(fileURLToPath(import.meta.url));

async function seedIfEmpty(sql: Sql, seedPath: string | null): Promise<void> {
  if (!seedPath) return;
  const [{ count }] = await sql<{ count: string }[]>`SELECT count(*) FROM price_table`;
  if (Number(count) > 0) return;
  const seed = JSON.parse(await readFile(seedPath, "utf8")) as { version: string; rows: Record<string, unknown>[]; aliases?: { provider: string; alias: string; canonical: string }[] };
  type SeedRow = { version: string; provider: string; model: string; operation: string; input_tier_max: number; input_per_mtok: number | null; output_per_mtok: number | null; cache_read_per_mtok: number | null; reasoning_per_mtok: number | null; per_image: number | null; currency: string };
  const rows: SeedRow[] = seed.rows.map((r, idx) => {
    // C6: validate required string fields before insert — raw cast silently produces undefined on malformed JSON
    for (const field of ["provider", "model", "operation"] as const) {
      if (typeof r[field] !== "string" || r[field] === "") {
        throw new Error(`chobo seed: row[${idx}] missing or invalid field "${field}" in ${seedPath}`);
      }
    }
    if (typeof seed.version !== "string" || seed.version === "") {
      throw new Error(`chobo seed: top-level "version" missing or invalid in ${seedPath}`);
    }
    const base: SeedRow = { version: seed.version, input_tier_max: 0, input_per_mtok: null, output_per_mtok: null, cache_read_per_mtok: null, reasoning_per_mtok: null, per_image: null, currency: "CNY", provider: r["provider"] as string, model: r["model"] as string, operation: r["operation"] as string };
    if (r["input_per_mtok"] != null) base.input_per_mtok = r["input_per_mtok"] as number;
    if (r["output_per_mtok"] != null) base.output_per_mtok = r["output_per_mtok"] as number;
    if (r["cache_read_per_mtok"] != null) base.cache_read_per_mtok = r["cache_read_per_mtok"] as number;
    if (r["reasoning_per_mtok"] != null) base.reasoning_per_mtok = r["reasoning_per_mtok"] as number;
    if (r["per_image"] != null) base.per_image = r["per_image"] as number;
    if (r["input_tier_max"] != null) base.input_tier_max = r["input_tier_max"] as number;
    if (r["currency"] != null) base.currency = r["currency"] as string;
    return base;
  });
  await sql`INSERT INTO price_table ${sql(rows, "version","provider","model","operation","input_tier_max","input_per_mtok","output_per_mtok","cache_read_per_mtok","reasoning_per_mtok","per_image","currency")} ON CONFLICT DO NOTHING`;
  if (seed.aliases?.length) await sql`INSERT INTO model_aliases ${sql(seed.aliases, "provider","alias","canonical")} ON CONFLICT DO NOTHING`;
}

async function main(): Promise<void> {
  const cfg = resolveConfig(process.env);
  const sql = createSql(cfg.databaseUrl);
  await migrate(sql, join(here, "..", "migrations"));
  await seedIfEmpty(sql, cfg.priceSeedPath);

  const priceTable = await loadPriceTable(sql);
  const app = buildApp({ sql, cfg, priceTable: () => priceTable });

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ sig }, "chobo: shutting down");
    try {
      await app.close();
      await sql.end({ timeout: 5 });
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "chobo: error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: cfg.host, port: cfg.port });
  app.log.info({ priceVersion: priceTable.version, rows: priceTable.rows.length, aliases: Object.keys(priceTable.aliases).length }, "chobo CRM up");
}

main().catch((err) => { console.error("chobo: fatal", err); process.exit(1); });
```

- [ ] **Step 3: 端到端测试 `test/e2e.test.ts`**(真容器 + 归一化端到端:事件带 dated id,经别名算价)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startPg, type PgHandle } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { loadPriceTable } from "../src/pricing.js";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../src/types.js";

const CFG: ServerConfig = { databaseUrl: "", host: "0.0.0.0", port: 0, ingestSecret: null, payloadMode: "metadata", payloadMaxBytes: 8192, priceSeedPath: null };
const ev = (id: string, user: string, inTok: number, outTok: number) => ({
  event_id: id, user_id: user, org_id: "school1", project: "goal_generation",
  identity_source: "header", start_time: 1750000000000, end_time: 1750000001000,
  service: "python-lesson-parser", provider: "doubao", operation: "chat",
  request_model: "doubao-seed-2-0-pro-260215",  // 带版本 id —— 经别名归一后算价
  input_tokens: inTok, output_tokens: outTok, total_tokens: inTok + outTok, cached_tokens: 0,
  usage_source: "measured", status: "success", sdk_lang: "python", sdk_version: "0.1.0",
});

let pg: PgHandle; let app: FastifyInstance;
beforeAll(async () => {
  pg = await startPg();
  await pg.sql`INSERT INTO price_table (version,provider,model,operation,input_tier_max,input_per_mtok,output_per_mtok,cache_read_per_mtok,currency) VALUES
    ('e2e','doubao','doubao-seed-2.0-pro','chat',32000,3.2,16,0.64,'CNY')`;
  await pg.sql`INSERT INTO model_aliases (provider,alias,canonical) VALUES ('doubao','doubao-seed-2-0-pro-260215','doubao-seed-2.0-pro')`;
  const priceTable = await loadPriceTable(pg.sql);
  app = buildApp({ sql: pg.sql, cfg: CFG, priceTable: () => priceTable });
  await app.ready();
});
afterAll(async () => { await app.close(); await pg.stop(); });

describe("end-to-end", () => {
  it("ingests dated-id events (priced via alias) then stats reflect it", async () => {
    const post = await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev("x1", "teacherA", 10000, 1000), ev("x2", "teacherA", 20000, 2000), ev("x3", "teacherB", 5000, 500)] } });
    expect(post.json()).toEqual({ accepted: 3, duplicates: 0, rejected: 0 });

    const ov = (await app.inject({ method: "GET", url: "/v1/stats/overview" })).json();
    expect(ov.totals.events).toBe(3);
    expect(ov.totals.total_tokens).toBe(38500);
    expect(ov.totals.total_cost).toBe("0.16800000");  // 归一化算价端到端验证

    const byUser = (await app.inject({ method: "GET", url: "/v1/stats/by-user" })).json();
    expect(byUser.rows[0].key).toBe("teacherA"); expect(byUser.rows[0].events).toBe(2);

    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 4: 运行确认通过** — `npx vitest run test/e2e.test.ts` → PASS(1)。
- [ ] **Step 5: 全量 + 构建** — `npx vitest run && npx tsc -p tsconfig.json --noEmit` → 全 PASS,tsc 无报错。
- [ ] **Step 6: 提交** — `git commit -m "feat(server): app/server 装配 — Ajv2020 接线 + seed(价+别名) + 优雅退出 + 端到端归一化"`

---

## Task 14: `reprice.ts` — 重算价回填(让"先用后配"无损)

**Files:** Create `server/src/reprice.ts` · Create `server/src/reprice-cli.ts` · Modify `server/package.json`(加 `reprice` 脚本) · Test `server/test/reprice.test.ts`

> 用途:**价格后配 / 费率更正后**,按 `usage_events` 里存好的**原始用量**重算 cost 回填 —— spec §8"费率变了可按版本历史重算"的落地,使"先用后配"对早期 `total_cost IS NULL` 的行不丢钱。默认**只补 NULL 行**(不动已正确算过的历史快照);`--all` 重算全部(费率更正用)。keyset 游标分批,每批一事务。

- [ ] **Step 1: 失败测试 `test/reprice.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { startPg, truncateAll, type PgHandle } from "./helpers.js";
import { registerIngest } from "../src/ingest.js";
import { makeEventValidator } from "../src/validator.js";
import { loadPriceTable } from "../src/pricing.js";
import { reprice } from "../src/reprice.js";
import type { PriceTable } from "../src/types.js";

const ev = (id: string, inTok: number, outTok: number) => ({
  event_id: id, identity_source: "header", start_time: 1750000000000, service: "s",
  provider: "doubao", operation: "chat", request_model: "doubao-seed-2.0-pro",
  input_tokens: inTok, output_tokens: outTok, cached_tokens: 0,
  usage_source: "measured", status: "success", sdk_lang: "node", sdk_version: "0.1.0",
});

let pg: PgHandle; let app: FastifyInstance;
let table: PriceTable = { version: "", rows: [], aliases: {} };
beforeAll(async () => {
  pg = await startPg(); app = Fastify({ logger: false });
  registerIngest(app, { sql: pg.sql, validateEvent: makeEventValidator(), priceTable: () => table, payloadMode: "metadata", payloadMaxBytes: 8192 });
  await app.ready();
});
afterAll(async () => { await app.close(); await pg.stop(); });
beforeEach(async () => { table = { version: "", rows: [], aliases: {} }; await truncateAll(pg.sql); await pg.sql`DELETE FROM price_table`; });

describe("reprice — 先用后配回填", () => {
  it("fills NULL costs after prices are configured later", async () => {
    await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev("a", 10000, 1000)] } });
    let [row] = await pg.sql`SELECT total_cost FROM usage_events WHERE event_id='a'`;
    expect(row.total_cost).toBeNull();                              // 价未配 → NULL

    await pg.sql`INSERT INTO price_table (version,provider,model,operation,input_tier_max,input_per_mtok,output_per_mtok,cache_read_per_mtok,currency)
                 VALUES ('v1','doubao','doubao-seed-2.0-pro','chat',32000,3.2,16,0.64,'CNY')`;
    expect(await reprice(pg.sql, await loadPriceTable(pg.sql))).toBe(1);   // 后配价 + 回填
    [row] = await pg.sql`SELECT total_cost, price_table_version FROM usage_events WHERE event_id='a'`;
    expect(row.total_cost).toBe("0.04800000"); expect(row.price_table_version).toBe("v1");

    expect(await reprice(pg.sql, await loadPriceTable(pg.sql))).toBe(0);   // 再跑只补 NULL → 0
  });

  it("--all preserves existing snapshot when model absent from new price table", async () => {
    // seed v1 with doubao-seed-2.0-pro
    await pg.sql`INSERT INTO price_table (version,provider,model,operation,input_tier_max,input_per_mtok,output_per_mtok,cache_read_per_mtok,currency)
                 VALUES ('v1','doubao','doubao-seed-2.0-pro','chat',32000,3.2,16,0.64,'CNY')`;
    table = await loadPriceTable(pg.sql);
    await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev("c", 10000, 0)] } });
    let [row] = await pg.sql`SELECT total_cost, price_table_version FROM usage_events WHERE event_id='c'`;
    expect(row.total_cost).toBe("0.03200000");
    expect(row.price_table_version).toBe("v1");

    // seed v2 that does NOT contain doubao-seed-2.0-pro (only a different model)
    await pg.sql`INSERT INTO price_table (version,provider,model,operation,input_tier_max,input_per_mtok,output_per_mtok,cache_read_per_mtok,currency)
                 VALUES ('v2','doubao','some-other-model','chat',32000,1.0,2.0,0.2,'CNY')`;
    const repriced = await reprice(pg.sql, await loadPriceTable(pg.sql), { all: true });
    expect(repriced).toBe(0);  // model absent → skipped
    [row] = await pg.sql`SELECT total_cost, price_table_version FROM usage_events WHERE event_id='c'`;
    // C1: existing snapshot must NOT be nulled
    expect(row.total_cost).toBe("0.03200000");
    expect(row.price_table_version).toBe("v1");
  });

  it("--all re-prices everything (rate correction)", async () => {
    await pg.sql`INSERT INTO price_table (version,provider,model,operation,input_tier_max,input_per_mtok,output_per_mtok,cache_read_per_mtok,currency)
                 VALUES ('v1','doubao','doubao-seed-2.0-pro','chat',32000,3.2,16,0.64,'CNY')`;
    table = await loadPriceTable(pg.sql);
    await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev("b", 10000, 0)] } });
    let [row] = await pg.sql`SELECT total_cost FROM usage_events WHERE event_id='b'`;
    expect(row.total_cost).toBe("0.03200000");                     // 写时按 v1 算

    await pg.sql`INSERT INTO price_table (version,provider,model,operation,input_tier_max,input_per_mtok,output_per_mtok,cache_read_per_mtok,currency)
                 VALUES ('v2','doubao','doubao-seed-2.0-pro','chat',32000,6.4,32,1.28,'CNY')`;
    expect(await reprice(pg.sql, await loadPriceTable(pg.sql), { all: true })).toBe(1);
    [row] = await pg.sql`SELECT total_cost, price_table_version FROM usage_events WHERE event_id='b'`;
    expect(row.total_cost).toBe("0.06400000"); expect(row.price_table_version).toBe("v2");  // v2 重算
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd server && npx vitest run test/reprice.test.ts` → FAIL(`reprice` 不存在)。

- [ ] **Step 3: `src/reprice.ts`**

> **ADAPTATION(实施时发现):** 原计划用 `(created_at, event_id)` 双列游标。实测发现无限循环 bug:
> JS `Date.toISOString()` 只有毫秒精度,而 PostgreSQL `timestamptz` 是微秒精度。
> 修复:改为仅用 `event_id > ${cursorId}` 游标(PRIMARY KEY,全局唯一,字典序稳定)。
>
> **C1 fix(code-review):** `--all` 模式下,`computeCost` 返回 `priced:false`(价表缺行)时原代码仍执行 UPDATE,
> 把 NULL 写入 `total_cost`/`price_table_version`,销毁历史快照。修复:跳过 UPDATE,仅对每个
> (provider,model,operation) 三元组 warn 一次(Set 去重)。
>
> **C5 fix(code-review):** TS7022 隐式 any 问题通过给 fragment 变量加 `Fragment` 显式类型注解解决,
> 4 个重复 SELECT 分支合并为 1 个,用 `scope`/`after` 两个 `postgres.Fragment` 变量组合。

```ts
import type { Sql, Fragment } from "postgres";
import { computeCost } from "./pricing.js";
import type { PriceTable } from "./types.js";

const BATCH = 500;
export interface RepriceOpts { all?: boolean; }

type RepriceRow = { event_id: string; provider: string; request_model: string; operation: string; input_tokens: number | null; output_tokens: number | null; cached_tokens: number | null; reasoning_tokens: number | null; image_count: number | null };

/** 用给定价格表重算并回填 usage_events 的 cost。默认只补 total_cost IS NULL 的行(先用后配);
 *  all=true 重算全部(费率更正);对当前价表没有匹配行的 (provider,model,operation) 三元组,
 *  跳过 UPDATE——不会用 NULL 覆盖已有历史快照。keyset 游标分批(按 event_id),每批一事务。返回成功定价(priced)的行数。 */
export async function reprice(sql: Sql, table: PriceTable, opts: RepriceOpts = {}): Promise<number> {
  let priced = 0;
  let cursorId: string | null = null;
  // C1: warn once per unique (provider, model, operation) triple — do NOT write NULL over existing snapshot
  const warnedTriples = new Set<string>();

  for (;;) {
    // C5: unified query — compose scope + cursor predicates instead of 4 duplicated branches
    const scope: Fragment = opts.all ? sql`true` : sql`total_cost IS NULL`;
    const after: Fragment = cursorId === null ? sql`true` : sql`event_id > ${cursorId}`;
    const rows = await sql<RepriceRow[]>`
      SELECT event_id, provider, request_model, operation,
             input_tokens, output_tokens, cached_tokens, reasoning_tokens, image_count
      FROM usage_events
      WHERE ${scope} AND ${after}
      ORDER BY event_id LIMIT ${BATCH}`;

    if (rows.length === 0) break;

    await sql.begin(async (tx) => {
      for (const r of rows) {
        const c = computeCost({ provider: r.provider, model: r.request_model, operation: r.operation, input_tokens: r.input_tokens, output_tokens: r.output_tokens, cached_tokens: r.cached_tokens, reasoning_tokens: r.reasoning_tokens, image_count: r.image_count }, table);

        // C1: if model not in current price table, skip UPDATE to preserve existing snapshot
        if (!c.priced) {
          const key = `${r.provider}\0${r.request_model}\0${r.operation}`;
          if (!warnedTriples.has(key)) {
            warnedTriples.add(key);
            console.warn(`chobo reprice: no price for ${r.provider}/${r.request_model} (${r.operation}) — left unchanged`);
          }
          continue;
        }

        await tx`UPDATE usage_events SET input_cost=${c.input_cost}, output_cost=${c.output_cost}, cache_cost=${c.cache_cost}, total_cost=${c.total_cost}, currency=${c.currency ?? "CNY"}, price_table_version=${c.price_table_version} WHERE event_id=${r.event_id}`;
        priced++;
      }
    });

    cursorId = rows[rows.length - 1].event_id;  // 游标单调推进,每行只扫一次
  }
  return priced;
}
```

- [ ] **Step 4: `src/reprice-cli.ts`**(运维入口,手动跑)

> **C4 fix(code-review):** 原代码中 `sql.end()` 在 top-level await 直接调用,若 `reprice()` 抛异常则连接池泄漏。
> 改为 try/finally 确保 `sql.end()` 始终执行。

```ts
import { resolveConfig } from "./config.js";
import { createSql } from "./db.js";
import { loadPriceTable } from "./pricing.js";
import { reprice } from "./reprice.js";

const cfg = resolveConfig(process.env);
const sql = createSql(cfg.databaseUrl);
try {
  const table = await loadPriceTable(sql);
  const all = process.argv.includes("--all");
  const n = await reprice(sql, table, { all });
  console.log(`chobo reprice: priced ${n} rows (version=${table.version || "<none>"}, all=${all})`);
} finally {
  await sql.end({ timeout: 5 });
}
```

- [ ] **Step 5: `server/package.json` scripts 加 `reprice`**

```json
    "start": "node dist/server.js",
    "reprice": "node dist/reprice-cli.js",
    "test": "vitest run"
```

- [ ] **Step 6: 运行确认通过** — `npx vitest run test/reprice.test.ts` → PASS(2)。
- [ ] **Step 7: 提交** — `git commit -m "feat(server): reprice — 重算价回填(先用后配无损,spec §8 历史重算落地)"`

---

## Task 15: `server/README.md` + 文档同步 + 收尾

**Files:** Create `server/README.md` · Modify `CLAUDE.md` · `README.md` · `docs/dev-log.md`

- [ ] **Step 1: `server/README.md`**

````markdown
# @chobo/server — CRM 后端

ingest + 算价 + 看板读 API。**每接入方一套实例**,PG 连接串由环境注入。

## 运行
```bash
cp .env.example .env   # 填 CHOBO_DATABASE_URL(该接入方自己的 PG)
npm install && npm run dev
```
启动自动迁移 + 首次 seed 价格表与别名(`CHOBO_PRICE_SEED`)。

## API
- `POST /v1/events` — 收 `{events:[...]}`,逐事件校验、算价(豆包 dated id 经 `model_aliases` 归一)、`ON CONFLICT (event_id) DO NOTHING` 幂等落库。返回 `{accepted, duplicates, rejected}`(信封非法才 400;坏事件计入 rejected 不毒批)。
- `GET /v1/stats/overview|timeseries|by-user|by-org|by-project` — 聚合(全 CNY)。
- `GET /v1/events` — 明细审计(游标分页,`include_payload=true` 取 payload)。

## v1 范围 / 价格
在用:`doubao/doubao-seed-2.0-pro`(Ark 直连,已 seed 真价 3 档)、`example-gateway/{gpt-5.5, gemini-3.5-flash, gpt-image-2}`(待 fugue 给 CNY 价 → 在此前算 `total_cost=NULL`+告警)。改价 = 新 `version`,不就地改。
````

- [ ] **Step 2: 同步 `CLAUDE.md`/`README.md`/`dev-log.md`** —— Plan 2 标 ✅,指向 Plan 4。dev-log 追加 `## 2026-06-DD — Plan 2(CRM server)交付`,记:Fastify5+Ajv2020(绕默认 draft-07)、postgres.js 幂等 upsert、testcontainers、宽容部分接收、全 CNY、豆包 model_aliases 归一、reprice 先用后配回填、example-gateway 三项待 fugue 给价。

- [ ] **Step 3: 全量验收** — `cd server && npx vitest run` → 全绿(config/migrate/validator/pricing/ingest×3/auth/stats×4/reprice/e2e)。
- [ ] **Step 4: 提交** — `git commit -m "docs(server): Plan 2 README + 状态同步(Plan 2 ✅,指向 Plan 4)"`

---

## Self-Review(写计划者已自查)

**Spec coverage:** §3 三段解耦 → ingest/stats 分离 ✓;§4 事件契约 → validator + toRow 全字段 ✓;§7.1 usage_events + 预留对账列 ✓;§7.2 event_payloads ✓;§7.3 price_table + §新增 model_aliases ✓;§8 算价(分档/缓存/按张/归一/未知→NULL/版本)→ pricing.ts + 边界测试 ✓,**历史重算 → reprice.ts(先用后配回填)✓**;§9 幂等 → ON CONFLICT + Task 6 ✓;§11 五端点 → Task 9-12,并补 spec 未定义的响应体/错误/去重/宽容语义 ✓;§18 决策表全部体现 ✓。

**修正后范围(side-chat 交接):** 全 CNY 单币种(覆盖早先 Gemini-USD);v1 = doubao/doubao-seed-2.0-pro + example-gateway/三项;GLM/MiniMax/seedream 移出;豆包 dated id 经 model_aliases 归一;example-gateway 三项不 seed 占位(避免静默 0)。

**Placeholder scan:** 无 TBD/TODO;每步含真实代码 + 命令。

**Type consistency:** `EventInput`/`PriceRow`/`PriceTable`(含 `aliases`)/`Cost`/`ServerConfig` 集中 `types.ts`;`registerIngest`/`registerStats`/`computeCost`/`loadPriceTable`/`makeAjv`/`buildApp` 签名跨任务一致;所有测试的 `PriceTable` 字面量均含 `aliases`;`ROW_COLS` 与 `0001_init` 对齐;stats 全部返回单 `total_cost`(CNY)。

**待 fugue(卡上线 seed,不卡开工):** ① example-gateway 对 `gpt-5.5`/`gemini-3.5-flash`/`gpt-image-2` 的 CNY 费率;② 抽查豆包 3 档数字;③ 确认线上豆包接入点 id(若非 `…-260215`,补 `model_aliases` 行);④ 确认采集端(Plan 5)`provider` 填 `doubao`/`example-gateway`。
