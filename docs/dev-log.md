# chobo 开发日志

## 2026-07-01 — 价目表运行时热更新 + 接入方自助加模型

- CRM 价目表从"开机加载一次"改为可变持有器 + 轮询热载(`CHOBO_PRICE_REFRESH_SEC` 默认 60,0=关闭;崩溃保留上一版 + 防清空 + 原子替换);`syncPriceSeed` 抽成独立 `price-seed.ts`;新增 `seed-cli`(版本增量写库)+ 裸 Node 包 `update-prices.sh` 一键(写价+回填);接入方自助加模型文档(价目行字段 + 三元组自查)。
- 纯 CRM+打包+文档,**不改 SDK/契约**,不发 SDK 版本。历史 NULL 仍靠 `reprice`。
- 测试基线全绿(CRM 109)。
- **合并 + 上线:** subagent-driven 8 任务(逐任务两段评审 + opus 终审「ready to merge」)→ 合入 `main` → 部署到生产 CRM;boot 日志 `priceRefreshSec:60` 证明热载在跑,fugue 亲测通过。
- **首个自助加价实例:** 新增 `doubao-seed-2.1-pro` 价目(chat,无分档,¥6 in / ¥30 out / ¥1.2 cache,CNY)+ 别名归一 `doubao-seed-2-1-pro-260628`,价目版本 `2026-06-26a → 2026-07-01a`。按小时的缓存「存储」费(0.017/时)不建模(chobo 按 token 计、不按时)。新增人读参考 `docs/模型定价.md`(镜像 `price-seed.json`)。
- **接入方交付(AdopterA,裸 Node 无 Docker):** 重打 `dist/chobo-crm-bare-*.tar.gz`(含热载 + `seed-cli` + `update-prices.sh` + price-seed)。`交付指南.md「以后新增模型价格」` 补 doubao-2.1-pro **完整 4 步活样例**(抄官方价 → 库内 `SELECT DISTINCT` 查三元组 → 加行/别名 → `update-prices.sh`);`README §7` 补「旧版一次性升级(不丢数据)」+ 计费安全警告(升级别用示例 price-seed 顶掉接入方现行价)。接入方应用服务零改动(纯 CRM 升级,SDK/契约未变)。

## 2026-06-24 — 立项 + 设计定稿

- **立项:** chobo = 独立、可泛化的 LLM 用量计量 + 计费产品;AdopterA 为**首个接入方**(非边界)。
- **调研落地:** 完成 AdopterA 两个 AI 服务的全量调用点/咽喉扫描;调研业界低侵入计量计费做法
  (LiteLLM / Helicone / Langfuse / OpenMeter / OTel GenAI);核实 new-api 能力(只到 `(user, token)`,
  做不了下级归因 —— 正是 chobo 要补的)。
- **决策锁定**(详见 spec §18 决策表):进程内 SDK 拦截、不加网关、覆盖锁定首个接入方两个服务、
  SDK→CRM ingest、自足算价(Y)+ new-api 对账为可选后装、身份 header(v1)/JWT 可热插拔、
  Node 显式取 usage、价格表豆包分档+按张+带版本、失败全落账、投递永不阻塞+幂等、
  payload 默认仅元信息、CRM 后端 = Node+TS、运行时约束(Py 3.12 基准 / Node 18 ESM+CJS)。
- **产出:** 设计 spec 写定并提交 → `docs/specs/2026-06-24-billing-sdk-design.md`。
- **下一步:** `writing-plans` 出 v1 实现计划。

## 2026-06-24 — Plan 1(Python SDK)+ Plan 3(Node SDK)交付,均合并入 master

- **Plan 1 — 契约 + Python SDK:** `contracts/`(事件 + 价格表 JSON Schema 2020-12,`POST /v1/events` 信封)
  + `packages/sdk-python`(stdlib-only `chobo`:identity contextvars / event / extractors / config / transport /
  capture `@meter` / runtime / 公共 API)。**35 测试绿**,subagent 逐任务 TDD。独立评审**抓出并修复**落盘 drain
  的并发丢事件竞态(原子消费:锁内读+截断,剩余追加)。计划:`docs/superpowers/plans/2026-06-24-contracts-and-python-sdk.md`。
- **Plan 3 — Node SDK:** `packages/sdk-node` = `@chobo/sdk`,TypeScript,**双格式 ESM+CJS**,**零运行时依赖**,
  Node ≥18。`meter`(缓冲)+ `meterStream`(流式透传,取末块/末值 usage);身份 AsyncLocalStorage;transport 同款
  韧性(落盘/退避/有界 shutdown,含 `drainSpool` try/catch 防后台未捕获拒绝崩进程)。**43 测试绿**,publint/attw 干净。
  Node 取 usage 事实(OpenAI `include_usage` 空 `choices` 末块 / Gemini `usageMetadata` 末值;node-ai-proxy 三类传输)
  经独立复核 → `docs/research/2026-06-24-node-sdk-grounding.md`。计划:`docs/superpowers/plans/2026-06-24-node-sdk.md`。
- **Plan 2 前置已备:** `docs/research/2026-06-24-plan2-prerequisites.md`(6 决策)+
  `docs/research/2026-06-24-plan2-pricing-draft.md`(公开价目草案,待 fugue 核实 + 补合同价;豆包 32K+ 档需 Ark 控制台)。
- **下一步:** Plan 2 —— CRM `server/`(ingest + 算价 + stats)。

## 2026-06-24 — Plan 2(CRM server/)交付

