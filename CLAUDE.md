# CLAUDE.md — chobo

## 项目简介

**chobo(帳簿 = 账簿)是一个独立、可泛化的 LLM 用量计量与计费产品。** 低侵入地"代理"每一次大模型
调用,记下 **谁(含从属)/ 何时 / 何地 / 做了什么(类别·模型·输入输出)/ 代价**,让每一笔可计费、可审计。

**chobo 是主项目,面向任意接入方。** AdopterA(`C:\Code\adopter-a` 的 `node-ai-proxy`、
`python-lesson-parser`)是 chobo 的**首个接入方/用户,不是 chobo 的边界**;chobo 不依赖 AdopterA
的特定结构。

## 定位:两级计费链的第二级

- **Tier 1**(运营方 → 接入方):现成 LLM 网关(new-api)已能按 key 计费。
- **Tier 2**(接入方 → 其终端用户,如某校某老师):网关只到 `(user, token)`,看不到 key 下的下级。
  **chobo 补这层 per-end-user 归因 —— 这是产品的核心理由。**

## 架构

```
被插桩服务  --进程内 SDK 拦截-->  自测 identity + tokens + model + request_id
          --响应后异步 POST 事件-->  CRM 后端(去重 + 算价 + 落 Postgres)  -->  看板(纯读)
```

- **进程内 SDK 拦截,不引入网关。** SDK 永不阻塞业务;响应返回后异步落账。
- **自足算价(Y):** CRM 用**自有带版本价格表**算 cost,不借 new-api → 与 provider/网关无关、可泛化。
- **new-api 对账 = 可选零返工后装件**(靠 `request_id` 纪律;不配则休眠,无 new-api 的接入方自动退化)。

## 仓库结构(monorepo,稳定后可拆成各自 repo)

```
contracts/            # 事件 JSON 契约 + 价格表 schema(SDK 与 CRM 的唯一接口)
packages/sdk-python   # Python SDK ✅(Plan 1)
packages/sdk-node     # Node SDK ✅(Plan 3)
server/               # CRM 后端(ingest + 算价 + 看板读 API)✅(Plan 2,@chobo/server)
web/                  # 看板前端 ✅(Plan 4,@chobo/web,React+Vite)
docs/specs/           # 权威设计文档
docs/superpowers/plans/  # 各 Plan 的实现计划(TDD,逐任务)
docs/research/        # 事实地基 + Plan 2 前置/价目草案(带引用)
```

## 技术栈与运行时约束

| 组件 | 栈 | 约束 |
|------|----|----|
| Python SDK | Python | `>=3.9`,**以 3.12 为基准**,**不用 3.13 独特语法**,**依赖极简**(尽量 stdlib) |
| Node SDK | TypeScript | **Node ≥18(20 LTS)**,产物 **ESM + CJS 双格式** |
| CRM 后端 | **Node + TypeScript**(**Fastify 5** + postgres.js) | Node 20 LTS,ESM;Ajv2020 校验(默认 Ajv 是 draft-07,撑不住 2020-12 契约) |
| 看板 | **React 18 + TS + Vite**(`@chobo/web`) | 手写 SVG 图表 + 自写 `useFetch` + 手写 CSS 令牌;**零额外运行时依赖**;由 CRM `@fastify/static` 同源托管 |
| 存储 | PostgreSQL | `usage_events` / `event_payloads` / `price_table` |

> 运行时约束源于 AdopterA 的坑:`python-lesson-parser` 锁 `.python-version=3.12.10`,3.13 装不上
> 重型 ML 轮子(onnxruntime/scipy);`node-ai-proxy` 是 ESM、跑 Node 25、未声明 engines。

## 不变量(铁律)

- SDK **永不阻塞/拖慢**真实模型调用;有界队列 → 溢出落盘 → 退避重投 → 退出 flush。
- **不静默:** 不静默丢事件(丢必计数告警)、不静默估算(估了标 `usage_source=estimated`)、
  缺身份标 `identity_source=missing` 并告警。
- **幂等:** 每事件 `event_id`,CRM 去重,重投不重复计费。
- **可审计:** 价格表带 `price_table_version`;原始用量 + 快照 cost 都存。
- **算价只在 CRM 一处**实现(SDK 不算价,避免 Python/Node 双实现漂移)。

## 权威设计

完整设计见 [`docs/specs/2026-06-24-billing-sdk-design.md`](docs/specs/2026-06-24-billing-sdk-design.md)
(18 节 + 决策表)。改动行为前先读它;有出入以 spec 为准。

