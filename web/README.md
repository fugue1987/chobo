# @chobo/web — 看板前端

## 用途

chobo 看板是**纯读前端**,对接 CRM(`@chobo/server`)的聚合 stats API,回答「每个终端用户 / 机构 / 任务花了多少」。数据由 CRM 算好后吐出,看板不做任何金额计算。

## 技术栈

- **React 18 + TypeScript + Vite**
- **手写 CSS + 设计令牌**:清亮分析型配色,无第三方 UI 组件库
- **零额外运行时依赖**:图表手写 SVG(`TimeseriesChart`、`DimensionRanking`),取数自写 `useFetch`,格式化自写 `format`
- 测试:vitest + @testing-library/react(34 测试)

## 目录结构

```
web/
  src/
    api/        # types.ts(API 响应类型)
    hooks/      # useFetch + Error/Empty 状态组件
    lib/        # format.ts(金额/数量格式化,计费铁律落实)
    components/ # FilterBar / KpiCards / TimeseriesChart / DimensionRanking / EventsTable
    pages/      # OverviewPage / EventsPage
    App.tsx / main.tsx / tokens.css
  test/         # 各组件 + hooks + lib 单测
```

## 本地开发

需要本地 CRM 监听 `:8787`。Vite 把 `/v1` 代理到 CRM,解决开发期跨域。

```bash
# 启动 CRM(见 server/README.md)
cd server && CHOBO_WEB_DIR=../web/dist node dist/index.js

# 另开终端启动 Vite dev server
cd web && npm run dev
# → http://localhost:5173  (Vite 把 /v1/* 代理到 http://localhost:8787)
```

## 构建与部署

```bash
cd web && npm run build
# → web/dist/  (index.html + assets/)
```

构建产物由 CRM 通过 `@fastify/static` **同源托管**,零 CORS:

```bash
# 在 server/ 设置环境变量后启动
CHOBO_WEB_DIR=/absolute/path/to/web/dist \
CHOBO_INGEST_KEY=your-secret \
node dist/index.js
```

浏览器访问 `http://localhost:8787` 即可看到看板。不设 `CHOBO_WEB_DIR` 时 CRM 退回纯 API 模式,互不干扰。

## 测试

```bash
cd web && npm test          # vitest run — 34 测试 × 8 文件
cd web && npm run typecheck # tsc --noEmit
```

## 计费铁律(渲染层保障)

- **开销以服务端 `numeric` 字符串呈现**,前端不做金额加总,避免 JS 浮点漂移
- **缺价显「未定价」,绝不显 ¥0**:收到 `total_cost: null` 时渲染 `—`,不归零
- 以上两条由 `format.ts` 单测(`test/format.test.tsx`)钉死

## 端到端本地联调

1. 确认 Docker 已启动
2. 启动 PostgreSQL 并跑迁移:

   ```bash
   cd server
   docker run -d --name chobo-pg -e POSTGRES_PASSWORD=chobo -p 5432:5432 postgres:16-alpine
   DATABASE_URL=postgres://postgres:chobo@localhost:5432/postgres node dist/migrate.js
   ```

3. 植入价格种子 + 仿真事件:

   ```bash
   NODE_PATH=./dist node dist/seed-prices.js   # 或 npm run seed:prices
   CHOBO_INGEST_KEY=dev npm run seed:events     # POST 300 条真实 ingest 事件
   ```

4. 启动 CRM(含 SPA 托管):

   ```bash
   DATABASE_URL=postgres://postgres:chobo@localhost:5432/postgres \
   CHOBO_INGEST_KEY=dev \
   CHOBO_WEB_DIR=$(pwd)/../web/dist \
   node dist/index.js
   ```

5. 浏览器打开 `http://localhost:8787`

   看板显示:doubao 模型有定价(非空金额)/ example-gateway 模型未定价(显「未定价」)—— 诚实混合场景。

## 鉴权说明

v1 看板不要求登录。`CHOBO_INGEST_KEY` 只保护 `POST /v1/events`(写入路径),stats 读 API 开放靠内网隔离。后续可在 Nginx/反向代理层加认证,无需改动 CRM 代码。