- **栈:** `@chobo/server`,Node 20 LTS · ESM · TypeScript · **Fastify 5.8.5 + 自建 Ajv2020 校验器** · postgres.js 3.4.9 · 纯 `.sql` 启动迁移 · vitest + @testcontainers/postgresql(因 pg-mem 不强制 `numeric(18,8)` 精度被否决)。
- **51 测试 × 16 文件全绿;tsc --noEmit 干净;`tsc` 构建产出 `dist/*.js`。** 已 fast-forward 合入 `master`(`ba9ce40`)。
- **交付方式:** subagent 驱动 TDD,6 组实现、每组两段式评审(spec 合规 → 代码质量)+ 终审(opus)。
- **能力:** `POST /v1/events`(信封 Ajv2020 校验 + 逐事件校验,**宽容部分接收**不毒批,`ON CONFLICT` 幂等去重,写时算价)· `GET /v1/stats/{overview,timeseries,by-user|org|project,events}` · `/healthz` · `reprice` CLI(先用后配回填)· 可选 ingest 密钥 · 优雅退出。算价全 CNY,带版本 `price_table` + `model_aliases`(豆包 dated id 归一),缺价→`total_cost=NULL`+告警(不静默 0)。
- **评审抓出并修复的 8 个真 bug(各配回归测试),其中 4 个会真丢钱/坏账:**
  - **🔴 ingest 毒批静默丢事件(终审 opus 发现,最关键):** schema 合法但**无法入库**的事件(token 超 PG int 上限 / 坏时间戳 / 负数)会 `500` 整批 → SDK 无限重投 → 永久静默丢事件(违反 spec §9"丢=丢钱")。改为逐事件**可存储性闸门**:坏事件 → `rejected` 计数+告警、整批仍 `2xx`;+ 可配 `bodyLimit` 余量防大批 413 毒重投;+ 负 token→0 成本守卫。
  - **🔴 `reprice --all` 毁历史:** 重算时对新价格表中**不存在**的旧型号会把历史 `total_cost`/`price_table_version` 覆盖为 NULL。改为跳过该 UPDATE、保全旧快照 + 告警。
  - **🔴 `/v1/events` 分页丢行:** 游标用毫秒精度 Date,而同一批 ingest 事件共享微秒级 `created_at`(`now()` 单事务恒定)→ 第 2 页空、静默丢行。改用 **epoch 微秒 bigint** keyset(base64url 不透明游标)。
  - **🔴 迁移锁失效:** `pg_advisory_lock` 加在池里的某条连接、迁移却在别的连接执行 → 锁形同虚设。改用 `sql.reserve()` 固定单连接持锁 + 跑全部迁移。
  - **Ajv NodeNext 具名导入:** default import 解析为 namespace、不可 `new`;须用具名 `import { Ajv2020 } from "ajv/dist/2020.js"`(+ `InstanceType<typeof Ajv2020>` 作类型),ajv-formats 经 namespace 取 `.default`。
  - **computeCost model 映射:** ingest 传入须把 `request_model` 映射到 `model`(否则全部不命中、静默不计价)。
  - **payload 字节截断:** 按 UTF-8 **字节**计长(非字符),用 `Buffer` 截断防多字节裂开 / 孤 surrogate(PG jsonb 拒收)。
  - **stats 输入校验:** `limit` 非有限/负数会客户端触发 `500`,须 clamp;`cursor` 形状非法须返 400 而非透传 PG 错。
- **example-gateway 三项待价:** `gpt-5.5` / `gemini-3.5-flash` / `gpt-image-2` 的 CNY 价目 await fugue 给出后再 seed;在此前这三项 `total_cost=NULL` + 告警,然后 `npm run reprice` 回填历史(先用后配)。
- **下一步:** Plan 4 —— 看板 `web/`(纯读前端,对接 stats API 已定的响应体)。

## 2026-06-25 — Plan 4(看板 web/)交付

- **栈:** `@chobo/web`,React 18 + TypeScript + Vite + vitest/RTL。**零额外运行时依赖**:图表手写 SVG(`TimeseriesChart`、`DimensionRanking`)+ 自写 `useFetch` + 手写 CSS 设计令牌(清亮分析型)。同源托管:CRM 加 `@fastify/static`(非破坏性——无 `web/dist` 时退回纯 API 模式)。

- **server 侧改动:** ingest 密钥闸门**从全局路由收窄到只守 `/v1/events`**(stats 读 API 须开放供看板访问;安全靠内网隔离,与 v1 定位一致)。新增 `seed-events` 确定性仿真脚本:可配数量(默认 300)、POST 真实 ingest 请求、含未定价 example-gateway 模型——全栈联调零额外工具。

- **计费铁律落渲染层:** 开销保 numeric 字符串精度(前端不做金额加总)、`total_cost: null` 显「未定价」而非 ¥0 —— 由 `format.ts` 单测 + 各组件测试钉死,无法退化。

- **交付方式:** subagent 驱动 TDD,14 任务,每任务两段式评审(spec 合规 → 代码质量)+ 关键任务 opus 审(T6 计费格式化、T12 EventsTable、T13 端到端)。

- **评审抓出并修的真问题(择要):**
  - **EventsTable 状态机 bug ①** — 筛选切换时带旧 keyset cursor 发废请求(新 URL+旧 cursor 组合 → 服务端返空):改为渲染期重置 cursor 消除竞态。
  - **EventsTable 状态机 bug ②** — 展开行触发分页重置并自折叠(cursor 变化 → 重渲 → 折叠所有展开行):payload 改为显式勾选框状态,解耦展开/分页。
  - **formatCompact 进位边界** — `999999` 应格式化为 `999,999` 而非 `1.0M`(1M 阈值须严格大于,非大于等于)。
  - **FilterBar 日期框受控化** — 清空操作后可视输入框未同步(value 未绑 state):改为受控 `<input>`。
  - **看板鉴权收窄** — 原全局 auth hook 拦截所有路由含 stats,导致无 key 场景看板无法访问:收窄到仅 ingest 路由。
  - **`.nav`/tab 焦点环可达性** — 纯 CSS active 状态无键盘焦点环:补 `:focus-visible` 样式。

- **端到端验证:** docker PG + CRM(`CHOBO_WEB_DIR` + 价目种子)+ `npm run seed:events` 写入 300 条事件 → CRM 同源发 SPA、`/v1/stats/*` 返回数据。doubao 模型正常计价、example-gateway 模型未定价混合出现,总开销为非空 numeric 字符串——诚实、可计费的全栈链路打通。

