# Plan 5 — 首个真实接入方:five-elements server 集成设计

> 状态:设计待复审 · 2026-06-25 · 取代原 Plan 5"接 AdopterA"的接入方选择(见 §1)。
> 权威上位文档:`docs/specs/2026-06-24-billing-sdk-design.md`(18 节)。本文只覆盖 Plan 5 的接入实现,有出入以上位 spec 为准。

## 1. 背景:接入方从 AdopterA 转向 five-elements

原计划 Plan 5 = 把 SDK 接进 **AdopterA**(朋友的项目)。问题:AdopterA 的两个 AI 服务今天都没有 user/org/project 身份(只有 trace_id),要做 per-end-user 归因就得改 AdopterA 的**前端/后端调用方** —— 那是别人的代码,需显式同意、风险高。

fugue 提出更优解:用**自己的项目 `C:\Code\five-elements\server`** 作首个真实接入方。它是 Node 后端、恰好同时有 **doubao 文本**(走火山 Ark)和 **gpt-image-2 生图**(走 OpenAI 兼容、NewAPI 作 baseURL)。

**为什么这是更好的首个接入方,而非退而求其次:**
- **零第三方同意风险** —— 自己的 repo,随便改、随便部署。
- **首次真实检验已建的 `@chobo/sdk`**(Plan 3,43 测试)在真实项目里的接入体验 —— 这正是"可泛化产品"绕不开的第一道考题。
- **doubao 文本 + gpt-image-2 生图** 一文本一生图,覆盖 `chat` 与 `image` 两种 operation。
- **唯一代价:** Python SDK 这轮不被覆盖(项目纯 Node)。不阻塞 —— Python SDK 已 35 测试绿,留作后续单独 e2e。

AdopterA 顺延为**后续可选接入方**,本轮不碰。

## 2. 范围与非目标

**做(范围内):**
- 把 `@chobo/sdk` 以 **tarball vendoring** 方式接进 five-elements server。
- 在**两个咽喉**(`lib/llm.js` 文本、`lib/imageGen.js` 生图)原地插桩(方案 A),发计量事件到 CRM。
- 在请求边界 + 后台 worker 注入身份(user_id),`project` 走常量。
- 给 `@chobo/sdk` 补 `ingestSecret`(让它能对接受密钥保护的 CRM)。
- CRM 价格表加 gpt-image-2 行(待 fugue 给单价;doubao 已现成)。
- 端到端:fugue 部署上线后真实跑通 doubao 文本 + 生图,看板看到归因+算价。

**不做(非目标):**
- 不接 AdopterA(顺延)。
- 不涉及 Python SDK(项目纯 Node)。
- 不做流式(`meterStream`)—— five-elements 两咽喉都是 buffered 非流式 `await`。
- 不改 five-elements 的业务行为 —— 插桩必须 env 闸门化、字节级可关闭。
- 不在 five-elements 算价 —— 算价只在 CRM 一处(铁律)。
- 不动那 ~8 个调用点的 scene 维度(fugue 已定 `project=常量`,不做 per-scene 拆分)。

## 3. 架构与数据流

```
five-elements server (Express, CJS)
  ├─ 请求中间件: runWithIdentity({user_id: req.user.id, project:'five-elements', identity_source:'jwt'})
  ├─ 后台 worker: runWithIdentity({user_id: job.user_id, ...}) 包住 processJob(job)
  │
  ├─ lib/llm.js     chatComplete()      ──meter(chat, doubao, openaiChatUsage)──┐
  └─ lib/imageGen.js generateImage()    ──meter(image, newapi, imageUsage)──────┤
                                                                                 │ 响应后异步
                                                          @chobo/sdk Transport ──┘ POST /v1/events
                                                                                      │ (x-chobo-secret)
                                                                       chobo CRM (@chobo/server)
                                                                       去重 + 算价 + 落 Postgres
                                                                                      │
                                                                              看板 @chobo/web(纯读)
```

- SDK **永不阻塞**:`meter` 包住 `await fetch`,响应原样返回/原样抛错,事件进有界内存队列后异步批量 POST(溢出落盘、退避重投、`shutdown()` flush)。
- env 未配 `CHOBO_INGEST_URL` 时,`chobo.init()` 不调用,两咽喉退化为原始直接调用(**字节等同**)。

## 4. 接入方现状(实证地基)

