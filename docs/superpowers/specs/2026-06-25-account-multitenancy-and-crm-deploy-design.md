# Plan 6 — `account` 多租户维度 + CRM 部署设计

> 状态:设计待复审 · 2026-06-25 · 上位文档 `docs/specs/2026-06-24-billing-sdk-design.md`(开放项 #8 预留了租户维度)。

## 1. 背景与目标

chobo 要服务 fugue 的**多个自有应用**(five-elements + 以后的),而非只接一个。决策(与 fugue 对齐):
- **采用 B —— 一套共享多租户 CRM**(不是每接入方一套实例)。理由:都是 fugue 自己的 app,一套服务 + 一块看板看全部最省运维;chobo 是 push 模型(各 app HTTP POST 事件),**从不碰各 app 的数据库**,所以"各 app 的 PG 散在多套"对 chobo 无关 —— chobo 只需自己一个库。
- 加一个 **`account` 维度**区分"哪个 app"(spec 开放项 #8 早预留:可空列,非破坏)。
- chobo CRM 是**中立的独立服务**:独立仓库/部署/库,命名中立(`chobo-crm`),对任何 app 零耦合 —— app 对 chobo 的全部认知 = env 里一行 `CHOBO_INGEST_URL` + 自己叫什么 `account`。物理上当前先跑在 fugue 唯一的那台机,但架构上不属于任何 app。

本 plan 两部分:**Part 1** 加 `account` 维度(跨契约/双 SDK/CRM/看板,TDD);**Part 2** 把 CRM 部署到生产(独立中立服务)。

## 2. 范围与非目标

**做:**
- 契约 + Node SDK + Python SDK + CRM + 看板 全链路加 `account` 维度。
- five-elements `choboMeter` 设 `account='five-elements'`,并把现在冗余的 `project` 常量改为 `null`。
- chobo CRM 容器化 + 部署件(Dockerfile / ship-crm.sh / compose / 建库 SQL / doubao 价格 seed / nginx basic-auth vhost)。
- 修正 five-elements 生产 env(`CHOBO_INGEST_URL` 指 `chobo-crm`、共享密钥、spool 绝对路径 + 挂卷)。

**不做(非目标):**
- gpt-image-2 计价(fugue 决定往后放 —— 它是 token 计价 / 多币种 / 文本图像 token 分开,单独一个 plan)。本轮 gpt-image-2 事件照旧 `total_cost=NULL`+告警。
- 第三方接入方的硬隔离(B 的逻辑隔离够 fugue 自有 app 用;真有第三方再议)。
- 顶部"account 切换器"等高级看板交互(本轮 account 仅作过滤项 + by-account 排行,YAGNI)。
- 不改各 app 的数据库、不让 CRM 读任何 app 的库。

## 3. `account` 的语义与来源

- **`account` = 部署期常量,SDK init 配置项**,与 `service` 平级,每条事件盖戳。**不是 per-request 身份**(不进 identity ALS)——它表达"哪个 app",不随请求变。
  ```js
  chobo.init({ account: 'five-elements', service: 'five-elements-server', ingestUrl, ... })
  ```
- 缺省可空:未配 `account` → 事件 `account=null`(诚实,非破坏)。
- 维度层级:`account`(哪个 app)> `org_id`(app 内的机构)> `project`(子项目)> `user_id`(终端用户)。

## 4. Part 1 — `account` 维度(逐组件)

### 4.1 契约 `contracts/event.schema.json`
加一个可空字段(放在 `project` 之后):
```json
"account": { "type": ["string", "null"] }
```
非破坏(可选字段)。⚠ 但契约是 `additionalProperties:false` —— 必须先加该字段,CRM 的 Ajv2020 才允许事件携带 `account`。故**契约/CRM 必须先认 account,SDK 才发**(本轮 CRM 全新部署 + five-elements 重发新 tarball,天然协调)。

### 4.2 Node SDK(`packages/sdk-node`)
- `config.ts`:`ChoboConfig`/`ChoboConfigInput` 加可选 `account?: string`;`resolveConfig` 透传。
- `event.ts`:`ChoboEvent` 加 `account: string | null`;`BuildEventInput` 加 `account`;`buildEvent` 写入(默认 null)。
- `capture.ts`:`emitSuccess`/`emitFailure`/`meterStream` 在 `buildEvent({...})` 里带上 `account: getConfig()?.account ?? null`(与 `service` 同源取法)。
- 测试:配 account → 事件带之;未配 → null。
- 版本 0.1.1 → **0.1.2**(tarball 随之更新)。

### 4.3 Python SDK(`packages/sdk-python`)
- 对称改动:config 加 `account`;event 构造盖戳;捕获处带上。+ 测试。(本轮无 Python 接入方,但为契约对称一并做。)

### 4.4 CRM(`server/`)
- **迁移**:新增一条 `.sql`,`ALTER TABLE usage_events ADD COLUMN account text;` + `CREATE INDEX ... ON usage_events(account);`(迁移幂等,跟现有迁移风格一致)。
- **ingest**:把事件的 `account` 存进列(与 user_id/org_id/project 同路)。
- **filters**(`filters.ts`):`parseFilters` 加 `account`;`whereFragment` 支持按 account 过滤。
- **stats**(`stats.ts`):`DIM_COL` 加 `"by-account": "account"`(循环自动生成 `/v1/stats/by-account`);overview/timeseries/events 自动受 account 过滤(走 whereFragment)。
- 测试:account 过滤、by-account 维度、ingest 存取。

### 4.5 看板(`web/`)
- `api/types.ts`:`Filters` 加 `account`;`EventRow` 加 `account`;`Dimension` 加 `by-account`。
- `FilterBar.tsx`:加 `account` 过滤输入(与现有字段并列,受控)。
- `DimensionRanking` / `App`:`by-account` 作为可选维度(与 by-user/org/project 并列);下钻写 `account` 过滤。
- 测试:account 过滤项渲染 + 下钻写 filter。

### 4.6 five-elements(`server/src/lib/choboMeter.js`)
- `initChobo()` 的 `chobo.init({...})` 加 `account: 'five-elements'`。
- `runIdentity` 里 `project: PROJECT` 改为 `project: null`(account 已表达 app;PROJECT 常量删除或留空)。`identity_source` 逻辑不变。
- 测试更新:事件断言 `account='five-elements'`、`project=null`。
- 重新打 tarball(0.1.2)+ 重装 + 重部署。

## 5. Part 2 — CRM 部署(独立中立服务)

### 5.1 目标拓扑(贴 fugue 现有基建)
- 宿主 `203.0.113.10`,外部网络 `postgres18_default`,复用 `postgres18` PG 容器。
- **新建独立库 `chobo` + 账号 `chobo`**(与 `five_elements` 库隔离;用 `pgadmin` 超级用户建,fugue 手动跑 SQL)。
- 新容器 **`chobo-crm`**(镜像 `chobo-crm:latest`),挂 `postgres18_default`,容器内听 8787,宿主绑 `127.0.0.1:8787`。
- five-elements(同网络)用容器名直达:`CHOBO_INGEST_URL=http://chobo-crm:8787/v1/events`。

### 5.2 CRM 镜像(`chobo` 仓 `ci/Dockerfile`)
多阶段:
1. **build**:装 `server/` + `web/` 依赖,`server` tsc → `server/dist`,`web` vite build → `web/dist`。
2. **runtime**(node:20-slim):拷 `server/dist`、`server` 生产 `node_modules`、**`server/migrations`**、**`contracts/event.schema.json`**(validator 读 `../../contracts/event.schema.json`,镜像内布局须保留该相对路径)、`web/dist`、`price-seed.json`。`CMD ["node","dist/server.js"]`。
- CRM 启动 env:`CHOBO_DATABASE_URL`(指 `postgres18:5432/chobo`)、`CHOBO_PORT=8787`、`CHOBO_HOST=0.0.0.0`、`CHOBO_WEB_DIR=/app/web/dist`、`CHOBO_PRICE_SEED=/app/price-seed.json`、`CHOBO_INGEST_SECRET=<共享>`。

### 5.3 部署件(`chobo` 仓 `deploy/`)
- `ship-crm.sh`:本地 build → `docker save` → scp 到宿主 → `docker load` → 起容器(独立 compose 或 `docker run --network postgres18_default --name chobo-crm -p 127.0.0.1:8787:8787 --env-file chobo.prod.env`),镜像 fugue 现有 ship 那套。幂等、不覆盖宿主 `chobo.prod.env`。
- `docker-compose.crm.yml`(可选,与 ship-crm.sh 二选一):`chobo-crm` 服务 + external `postgres18_default` 网络。
- `chobo-init-db.sql`:建 `chobo` 库 + 账号 + 授权(fugue 用 pgadmin 跑一次)。
- `price-seed.json`:doubao 行 + alias(现成,PDF 核过);gpt-image-2 不进(待价 → NULL)。
- `nginx.chobo.conf`:子域名(如 `chobo.example.com`)vhost,复用 `*.example.com` 泛域名证书,反代 `127.0.0.1:8787`,**加 basic-auth**(`auth_basic` + htpasswd 文件;app 自身无登录,鉴权由 nginx 提供)。

### 5.4 five-elements 生产 env 修正
`server.prod.env` 的 chobo 三行(+ compose 挂卷):
```
CHOBO_INGEST_URL=http://chobo-crm:8787/v1/events
CHOBO_INGEST_SECRET=<与 CRM 同一个共享密钥>
CHOBO_SPOOL_DIR=/app/.chobo-spool          # 绝对路径
```
- `docker-compose.prod.yml` 给 server 加一个卷把 `/app/.chobo-spool` 持久化(CRM 短暂不可达时缓冲事件不随容器重建丢)。
- 改完 `ship.sh --force-recreate` 生效。CRM 一上线,spool 里积压的事件自动重投补上。

### 5.5 看板访问
- 浏览器开 `https://chobo.example.com`(nginx basic-auth)→ 看全部 app 的计量;或 SSH 隧道 `ssh -L 8787:127.0.0.1:8787 root@203.0.113.10` 开 `http://localhost:8787`。
- **无 app 登录页**:鉴权全靠 nginx basic-auth(或 IP 白名单)。

## 6. 数据流(端到端)

```
five-elements 容器(account=five-elements, CHOBO_INGEST_URL=chobo-crm:8787)
  --HTTP POST 事件(x-chobo-secret)--> chobo-crm 容器(postgres18_default)
       --算价(doubao 现成 / gpt-image-2 NULL)+ 落 chobo 库(account 列区分)-->
  nginx(basic-auth)/ SSH 隧道 --> 看板(按 account 过滤看全部 app)
```

## 7. 错误处理与不变量(延续)
- SDK 永不阻塞;CRM 不可达 → 事件落盘(绝对路径 + 挂卷)→ 重投,永不丢。
- `account` 缺失 → null(诚实);gpt-image-2 缺价 → `total_cost=NULL`+告警(非 ¥0)。
- ingest 受 `x-chobo-secret` 保护;看板/stats 开放,靠 nginx basic-auth + 内网绑定。
- 算价只在 CRM;契约 `additionalProperties:false` 保证字段纪律。

## 8. 测试策略
- **契约/SDK**(Node vitest + Python):配 account → 事件带之 / 未配 → null。
- **CRM**(vitest + testcontainers):迁移加列;ingest 存 account;account 过滤;by-account 维度。
- **看板**(vitest/RTL):account 过滤项 + 下钻写 filter。
- **five-elements**(jest):事件断言 account='five-elements'、project=null。
- **部署**:非 TDD —— 由 fugue 跑 ship-crm.sh 起 CRM、修 five-elements env 重部署,SSH/nginx 开看板核对:five-elements 真实流量按 account 归因、doubao 计价、gpt-image-2 NULL。

## 9. 仓库触面
- **chobo**:contracts(+1 字段)、sdk-node(account+版本 0.1.2)、sdk-python(account)、server(迁移+ingest+filters+stats)、web(filter+dim+types)、`ci/Dockerfile`、`deploy/{ship-crm.sh,docker-compose.crm.yml,chobo-init-db.sql,nginx.chobo.conf}`、`price-seed.json`、docs。
- **five-elements**:`lib/choboMeter.js`(account + project=null)、`vendor/chobo-sdk-0.1.2.tgz`、`server.prod.env`(fugue 在宿主改)、`docker-compose.prod.yml`(spool 卷)、`.env.example`、测试。

## 10. 决策记录(本轮已锁)
| # | 决策 | 选择 |
|---|---|---|
| 1 | 多租户模型 | B:一套共享 CRM + `account` 维度(非每接入方一套) |
| 2 | account 来源 | SDK init 配置项(与 service 平级),每事件盖戳,缺则 null |
| 3 | 时序 | B1:先做 account 维度,再部署 |
| 4 | five-elements project | 改为 `null`(account 已表达 app) |
| 5 | SDK 覆盖 | Node + Python 都做(契约对称) |
| 6 | CRM 部署形态 | 独立中立服务,复用 postgres18(独立 `chobo` 库),挂 postgres18_default |
| 7 | 看板暴露 | nginx 子域名 + basic-auth(app 无登录) |
| 8 | gpt-image-2 计价 | 往后放(token/多币种,单独 plan);本轮 NULL |

## 11. 开放项(实现期/部署期消解)
1. nginx 子域名具体名(`chobo.example.com`?)+ A 记录 —— fugue 部署时定。
2. `chobo` 库账号密码 —— fugue 用 pgadmin 设强密码。
3. 共享 `CHOBO_INGEST_SECRET` 值 —— 实现期生成(如 `openssl rand -hex 32`)。
4. Dockerfile 里 `contracts/` 相对路径布局 —— 实现期按 validator 的 `../../contracts/` 摆正并冒烟。
5. gpt-image-2 token 抓取(现在抓存 vs 完全往后放)—— fugue 之前倾向往后放;若改主意再补 SDK 抓 usage。