- **测试:** server **66 测试 × 18 文件**全绿;web **34 测试 × 8 文件**全绿;server tsc 干净;web tsc 干净;web build 干净(154 kB JS / 1.4 kB CSS,43 模块)。

- **下一步:** **Plan 5 —— 把 SDK 接进 AdopterA + 真实端到端**(改动 AdopterA,需显式同意);example-gateway 三模型(`gpt-5.5` / `gemini-3.5-flash` / `gpt-image-2`)CNY 价目待 fugue 给出后 `npm run reprice` 回填历史。

## 2026-06-25 — Plan 5(接入首个真实接入方 five-elements)交付

- **接入方转向:** 原计划接 AdopterA(朋友项目;改其前端/后端层需显式同意、风险高),改为接 fugue **自有的 five-elements server**(微信小程序后端,Node CommonJS + Express),零第三方同意风险;AdopterA 顺延为后续可选接入方。Python SDK 这轮不涉及(项目纯 Node),留后续单独 e2e。
- **SDK 增强(chobo 侧,`plan5-sdk-ingest-secret` 分支):** `@chobo/sdk` 补 `ingestSecret` → ingest POST 发 `x-chobo-secret` 头(对接设了 `CHOBO_INGEST_SECRET` 的 CRM),版本 0.1.0→0.1.1,**45 测试绿**,publint/attw 干净。以 **tarball vendoring** 交付(`npm pack` → five-elements `vendor/chobo-sdk-0.1.1.tgz`,`file:` 依赖,CJS `require` 解析)。
- **接入(five-elements 侧,`chobo-metering` 分支):** 唯一接入点 `lib/choboMeter.js`(init/shutdown/runIdentity/meterChat/meterImage,全 **env 闸门**:未配 `CHOBO_INGEST_URL` → 字节等同)。两咽喉原地 `meter`:`lib/llm.js` chatComplete(doubao 文本,provider=`doubao`,usage 取 `data.usage`,重构成内层返回解析后 JSON)、`lib/imageGen.js` generateImage(gpt-image-2 经 NewAPI,provider=`newapi`,按张 image_count=1;ark 回退→`doubao`)。身份注入三处:devAuth(请求路径 `req.user.id`)+ forumAiWorker/visualJobWorker(worker 路径 `job.user_id`),project=常量 `five-elements`、identity_source=`jwt`、缺身份诚实标 `missing`。index.js 启动 `initChobo` + SIGTERM/SIGINT `shutdownChobo` flush。
- **交付方式:** subagent 驱动 TDD,A/B/C 三阶段跨两仓;关键任务(choboMeter 接入点 / 文本咽喉重构 / 身份注入)实现与评审均 opus。**five-elements 侧 12 chobo 测试绿**(choboMeter ×4、llm.metered ×3 含成功/HTTP 失败/abort、imageGen.metered ×1、identity ×2、worker-identity ×2 含 worker 归因+抛错传播)。评审抓修/加固:测试目录纠正到项目约定 `tests/`、文本咽喉 abort 路径测试、worker 路径身份+抛错传播测试、计费不变量注释(image_count 固定 1 的 n>1 风险)、shutdown 不静默 warn。
- **算价:** doubao 文本现成(0–32K 档 PDF 核过 + alias 已 seed,五行 `max_tokens` 小稳落该档);**gpt-image-2 经 NewAPI 的每张价待 fugue 给出** → 给出前 `total_cost=NULL`+告警(诚实),CRM 加 `{provider:"newapi",model:"gpt-image-2",operation:"image",per_image:X}` 行后 `npm run reprice` 回填。
- **状态:** 两仓实现均已交付并测试绿,工作在功能分支(`plan5-sdk-ingest-secret` / `chobo-metering`),**端到端由 fugue 部署上线后真实场景验证**(无正式用户,安全);验证步骤见 five-elements `server/CHOBO_INTEGRATION.md`。
- **下一步:** fugue 部署验证 + 给 gpt-image-2(newapi)每张价;AdopterA 接入顺延为后续可选。

## 2026-06-25 — Plan 6(account 多租户维度 + CRM 独立部署)交付

- **account 维度端到端落地(Part 1):** 一条 `account` nullable 字段贯穿全栈:
  - **契约:** `event.schema.json` 加 `account` nullable string 字段。
  - **Node SDK 0.1.2:** init 配置项 `account` → 每事件 cover;`sdk-node` **47 测试绿**。
  - **Python SDK 0.1.1:** 对称实现,同样 init 配置 + 每事件盖戳;`sdk-python` **39 测试绿**。
  - **CRM:** 迁移 `0002_account.sql`(nullable `account` 列 + B-tree 复合索引 `(account, created_at)`);ingest 存 `account`;stats 支持 `?account=` 过滤;新增 `/v1/stats/by-account` 维度端点。`server` **70 测试绿**(Testcontainers/真实 PG)。
  - **看板:** account 过滤输入框 + 按账户排行 tab + 下钻;修复了 `drill()` fall-through footgun(改用 `Record<Dimension>` map 完全覆盖所有维度)。`web` **38 测试绿**。
- **five-elements 接入方更新(Part 1):** `chobo.init` 加 `account:'five-elements'`;每事件 `project` 改 `null`(account 已能识别接入方,project 退回 null);SDK 以 `chobo-sdk-0.1.2.tgz` tarball 重新 vendor。**12 chobo 子集测试绿**。
- **CRM 独立部署件交付(Part 2):**
  - **Dockerfile:** `ci/Dockerfile` 多阶段(server `tsc` + web `vite build` + contracts/migrations 运行时布局);e2e 容器冒烟**通过**(`/healthz` ok、`/v1/stats/by-account` 200、看板 HTML 正常服务、迁移 + 价格 seed 自动跑)。
  - **deploy/ 目录:** `docker-compose.crm.yml`(挂外部网络 `postgres18_default`,CRM 以 `chobo-crm` 服务名可达)、`ship-crm.sh`(一键构建+推送+部署)、`chobo-init-db.sql`(建 `chobo` 数据库)、`nginx.chobo.conf`(子域名 basic-auth 守看板)、`CRM_DEPLOY_RUNBOOK.md`(分步部署说明)。
  - **repo-root `.dockerignore`** 防大文件入镜像;**`price-seed.json`** 豆包价格种子。
