# 帳簿 chobo — LLM 用量计量与计费 SDK 设计

| | |
|---|---|
| **状态** | 草案 / 待 fugue 复审 |
| **日期** | 2026-06-24 |
| **被插桩对象** | AdopterA 的 `node-ai-proxy`(:3001)、`python-lesson-parser`(:8000) |
| **交付物** | ① SDK(Python + Node 同一套) ② CRM 后端(ingest + 算价 + 看板) |

---

## 1. 背景与动机

**chobo 是我们自己的产品** —— 一个低侵入、可泛化的 LLM 用量计量与计费层,目标是给**任意接入方**使用。
**AdopterA 是 chobo 的首个接入方/用户,不是 chobo 的边界**:AdopterA 的两个 AI 服务
(`node-ai-proxy`、`python-lesson-parser`)调用 LLM / 生图 /(将来)生视频,chobo 计量这些调用以支撑计费;
下文出现的 AdopterA 具体文件路径,均属「首个接入的对接细节」,不是 chobo 的固有范围。

这构成一条**两级计费链**:

| 级 | 谁向谁收 | 现状 |
|----|----------|------|
| **Tier 1** | 我们 → 接入方(朋友) | 现成 LLM 网关(如 new-api)已能按 key 计费 |
| **Tier 2** | 接入方 → 其终端用户(某校的某老师) | **空白** —— 网关只到 `(user, token)`,看不到 key 下的老师/学校 |

`new-api` 实测确认:它每笔调用落一行 `logs`(含真实 cost),但**最细粒度是它自己的
`(user, token)`,不记录调用方传入的下级身份**。因此 **Tier 2 的 per-end-user 归因必须由我们补**
—— 这就是 chobo 存在的核心理由。

chobo 要做一个**低侵入、用户侧尽量无感**的计量层,记下每次调用的
**谁(含从属)/ 何时 / 何地 / 做了什么(类别·模型·输入输出明细)/ 代价**,
并且**可泛化**到任意接入方与 provider(不绑定 new-api、不绑定 AdopterA)。

---

## 2. 目标与非目标

### 目标(v1)
- 进程内拦截**首个接入方(AdopterA)**的两个 AI 服务(`node-ai-proxy`、`python-lesson-parser`)的全部模型调用,作为 chobo 的首个验证。
- 每笔调用产出一条**计量事件**:身份(user/org/project)、时间、来源、类别、模型、用量(token/张数)、输入输出明细、状态。
- CRM 后端用**自有价格表**算出 cost,落 Postgres(原始用量 + 快照 cost 都存)。
- 一个**最小看板**:整体开销、时间段开销、按用户/机构/任务开销。
- SDK 对业务**无感、不阻塞、不拖慢**模型调用。

### 非目标 / 明确不做
- **不引入网关**(覆盖范围锁定这两个服务,进程内拦截已够)。
- **不替代、不依赖 new-api**(它在不在都不影响我们对不对;对账作为可选后装件)。
- **v1 不建 new-api 对账适配器**(仅预留 `request_id` 纪律 + 可空字段,零返工后装)。
- **v1 不做 JWT 身份校验**(header 起步,JWT 为可热插拔加固)。
- **v1 不计量生视频**(预留 `operation` 取值,接口出现再接)。
- 不做完整 CRM/客户管理,只做计量与开销看板。

---

## 3. 总体架构

```
[被插桩服务: node-ai-proxy / python-lesson-parser]
        │  (1) 进程内 SDK 在"咽喉"处拦截调用
        │  (2) 自测 identity + tokens + model + request_id + 输入输出
        │  (3) 入有界内存队列后立刻返回 —— 业务调用照常进行
        │  (4) 后台 flusher 在响应返回后异步批量 POST
        ▼
   POST /v1/events  (事件 JSON 契约, 见 §4)
        ▼
[CRM 后端 (server/)]
   ingest:  按 event_id 幂等去重 → 用带版本价格表算 cost → 写 usage_events(原始用量+快照cost)
            输入输出明细 → 写 event_payloads(可选, 截断/脱敏)
   看板:    /v1/stats/*  只读聚合 API
   拥有:    Postgres: usage_events / event_payloads / price_table (+ 预留 reconciliation 列)
        ▼
[看板前端 (web/)]  纯读 CRM 的聚合 API
```

