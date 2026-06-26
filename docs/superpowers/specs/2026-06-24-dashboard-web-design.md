# 帳簿 chobo — Plan 4 看板(web/)设计

| | |
|---|---|
| **状态** | 草案 / 待 fugue 复审 |
| **日期** | 2026-06-24 |
| **范围** | Plan 4 —— 最小看板前端 `web/`,纯读 CRM 聚合 API |
| **上游权威** | [`docs/specs/2026-06-24-billing-sdk-design.md`](../../specs/2026-06-24-billing-sdk-design.md) §11(CRM 后端与看板)/ §14(模块边界) |
| **前置** | Plan 2 `@chobo/server` 已交付(ingest + 算价 + stats + reprice,merged `ba9ce40`) |

---

## 1. 背景与目标

主设计 spec §11 把看板列为 v1 交付物的最后一环、§16 里程碑序的「最小看板」。Plan 2 已经把**读侧 5 个端点**全部建好并测过(overview / timeseries / by-user·org·project / events)。本计划只做一件事:**把这 5 个端点画成一个优质、简洁、大方的只读看板**,回答产品的核心问题 —— *每个终端用户 / 机构 / 任务花了多少*。

**指导节奏(fugue 定调):** 先快速做出一个能用的最小看板,上线后拿真实客户的实际痛点再精雕细琢。因此本设计在每个分叉都选「最少零件、最快跑通」的一侧,不堆架构。

### 目标
- 一个能跑的最小看板:整体开销 / 时间趋势 / 按用户·机构·任务的排行与下钻 / 单笔审计明细。
- 忠实呈现 Plan 2 的两条计费铁律(见 §6),不在前端制造精度坏账或静默 ¥0。
- 同源部署:一个 CRM 进程同时发页面与 API,零 CORS、最少运行时依赖。

### 非目标(YAGNI,真实客户有痛点再做)
登录 / 账号管理、告警配置、价格表编辑 UI、导出 CSV、预算阈值、邮件报表、暗色主题切换、多语言。

---

## 2. 架构与服务方式

```
[浏览器 SPA] ──同源 /v1/stats/*、/v1/events──▶ [CRM 一个进程] ──▶ [Postgres]
   (web/dist)        (无 CORS、无密钥)         @fastify/static 发 web/dist
                                               + 既有 /v1/* API
   [SDK] ──🔑 X-Chobo-Secret──▶ /v1/events(仅此路由要密钥,服务器到服务器)
```

- **`web/` = 新建独立包**(React + TypeScript + Vite),与 `packages/sdk-*`、`server/` 一样**不进 workspace**、各自自洽(本仓无根 `package.json`,沿用此约定)。
- 产物:`vite build → web/dist`。
- **CRM 新增 `@fastify/static`**(Fastify 一方插件,server 唯一新增运行时依赖)发 `web/dist`;SPA 回退:**非 `/v1/*`、非 `/healthz`** 的路径一律回 `index.html`(供前端路由)。
- **非破坏式、零回归:** 静态托管按配置启用 —— 检测到 `web/dist`(或显式设 `CHOBO_WEB_DIR`)才挂;无产物时 CRM 退回纯 API(Plan 2 现状)。
- **开发期:** Vite dev server 用 proxy 把 `/v1` 转发给本地 CRM。前端**始终用相对路径**,dev 与 prod 一致,无需 base-URL 配置。

---

## 3. 对 Plan 2 的真实改动(鉴权收窄)

当前 `server/src/app.ts` 把 `secretGuard` 作为**全局 `preHandler`** 挂上 —— 一旦配 `ingestSecret`,**所有路由**(含 stats、healthz)都要 `X-Chobo-Secret`。看板是浏览器,**密钥不能放进浏览器**(源码可见),故必须改:

- 把 `secretGuard` 从全局 `addHook` 改为**只挂 `/v1/events`(ingest)路由级 `preHandler`**。
- 结果:配 secret 时**仅 ingest 需要**密钥(SDK 服务器到服务器照旧带);`/v1/stats/*`、静态资源、`/healthz` 开放。
- **安全取舍(如实记录,不隐藏):** 这意味着 stats 在 v1 是开放的 —— 安全**完全依赖网络隔离**(每接入方一套实例,部署在内网/VPN 后)。留好「以后加 dashboard 登录」的接缝,真实客户有需求再做。
- **测试同步:** 改动 Plan 2 现有 auth 测试(原断言「全局保护」→ 改断言「ingest 守、stats 开」),并记入 dev-log。