- **opus 评审:** CRM ingest 路径、five-elements 计费路径、Dockerfile 均经 opus 对抗评审通过。
- **测试基线(终审实测):** Node SDK 47、Python SDK 39、CRM 70、web 38、five-elements chobo 子集 12 —— 全绿。
- **仍待办(由设计决策延后):** fugue 执行 CRM 部署 runbook(CRM 尚未上线);gpt-image-2(provider=newapi)token 计价延至后续 plan → 当前 `total_cost=NULL`+告警。five-elements 全量 jest 套件约 148 个失败为**环境原因**(无本地 Postgres),非 chobo 回归。
- **下一步:** fugue 部署 CRM → 端到端验证;gpt-image-2 价格给出后 `npm run reprice` 回填。

## 2026-06-25 — Plan 5 部署落地 + Plan 6 启动(account 多租户 + CRM 部署)

- **five-elements 部署成功**(fugue 在生产宿主 `203.0.113.10` 跑 `deploy/ship.sh`)。途中踩一个 tarball 坑并修复:依赖缓存层 `ci/Dockerfile.cache` 只 `COPY server/package*.json` 就 `npm ci`,而 `@chobo/sdk` 是 `file:vendor/*.tgz` 本地依赖 → tarball 不在镜像内 → `ENOENT`(npm 误报 "corrupted")。**修复:缓存层加 `COPY server/vendor ./vendor`**(five-elements `38a763a`)。核过 tarball sha512 与 lockfile 一致,无真损坏。
- **发现 CRM 尚未部署:** chobo CRM(`@chobo/server` + 看板)是独立服务、**从没部署过**(chobo 仓无 Docker/部署设置)。且 five-elements 生产 env 误用 `.env.example` 占位 `CHOBO_INGEST_URL=http://127.0.0.1:8787/...` —— 容器内 127.0.0.1 是容器自身 loopback,发不到任何 CRM。现状:five-elements 在产生事件 → 发 127.0.0.1 失败 → 落盘 `/app/server/.chobo-spool` 重试(永不丢、未送达)。**看板无登录页**(Plan 4:鉴权只守 ingest,看板/stats 开放,靠网络隔离)。
- **生产拓扑(已摸清,部署期用):** 宿主 `203.0.113.10`;后端走 `docker-compose.prod.yml`,挂**外部网络 `postgres18_default`**,连宿主已有 PG 容器 `postgres18`(库 `five_elements`,见独立 reference memory)。`OPENAI_BASE_URL=https://api.example-gateway.com/v1`(gpt-image-2 网关其实是 example-gateway,当前标签 `newapi`)。
- **架构决策(与 fugue 对齐):chobo 要服务多个自有 app → 不走"每接入方一套实例",改 **B:一套共享多租户 CRM** + `account` 维度**(chobo 是 push 模型,从不碰各 app 的库,故"各 app PG 散多套"无关)。chobo CRM = 中立独立服务,对任何 app 零耦合。
- **Plan 6 spec 写定**(`docs/superpowers/specs/2026-06-25-account-multitenancy-and-crm-deploy-design.md`,chobo `726c6cf`):Part 1 跨契约/双 SDK(Node+Python)/CRM/看板加 `account`(SDK init 配置项、每事件盖戳、缺则 null;five-elements `project` 改 null;SDK 0.1.1→0.1.2);Part 2 CRM 独立部署(Dockerfile + ship-crm + 复用 postgres18 的独立 `chobo` 库 + 挂 postgres18_default + nginx 子域名 basic-auth + five-elements env 修正指 `chobo-crm:8787` + spool 挂卷)。gpt-image-2 计价(token/多币种)往后放、本轮 NULL。
- **下一步:** fugue 复审 spec → `writing-plans` → subagent TDD 做 Part 1 → 出 Part 2 部署件 → fugue 部署。

## 2026-06-25 — Plan 6 部署上线 + 生产真实流量验证(闭环)

> 合并:chobo `2f40d33`、five-elements `b9ebbc2`(均 fast-forward 入 master,功能分支已删)。

- **CRM 上线:** 本地 `bash deploy/ship-crm.sh`(构建→save→scp→远程 load→`compose up`→health)。容器 `chobo-crm` 跑在外部网络 `postgres18_default`,连**独立 `chobo` 库**(fugue 用 pgadmin 建库+账号),启动自迁移(`0001`+`0002_account`)+ 自 seed 豆包价(`priceVersion 2026-06-24a`,3 行价 + 1 alias),宿主绑 `127.0.0.1:8787`。
- **看板对外:** 子域名 `https://chobo.example.com`,nginx vhost 复用 `*.example.com` 泛域名证书 + **basic-auth**(宿主无 `apache2-utils`,改用 `openssl passwd -apr1` 生成 htpasswd)。ingest(`/v1/events`)走容器内网 `chobo-crm:8787`、不经 nginx,故 basic-auth 不挡接入方上报。验证:无凭据 `401`、带凭据 `/healthz` → `{"ok":true}`。
- **five-elements 接回:** 本地 `SKIP_FRONTEND=1 bash deploy/ship.sh` 把带 `account` 的新版后端(SDK 0.1.2)+ 修正后的 env 部署上去。env 三行(`CHOBO_INGEST_URL=http://chobo-crm:8787/v1/events`、`CHOBO_INGEST_SECRET`=与 CRM 同一密钥、`CHOBO_SPOOL_DIR=/app/.chobo-spool`)+ compose 持久卷 `chobo_spool`。容器内实测:`@chobo/sdk` 版本 `0.1.2`、`fetch http://chobo-crm:8787/healthz` 通(当初 `127.0.0.1` 坑彻底解决)。
- **🎯 生产真实流量验证(闭环达成):** 看板「审计明细」出现 five-elements 真实事件 —— **doubao 文本按终端用户计价**(CNY,每 token 有效单价随 input/output 配比浮动 = CRM 分项算价的证据)、**gpt-image-2 诚实标「未定价」**(cost=NULL,非假 ¥0)、**每条挂到真实 `user_id`**(`usr_03d9...`)。Tier-2 per-end-user 归因在生产被证实跑通。
- **顺手清理:** 删掉 five-elements `deploy/` 里 7 个构建溅出的零字节/碎片垃圾文件(未追踪)。
- **仍待办:**
  1. **gpt-image-2 定价(下一项工作)** —— 它走 NewAPI(实为 example-gateway 网关),OpenAI gpt-image-2 是 **token 计价、计美元、文本/图像 token 分项**。这与现系统「全 CNY 单币种、无 FX」冲突,且当前 SDK 在生图咽喉只记 `image_count:1`、**没抓 token usage**。所以是个两段设计:(a) SDK/接入方从 gpt-image-2 响应抓真实 usage,(b) CRM 加 token-based USD 计价 + 多币种支持。需单独 brainstorm→spec→plan。在此之前诚实记 NULL。
  2. 看板 basic-auth 口令偏弱(`admin:123qwe`,公网可达),建议轮换强口令(覆盖 `/etc/nginx/.htpasswd.chobo` 即时生效)。