三段解耦,各自可独立理解与测试:
- **SDK** —— 输入:被拦截的调用 + 进程内身份上下文;输出:事件 JSON。不知道 Postgres 存在。
- **CRM 后端** —— 输入:事件 JSON;输出:Postgres 行 + 聚合 API。不知道是谁、用什么语言发来的。
- **看板** —— 输入:聚合 API;输出:页面。只读。

**唯一耦合点是 §4 的事件契约。** 放在 `contracts/`,SDK 与 CRM 共同遵守。

---

## 4. 事件 JSON 契约(核心接口)

SDK POST 给 CRM 的单条事件(`cost_*` 由 CRM 算,不由 SDK 发):

```jsonc
{
  // —— 幂等与关联 ——
  "event_id":      "uuid",          // 必填, 唯一; CRM 去重键, 重投不重复计费
  "request_id":    "string|null",   // 上游调用的 request id(用于 new-api 对账 & 多调用归组)
  "parent_id":     "string|null",   // 嵌套子调用(如 JSON 修复重试、流水线子步骤)

  // —— 谁(who) ——
  "user_id":       "string|null",   // 终端用户(如 teacherId)
  "org_id":        "string|null",   // 机构(学校/组织)
  "project":       "string|null",   // 接入方自定义的调用场景/任务标识(如 goal_generation, ggb, report-action-cards)
  "identity_source": "header|jwt|missing",  // 身份从哪来; missing = 未归因(unattributed)

  // —— 何时(when) ——
  "start_time":    1750000000123,   // unix ms
  "end_time":      1750000002456,
  "latency_ms":    2333,

  // —— 何地(where) ——
  "service":       "python-lesson-parser|node-ai-proxy",
  "provider":      "doubao|gemini|glm|minimax|...",
  "operation":     "chat|image|video|embedding",
  "request_model": "doubao-seed-2-0-pro-260215",
  "response_model":"string|null",

  // —— 做了什么 · 用量(what) ——
  "input_tokens":  1234,
  "output_tokens": 567,
  "total_tokens":  1801,
  "cached_tokens": 0,
  "reasoning_tokens": 0,
  "image_count":   0,
  "usage_source":  "measured|estimated|none",  // 精确 / 估算 / 无(失败等)

  // —— 状态 ——
  "status":        "success|failure",
  "error_type":    "string|null",
  "finish_reason": "string|null",

  // —— 输入输出明细(可选, 见 §7.2) ——
  "payload": {                      // 可整体省略; 受配置/截断/脱敏控制
    "request":   { /* 截断后的请求 */ },
    "response":  { /* 截断后的响应 */ },
    "truncated": false,
    "redacted":  false
  },

  // —— SDK 自述 ——
  "sdk_lang":      "python|node",
  "sdk_version":   "0.1.0"
}
```

字段名借 OpenTelemetry GenAI 语义约定(`input_tokens`/`output_tokens`/`provider`/`operation`),
便于将来导出到任意 OTel 后端。

---

## 5. 拦截与低侵入机制

> 依据 2026-06-24 对两个服务的全量调用点扫描。

### 5.1 Python(`python-lesson-parser`)—— 干净,近乎零改动

几乎所有调用汇入 **3 个咽喉**,全为**非流式 `await` 完整响应,`usage` 一定在返回里**:

| 咽喉 | 文件 | 覆盖 |
|------|------|------|
| `request_upstream()` | `app/services/upstream_api.py` | 聊天 ~95% |
| `UpstreamProvider.complete()` | `app/services/providers/upstream.py` | 旁路 ~10%(task_design / lesson_plan_design_assist / from_lesson_plan) |
| `ImageProvider.generate()` | `app/services/providers/image.py` | 生图 100% |

**机制:** 装饰器 / 子类包这三处即可,**不动任何调用点**。
`request_upstream` 已在记 model/url/elapsed,天然是埋点位。Python 侧工作量:数小时。

### 5.2 Node(`node-ai-proxy`)—— 分散,最小侵入(~6 点)

无统一 client,按协议分流:

| 路径 | 文件 | 覆盖 | usage 现状 |
|------|------|------|-----------|
| OpenAI/GLM/MiniMax + Responses API | `lib/openaiClient.js:requestStreamingResponse()` | ~45% | 流式默认不带,需开 `include_usage` |
| 全局 fetch 包装 | `lib/traceContext.js:traceFetch()` | ~30% | report-action-cards 等 |
| Gemini 原生 | `lib/geminiClient.js` / `lib/googleStreamClient.js` | ~15% | `usageMetadata` 可读但现在没读 |

**机制:**
1. 包 `requestStreamingResponse()` 与 `traceFetch()` 做传输层捕获(身份/计时/request_id)。
2. **流式取 usage(决策 §10.1):** 在流消费处(`consumeChatStream`/`consumeGenerateStream`)设
   `stream_options.include_usage=true` 并解析末尾 usage 块;Gemini 读 `usageMetadata`。
   —— 这是 ~6 个**真要碰代码**的点,非纯包装。
3. 复用既有 `server.js` 的 `traceMiddleware` + `AsyncLocalStorage` 承载身份上下文。

**诚实结论:** Python 近乎零侵入;Node 是"最小侵入",做不到零。

---

## 6. 身份契约

**现状:** 两个服务目前都只有 `trace_id/request_id`,**没有 user/org/project**。

**契约:** 接入方在 **HTTP 边界**注入身份,SDK 在边界读一次、存进进程内上下文,调用点自动带上:
- **Python:** `contextvars.ContextVar` 在 FastAPI 路由层 set,`request_upstream` 处 read。
- **Node:** 扩展既有 `AsyncLocalStorage`(`traceStorage`)携带 `{user_id, org_id, project}`,包装处 read。

**v1 来源 = header**(如 `X-Chobo-User`/`X-Chobo-Org`/`X-Chobo-Project`)。
SDK 与"身份从哪来"**解耦**:它只从上下文读;来源换 JWT 不动 SDK 内核(可热插拔加固路径)。

**契约校验(不静默):** 缺身份时**照样落账**,但标 `identity_source=missing`(unattributed)并告警 ——
绝不悄悄错算到别人头上,也绝不丢数据。

---

## 7. 数据模型(Postgres)

### 7.1 `usage_events`(聚合主表,保持精简)

```sql
-- 幂等/关联
event_id            text PRIMARY KEY,        -- SDK 生成的唯一键
request_id          text,
parent_id           text,
-- 谁
user_id             text,
org_id              text,
project             text,
identity_source     text NOT NULL,           -- header | jwt | missing
-- 何时
start_time          timestamptz NOT NULL,
end_time            timestamptz,
latency_ms          integer,
-- 何地
service             text NOT NULL,
provider            text NOT NULL,
operation           text NOT NULL,           -- chat | image | video | embedding
request_model       text NOT NULL,
response_model      text,
-- 用量
input_tokens        integer,
output_tokens       integer,
total_tokens        integer,
cached_tokens       integer,
reasoning_tokens    integer,
image_count         integer,
usage_source        text NOT NULL,           -- measured | estimated | none
-- 成本(由 CRM 算价填入; 原始用量与快照 cost 并存)
input_cost          numeric(18,8),
output_cost         numeric(18,8),
cache_cost          numeric(18,8),
total_cost          numeric(18,8),
currency            text DEFAULT 'CNY',
price_table_version text,                     -- 快照版本, 便于历史重算价
-- 状态
status              text NOT NULL,            -- success | failure
error_type          text,
finish_reason       text,
-- SDK
sdk_lang            text,
sdk_version         text,
created_at          timestamptz NOT NULL DEFAULT now()

-- 预留(v1 不填; new-api 对账后装件用, 见 §12):
-- newapi_cost      numeric(18,8),
-- cost_delta       numeric(18,8),
-- recon_status     text
```

索引:`(org_id, created_at)`、`(user_id, created_at)`、`(project, created_at)`、`(request_model, created_at)`、`(request_id)`。
数据量增长后按 `created_at` 月度分区。

### 7.2 `event_payloads`(输入输出明细,旁挂表)

为满足"具体包含哪些输入/输出"的审计需求,但**不拖垮聚合主表**,明细单独存:

```sql
event_id          text PRIMARY KEY REFERENCES usage_events(event_id),
request_payload   jsonb,        -- 截断 + 脱敏后的请求
response_payload  jsonb,        -- 截断 + 脱敏后的响应
truncated         boolean DEFAULT false,
redacted          boolean DEFAULT false,
created_at        timestamptz NOT NULL DEFAULT now()
```

**默认 = 仅元信息**(不存请求/响应明文);可配为 off / 仅元信息 / 截断明文(带大小上限 + 脱敏规则)。
看板默认不展示明文,按权限展开。

### 7.3 `price_table`(价格表,带版本)

```sql
version           text NOT NULL,        -- 价格表版本号
provider          text NOT NULL,
model             text NOT NULL,
operation         text NOT NULL,        -- chat | image | ...
input_tier_max    bigint,               -- 输入长度档位上界(NULL=无分档); 豆包: 32K/128K/256K
input_per_mtok    numeric(18,8),        -- 每百万输入 token
output_per_mtok   numeric(18,8),
cache_read_per_mtok   numeric(18,8),
reasoning_per_mtok    numeric(18,8),
per_image         numeric(18,8),        -- 按张(元/张), 生图用
currency          text DEFAULT 'CNY',
PRIMARY KEY (version, provider, model, operation, input_tier_max)
```

做成**可加载配置**(JSON 种子 → 表)。可借 LiteLLM 开源价目打底,再补豆包分档 / GLM / Seedream 按张。

---

## 8. 算价(在 CRM 后端,一处实现)

- **来源:** 自有 `price_table`(SDK 不算价,避免 Python/Node 双实现漂移)。
- **写时算价:** ingest 时即算出 cost 落库,看板纯 `SUM/GROUP BY`;**同时存原始用量**,
  费率变了可按新版本历史重算。
- **豆包形态(第一天就上):** 文本按 `(模型, 输入档位)` 选费率 + `cache_read` / `reasoning` 分项;
  生图按 `image_count × per_image`(元/张)。
- **每条事件记 `price_table_version`** —— 审计可还原"当时用的什么价"。
- 找不到价目的模型:`total_cost=NULL` + 告警(不静默填 0)。

---

## 9. 事件投递与可靠性(SDK 侧)

铁律:**绝不阻塞、不拖慢真实模型调用。**

1. 拦截后构造事件 → 入**有界内存队列** → 立即返回,业务继续。
2. 后台 flusher **批量** POST `/v1/events`,带退避重试。
3. **CRM 不可达 / 背压:** 内存队列满则**溢出落盘**(append-only 文件 / sqlite),恢复后重放。
4. 盘也满(极端):丢最旧 + **计数 + 告警**(绝不静默丢 —— 丢 = 丢钱)。
5. **`flush()` / `shutdown()` 钩子:** 进程退出前清空缓冲(接 FastAPI lifespan / Node 退出信号)——
   多 worker / 重启不丢已缓冲事件。
6. **幂等:** 每事件 `event_id`,CRM 去重 → 溢出重放、at-least-once 投递都不重复计费。

---

## 10. 关键战术决策(已锁)

### 10.1 Node 取 usage:显式取
流式开 `stream_options.include_usage=true` 解析末尾 usage 块;Gemini 读 `usageMetadata`。
缺失才退回本地估算并标 `usage_source=estimated`。**理由:** 计费系统不准则无意义;准确用量
两条 Node 路径都拿得到,代价仅 ~6 点;绝不静默估算。

### 10.2 价格表:豆包分档 + 按张第一天就上
真实栈就是豆包(分档)+ Seedream(按张),按模型名一刀切从第一天就错。

### 10.3 失败:全落账
success/failure/timeout 都记,`status`+`error_type` 区分;cost 按真实规则(失败图 0,失败 LLM
若 provider 扣了 input 就记 input)。算不算钱在计费聚合时按策略决定,采集端不丢数据。

### 10.4 身份:header(v1)+ 契约校验,JWT 可热插拔加固。

### 10.5 投递:见 §9。

---

## 11. CRM 后端与看板