---

## 4. 它消费的数据契约(锚定 Plan 2 实际实现,非愿望)

所有 stats 端点接受同一组**筛选参数**(`server/src/filters.ts`):
`from`、`to`(epoch 毫秒数字或 ISO 串均可)、`user_id`、`org_id`、`project`、`provider`、`service`、`request_model`、`status`。

| 端点 | 响应体(关键字段) |
|---|---|
| `GET /v1/stats/overview` | `{ currency:"CNY", totals:{ events:number, input_tokens, output_tokens, total_tokens:number, total_cost: string\|null, by_status:{ success:number, failure:number } } }` |
| `GET /v1/stats/timeseries?bucket=hour\|day\|week\|month` | `{ bucket, currency:"CNY", series:[{ ts:ISO串, events:number, total_tokens:number, total_cost: string\|null }] }`;非法 bucket → 400 |
| `GET /v1/stats/{by-user\|by-org\|by-project}?limit=` | `{ dimension:"user_id"\|"org_id"\|"project", currency:"CNY", rows:[{ key: string\|null, events:number, total_tokens:number, total_cost: string\|null }] }`;limit 夹在 1..500、默认 50 |
| `GET /v1/events?include_payload=&cursor=&limit=&<筛选>` | `{ events:[ usage_events 全列(+ 可选 payload 字段) ], next_cursor: string\|null }`;cursor 为不透明 base64url;畸形 cursor → 400 |

**三个不可动摇的事实(直接决定渲染):**
1. `total_cost` 是 **numeric 字符串**(精度无损),不是 number。
2. `total_cost` 可为 **`null`**(缺价事件)。
3. `next_cursor` **不透明**,前端只回传、不解析。

---

## 5. 取数层

- 零依赖 `useFetch<T>(path, params)` hook,返回 `{ data, error, loading }`。
- 构造查询串(筛选 + bucket / limit / cursor / include_payload),`fetch` 相对路径。
- **非 2xx 或网络错 → 进入 `error` 态**,由 UI 红色显式呈现 —— **绝不吞错、绝不返回空当成功**(全局铁律 §2)。

---

## 6. 计费铁律落进渲染(核心)

- **开销 = numeric 字符串:** UI **只展示服务端算好的合计**;v1 前端**不做任何钱的加总/换算**(根除把字符串转 JS number 引入的精度坏账)。若将来确需前端聚合,另起决策,不在 v1。
- **`total_cost === null` → 显示「未定价」灰标,绝不 ¥0**(全局铁律 §2「不静默估算」)。
- 辅助 `formatCost(s: string|null)`:`null` → 「未定价」徽标;否则 `¥` + 千分位字符串(字符串级格式化,不经 number)。
- token / 计数字段服务端已转 number,仅展示,无碍。

---

## 7. 页面与组件

- **App 壳**:顶栏 = 品牌 + 导航(概览 / 审计)+ `FilterBar`。全局筛选状态(时间范围 + user/org/project/provider/model/status)提到 App 层,驱动所有端点。
- **概览页**
  - `KpiCards` ← overview(总开销 / 调用数 / Tokens / 成败)。
  - `TimeseriesChart` ← timeseries(**手写 SVG** 折线/面积,hour·day·week·month 切换)。
  - `DimensionRanking` ← by-user / by-org / by-project(三 tab 切换;**行点击 = 下钻**,把该维度值写进全局筛选)。
- **审计页**
  - `EventsTable` ← events(筛选感知;`next_cursor` keyset 翻页;行展开时按 `include_payload=true` 取 payload)。
- **共用**:`FilterBar`、`ErrorBanner`、`EmptyState`、`api/useFetch.ts`、`api/format.ts`、`api/types.ts`。

---

## 8. 错误与边界

| 情形 | 表现 |
|---|---|
| API 非 2xx / 网络错 | 该面板红色 `ErrorBanner` + 重试,绝不静默 |
| 空数据(空 seed / 无事件) | 友好 `EmptyState`,不画碎图 |
| 加载中 | 每面板骨架/占位 |
| 缺价行 | 「未定价」灰标(§6) |
| 畸形 cursor / 后端 400 | 显式提示,不卡死 |

---

## 9. 视觉:设计令牌(清亮分析型)

单一浅色主题(无暗色切换)。手写 CSS + CSS 变量,不引 Tailwind/UI 库 —— 既合「依赖极简」,又能做出辨识度、避开千篇一律的组件味。