- **下一步:** 解决 gpt-image-2 定价(见上「仍待办 1」)。

## 2026-06-25 — gpt-image-2 USD token 计价 + 多币种 + 成本明细弹层(实现交付,待合并/部署)

> 跨两仓功能分支:chobo `feat/gpt-image-2-pricing`、five-elements `feat/gpt-image-2-token-metering`。subagent-driven TDD 逐任务,金额关键任务上 opus 对抗评审。spec `docs/superpowers/specs/2026-06-25-gpt-image-2-pricing-design.md`、plan `docs/superpowers/plans/2026-06-25-gpt-image-2-pricing.md`。

- **G0 闸门(实现前):** fugue 确认 NewAPI **原样透传 OpenAI images 接口的 `usage`** —— `input_tokens`/`output_tokens`/`total_tokens` + `input_tokens_details.{text_tokens,image_tokens}`。逐模态计价可行,闸门关闭。
- **诚实化纠偏(fugue 当场抓的):** 早先 spec 写「约 ¥0.08/张」是借文档示例 token 拼的估算、且用 1024 小图口径,**作废**。查实(本人 WebFetch OpenAI 官方):gpt-image-2 **无公开固定 token 表**(数千分辨率动态路由),官方只给每张美元估算 low/med/high @1024² ≈ $0.006/$0.053/$0.211;而 five-elements 实际用 1536²/1440×2560 大图 + 带参考图(edits),按面积粗放外推一次「头像+背景」≈ $0.05–0.10。**结论:绝不硬编码 token 表 —— 计价完全靠读每条真实响应的 `usage`**(单测用明确标注的合成 golden `$0.10650000`,端到端真值待生产取)。
- **关键决策(D1–D7):** 币种**原币种存、看板分币种「¥·$」、永不跨币种相加**(D1,首次引入非 CNY);记 OpenAI 公示价非付 example-gateway 那笔(D2);计费 key 仍 `(newapi,gpt-image-2,image)` 不改名(D3);价目表复用 `input_per_mtok=8`/`output_per_mtok=30` + 新增 `text_input_per_mtok=5`(D4);逐模态 token 加 `input_text_tokens`/`input_image_tokens`(D5);`cost_breakdown` jsonb 对全站已定价事件都写(D6);价目新版本 `2026-06-25a` 完整快照(doubao 原样 + gpt-image-2,D7)。
- **chobo 侧(Part A–C):**
  - **A 契约 + 双 SDK:** 契约加 2 可空 token 字段;Node SDK Usage/ChoboEvent/buildEvent 透传 + bump **0.1.3**;Python SDK 对称 + bump **0.1.2**。
  - **B CRM:** migration `0003`(价目表 `text_input_per_mtok` + 用量表 `input_text_tokens`/`input_image_tokens`/`cost_breakdown`,token 列用 **integer** 与既有列一致);`computeCost` image-token 分支(text×5 + image×8 + output×30,USD)+ `cost_breakdown`,**拆分缺失→NULL(不静默近似)、cached 永不出现**;chat 也产 breakdown;ingest/reprice 存+回填;seed 列扩;**stats 三接口改 `cost_by_currency`(GROUP BY currency + handler JS 合并,永不跨币种相加)**;价目版本 2026-06-25a。
  - **C 看板:** `formatCost(cost,currency)`(¥/$ 符号)+ `formatCostList`;KPI/排行分币种;趋势按币种单线切换;**审计明细总价 hover/点击弹「成本明细」弹层**(逐行 输入/输出×文本/图像 · tokens · 单价 · 该项成本)。
- **five-elements 侧(Part D,G0 后):** vendor `@chobo/sdk` 0.1.3;`imageGen.js` `imageFetch`/`generateOpenAI`/`generateArk` 透出响应 `usage`(纯增量,persistImage 无感);`meterImage` extractor 读 `result.usage.input_tokens_details` 映射逐模态 token,**缺 usage 安全降级为仅 image_count:1、绝不抛错**。
- **opus / 评审抓到的真问题(全已修):**
  1. ingest 的 `computeCost` 调用漏传 `input_text_tokens`/`input_image_tokens` → gpt-image-2 会算成未定价(B4 修)。
  2. 迁移把 token 列写成 `bigint` → postgres.js 返回字符串 → pricing `finite()` 视为非有限 → 静默 0;**改 `integer`** 与既有 token 列一致(根因修)。
  3. 看板弹层在 `.card{overflow:hidden}` 里用 `position:absolute` → **真浏览器裁剪不可见**(jsdom 测不到);**改 `position:fixed` + cell rect 锚定**逃逸裁剪。**Playwright 真浏览器冒烟实证**:弹层 `visible:true`、`withinViewport:true`,三行明细($0.00018500/$0.00258400/$0.00816000)正常,KPI/排行分币种「¥·$」正常。
  4. `main()` 入口守卫只单侧规范化路径分隔符 → 跨平台直跑隐患,两侧统一规范化(硬化)。
  5. 弹层 hover/pin 自抵消、role/键盘无障碍、modality 标签缺空格 —— 评审一并修正。