> 依据 2026-06-25 对 `C:\Code\five-elements\server\src` 的实读。

- **栈:** CommonJS(`"type":"commonjs"`)· Express 4.21 · `pg` · `jsonwebtoken` · Jest+supertest。微信小程序后端(五行/八字:每日指引、社交匹配、生图、论坛)。
- **两个咽喉,都是手写 `fetch`、非流式 `await`、usage 在返回 JSON 里现在没读:**
  - 文本 `lib/llm.js` `chatComplete()`:Ark `/chat/completions`,`stream:false`,响应 `data.usage`(`prompt_tokens`/`completion_tokens`/`total_tokens`)未读;`data.choices[0].message.content` 已读。默认 model `doubao-seed-2-0-pro-260215`,`max_tokens:900`。
  - 生图 `lib/imageGen.js` `generateImage()`→`generateOpenAI()`:`{OPENAI_BASE_URL}/images/generations`(或 `/images/edits` multipart),`n:1`,默认 model `gpt-image-2`,quality `low`。另有 `generateArk()`(Seedream)作 `IMAGE_PROVIDER=ark` 回退。
- **身份现成,且每个调用点(含 worker)都已知道:** `middleware/devAuth.js` 设 `req.user = jwt.verify(token, JWT_SECRET)`,`req.user.id` 即用户 id;worker 路径用 `job.user_id`(见 `forumAiWorker.js:86`)。现有 `logLLM({uid, scene, ...})` 在每个调用点都拿到了 uid。
- **`lib/llmLog.js` 不是计量系统,与 chobo 互补:** 它只记 `{uid, scene, status, request/response 摘要, traceId}`,**没有 token/cost/model/latency**。chobo 补的正是它缺的计费维度;两者不冲突、不重复。
- **生图全程在异步 worker:** `visualJobWorker`(setInterval 轮询 DB 队列 `visual_generation_jobs`)→ `socialVisualService.processJob(job)` → `imageGen.generateImage()`,**脱离 HTTP 请求上下文**。故身份不能只靠请求级 ALS。

## 5. 插桩设计(方案 A:两 funnel 原地)

**原则:** 两个 funnel 是全部 LLM 调用的唯一入口,在 funnel 内部包 `meter` → 所有 caller 自动覆盖、**零调用点改动**。

**5.1 SDK 初始化(单处,启动时)**

新增 `lib/choboMeter.js`(集中接入点,导出包装后的调用 + init/shutdown 钩子),`src/index.js` 启动时调用初始化。仅当 `process.env.CHOBO_INGEST_URL` 存在才 `chobo.init(...)`:

```js
// 概念示意(完整代码在 plan):
const chobo = require('@chobo/sdk')
let enabled = false
function initChobo() {
  if (!process.env.CHOBO_INGEST_URL) return        // 闸门:未配 → 整体休眠,业务字节等同
  chobo.init({
    ingestUrl: process.env.CHOBO_INGEST_URL,
    service: 'five-elements-server',
    ingestSecret: process.env.CHOBO_INGEST_SECRET || undefined,  // §8 新增能力
    spoolDir: process.env.CHOBO_SPOOL_DIR || './.chobo-spool',
  })
  enabled = true
}
```

**5.2 文本咽喉(`lib/llm.js` `chatComplete`)**

把那次 `await fetch(...)` 用 `meter` 包住;`enabled` 为假时直接调用(零开销):

```js
// 概念示意:
const doFetch = () => fetch(endpoint, { ... })           // 原逻辑
const resp = enabled
  ? await chobo.meter(
      { operation: 'chat', provider: 'doubao', requestModel: model,
        extract: chobo.extractors.openaiChatUsage },
      doFetch)
  : await doFetch()
// 其后 resp.ok 检查、data.usage、content 解析全不变
```

> `meter` 的 `extract(response)` 收到的是 **resolved 的 fetch `Response` 对象**,而 `openaiChatUsage` 需要的是**解析后的 JSON**(读 `usage`/`choices`)。因此包装层不能直接把 `Response` 交给 extractor —— 实现方案在 plan 中钉死(二选一:① `meter` 包到"取 JSON 后"返回已解析对象;② 提供一个 `extract` 适配,先 `await response.clone().json()`)。**首选 ①**:把 `meter` 包在"返回解析后 data"的内层函数上,extractor 直接拿 data。该细节在 plan 的第一组任务里以测试钉死,避免 extractor 拿错形状。

