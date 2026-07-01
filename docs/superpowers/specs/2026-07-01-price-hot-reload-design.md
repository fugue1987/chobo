# 价目表运行时热更新(轮询热载)+ 接入方自助加模型 — 设计

> 状态:设计待复审 · 2026-07-01 · 上位文档 `docs/specs/2026-06-24-billing-sdk-design.md`、`server/src/server.ts` 的 `syncPriceSeed`(Task #102 落地的版本增量 upsert)。

## 1. 背景与目标

模型频繁出新(如 Claude Sonnet 5)。今天给 CRM 加一个模型价格要"发版",根因是两处与部署耦合:

1. **价目表在启动时读入内存、之后永不重读。** `server.ts` 的 `const priceTable = await loadPriceTable(sql)` 只跑一次,下游经 `() => priceTable` 闭包取值 → 光写库不重启进程不生效。
2. **seed 文件烤进镜像。** `price-seed.json` 在 Docker 镜像内 → 改价 = 重建镜像。

**目标(与 fugue 对齐):** 让 chobo 把这套能力做成**接入方自助、一劳永逸**的交付件。该接入方是 fugue 朋友的项目,拿的是**裸 Node 交付包**(无 Docker、用自有 Postgres)。交付后,接入方**永远**能自己加新模型的价格,**零重启、零重建、无需再找 fugue 或我们**:改一行 JSON → 跑一条命令 → 约 1 分钟内全实例自动生效。

**关键杠杆:** `ingest.ts` 本就每请求调 `priceTable()` 取值。把闭包背后的 `const` 换成**可变引用**,再加一个从库定时重读并**原子热替换**的刷新器,ingest 热路径**零改动**即可感知新价。

## 2. 范围与非目标

**做:**
- CRM 侧:可变价目表持有器 + 轮询刷新器(`price-store.ts`);`syncPriceSeed` 抽成独立纯模块(`price-seed.ts`);`config.ts` 加 `CHOBO_PRICE_REFRESH_SEC`;`server.ts` 装配;新增 `seed-cli`(把 seed JSON 版本增量写库,复用已审计逻辑)。
- 交付件:裸 Node 包(`deploy/customer/bare-node/`)加 `update-prices.sh` 一键封装(写价 + 回填);turnkey Docker(`deploy/customer/`)文档补 `docker exec` 加价路径与 seed 文件挂载。
- 文档:裸 Node `交付指南.md` 加"以后自助加模型"章节(价目行字段格式 + 如何从自有库找准三元组 + 币种 + 别名 + 一条命令);`CLAUDE.md` / `docs/dev-log.md` 同步。

**不做(非目标):**
- **不加**任何"改定价"的 HTTP 端点(轮询热载已满足;端点是新的可变更定价受控面,YAGNI + 更大攻击面)。
- **不用** LISTEN/NOTIFY(为省约 1 分钟延迟维护专用 listen 连接 + 断线重连,机件不划算)。
- **不做**每请求读库定价(热路径每事件多一次 DB 往返,不可接受)。
- **不改** `reprice` 逻辑、不改定价数学、不改契约、不改任何 SDK —— 本特性**纯 CRM + 打包 + 文档**。故**不需要发任何 SDK / 契约版本**。
- 不做价目管理 UI。

## 3. 机制抉择(已定:轮询热载)

在三选一里(与 fugue 确认)选**轮询热载**:服务每 `CHOBO_PRICE_REFRESH_SEC` 秒从库重读 MAX 版价目表并原子热替换。理由:机件最少、最难出错、Postgres 保持唯一真源;代价仅为"最长约 N 秒的生效延迟"(该窗口内新模型算 NULL,可被 `reprice` 补)。落选:即时 reload 端点(多受控面)、LISTEN/NOTIFY(多机件)。

## 4. 组件设计(逐文件)

### 4.1 `server/src/config.ts` — 加刷新间隔
- 加 `CHOBO_PRICE_REFRESH_SEC`,默认 `60`;解析为整数,校验 `≥ 0`;非法则 `throw`(与现有 `CHOBO_PORT` 等同款校验)。
- `0` = **关闭轮询** = 退回今天的"仅开机加载一次"。默认 `60`:现网镜像重建后会开始每 60s 一次**轻量 SELECT** 重读价表(计价结果不变,只是多了"自动拾取新价"的能力,无需改任何配置);要完全保持旧行为则显式设 `0`。
- `ServerConfig` 类型加 `priceRefreshSec: number`。

### 4.2 `server/src/price-seed.ts` — 抽出 `syncPriceSeed`(纯模块)
- 把现在写在 `server.ts` 里的 `export async function syncPriceSeed(sql, seedPath)` **原样移到**新文件 `price-seed.ts`(逻辑不变、签名不变)。
- `server.ts` 与新的 `seed-cli.ts` 都从此处 import。**目的:CLI 不必 import 服务入口**(否则会把 Fastify/app 装配拉进一个命令行工具,且触发 `isMain` 判定的脆弱性)。
- 现有 `server/test/seed.test.ts` 的 import 路径从 `../src/server.js` 改为 `../src/price-seed.js`(仅路径,断言不变)。

### 4.3 `server/src/price-store.ts` — 可变持有器 + 刷新器(唯一新增运行时逻辑)
接口:
```ts
export interface PriceStore {
  current: () => PriceTable;          // 传给 buildApp;ingest 每请求读一次
  refreshNow: () => Promise<boolean>; // 从库重读并原子热替换;返回"是否变化"(供测试/日志)
  start: (intervalMs: number) => void;
  stop: () => void;
}
export function createPriceStore(sql: Sql, initial: PriceTable): PriceStore;
```
行为:
- 内部 `let table = initial`;`current = () => table`。**单次赋值热替换**(JS 单线程,ingest 读到的永远是某个完整快照,无撕裂读)。
- `refreshNow()`:
  1. `const next = await loadPriceTable(sql)`(整包 try/catch)。
  2. **防清空守卫:** 若 `next.version === ""`(库里一行价都没有)而当前 `table` 有版本 → 判为异常(误删/迁移中),**保留上一版 + warn**,`return false`。防止一次误操作把全站定价打成 NULL。
  3. 否则:`const changed = next.version !== table.version || next.rows.length !== table.rows.length`;**总是**赋值 `table = next`(这样同版本内手工改价也能被拾取);仅当 `changed` 打 `info` 日志 `price table reloaded {from, to, rows}`;`return changed`。
  4. `catch`(DB 抖动):`warn "price refresh failed, keeping last-good"`,**不改 `table`、不抛、不 crash**,下一拍重试;`return false`。
- `start(ms)`:`this._timer = setInterval(() => void refreshNow(), ms)`;`this._timer.unref()`(不阻塞进程退出/测试)。
- `stop()`:`clearInterval(this._timer)`。

### 4.4 `server/src/server.ts` — 装配 + 抽出 syncPriceSeed 后的引用
```ts
const initial = await loadPriceTable(sql);
const store = createPriceStore(sql, initial);
const app = buildApp({ sql, cfg, priceTable: store.current });   // 传 getter,app.ts/ingest.ts 零改
if (cfg.priceRefreshSec > 0) store.start(cfg.priceRefreshSec * 1000);
```
- shutdown() 里在 `app.close()` 前 `store.stop()`。
- 启动日志加 `priceRefreshSec`。
- `syncPriceSeed` 改为从 `./price-seed.js` import(见 4.2)。

### 4.5 `server/src/seed-cli.ts` — 授权侧写库入口(自助加价的机器)
镜像 `reprice-cli.ts` 的引导:
```ts
const cfg = resolveConfig(process.env);
const sql = createSql(cfg.databaseUrl);
try {
  await migrate(sql, join(here, "..", "migrations"));   // 幂等,保证 price_table 存在(独立可跑)
  const seedPath = process.argv[2] ?? cfg.priceSeedPath; // 位置参数优先,回落 CHOBO_PRICE_SEED
  if (!seedPath) throw new Error("chobo seed-cli: 需给 seed 文件路径(位置参数或 CHOBO_PRICE_SEED)");
  const r = await syncPriceSeed(sql, seedPath);
  console.log(r?.inserted
    ? `chobo seed: inserted version ${r.version}`
    : `chobo seed: version ${r?.version} 已在库 → 无改动(要改动请 bump price-seed.json 的 version)`);
} finally { await sql.end({ timeout: 5 }); }
```
- **不新增任何写逻辑**,只调已审计的 `syncPriceSeed`(版本增量、已存在版本一律 no-op、保留人工调价)→ 与开机 seed 同一套,**库与 seed 文件不漂移**。

### 4.6 `server/package.json` — 脚本
加 `"seed:prices": "node dist/seed-cli.js"`(与现有 `"reprice"` 并列)。

## 5. 计费铁律 / 错误处理(本设计最关键的一节)

- **不静默、不清空:** 刷新失败保留上一版并告警;库空守卫防止把全站打成 NULL。二者都"出问题必留痕",符合铁律。
- **无半写读:** 一个版本由 `syncPriceSeed` 在单条 `INSERT`(postgres.js 批量插入,单语句)内整版写入;`loadPriceTable` 单查询读 MAX 版。轮询只会看到"旧版"或"完整新版",**永不读到半版**。
- **历史 NULL 仍靠 reprice:** 热载只改**未来**定价;补价前落库的 NULL 由现成 `reprice`(默认只补 `total_cost IS NULL`、对无匹配三元组跳过、绝不用 NULL 覆盖历史快照)回填。逻辑**不变**。
- **幂等 / 可审计不变:** 版本仍不可变(改价 = bump 版本);`price_table_version` 仍随事件落库;`syncPriceSeed` 仍绝不覆盖已有版本。
- **可退回:** `CHOBO_PRICE_REFRESH_SEC=0` 关闭轮询即回到今天的行为。

## 6. 交付件集成

### 6.1 裸 Node 包(本接入方主用形态)
- `seed-cli.js` 随 `server/dist` **自动进包**(`package-crm-bare.sh` 第 38 行整目录拷贝 `server/dist`)。
- 新增 `deploy/customer/bare-node/update-prices.sh`(打包脚本第 43-46 行一并拷入,`chmod +x`):像 `start.sh` 一样读 `chobo-crm.env` + 设 `CHOBO_PRICE_SEED` 默认,然后**一条龙**:
  1. `node "$ROOT/server/dist/seed-cli.js" "$ROOT/price-seed.json"` —— 把新版本写库。
  2. `node "$ROOT/server/dist/reprice-cli.js"` —— 回填补价前的 NULL(默认只补 NULL,幂等安全)。
  3. 打印:"新价已写库;运行中的 CRM 将在 ≤ CHOBO_PRICE_REFRESH_SEC 秒内自动生效;历史 NULL 已回填。"
- `chobo-crm.env.example` 注释掉一行 `# CHOBO_PRICE_REFRESH_SEC=60`(说明:改价生效延迟;0=关闭)。
- `package-crm-bare.sh`:第 43-47 行加 `cp "$SRC_DIR/update-prices.sh" "$STAGE/"` + `chmod +x`。

### 6.2 turnkey Docker 包(`deploy/customer/`,保持一致)
- 镜像已含 `dist` → `seed-cli` 天然在内。文档补:`docker exec chobo-crm node dist/seed-cli.js /app/price-seed.json` + `docker exec chobo-crm node dist/reprice-cli.js`。
- compose 把 `price-seed.json` 作为**卷挂载**(host 可编辑),并在 env 示例加 `CHOBO_PRICE_REFRESH_SEC=60`。

## 7. 接入方自助文档(裸 Node `交付指南.md` 新增章节)

标题:"以后新增模型价格(自助,无需联系我们)"。内容:
1. **三步:** 编辑 `price-seed.json`(**bump `version`** + 追加一行价目行,保留全集) → `./update-prices.sh` → 约 60 秒内自动生效。
2. **价目行字段格式**(逐字段,含单位):`provider` / `model` / `operation`(chat|image) / `input_tier_max`(0=不分档) / `input_per_mtok` / `output_per_mtok` / `cache_read_per_mtok` / `reasoning_per_mtok` / `text_input_per_mtok`(仅图像 token 计价) / `per_image`(旧平价分支) / `currency`(如 `CNY`/`USD`,**永不跨币种相加**)。给一个 chat 模型样例行。
3. **如何找准三元组**(最易错点):定价按 `(provider, model, operation)` **精确匹配**。别猜,直接查自有库:
   ```sql
   SELECT DISTINCT provider, request_model, operation, currency
   FROM usage_events WHERE request_model LIKE '%你的新模型%';
   ```
   按查出来的真实 `provider`/`operation` 去配价;若上游返回的 model 带版本后缀,加一条 `aliases` 归一映射。
4. **提示:** `version` 不 bump 就 no-op(`update-prices.sh` 会明确提示);币种按上游真实计价单位填。

## 8. 测试(用现成 `@testcontainers/postgresql` harness)

- `server/test/price-store.test.ts`(新):
  - 初始表 → 库里插入更高版本 → `refreshNow()` 返回 `true` 且 `current().version` 变新。
  - 模拟刷新失败(向 `createPriceStore` 传一个会抛错的 `sql` 桩,或指向坏库)→ `refreshNow()` 返回 `false`、`current()` 仍是上一版、不抛。
  - 库空守卫:当前有版本、库被清空 → `refreshNow()` 保留上一版、返回 `false`。
  - `start`/`stop`:定时器 `unref` 且 `stop` 后不再刷新(可注入极短间隔断言调用次数或直接断言 `stop` 清了 timer)。
- `server/test/config.test.ts`(改):`CHOBO_PRICE_REFRESH_SEC` 默认 60 / `"0"` / 非法值(`"-1"`、`"x"`)三类。
- `server/test/seed.test.ts`(改):import 路径改到 `price-seed.js`;新增一条断言 `seed-cli` 语义 —— 同版本再跑 = `inserted:false`。
- `server/test/e2e.test.ts`(改/加):运行中经 `syncPriceSeed` 插入含新模型的新版本 → `store.refreshNow()` → ingest 该新模型事件 → 断言 `total_cost` **非 NULL**(证明整环:写库→热载→定价)。
- 全量基线保持全绿(CRM 现 102 测试 + 上述新增)。

## 9. 上线 / 交付 / dogfood 顺序

1. 实现 + 测试全绿。
2. **先自有 dogfood:** 把本特性部署到 fugue 自有的共享 CRM(`ship-crm.sh` 重建镜像 → `up -d`;默认 60s 轮询)。加一条价目行(`seed-cli` / 改 seed + `update-prices.sh`)→ 观察日志 `price table reloaded` + 用一条测试事件断言该模型非 NULL 计价 —— 在自有 infra 上先跑通"无重启加价"整环。
3. **再交付自建 CRM 的接入方:** `bash deploy/customer/bare-node/package-crm-bare.sh` 重打裸 Node 包(自动含 `seed-cli` + `update-prices.sh`)→ 在 `node:20` 容器对解压件端到端复验(设 `CHOBO_PRICE_REFRESH_SEC=3` 便于观测)→ fugue 把 `.tar.gz` + `交付指南.md` 发接入方 → 他们**重新部署 CRM**(一次性,替换已在跑的旧包)→ 之后加任何新模型皆免重启。
   - 注:已自建 CRM 的接入方**不需要为本特性合并任何应用仓分支** —— vendored SDK 不变、契约不变;拿到的是新 CRM 包 + 重部署,应用代码零改动。
4. **加某模型价格时(团队与接入方同守):** 该模型的真实**费率 / 币种 / `(provider, model, operation)` 三元组**必须**据实核对** —— 查上游官方价、从真实 `usage_events` 查三元组,**不得凭记忆填**(尤其非 CNY 币种;网关中转模型按上游 provider 的 USD 计价)。

## 10. 开放项

- 默认间隔 **60s**(可配);无其它开放项。