- **测试基线(实测全绿):** Node SDK **49**、Python SDK **41**、CRM **93**(真 Postgres testcontainers)、web **45**、five-elements chobo 子集 **14**。
- **上线步骤(待 fugue 执行):**
  1. 合并两分支(chobo `feat/gpt-image-2-pricing`、five-elements `feat/gpt-image-2-token-metering`)。
  2. 重建并部署 CRM 镜像 → migration `0003` 自动跑。
  3. **一次性灌价目版本 `2026-06-25a` 到 prod**(`seedIfEmpty` 仅空表灌入,生产库已有数据 → 需手工:连 prod `chobo` 库插入 gpt-image-2 USD 行 + doubao 三行的新版本快照;给精确 INSERT 即可)。
  4. 重发 five-elements(SDK 0.1.3)。
  5. `npm run reprice` 回填**部署后**带 token 的 NULL gpt-image-2 事件。
- **诚实的回填边界:** 部署前已落库的 gpt-image-2 事件**没有逐模态 token**(当时未抓)→ **保持 NULL,不回填**(拿不到的数不假装)。计价只对 five-elements 抓 token **之后**的新事件生效。
- **下一步:** fugue 合并两分支 + 按上述步骤部署;之后从真实流量取一条 gpt-image-2 `usage` 核对端到端每张价。

## 2026-06-26 — Plan 7 部署上线 + 生产真实流量验证(闭环)

> 两仓 master fast-forward 合并:chobo `ceac5f3`、five-elements `0da1be7`。按 plan §11 五步部署上线。

- **部署:** 重建 CRM(migration `0003` 自动跑加列)→ 手工灌价目版本 `2026-06-25a`(`seedIfEmpty` 仅空表灌入,生产库非空 → psql 手工 INSERT,doubao 三档原样 + gpt-image-2 USD)→ `SKIP_FRONTEND=1 bash deploy/ship.sh` 重发 five-elements(SDK 0.1.3 + imageGen 抓 usage)→ `npm run reprice` → 看板验收。
- **踩坑(我步骤的疏忽,fugue 当场点出):价目表是 CRM 进程级缓存** —— `server.ts:49` 启动时 `loadPriceTable` 一次,`ingest.ts:124` 用缓存闭包 `priceTable()`、**不重查库**。fugue 先起 CRM(缓存当时的 `2026-06-24a`、无 gpt-image-2 行)、**之后**才灌 `2026-06-25a` → 运行中进程看不到新价 → 新生图 ingest 时判 NULL(reprice 是独立进程会重查库,但测试图是 reprice 之后才生的)。**修复:`docker restart chobo-crm`(重载价表,`migrate` 幂等空跑、`seedIfEmpty` 跳过)+ `docker exec chobo-crm npm run reprice` 回填。** 教训:写「运行中改状态」的部署步骤,必须把「让服务重新读(重启/reload)」一并写清 —— 已补进 `CRM_DEPLOY_RUNBOOK.md`。
- **生产真实流量验证(闭环,fugue 两步生图实测 + 独立复核):**
  - 文生图 A(`quality=low`,1536²,无参考图):text 171×$5 + out 279×$30 (/1M) = **`$0.00922500`**
  - A+文字→图 B(low,1440×2560,带 1536² 参考图):text 254×$5 + **图输入 1521×$8** + out 205×$30 = **`$0.01958800`** —— 参考图输入是最大成本($0.0122)。
  - 逐项费率 × 实测 token 完全对账;币种 USD;成本明细弹层三行正确。
- **token 机制洞察(记一笔,后续定价/优化用):**
  - **输出图像 token** = 按 `quality`+尺寸的「渲染计费」抽象(low → 两三百 token),**不随尺寸线性**(动态路由:图 B 1440×2560 输出 205 < 图 A 1536² 输出 279)。
  - **输入参考图 token** = 视觉编码器「高保真读图」;**gpt-image-2 强制高保真输入、无开关**,1536² 参考图 ≈ 1521 token(≈9 个 512px tile),$8/1M 下成带参考图步骤的最大头。省钱杠杆在「参考图」而非输出 quality。
- **诚实边界:** 记的是「OpenAI 公示费率 × 实测 token」的 list price,**≠ example-gateway 实际加价账单**;OpenAI 也没公布这俩非标尺寸(1536²/1440×2560)的每张价,故验证靠「逐项费率 × 实测 token + token 量级 sanity」而非对某公布数。
- **状态:Plan 7 已部署、生产真实流量验证通过、价格 fugue 独立复核合理。**

## 2026-06-26 — AdopterA 接入(node-ai-proxy + python-lesson-parser)

> fugue 绿灯自主推进(从 `main` 切 `feature/chobo`)。两仓功能分支:chobo `feature/adopter-a-onboarding`、adopter-a `feature/chobo`。复用 five-elements 范式(「互联网边际效应」,不重起炉灶)。

**背景修正(fugue 当场纠 + 我读真 `.env`):** AdopterA 真实在用模型以 `.env` 为准,非代码扒出的依赖(外行项目堆了一堆没清的依赖)。真实:node-ai-proxy = **gpt-5.5**(example-gateway,openai 协议)+ **gemini-3.5-flash**(example-gateway,google 原生);python-lesson-parser = **doubao-seed-2-0-pro-260215**(Ark 直连)+ **gpt-image-2**(example-gateway)+ gpt-5.5(课件渲染)。身份:AdopterA 不接 per-end-user → **粗粒度**(`account=adopter-a`/`identity_source=default`/`user_id=default`;fugue 定「不要为别人担忧」;`default` 入契约枚举,非 missing 不告警)。provider:example-gateway 网关沿用 five-elements 的 `newapi` 标注(各客户自有 CRM 不冲突),doubao Ark 直连标 `doubao`。