### 后端(`server/`,**Node + TypeScript**,Fastify 或 NestJS,`pg` / `postgres.js` 连库)
- `POST /v1/events` —— 收事件,校验契约(Pydantic),幂等去重,算价,落库。
- `GET /v1/stats/overview` —— 整体开销/调用数/token。
- `GET /v1/stats/timeseries?from&to&bucket` —— 时间段趋势。
- `GET /v1/stats/by-user` / `by-org` / `by-project` —— 维度聚合。
- `GET /v1/events?filters` —— 明细查询(审计;按权限展开 payload)。

### 看板(`web/`,React,与 admin/teacher 前端一致)
- 整体卡片(总开销/调用/token)、时间趋势图、按用户/机构/任务 Top 榜与下钻、单笔审计详情。
- **纯读** CRM 聚合 API,不直连库逻辑。

---

## 12. new-api 对账(可选,后装,v1 不建)

实测:new-api 的 `logs` 表(`model_name/prompt_tokens/completion_tokens/quota/request_id/...`)
**可经 `GetAllLogs` API 或直连其库读取**。

**后装件(非依赖):** 配上 new-api 库 DSN/API,定时任务按 `request_id` join 其 logs,
把"我们自测的 cost"与"网关实收的 cost"对账,写入 §7.1 预留列(`newapi_cost/cost_delta/recon_status`)
并对差异告警。

**为何 v1 不建却零返工:** SDK 在 C / A 两模式下**字节级相同**(都存 `request_id`);
对账纯属 CRM 读侧可选模块,不配则休眠,无 new-api 的部署自动退化为纯自足。

---

## 13. SDK 公共接口(Python / Node 对齐)

两语言同一套心智模型:

- **`init(config)`** —— ingest URL、service 名、采样/payload 策略、缓冲与落盘、flush 间隔。
- **拦截装载** —— Python:对三咽喉 `@meter` / 子类;Node:包 `requestStreamingResponse`/`traceFetch` + 流消费处取 usage。
- **`set_identity(user_id, org_id, project)`** —— 在边界写进程内上下文(contextvars / AsyncLocalStorage)。
- **`meter(event)`** —— 逃生口:无法自动拦截时手动上报一条。
- **`flush()` / `shutdown()`** —— 清空缓冲;接服务的退出钩子。

SDK **不**含算价、不含 DB、不感知 new-api。

### 运行时与版本约束(踩过 AdopterA 的坑)

- **Python SDK:** `requires-python >= 3.9`,但**以 3.12 为开发/CI 基准** —— AdopterA 的
  `python-lesson-parser` 用 `.python-version` 锁死 **3.12.10**,SDK 要装进它的 3.12 venv;
  **不使用 3.13 才有的语法/特性**。
- **依赖极简:** SDK 尽量 stdlib-only(HTTP 用内置即可),**少装或不装第三方** ——
  AdopterA 用 3.13 建 venv 时正是被重型 native/ML 轮子(onnxruntime / scipy 一类)卡住装不上;
  dep-light 的 SDK 能干净落进任意宿主 venv,从根上避开这类冲突。
- **Node SDK + 后端:** 目标 **Node ≥ 18(以 20 LTS 为准)**。node-ai-proxy 未声明 `engines`、
  且是 `"type":"module"`(ESM),实跑在 Node 25;为最大兼容,**Node SDK 产物走 ESM + CJS 双格式**,
  后端用 ESM + TypeScript。chobo 自己声明 `engines` 收紧下限。

---

## 14. 模块边界与隔离

| 单元 | 职责 | 接口 | 依赖 |
|------|------|------|------|
| `contracts/` | 事件 JSON 契约 + 价格表 schema | 文件(JSON Schema / 类型) | 无 |
| `sdk-*/capture` | 在咽喉拦截、构造事件 | 被插桩函数 ↔ 事件对象 | contracts |
| `sdk-*/identity` | 进程内身份上下文 | set/get | 无 |
| `sdk-*/transport` | 缓冲、落盘、重试、flush | 事件 → HTTP POST | contracts |
| `server/ingest` | 校验、去重、算价、落库 | HTTP ↔ Postgres | contracts, pricing |
| `server/pricing` | 价格表加载 + 算价 | (用量,模型,档位) → cost | price_table |
| `server/stats` | 聚合读 API | SQL → JSON | Postgres |
| `server/recon`(后装) | new-api 对账 | new-api logs → 预留列 | (可选) |
| `web/` | 看板 | 调 stats API | server |