```
:root{
  --bg:#f8fafc; --surface:#ffffff; --text:#0f172a; --muted:#64748b;
  --border:#e2e8f0; --accent:#4f46e5; --success:#16a34a; --danger:#dc2626;
  --radius:12px; --shadow:0 1px 2px rgba(0,0,0,.04);
  --font: ui-sans-serif, system-ui, "Segoe UI", sans-serif;
}
```

卡片:白底、细边、微阴影、小号大写标签 + 大号数字。趋势图:靛蓝细折线 + 极淡面积。

---

## 10. 开发数据

- `server/scripts/seed-events.ts` + npm `seed:events`:生成仿真 `usage_events`(带身份、跨时间分布、**故意含几条"未定价"模型** → `total_cost=NULL`),批量 **POST 到运行中的 CRM `/v1/events`**。
- 走真 ingest + 去重 + 算价 —— 看板对着**真 API、真响应体**开发;附带是一次真接缝冒烟。

---

## 11. 文件结构(web/)

```
web/
  package.json          # react, react-dom, vite, @vitejs/plugin-react, typescript, vitest, @testing-library/react, jsdom
  vite.config.ts        # dev proxy /v1 → CRM;build → dist
  tsconfig.json
  index.html
  src/
    main.tsx
    App.tsx             # 壳 + 导航 + 全局筛选状态
    api/useFetch.ts
    api/types.ts        # §4 响应体类型
    api/format.ts       # formatCost / formatNumber
    components/
      FilterBar.tsx  KpiCards.tsx  TimeseriesChart.tsx
      DimensionRanking.tsx  EventsTable.tsx
      ErrorBanner.tsx  EmptyState.tsx
    styles/ tokens.css  app.css
  test/                 # vitest + RTL
```

server 侧新增:`server/src/static.ts`(注册 @fastify/static + SPA 回退,按配置启用)、`server/scripts/seed-events.ts`、`ServerConfig.webDir` 字段。

---

## 12. 模块边界

| 单元 | 职责 | 接口 | 依赖 |
|---|---|---|---|
| `api/useFetch` | 取数 + loading/error | (path, params) → 状态 | 无 |
| `api/format` | 钱/数字字符串级格式化 | string\|null → 展示串 | 无 |
| `components/*` | 各视图渲染 | props ← 端点响应 | useFetch, format |
| `server static` | 发 SPA + 回退 | 文件 ↔ HTTP | @fastify/static |
| `scripts/seed-events` | 灌仿真事件 | → POST /v1/events | (运行中的 CRM) |

每个组件可独立单测;换内部实现不破坏消费方。

---

## 13. 测试策略

- **web/(vitest + RTL)**:
  - `formatCost`:`null`→未定价、字符串千分位、不经 number。
  - `useFetch`:成功 / 非2xx错 / 网络错 / loading。
  - 组件:KPI 合计渲染 + 未定价;Timeseries 点/空态;DimensionRanking tab 切换 + 下钻写筛选;EventsTable 翻页 + payload 展开 + 错误条 + 空态。
- **server/**:
  - 更新 auth 测试:配 secret 时 **ingest 401 守、stats 开放**。
  - 新增 `@fastify/static`:发 `index.html`、SPA 回退、`/v1/*` 仍走 API、无 `web/dist` 时退回纯 API。
  - 保留 testcontainers 集成。

---

## 14. 决策表(本计划锁定)

| # | 决策 | 取值 |
|---|------|------|
| 1 | 范围 | 最小看板:概览页(KPI+趋势+排行)+ 审计页;无登录/告警/导出等 |
| 2 | 取数 | 同源,CRM `@fastify/static` 发 SPA + API,零 CORS |
| 3 | 鉴权(v1) | secret 收窄到只守 ingest;stats/页面不登录,靠网络隔离(取舍已记 §3) |
| 4 | 栈 | React + TS + Vite;手写 CSS+令牌;**零依赖**手写 SVG 图表 + `useFetch` |
| 5 | 开发数据 | 真 PG + `seed-events`(含未定价行),对真 API 开发 |
| 6 | 视觉 | 清亮分析型,单一浅色主题 |
| 7 | 计费渲染 | 开销只展示服务端合计(不前端加总);缺价→未定价非¥0 |

---

## 15. 运行时与版本约束

- Node ≥ 20(与 server 一致);ESM;TypeScript 5.x。
- web/ 运行时依赖压到几乎只剩 `react` / `react-dom`;构建期 `vite` 系。
- server 新增运行时依赖仅 `@fastify/static`(Fastify 一方)。