**chobo 侧(`feature/adopter-a-onboarding`):**
- **计价(`0dae2df`):** price-seed 版本 `2026-06-26a` 加 `newapi/gpt-5.5`(in$5/out$30/cache$0.5)、`newapi/gemini-3.5-flash`(in$1.5/out$9/cache$0.15 + `reasoning_per_mtok=9`),USD,官方页实访核对。**计费口径(该重视的):gpt-5.5(OpenAI completion 已含 reasoning)→ reasoning_per_mtok=null 不重复计;gemini(candidates 不含 thoughts)→ reasoning_per_mtok=9 让 thoughtsTokenCount 按 output 价计,贴合 Google「$9 含 thinking」。** 契约 `identity_source` 加 `default`。
- **Node SDK `meterManual`(`87c79dc`,0.1.5):** 命令式计量 span(observe/done/fail),服务于手写 SSE 解析循环;复用 emit/buildEvent;+3 测试。
- **Python SDK `ingest_secret`(`d6c3b5e`,0.1.3):** 补 Node SDK 已有的 x-chobo-secret 鉴权头(共用 secret-guarded CRM)。
- 测试:Node SDK **52** / Python SDK **41** / CRM pricing 18 + validator 9 全绿。

**adopter-a node-ai-proxy(`97283402`):** `lib/choboMeter.js` 唯一接入点(env 闸门 no-op);server.js init + 请求边界粗粒度身份中间件 + 优雅 flush;gemini.js 3 处 generateContent buffered 计量;resource.js gpt-5.5 全 funnel(handleChat/generate stage1+2/ggb 流式 → 加 `stream_options.include_usage` + meterManual span 抓尾包;callLLMForJSON buffered);googleStreamClient 透出 usageMetadata + 消费者接 startGeminiChat span(FLASH gemini-resource-gen)。vendor 0.1.5。**冒烟 4 funnel 落出形状正确事件。**

**adopter-a python-lesson-parser(`2fbec8c7`):** `app/chobo_meter.py` 唯一接入点(纯 ASGI 身份中间件避开 BaseHTTPMiddleware 的 contextvar 不传播坑;模块级 init 让默认身份传播至后台/worker 任务;`provider_for` 据 base_url 判定 Ark→doubao / example-gateway→newapi);main.py 中间件 + init + shutdown;providers/upstream.py(doubao chat,`CompletionResponse.raw` 含 usage)+ providers/image.py(gpt-image-2 — 先抓 `data.usage`(原代码丢弃)再 meter,逐模态 token)。vendor 0.1.3 wheel + requirements。**冒烟 doubao + gpt-image-2 落出形状正确事件,发 x-chobo-secret。**

**本次范围 / 待后续(同 chobo_meter 套路接入即可):** python-lesson-parser 的 render 课件(gpt-5.5)/ grading 主观题视觉(doubao)/ sheet_generator / misconception 未接;node 端流式调用中途失败/客户端断开不落账(SDK meterStream v1 已知限制)。

**部署(待 fugue):** 两仓 feature 分支审核合并 → AdopterA 起一套**自有** chobo CRM(灌 `2026-06-26a` 价目;⚠ 改价后须 `docker restart` 重载进程缓存)→ 两服务 `.env` 配 `CHOBO_INGEST_URL`/`CHOBO_INGEST_SECRET` + 重启 → 真实流量验证逐项对账。

## 2026-06-26(续)— AdopterA 接入收尾:剩余咽喉全接 + 快速验证 + turnkey 交付件

> fugue 对齐:朋友项目无线上真实用户 → 可加快;「30+ 人日」评估是干扰项,无意义。指令:python/node 该接入的都接入即可合并;.env 是固定一套(与 chobo/five-elements 一致);加快速验证让数据打到 `chobo.example.com`(看见即可);最后做一个**交出去就不操心**的 turnkey docker(接入方自备 postgres,改 env 重启即接好)。

**1. python-lesson-parser 剩余咽喉全接(承接上一段「待后续」)。** 先读真实 `.env` + 全 `httpx.AsyncClient` 边界定位,确认完整咽喉集:
- **`services/upstream_api.py:request_upstream`** —— 真正的大咽喉:`_chat`/`_chat_json`/JSON 修复(`_repair_json_via_llm` 回落 `_chat`)+ 12 处流水线(parse/structure/resources/goal_generation/lesson_flow*/document/quiz/learning_situation)**全经此一处 HTTP**。在此一点 meter(provider=doubao,model 取请求体支持 per-call 覆盖)即全覆盖。
- **`pipeline/render/slide_design.py` + `pipeline/sheet_md_generation.py`** 各 3 协议 leaf(openai 活、google/claude 当前 `RENDER_LLM_PROTOCOL=openai` 为死配置,仍按对应提取器包好,翻协议即正确)。RENDER_*=gpt-5.5/newapi。
- **`routes/grading.py`** `grade_subjective`(GRADING_*=doubao)+ `analyze_misconception`(MISCONCEPTION_*→RENDER_*=gpt-5.5/newapi)。
- 已计量(上段):providers/upstream.py + providers/image.py。**跳过(诚实标注):** `sheet_generator._call_vision_llm/_call_text_llm` 用 `SHEET_*`,真实 `.env` 未配(空 base_url → 运行即废)→ 死/坏路径不接,留一行注记,配 SHEET_* 时一行包上即可。下载(`image_check`/`file_saver`/sheet 1449)与本地 node 渲染代理非模型调用,排除。
- **chobo_meter 扩展:** `meter_chat` 加 `extract=` 参;补 `gemini_usage`(`usageMetadata`:promptTokenCount/candidatesTokenCount + **thoughtsTokenCount 单列 reasoning_tokens**,贴合价表 reasoning=output 价)/`claude_usage`(Messages usage)本地提取器(放 AdopterA 侧 glue,不动 SDK)。
- **计费口径不变(铁律):** 全活跃路径均 openai 兼容 → SDK `openai_chat_usage` 覆盖;每次真实上游调用(含 json 重试、修复)各落一条 = 各计一次真金白银,正确不漏不重(`request_upstream` 与 `providers/upstream.py` 是两套独立 httpx,无双计)。