## 状态

v1 拆成 **5 份顺序计划**,加 Plan 6 多租户扩展(计划文件在 `docs/superpowers/plans/`,各自独立可测):

- ✅ **Plan 1 — 契约 + Python SDK**(`contracts/` + `packages/sdk-python`,stdlib-only `chobo`,35 测试)
- ✅ **Plan 3 — Node SDK**(`packages/sdk-node` = `@chobo/sdk`,TS 双格式 ESM+CJS,零运行时依赖,43 测试,publint/attw 干净)
- ✅ **Plan 2 — CRM `server/`**(`@chobo/server`,Fastify 5.8.5 + Ajv2020 + postgres.js,51 测试,ingest + 算价 + stats + reprice;merged `ba9ce40`)
- ✅ **Plan 4 — 看板 `web/`**(`@chobo/web`,React 18 + TS + Vite,零额外运行时依赖,手写 SVG 图表 + useFetch,35 测试,同源 `@fastify/static` 托管 + ingest 鉴权收窄;merged `8993c1a`)
- ✅ **Plan 5 — 接入首个真实接入方 five-elements**(实现交付,端到端待部署):接入方为 fugue 自有的 `five-elements` Node/CJS 微信小程序后端(**非 AdopterA** —— 改朋友项目需显式同意,顺延)。SDK 补 `ingestSecret`(发 `x-chobo-secret`,0.1.1)+ tarball vendoring;`lib/choboMeter.js` 唯一接入点(env 闸门)+ 两 funnel 原地 `meter`(doubao 文本 / gpt-image-2 经 NewAPI)+ devAuth/双 worker 身份注入。five-elements 12 chobo 测试绿 / SDK 45 测试绿;关键任务 opus 两段评审。端到端待 fugue 部署;gpt-image-2(provider=newapi)每张价待 fugue → NULL+reprice。
- ✅ **Plan 6 — account 多租户维度 + CRM 独立部署(已上线 + 生产真实流量验证)**:Model B(一套共享 CRM + `account` 列)。契约/Node SDK 0.1.2/Python SDK 0.1.1/CRM(`0002_account.sql` + `/v1/stats/by-account`)/看板(account 过滤+排行+下钻) 端到端落地;five-elements 改 `account='five-elements'` + `project=null` + SDK 0.1.2 tarball。CRM 部署件:`ci/Dockerfile`(多阶段)+ `deploy/{docker-compose.crm.yml,ship-crm.sh,chobo-init-db.sql,nginx.chobo.conf,CRM_DEPLOY_RUNBOOK.md}`。测试基线全绿(Node 47 / Python 39 / CRM 70 / web 38 / five-elements chobo 12)。**已部署:** CRM 容器 `chobo-crm` 跑在生产宿主(独立 `chobo` 库,挂 `postgres18_default`),看板 `https://chobo.example.com`(nginx basic-auth);five-elements 接回(SDK 0.1.2、`CHOBO_INGEST_URL=http://chobo-crm:8787/v1/events`)。**生产验证闭环:** 真实流量下 doubao 按终端用户计价、gpt-image-2 诚实 NULL、每条挂真实 `user_id`。gpt-image-2 token 计价延后(下一项工作)。

- ✅ **Plan 7 — gpt-image-2 USD token 计价 + 多币种 + 成本明细弹层(已部署 + 生产真实流量验证通过)**:按 OpenAI 官方规则给经 NewAPI 中转的 gpt-image-2 逐次生图算真实上游成本,**首次引入非 CNY 币种**。决策:原币种存、看板分币种「¥·$」、**永不跨币种相加**(D1);记 OpenAI 公示价(D2);价目表复用 `input_per_mtok=8`/`output_per_mtok=30` + 新增 `text_input_per_mtok=5`(D4);逐模态 token 加 `input_text_tokens`/`input_image_tokens`(D5);`cost_breakdown` jsonb(D6);价目版本 `2026-06-25a`(D7)。**关键认知:gpt-image-2 无公开固定 token 表 → 计价靠读每条真实 `usage`(`input_tokens_details.{text,image}_tokens`)、不硬编码。** 契约/Node SDK 0.1.3/Python SDK 0.1.2/CRM(migration `0003` + image-token 计价分支 + 拆分缺失→NULL + stats 分币种)/看板(分币种 + 弹层,Playwright 真浏览器实证)/five-elements(`imageGen` 透出 usage + `meterImage` 映射 + vendor 0.1.3,G0 确认 NewAPI 透传)端到端落地。测试基线全绿(Node 49 / Python 41 / CRM 93 / web 45 / five-elements chobo 14)。**已部署 + 生产验证(2026-06-26):** 两仓 master fast-forward(chobo `ceac5f3` / five-elements `0da1be7`),5 步上线;生产实测两步生图价格逐项对账、fugue 独立复核(文生图 A `$0.00922500`;A+参考图→B `$0.01958800`,其中**参考图输入 1521 token × $8 是最大成本**)。**踩坑教训:价目表是 CRM 进程级缓存(`server.ts:49` 启动时 `loadPriceTable` 一次),运行中改价后必须 `docker restart chobo-crm` 重载 + `npm run reprice` 回填**(已补 runbook)。部署前无 token 的旧 gpt-image-2 事件保持 NULL。

