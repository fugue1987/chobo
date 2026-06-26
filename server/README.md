# @chobo/server — CRM 后端

ingest + 算价 + 看板读 API。**每接入方一套实例**,PG 连接串由环境注入。

## 技术栈

- Node 20 LTS · ESM · TypeScript
- Fastify 5.8.5 + 自定义 Ajv2020(默认 Ajv 是 draft-07,遇 2020-12 契约 boot 崩,故显式挂载)
- postgres.js 3.4.9(零依赖 PG 驱动)
- 迁移:纯 `.sql` 文件 + 启动期 runner(`pg_advisory_lock` on a `reserve()`-pinned connection)
- 测试:vitest + @testcontainers/postgresql(真实 PG,不用 pg-mem)

## 运行

```bash
cp .env.example .env   # 填 CHOBO_DATABASE_URL(该接入方自己的 PG)
npm install && npm run dev
```

启动自动跑幂等迁移,再 seed 价格表与别名(`CHOBO_PRICE_SEED`)。

## 生产构建

```bash
npm run build   # tsc → dist/
npm start       # node dist/server.js
```

## API

- `POST /v1/events` — 收 `{events:[...]}` 信封。
  - 信封级 Ajv2020 校验;坏信封 → 400(绝不毒批)。
  - 逐事件校验、算价(豆包 dated id 经 `model_aliases` 归一)、`ON CONFLICT (event_id) DO NOTHING` 幂等落库。
  - 返回 `{accepted, duplicates, rejected}`。坏事件计入 `rejected`，不阻止其余事件入库。

- `GET /v1/stats/overview|timeseries|by-user|by-org|by-project` — 聚合统计(全 CNY)。

- `GET /v1/events` — 明细审计,bigint 微秒精度游标分页(`?cursor=<token>&limit=<n>`,`include_payload=true` 附 payload)。

- `GET /healthz` — 健康检查。

## v1 价格范围

| provider | 归一 model | 状态 |
|---|---|---|
| `doubao` | `doubao-seed-2.0-pro` | ✅ 已 seed 真价 3 档(Ark 直连,含别名 `doubao-seed-2-0-pro-260215`) |
| `example-gateway` | `gpt-5.5` | ⏳ 待 fugue 给 CNY 价 → 在此前 `total_cost=NULL` + 告警 |
| `example-gateway` | `gemini-3.5-flash` | ⏳ 待 fugue 给 CNY 价 → 在此前 `total_cost=NULL` + 告警 |
| `example-gateway` | `gpt-image-2` | ⏳ 待 fugue 给 CNY 单价(元/张)→ 在此前 `total_cost=NULL` + 告警 |

改价 = 新 `version` 行,不就地修改历史快照。未知模型 → `total_cost=NULL` + 告警(绝不静默填 0)。

## 回填(先用后配)

```bash
npm run reprice          # 只重算 total_cost=NULL 的行(默认)
npm run reprice -- --all # 重算全部;对新表中无对应型号的旧行保留原快照,不 null 化
```

## 源码模块

```
src/
├── config.ts        # resolveConfig(env) → ServerConfig
├── db.ts            # createSql(url) + migrate(sql, dir)
├── validator.ts     # Ajv2020 编译 event.schema.json + 信封 schema
├── types.ts         # EventInput / UsageRow / PriceRow / PriceTable / Cost / ServerConfig
├── pricing.ts       # loadPriceTable(sql) + computeCost(event, table)(含 model 归一)
├── ingest.ts        # POST /v1/events
├── auth.ts          # secretGuard(可选 CHOBO_INGEST_SECRET)
├── filters.ts       # parseFilters + whereFragment(stats 共用)
├── stats.ts         # GET /v1/stats/* + GET /v1/events
├── app.ts           # buildApp(deps):挂 Ajv2020 + 路由 + hooks
├── server.ts        # 入口:config → sql → migrate → seed → buildApp → listen + 优雅退出
├── reprice.ts       # reprice(sql, table, opts) 逻辑
└── reprice-cli.ts   # npm run reprice 入口
```

## 测试

```bash
npm test   # vitest run(需 Docker Desktop 运行,testcontainers 自动起 PG)
```

51 测试,16 文件,全绿。覆盖:config · migrate · validator · pricing · ingest · ingest-dedup · ingest-reject · ingest-storability · ingest-payload · auth · stats-overview · stats-timeseries · stats-bydim · stats-events · reprice · e2e。

## 环境变量

详见 `.env.example`。关键项:

| 变量 | 说明 |
|---|---|
| `CHOBO_DATABASE_URL` | Postgres 连接串(必填) |
| `CHOBO_PRICE_SEED` | 价格 seed JSON 路径(不填则跳过 seed) |
| `CHOBO_INGEST_SECRET` | 不填 = 开放 ingest(v1 默认);填了则校验 `X-Chobo-Secret` 头 |
| `CHOBO_PAYLOAD_MAX_BYTES` | payload 截断上限(默认 8192) |
| `CHOBO_BODY_LIMIT` | Fastify 请求体上限(字节,默认 16777216 = 16 MiB) |
| `CHOBO_PORT` | 监听端口(默认 8787) |