**5.3 生图咽喉(`lib/imageGen.js` `generateOpenAI`/`generateArk`)**

同样包 `meter`,`extract: (data) => chobo.extractors.imageUsage(data)`(数 `data.data[]` = 1 张)。provider 按路由:openai 路由 → `newapi`;ark 路由 → `doubao`。同样遵守 §5.2 的"extractor 拿解析后 JSON"约定。

**5.4 失败也落账** —— `meter` 在 `fn()` 抛错时自动发 `status:"failure"` 事件并原样 re-throw,不改变 five-elements 现有的错误处理(`.code` 透传)。

## 6. 身份流

**字段映射(fugue 已定):**

| chobo 字段 | 值 | 来源 |
|---|---|---|
| `user_id` | 内部用户 id | 请求 = `req.user.id`;worker = `job.user_id` |
| `org_id` | `null` | 个人消费 app 无机构 |
| `project` | `"five-elements"` | 常量 |
| `identity_source` | `"jwt"` | app 自有 JWT/req.user(spec 预留的 JWT 热插拔路径) |

**注入两处(因 `meter` 在调用时 `getIdentity()` 同步快照,且 ALS 跨 await 传播,咽喉必须跑在 `runWithIdentity` 作用域内):**

1. **请求路径** —— 一个全局 Express 中间件,挂在 `devAuth` 之后,包住后续处理:
   ```js
   app.use((req, res, next) =>
     enabled
       ? chobo.runWithIdentity(
           { user_id: req.user?.id ?? null, org_id: null, project: 'five-elements', identity_source: 'jwt' },
           next)
       : next())
   ```
   覆盖请求内的文本调用(daily-guide、event-reads 等)。

2. **worker 路径** —— 每个后台 worker 的单 job 处理体包一层 `runWithIdentity({user_id: job.user_id, org_id:null, project:'five-elements', identity_source:'jwt'}, () => processJob(job))`。**生图 worker(visualJobWorker)必做**;文本 worker(forumAiWorker 等)同理。

**确切 worker/调用方清单在 plan 第一组任务里逐一核实**(追 `require('./llm')`/`require('./imageGen')` 的全部 caller,判定请求路径 vs worker 路径)。已知:请求路径有 daily-guide、event-reads;worker 路径有 visualJobWorker(生图 + prompt 改写文本)、forumAiWorker(lingshi-chat);socialBotService、socialMatchReasonService 待核。

**诚实降级:** 若某调用既不在请求中间件作用域、也不在 worker 包裹内,`getIdentity()` 自动回 `{user_id:null, identity_source:'missing'}` —— 照样落账、标 missing,绝不错算到别人头上(符合铁律"不静默")。

## 7. 事件字段映射(每咽喉)

| 咽喉 | operation | provider | request_model | extract | usage |
|---|---|---|---|---|---|
| `llm.chatComplete` | `chat` | `doubao` | `doubao-seed-2-0-pro-260215` | `openaiChatUsage` | prompt/completion/total tokens |
| `imageGen.generateOpenAI` | `image` | `newapi` | `gpt-image-2` | `imageUsage` | image_count=1 |
| `imageGen.generateArk`(回退) | `image` | `doubao` | `doubao-seedream-5-0-260128` | `imageUsage` | image_count=1 |

`service` 统一 `"five-elements-server"`。CRM 用 event 的 `provider`/`request_model`/`operation` 三者匹配价格行(§10)。

## 8. SDK 增强:`ingestSecret`

**现状缺口:** `@chobo/sdk` 的 `Transport.post()` 只发 `content-type` 头,**发不了 `x-chobo-secret`** → 无法对接配置了 `CHOBO_INGEST_SECRET` 的 CRM。

**改动(约 10 行 + 测试):**
- `config.ts`:`ChoboConfigInput` / `ChoboConfig` 加可选 `ingestSecret?: string`;`resolveConfig` 透传。
- `transport.ts`:`post()` 的 headers 加 `...(this.cfg.ingestSecret ? { "x-chobo-secret": this.cfg.ingestSecret } : {})`。**头名 `x-chobo-secret` 与 CRM `auth.ts:8` 一致。**
- 测试:注入假 `fetch`,断言配置了 secret 时请求带该头、未配时不带。
- README:Config 表加一行。