七份计划均已落地、合并入 master、**部署上线、生产真实流量验证通过**(Plan 6:chobo `2f40d33` / five-elements `b9ebbc2`;Plan 7:chobo `ceac5f3` / five-elements `0da1be7` —— gpt-image-2 已按 USD 逐模态计价、生产实测逐项对账通过)。开发日志见 `docs/dev-log.md`。

- 🚧 **AdopterA 接入(2026-06-26 自主夜间推进,功能分支未合并):** fugue 指令 #1(接入 AdopterA)+ #2(网关模型按上游 provider 的 **USD** 计价,"newapi 没有任何价格上的意义")落地。**node-ai-proxy**(gpt-5.5 全 funnel:handleChat/generate 两阶段/ggb/callLLMForJSON + gemini-3.5-flash buffered & FLASH 流式)+ **python-lesson-parser**(doubao chat + gpt-image-2 逐模态 token)接入。粗粒度归因:`account=adopter-a`、`identity_source=default`、`user_id=default`(契约加 `default` 枚举,非 missing 不告警);provider:example-gateway 网关沿用 `newapi`、Ark 直连 `doubao`(据 base_url 判定)。价目 `2026-06-26a` 加 gpt-5.5(USD in5/out30/cache0.5)+ gemini-3.5-flash(USD in1.5/out9/cache0.15,`reasoning_per_mtok=9` 让 thoughts 按 output 价、gpt-5.5 completion 含 reasoning 故不单算)。Node SDK `meterManual` 命令式 span(0.1.5,服务手写 SSE)+ Python SDK `ingest_secret` 鉴权(0.1.3)。分支:chobo `feature/adopter-a-onboarding`、adopter-a `feature/chobo`。测试 Node 52 / Python 41 / CRM pricing+validator 绿;两服务冒烟绿(**未在其真实 FastAPI/Express+Docker 运行时跑**)。**待 fugue:** 审+合两分支、起**每客户独立** chobo CRM 部署(#3 简化部署 / #4 反转共享 CRM,未做)、python 余下 chokepoint(render gpt-5.5 / grading doubao / sheet_generator / misconception,同 `chobo_meter` 套路)。

- ✅ **裸 Node(无 Docker)交付包(`deploy/customer/bare-node/`,2026-06-26,chobo `01190be`):** 给"不跑 Docker、不用我们地址、只要数据进自有库"的接入方。**解压即交付** —— 接入方仅需 Linux + Node≥20 + 自备空 Postgres,填两项 env、`./start.sh` 即起,数据全进其自有库、不连任何外部地址;含已编译 CRM + **全部生产依赖**(纯 JS 跨平台,免联网装包)+ 看板 + `交付指南.md`(环境 / 手把手 / `usage_events` 逐字段说明 + admin 示例 SQL + 计费正确性守则)+ 可复现打包脚本 `package-crm-bare.sh`。已在 `node:20` 容器对解压件**端到端验证**:自动建表、灌价 `2026-06-26a`、看板可达、错 secret→401、按终端用户 CNY 计价精确入库。与 Docker turnkey(`deploy/customer/`)并列两种交付形态。

## 规范

- 通用规范(命名、异常、日志、不吞错误、时效信息先搜索验证等)见全局 `~/.claude/CLAUDE.md`。
- Git:Conventional Commits,中文描述,功能分支。
- 被插桩对象 AdopterA 在 `C:\Code\adopter-a`(其 git 已切 `https://gitea.example.com/adopter/adopter-a.git`)—— 原则只读;**2026-06-26 fugue 已明确授权接入改动**(见上「AdopterA 接入」),在 `feature/chobo` 分支进行。