每个单元都能单测、能换内部实现而不破坏消费方。

---

## 15. 测试策略

- **SDK 捕获:** 模拟三类响应(含 usage / 流式末尾 usage / 失败),断言事件字段正确;Python 三咽喉、Node ~6 点各覆盖。
- **算价:** 豆包分档边界(32K/128K/256K)、缓存/推理分项、生图按张、未知模型→NULL+告警;价格表版本快照可重算。
- **幂等:** 同 `event_id` 重投只入一行。
- **投递韧性:** CRM 不可达 → 落盘 → 恢复重放无丢无重;`shutdown()` 清空缓冲(借鉴 task #1 多 worker 经验)。
- **身份:** 缺身份 → `identity_source=missing` 且落账、告警,不错算。
- **端到端:** 起 CRM + 用 SDK 打一批含身份的调用,看板数字对得上。

---

## 16. 分期与里程碑

- **v1(先做,让整套用起来):** SDK(Py + Node)+ CRM ingest/算价/落库 + 最小看板读 API。
  - 里程碑序:契约定稿 → Python SDK(最易)→ CRM ingest+pricing → Node SDK → 最小看板 → 端到端验收。
- **v1.5:** 看板前端 UI。
- **后续(deferred):** new-api 对账适配器(§12)、JWT 加固、生视频计量、双采集交叉校验、拆分独立 repo。

---

## 17. 待验证 / 开放项

1. **`request_id` 关联可行性**(为将来 §12 对账):我们在调用边界能拿到的 id 能否对上
   new-api `logs.request_id` —— 需在真实环境实测(对不上则对账退化为时间窗近似匹配)。
2. **CRM 后端框架细节** —— 已定 **Node + TypeScript**(见 §11/§18);Fastify vs NestJS、查询层(`pg` / `postgres.js` / 轻量 ORM)选型留实现期定。
3. **Node ~6 个取 usage 点的精确清单**与各自 `include_usage` 支持度,实现期逐一确认。
4. **豆包 / GLM / Seedream 价目的具体数值**与档位,实现期对照官方计费页录入价格表。
5. **身份 header 命名**与注入点(teacher-frontend / student-frontend 在 `/gen`、`/prep` 调用处)。
6. **payload 采集默认策略**(off / 元信息 / 截断明文)与脱敏规则、大小上限。
7. **chobo 各组件最终是否拆成独立 repo**(monorepo 起步,稳定后拆)。
8. **多接入方维度** —— v1 单接入方(朋友),`user_id`/`org_id` 已够 per-end-user 归因;
   若将来 chobo 服务多个接入方,需再加一个粗粒度 `tenant`/`account`(= 哪个接入方)维度。
   届时为 `usage_events` 增一可空列即可,不破坏现有契约。

---

## 18. 决策记录(已锁)

| # | 决策 | 选择 |
|---|------|------|
| 1 | 拦截形态 | 进程内 SDK,不加网关 |
| 2 | 覆盖范围 | 锁定 node-ai-proxy + python-lesson-parser |
| 3 | 落库/算价 | SDK POST → CRM ingest,后端用自有价格表算价、写时算价、原始+快照并存 |
| 4 | 成本来源 | 自足(Y);new-api 对账为可选零返工后装件(C 默认 / A 可后装) |
| 5 | 身份 | 边界注入,SDK 从上下文读;header(v1)↔ JWT 热插拔;缺身份标 unattributed |
| 6 | Node usage | 显式取(include_usage / usageMetadata),缺失估算并标记 |
| 7 | 价格表 | 豆包分档 + 按张 + 缓存/推理分项,带版本,第一天就上 |
| 8 | 失败 | 全落账,status/error_type 区分,cost 按真实规则 |
| 9 | 投递 | 永不阻塞;有界队列→溢出落盘→退避重投→退出 flush;event_id 幂等 |
| 10 | CRM 后端栈 | **Node + TypeScript**(Fastify/NestJS);看板 React;SDK Python+Node |
| 11 | 运行时 | Python SDK ≥3.9 / CI 3.12 / 不用 3.13 语法 / 依赖极简;Node ≥18(20 LTS),ESM+CJS |