**这是 chobo 仓库的改动(SDK,Plan 3 领域),走 chobo 的功能分支。** SDK 版本号 bump(0.1.0 → 0.1.1),tarball 随之更新。

## 9. 包管理 / 分发(tarball vendoring)

five-elements 是独立、要**部署上线**的仓库 → 本地 `file:` 路径依赖在服务器上不可用。采用**自包含 tarball**:

1. 在 `packages/sdk-node` 跑 `npm run build && npm pack` → 得 `chobo-sdk-0.1.1.tgz`(因 `files:["dist"]` 只含 dist+package.json+README,**零运行时依赖**故装它不拉别的包)。
2. 放入 `five-elements/server/vendor/chobo-sdk-0.1.1.tgz`。
3. `five-elements/server/package.json` 加 `"@chobo/sdk": "file:vendor/chobo-sdk-0.1.1.tgz"`,`npm install`。

**CJS 解析:** SDK `exports` 的 `require` 条件 → `dist/index.cjs`(类型 `.d.cts`);`const chobo = require('@chobo/sdk')` 在 CommonJS 项目里开箱即用,无需 ESM interop。

**升级路径(本轮不做):** SDK 迭代勤了之后改用 GitHub Packages / 私有 registry(`.npmrc` 指 `@chobo:` scope + token),届时 `npm install @chobo/sdk` 即可。

## 10. 算价(CRM 侧)

CRM `computeCost` 按 `(provider, model, operation)` 匹配价格行,model 先经 `provider::alias` 归一(`pricing.ts:40-49`)。

- **doubao 文本 —— 现成、开箱算价:** `price-seed.example.json` 已含 `doubao / doubao-seed-2.0-pro / chat` 三档(0–32K 档 `3.2/16.0/0.64` 与火山 PDF 核对过,HIGH),且 alias `doubao-seed-2-0-pro-260215 → doubao-seed-2.0-pro` 已在 seed。five-elements 文本 `max_tokens:900`、prompt 不大 → 输入稳落 0–32K 档,PDF 核过的那档全覆盖。
- **gpt-image-2 —— 待 fugue 给单价:** 需新增价格行 `{provider:"newapi", model:"gpt-image-2", operation:"image", per_image:<元/张>}`。⚠ 草案里 gpt-image-2 挂 `example-gateway`,但 five-elements 走 NewAPI,**价格行 provider 必须是 `newapi` 才匹配**。给价前 `total_cost=NULL`+告警(诚实),给价后 `npm run reprice` 回填历史。
- **ark Seedream 回退 —— 同理待价:** 若启用 `IMAGE_PROVIDER=ark`,需 `{provider:"doubao", model:"doubao-seedream-5-0-260128", operation:"image", per_image:...}`(草案有 Seedream 候选价,待核)。本轮默认 openai 路由,Seedream 行可暂缺。

## 11. CRM 侧改动小结

- 价格表 seed:doubao 行 + alias **已在**;**新增 gpt-image-2(provider=newapi)行**(待价,可先不 seed → NULL+告警)。
- 其余 CRM 能力(ingest 去重、stats、看板、reprice、x-chobo-secret 鉴权)**已就绪,无需改动**。

## 12. 配置与安全不变量

| 不变量 | 实现 |
|---|---|
| 绝不危及业务 app | `CHOBO_INGEST_URL` 未配 → 不 init、咽喉走原始路径,**字节等同**;SDK 本就 fire-and-forget、永不阻塞 |
| 优雅退出不丢账 | five-elements 的 SIGTERM/SIGINT 处 `await chobo.shutdown()`(若已 init) |
| 密钥不外泄 | `CHOBO_INGEST_SECRET` 只从 env 读,不打印/不入库(与项目现有 `ARK_API_KEY` 同纪律) |
| 不静默 | 缺身份标 `missing`、缺价 `NULL`+告警、丢事件计数(SDK `getStats()`) |

**新增 env(five-elements `.env`):** `CHOBO_INGEST_URL`(必需才启用)、`CHOBO_INGEST_SECRET`(可选)、`CHOBO_SPOOL_DIR`(可选)。

## 13. 端到端验收