**2. 验证(committed `tests/test_chobo_metering.py`,真过 meter 管线抓事件):** patch SDK 传输层 `urlopen` 抓上报 body + 各模块 httpx 回灌带 usage 假响应,断言每咽喉落出正确 provider/model/usage/account/identity_source。覆盖 request_upstream(doubao+cached)、slide_design 三协议(openai/gemini reasoning/claude cache_read)、sheet_md(gpt-5.5)、grade_subjective(doubao,route 级 vision)。**身份洞察:** 生产靠 ASGI 中间件按请求注入 default 身份(传播进 funnel);测试在异步上下文显式 set_identity 等价模拟。回归:我改的 upstream_api+grading 10 测试绿 + 冒烟绿;**全套 4 个 `test_sheet_generator` 失败经 `git stash` 我的改动复现 = 其测试套件预存的顺序耦合 bug,与本次无关**(单跑 `test_sheet_generator` 29 绿)。

**3. 快速验证 → `chobo.example.com`(`deploy/nginx.chobo.conf` 改 + `deploy/ADOPTER_QUICK_VALIDATION.md`):** 现 vhost 把 basic-auth 加在整 server 块 → 外部接入方(发 x-chobo-secret 非 basic-auth)被挡。改**分层鉴权**:`limit_except POST` 让**仅 POST `/v1/events` 豁免 basic-auth**(靠 CRM x-chobo-secret),**GET 审计与看板仍 basic-auth**(共享 CRM 含 five-elements 真实 per-end-user 数据,读侧不可裸奔)。AdopterA 配 `CHOBO_INGEST_URL=https://chobo.example.com/v1/events` + 同 secret,看板 account 过滤 `adopter-a` 即见。**价目现实:已部署 CRM 仍 `2026-06-25a`(只 doubao+gpt-image-2)→ doubao 流程即时计价、gpt-5.5/gemini 暂 NUL(诚实);要它们也计价须刷新 CRM 镜像(合并后 `ship-crm.sh` 重打,boot 自动加载 `2026-06-26a`,免手工 seed+restart 的缓存坑)。**

**4. turnkey 交付件(`deploy/customer/`,directive #3 简化 + #4 每客户独立):** CRM boot 自动 `migrate`(建表)+ `seedIfEmpty`(灌价)→ 接入方指向**空库**即自就绪。交付包 = 镜像 tar(`package-crm.sh` 产出)+ `docker-compose.yml`(自备 postgres,默认)/`docker-compose.all-in-one.yml`(连 postgres 一键,零依赖试用)+ `chobo-crm.env.example` + `README.md`。接入方 4 步:建空库 → `docker load` → 填 env(DATABASE_URL+secret)`docker compose up -d` → 业务服务加 `CHOBO_INGEST_URL`/`SECRET` 重启。**降级保证:不配 URL 业务字节等同、零风险。** 两 compose `docker compose config` 校验通过。

**`.env` 固定块(node-ai-proxy / python-lesson-parser 同一套):** `CHOBO_INGEST_URL` + `CHOBO_INGEST_SECRET` + `CHOBO_SPOOL_DIR`;`account=adopter-a`/`user_id=default` 由接入点写死,无需配。

**状态:** python/node 该接入的全接、冒烟+回归绿;快速验证 nginx 改 + runbook + turnkey 交付件就位。**待 fugue:** 审 + 合两 feature 分支;在生产宿主 reload nginx(放开公网 ingest)起快速验证;按需用 `deploy/customer/` 给 AdopterA 起独立 CRM。

## 2026-06-26(续 2)— 裸 Node(无 Docker)CRM 交付包

> fugue 指令:某接入方不部署 Docker、不愿用我们的公网地址、只想把数据落进自己的 Postgres 用自家 admin 展示。给一个"解压即交付"的无 Docker 包 + 文档。

**交付件(`deploy/customer/bare-node/`,chobo `01190be`):** 与现有 Docker turnkey 并列的第二种形态。接入方前置仅 **Linux + Node≥20 + 自备空 Postgres**;解压 → 填两项 env(`CHOBO_DATABASE_URL`/`CHOBO_INGEST_SECRET`)→ `./start.sh` 即起。包含:已编译 `server/dist` + **全部生产依赖**(`npm ci --omit=dev`,纯 JS 跨平台、免联网装包)+ `migrations/` + `contracts/` + 看板 `web/` + `price-seed.json`(`2026-06-26a`)+ `start.sh`(按解压位置自动设 price-seed/web 路径,容忍 CRLF)+ `chobo-crm.env.example` + `README.md` + `交付指南.md` + 可复现 `package-crm-bare.sh`。

- **布局要点(易踩):** 复刻 Docker 镜像的两级布局(`server/dist` 与 `contracts/`/`web/`/`price-seed.json` 同级)—— validator 按 `dist/../../contracts`、server 按 `dist/../migrations` 取路径,布局错则 ingest 500。打包脚本带"无原生 `.node` 二进制"闸门保证跨平台。
- **交付指南.md(给接入方,重点在数据库):** 0 环境 / 1 手把手跑起来 / 2 `usage_events` **逐字段**含义(归因·时间·模型·用量·成本·状态分组;`provider`=计费通道非厂商、`total_cost=NULL≠0`、`currency` 永不跨币种相加)+ 其余三表 + 4 条 admin 示例 SQL(按终端用户出账 / 按模型 / 按天 / 用户明细)+ 6 条计费正确性守则。
- **端到端验证(`node:20` 容器 = 接入方 Linux 主机的等价物;包本身零 Docker):** 解压件丢进 `node:20-bookworm-slim` 连一次性 PG,6 项断言全过 —— 自动建表、灌价 `2026-06-26a`、`/healthz` 与看板 200、错 secret→**401**、对 secret→`{"accepted":1}`、DB 行 `u-test|verify|0.01120000|CNY|2026-06-26a`(按终端用户 CNY 计价精确)。附带证实 **Windows 上打的 `node_modules` 在 Linux 直接能跑**(纯 JS)。