fugue 部署上线后(无正式用户,安全),真实场景跑通:
1. CRM(`@chobo/server`)部署可达 + 价格 seed(doubao 现成;gpt-image-2 待价则该项 NULL)+ 配 `CHOBO_INGEST_SECRET`。
2. five-elements 配 `CHOBO_INGEST_URL`/`CHOBO_INGEST_SECRET` 指向 CRM,装好 tarball。
3. 真实触发 **一次 daily-guide(doubao 文本)+ 一次社交生图(gpt-image-2)**。
4. **预期:** CRM 收到 2+ 事件;按 `user_id` 归因、`identity_source=jwt`;operation 分 `chat`/`image`;doubao 事件 `total_cost` 非空 numeric 字符串、gpt-image-2 事件 `total_cost=NULL`(待价);看板按用户/模型/operation 看得到。
5. 关掉 `CHOBO_INGEST_URL` 重启,确认业务行为字节等同(回归保险)。

## 14. 测试策略

- **five-elements(jest + supertest,新增):**
  - 闸门:未配 `CHOBO_INGEST_URL` 时,两咽喉行为与未插桩等同(用假 fetch 断言不发事件、返回值/抛错不变)。
  - 文本咽喉:配 chobo + 假 ingest,断言一次 `chatComplete` 发出一条 `chat`/`doubao` 事件且 usage 字段来自 `data.usage`;失败发 `failure` 事件。
  - 生图咽喉:同上,断言 `image`/`newapi` 事件 image_count=1。
  - 身份:在 `runWithIdentity` 内调用 → 事件带 user_id + `identity_source:jwt`;作用域外 → `missing` + user_id null。
  - extractor 形状:钉死 extractor 拿到的是解析后 JSON(§5.2)。
- **chobo(vitest,SDK):** `ingestSecret` 配置时 `post` 带 `x-chobo-secret` 头、未配不带。

## 15. 仓库触面小结

- **five-elements(fugue 的 repo,功能分支):** 新增 `lib/choboMeter.js`(接入点)、`src/index.js` 接线(init/shutdown/身份中间件)、`lib/llm.js`+`lib/imageGen.js` 各包 `meter`(几行,闸门化)、相关 worker 包 `runWithIdentity`、`package.json` 加 tarball 依赖、`vendor/*.tgz`、`.env` 项、jest 测试。
- **chobo(功能分支):** SDK 加 `ingestSecret`(config+transport+测试+README,版本 bump)、价格 seed 加 gpt-image-2 行(待价)、`CLAUDE.md`/`docs/dev-log.md`/memory 记 Plan 5 接入方 = five-elements、AdopterA 顺延。

## 16. 决策记录(本轮已锁)

| # | 决策 | 选择 |
|---|------|------|
| 1 | 首个真实接入方 | five-elements server(自有项目),AdopterA 顺延 |
| 2 | 插桩方式 | A:两 funnel 原地 `meter`,零调用点改动,env 闸门 |
| 3 | 归因维度 | user_id=req.user.id/job.user_id;org_id=null;**project=常量 "five-elements"**;identity_source=jwt |
| 4 | 生图 provider | `newapi` |
| 5 | SDK 增强 | 补 `ingestSecret`(发 `x-chobo-secret`) |
| 6 | 包分发 | tarball vendoring(`npm pack` → `file:vendor/*.tgz`) |
| 7 | e2e | fugue 部署上线真实跑(无正式用户) |
| 8 | 算价 | doubao 现成;gpt-image-2 = `provider:newapi` 待价 → NULL+reprice |
| 9 | 流式 | 不涉及(两咽喉均 buffered) |
| 10 | Python | 不涉及(项目纯 Node),顺延 |

## 17. 开放项(实现期消解)

1. **gpt-image-2 单价(元/张,经 NewAPI)** —— fugue 待查;给出前 NULL+reprice。
2. **worker/调用方精确清单** —— plan 第一组任务追 `llm`/`imageGen` 全部 caller,判定请求 vs worker,逐一包身份。
3. **`meter` × `extract` 拿解析后 JSON 的精确包法** —— plan 首组以测试钉死(§5.2 首选内层包法)。
4. **CRM 部署位置 / 可达性 / 密钥** —— fugue 部署时定(SDK 只认 `CHOBO_INGEST_URL`/`CHOBO_INGEST_SECRET`)。
5. **ark Seedream 生图价** —— 仅当启用 ark 回退时需要,本轮默认 openai 路由可缺。
