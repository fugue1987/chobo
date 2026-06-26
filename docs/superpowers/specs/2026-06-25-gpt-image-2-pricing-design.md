# gpt-image-2 计价（USD token 计价 + 多币种 + 成本明细弹层）设计 spec

> 状态：设计已逐节获 fugue 认可（2026-06-25）。这是权威设计文档；实现以本文为准，有出入回改本文。
> 上游权威：`docs/specs/2026-06-24-billing-sdk-design.md`（总设计）+ `CLAUDE.md`（不变量铁律）。

## 1. 目标

让 chobo 按 **OpenAI 官方 token 规则、以美元** 给 `gpt-image-2`（经 NewAPI 中转）逐次生图算出真实上游成本，
并在看板上对每一次生图提供 **逐项成本明细**（输入/输出 × 文本/图像）。这是 chobo 的「下一项工作」，
也是系统首次引入 **非 CNY 币种**。

**首个（也是当前唯一）接入点**：fugue 自有的 `five-elements` 微信小程序后端，生图咽喉 `server/lib/imageGen.js`
经 NewAPI 调 gpt-image-2（`provider='newapi'`、`request_model='gpt-image-2'`、当前 `n` 恒为 1）。

## 2. 事实地基（已核实，2026-06-25）

### 2.1 价格（USD / 1M tokens）— 本人 WebFetch 实测 + fugue 截图双重确认

来源：<https://developers.openai.com/api/docs/pricing>（本人实抓，数字与 fugue 截图逐项吻合）。
`platform.openai.com/docs/pricing` 现 301 重定向到此页（即权威页）。

| 维度 | Input | Cached input | Output |
|---|---|---|---|
| **Image** | $8.00 | $2.00 | $30.00 |
| **Text** | $5.00 | $1.25 | —（无） |

> 注意区分 gpt-image-1（数字不同：$10 image-in / $40 image-out）。本表是 gpt-image-2 专属。
> Batch 档为半价（不在本期范围）。

### 2.2 响应里带逐模态 token 拆分（→ token 计价可行）

直连 images 接口（`POST /v1/images/generations`、`/v1/images/edits`）的 `usage`（**下例仅示字段形状，数字非真实生成**；真实数量级见 §6.1）：

```json
"usage": {
  "total_tokens": 632,
  "input_tokens": 360,
  "output_tokens": 272,
  "input_tokens_details": { "text_tokens": 37, "image_tokens": 323 }
}
```

`input_tokens_details.{text_tokens, image_tokens}` 即所需的 text-vs-image 输入拆分。
来源对得上：NewAPI 官方文档（逐字镜像 OpenAI 形状，且写明直连 images 路径**透传** usage）
<https://github.com/QuantumNous/new-api-docs/blob/main/docs/en/api/openai-image.md>；
OpenAI Python SDK 类型源码 <https://github.com/openai/openai-python/blob/main/src/openai/types/images_response.py>。

### 2.3 三条必须诚实面对的坑

1. **Cached input 在图像接口里观测不到** —— `usage` 无 cached_tokens 字段
   （<https://community.openai.com/t/why-doesnt-the-usage-field-in-gpt-image-1-calls-provide-cached-token-details/1355287>）。
   故价目表 cached 列（$2/$1.25）**无法落地**，只按全价 input 计；**不假装算缓存折扣**。
2. **失败计费不可观测** —— OpenAI 对生成中途失败/超时是否计费没有明确承诺，且有用户报告被计费；
   输入侧 moderation 拦截（400 `moderation_blocked`）通常无 usage。诚实做法：**只在带真实 `usage` 的成功响应上计价**，失败不编造 usage。
3. **output 文本 token** —— gpt-image-2 表里 text-output 为「无」；输出按图像 token 全额计（$30/1M）。
   若未来响应出现 `output_tokens_details.text_tokens`，本期按图像输出口径处理（不单列文本输出价）。

### 2.4 验证闸门（实现前必须关闭）

唯一未 100% 锁死的是「NewAPI 真的把 `usage`（含 `input_tokens_details`）原样透传给 five-elements」。
NewAPI 文档强烈表明透传，但**实现动手前需 fugue 跑一次真实生图、贴回 `data.usage`**，
一眼确认形状后再定稿计价数学。这是 §1/§7 纪律，不靠二手摘要拍板。

## 3. 关键决策（已定，勿再推导）

| # | 决策 | 取舍 |
|---|---|---|
| D1 | **币种按原币种存，看板分币种展示** | gpt-image-2 事件 `currency='USD'`，doubao 仍 `'CNY'`；汇总 **GROUP BY currency**，看板「¥X · $Y」分列，**永不跨币种相加**。最诚实、零汇率假设，且 `price_table`/`usage_events` 早已预留 `currency` 列。代价：无单一大总额。否决「折算 CNY」（引入会变动的汇率模糊因子、存的不是 OpenAI 真实账单）与「汇率表」（单模型属过度设计）。 |
| D2 | **记的 cost = OpenAI 公示价算出的真实上游成本** | 不是 fugue 付给 example-gateway/NewAPI 的那笔（NewAPI 定价"不准"，正是不用它的理由）。 |
| D3 | **计费 key 不改名** | 价目行 keyed `(newapi, gpt-image-2, image)`，与事件发出的完全对齐；无需 alias、five-elements 那侧 model 名不动。`provider=newapi` 已是"计费路由"标签，不必叠成 `newapi-gpt-image-2`。 |
| D4 | **价目表 schema：复用 2 列 + 加 1 列** | gpt-image-2 行复用 `input_per_mtok=8`（图像输入）、`output_per_mtok=30`（图像输出），新增 `text_input_per_mtok=5`。最小诚实 delta。否决「显式 3 个 img_* 列」（多列）与「price_modality 子表」（过度通用）。 |
| D5 | **逐模态 token 新增 2 字段** | `input_text_tokens`、`input_image_tokens`（对应 `input_tokens_details.{text,image}_tokens`）。`input_tokens`(聚合)、`output_tokens`(=图像输出) 沿用。 |
| D6 | **成本明细存 `cost_breakdown` jsonb** | CRM 计价时单点写入逐项明细，直喂弹层。**对全站已定价事件都写**（doubao chat 也得三行，弹层全站统一，成本几乎为零）。 |
| D7 | **新价目版本 `2026-06-25a`（完整快照）** | 含 doubao 全档（数字不变）+ gpt-image-2 行。因 `loadPriceTable` 只加载**最大 version**，新版本必须自带 doubao 否则丢价。 |

## 4. 架构与数据流

```
five-elements imageGen.js  ──读出响应 usage──►  choboMeter.meterImage 透传逐模态 token
        │
@chobo/sdk (0.1.2 → 0.1.3) ──事件加 input_text_tokens/input_image_tokens──►  CRM ingest
@chobo/sdk(py) (0.1.1 → 0.1.2) 对称（five-elements 不用，保持双实现一致）
        │
CRM computeCost ──operation=image token 分支,按 OpenAI 规则算 USD──►
        │                                            └─► cost_breakdown jsonb（逐项）
        ▼
usage_events(currency='USD' + cost_breakdown) ──► stats GROUP BY currency ──► 看板「¥ · $」+ 弹层
```

不变量（全是现有铁律的延续）：SDK 永不阻塞业务；**算价只在 CRM 一处**；NULL 不伪装 ¥0；`event_id` 幂等去重；
前端只渲染明细、不求和。

## 5. 数据模型改动（精确）

### 5.1 契约 `contracts/event.schema.json`

`properties` 增 2 个可空字段（`additionalProperties:false`，故必须先于 SDK/CRM 发这俩字段）：

```json
"input_text_tokens":  { "type": ["integer", "null"] },
"input_image_tokens": { "type": ["integer", "null"] }
```

不进 `required`。

### 5.2 两 SDK

- **Node `@chobo/sdk` 0.1.2 → 0.1.3**：`ChoboEvent` 加 `input_text_tokens/input_image_tokens: number|null`；
  `buildEvent` 从 extract 结果透传（`?? null`）；capture 各点带上；version 5 处 bump；重打 tarball。
- **Python `chobo` 0.1.1 → 0.1.2**：对称加字段（`Optional[int] = None`，**不用** `int|None`，守 3.9 floor）；version 8 处 bump（含测试夹具）。five-elements 不用 Python SDK，但保持双实现一致（Plan 5/6 一贯做法）。

### 5.3 CRM 新 migration `server/migrations/0003_gpt_image_2_pricing.sql`

```sql
-- 价目表：图像 token 计价新增 text 输入费率列（复用 input_per_mtok=图像输入、output_per_mtok=图像输出）
ALTER TABLE price_table   ADD COLUMN IF NOT EXISTS text_input_per_mtok numeric(18,8);
-- 用量事件：逐模态输入 token 拆分 + 成本逐项明细
ALTER TABLE usage_events  ADD COLUMN IF NOT EXISTS input_text_tokens  bigint;
ALTER TABLE usage_events  ADD COLUMN IF NOT EXISTS input_image_tokens bigint;
ALTER TABLE usage_events  ADD COLUMN IF NOT EXISTS cost_breakdown     jsonb;
```

`migrate()` 自动发现按文件名顺序跑（与 `0002_account.sql` 同机制）。

> **连带改动（不可漏）：**
> - `server/src/server.ts:38` 的 seed INSERT 列清单加 `text_input_per_mtok`；`seedIfEmpty` 的 row 映射同步。
> - `server/src/ingest.ts` `ROW_COLS` 加 `input_text_tokens`、`input_image_tokens`、`cost_breakdown`；`toRow()` 映射。
> - `server/src/pricing.ts` `loadPriceTable` 的 SELECT 加 `text_input_per_mtok`；`PriceRow`/`Priceable`/`Cost` 类型加字段。
> - `server/src/reprice.ts`：`RepriceRow` 类型 + 第 24-25 行 SELECT **加 `input_text_tokens, input_image_tokens`** 并传入 `computeCost`（否则 gpt-image-2 行 reprice 时丢 token → 算不出价）；第 46 行 UPDATE **加 `cost_breakdown=${...}`**（cost 随价目变须重写；input_text/image_tokens 是输入、不 update）。
> - `server/src/types.ts` `EventInput` 加 `input_text_tokens/input_image_tokens`。

## 6. 计价数学 + cost_breakdown

### 6.1 `computeCost` 的 `operation='image'` token 分支

价目行 `(newapi, gpt-image-2, image)`：`input_per_mtok=8`、`output_per_mtok=30`、`text_input_per_mtok=5`、`cache_read_per_mtok=NULL`、`per_image=NULL`、`currency='USD'`。

分支判定：`operation==='image'` 且价目行 `text_input_per_mtok != null`（token 计价模型）→ 走 token 分支；
否则若 `per_image != null` → 走旧平价分支（向后兼容）；否则 `priced:false`（NULL）。

```
text_input_cost  = round8( input_text_tokens  / 1e6 × text_input_per_mtok )   # ×5
image_input_cost = round8( input_image_tokens / 1e6 × input_per_mtok )        # ×8
output_cost      = round8( output_tokens       / 1e6 × output_per_mtok )      # ×30
total_cost       = round8( text_input_cost + image_input_cost + output_cost )
```

落库 rollup：`input_cost = round8(text_input_cost + image_input_cost)`、`output_cost = 图像输出成本`、
`cache_cost = NULL`、`currency='USD'`、`priced:true`。沿用现有 `round8` / `numeric(18,8)` 精度纪律。

**拆分缺失兜底**：若 `input_text_tokens`/`input_image_tokens` 任一为 null（NewAPI 万一不透传拆分）→
**不静默近似** → `priced:false`、`total_cost=NULL`（诚实、可日后 reprice），而非按某侧费率蒙。
（此分支仅在 §2.4 闸门失败时触发；闸门通过则基本不会走到。）

**⚠ gpt-image-2 无公开固定 token 表**：它在数千种分辨率上动态路由输出 token，OpenAI 只给「每张美元估算」且仅覆盖 1024 那几档（low/med/high @1024² ≈ $0.006 / $0.053 / $0.211，本人 WebFetch 实测 <https://developers.openai.com/api/docs/guides/image-generation>）。**故绝不硬编码 token 表** —— 计价完全靠读响应里的真实 `usage`。

**接入方真实口径**：five-elements 用 `1536×1536` 头像（文生图）+ `1440×2560` 聊天背景（edits 带参考图），quality=`low` —— 均**大于** OpenAI 估算覆盖的尺寸；按面积粗放外推，一次「头像+背景」任务 ≈ **$0.05–0.10**（gpt-image-2 一律按 USD 存/显、**不折 ¥**），其中聊天背景的**参考图输入 token 最不可知**。**精确每张价只能从真实 `usage` 读出**（§2.4 闸门）。早先「¥0.08/张」是借文档示例 token + 1024 小图口径拼的估算，对你们大尺寸+参考图场景**低估约数倍**，已作废。

**单元测试 golden 用合成输入验算术（标注：非真实生成，仅验计价公式）**：input_text=100 / input_image=2000 / output=3000 →
text `0.00050000`(×5) + image `0.01600000`(×8) + out `0.09000000`(×30) = **`0.10650000` USD**。
**端到端真 golden**：取自 §2.4 抓到的那条真实 `usage`，实现期填入集成测试断言。

### 6.2 cost_breakdown jsonb（计价时写，逐行 cost/rate 存字符串守铁律；下例数字 = §6.1 合成输入）

```json
{
  "currency": "USD",
  "price_table_version": "2026-06-25a",
  "lines": [
    {"component":"input", "modality":"text",  "tokens":100,  "rate_per_mtok":"5.00",  "cost":"0.00050000"},
    {"component":"input", "modality":"image", "tokens":2000, "rate_per_mtok":"8.00",  "cost":"0.01600000"},
    {"component":"output","modality":"image", "tokens":3000, "rate_per_mtok":"30.00", "cost":"0.09000000"}
  ]
}
```

**全站统一（D6）**：doubao chat 等已定价事件也写 `cost_breakdown`（输入/缓存/输出三行，`modality` 省略或为 `"text"`），
弹层全站一致。前端只渲染 lines；**总价直接读 `total_cost` 列**（权威），lines 仅拆解、不求和。

## 7. 接入方/SDK token 搬运（five-elements）

### 7.1 `server/lib/imageGen.js`

现 `imageFetch` 只回 `data.data[0]`、把顶层 `data.usage` 丢了（见现状）。改：
- `imageFetch` 解析后**同时 surface 顶层 `usage`**（如返回 `{ first, usage }`，或让 `generateOpenAI` 拿整个 body）。
- `generateOpenAI` 回 `{ buffer/url, usage }`（`usage` 可空）。
- 纯增量：解析 `usage` 失败/缺失绝不影响生图，图像照常返回。

### 7.2 `server/src/lib/choboMeter.js` `meterImage`

extractor 读 `result.usage` 映射（OpenAI 形状 → chobo 字段）：

```
usage.input_tokens_details.text_tokens  → input_text_tokens
usage.input_tokens_details.image_tokens → input_image_tokens
usage.output_tokens                     → output_tokens
usage.input_tokens                      → input_tokens
usage.total_tokens                      → total_tokens
（恒）image_count: 1, usage_source: 'measured'
```

`result.usage` 缺失安全降级（ark/doubao 图像路径无此形状 → 仅 `image_count:1`，不报错、不抛错）。
**失败路径**：doGenerate 抛错 → 落 `status=failure`、无 usage、不编造 token（沿用现 SDK fire-and-forget 语义）。

### 7.3 重 vendor

构建 `@chobo/sdk` 0.1.3 → `npm pack` → 投 `five-elements/server/vendor/chobo-sdk-0.1.3.tgz`，
删 0.1.2，`package.json` 改 `file:vendor/chobo-sdk-0.1.3.tgz`，VERSION 守卫确认装的是 0.1.3。

## 8. 看板：分币种汇总 + 明细弹层

### 8.1 分币种汇总（stats + 前端）

`server/src/stats.ts` 三处（overview / timeseries / by-dim）现硬编码 `currency:"CNY"` + 无脑 `sum(total_cost)`。
改为 **GROUP BY currency** 返回逐币种成本（通用，未来多币种自适应），形如：

```jsonc
// overview.totals
"cost_by_currency": [ { "currency": "CNY", "total_cost": "12.3456" }, { "currency": "USD", "total_cost": "0.0109" } ]
```

（移除顶层 `currency:"CNY"` 硬编码；保留 `total_tokens` 等币种无关聚合。）
前端：
- `web/src/api/format.ts`：按币种取符号（CNY→¥、USD→$）格式化；新增逐币种渲染助手。
- `web/src/components/KpiCards.tsx`：总额「¥X · $Y」分列（无 USD 则只 ¥）。
- `web/src/components/DimensionRanking.tsx`：每行成本按币种分列。
- `web/src/components/TimeseriesChart.tsx`：现版画 `total_cost` 单线（「开销趋势」，把字符串 `Number()` 仅作像素几何）。多币种后 timeseries 端点改返回**逐币种** cost；图**单次只画一个币种**（顶部加币种切换，挨着现有 bucket 切换；默认 = 区间内唯一/占比最大的币种，回退 CNY），**绝不把 ¥ 和 $ 累加成一条线**。
- `web/src/api/types.ts`：响应类型同步。

### 8.2 明细弹层

`GET /v1/events`（`SELECT *`）已自动带出 `cost_breakdown` jsonb；无需改后端读路。
`web/src/components/EventsTable.tsx`：审计明细表**总价单元格 hover 弹出明细弹层（点击可固定）**，
逐行列 `输入/输出 × 文本/图像 · tokens · 单价/1M · 该项成本 · 币种`。
无 `cost_breakdown`（未定价）→ 显示「未定价」、不弹。手写 CSS/无新运行时依赖（守 web 零额外依赖铁律）。

## 9. 错误处理与不变量

- SDK 永不阻塞业务；token 解析失败 → 退化 `image_count:1`，事件照落。
- 失败事件无 token → `total_cost=NULL`；拆分缺失 → `total_cost=NULL`；cached **永不**出现在明细。
- 算价只在 CRM；前端不求和；总价读 `total_cost` 列。
- `event_id` 幂等去重；reprice 重投不重复计费且重算 cost_breakdown。

## 10. 测试策略（逐层 TDD）

| 层 | 关键用例 |
|---|---|
| 契约 | schema 接受/拒绝带新字段的事件 |
| Node SDK | extractor 给拆分 → 事件带 `input_text/image_tokens`；没给 → null；version=0.1.3 |
| Python SDK | 对称；version=0.1.2 |
| CRM 计价 | gpt-image-2 token 行 → USD total + cost_breakdown 对得上**合成 golden** `0.10650000`(§6.1，非真实生成)；**拆分缺失→NULL**；**失败→NULL**；cached 永不出现；doubao chat 也产出 cost_breakdown |
| CRM stats | CNY+USD 混合 → **按币种分组**，绝不跨币种相加；纯 CNY 时形状仍正确 |
| CRM reprice | NULL gpt-image-2(带 token) 事件回填出 USD total + cost_breakdown |
| five-elements | `meterImage` 正确映射 usage；usage 缺失→仅 image_count；失败→不编造 usage；VERSION 守卫=0.1.3 |
| 看板 | 弹层逐行渲染 + 点击固定；Kpi/排行「¥ · $」分列；未定价不弹 |

## 11. 灰度上线顺序

```
0. 【闸门 §2.4】fugue 跑真实生图，贴回 data.usage —— 确认 NewAPI 透传形状，再定稿
1. contracts + 两 SDK 加 token 字段（Node→0.1.3 / Python→0.1.2），重打 tgz
2. CRM：migration 0003 + pricing image-token 分支 + cost_breakdown + ingest + 分币种 stats + 类型/seed 列/reprice 连带改动
3. 看板：分币种汇总 + 明细弹层
4. five-elements：imageGen 读 usage + meterImage 映射 + 重 vendor SDK 0.1.3
5. 部署：重建 CRM 镜像 → migration 自动跑 → **一次性灌入新价目版本 2026-06-25a（doubao+gpt-image-2 完整快照）到 prod**（因 seedIfEmpty 仅空表灌入，需手工 SQL/命令，fugue 在宿主配合）→ 重发 five-elements → `npm run reprice` 回填
6. 生产验证：新 gpt-image-2 事件亮出 $ 成本 + 弹层；doubao 仍 ¥；汇总「¥ · $」
```

**诚实的回填边界**：部署前已落库的 gpt-image-2 事件**没有逐模态 token**（five-elements 当时未抓），
无法事后补 token → 它们**保持 NULL**。计价只对 five-elements 部署 token 抓取**之后**的新事件生效；
reprice 主要救「带 token 但价目未灌期间」的事件。这是 §2/铁律「不静默」的诚实交代，不会假装回填了拿不到的数据。

## 12. 文件触点总览（供 writing-plans 拆任务）

**chobo：**
- `contracts/event.schema.json`（+2 字段）
- `packages/sdk-node/src/{event,capture,index}.ts`（token 字段走 extract 结果、非 config）+ version 5 处（0.1.3）
- `packages/sdk-python/src/chobo/{event,capture,...}.py` + version 8 处（0.1.2）
- `server/migrations/0003_gpt_image_2_pricing.sql`（新）
- `server/src/{types,pricing,ingest,reprice,server,stats}.ts`
- `price-seed.json` + `server/price-seed.example.json`（新版本 2026-06-25a 完整快照）
- `web/src/api/{types,format}.ts` + `web/src/components/{KpiCards,DimensionRanking,EventsTable,TimeseriesChart}.tsx`
- `docs/dev-log.md`（收尾）

**five-elements：**
- `server/lib/imageGen.js`（读 usage）
- `server/src/lib/choboMeter.js`（meterImage 映射）
- `server/vendor/chobo-sdk-0.1.3.tgz` + `server/package.json`（file: 依赖）
- `server/CHOBO_INTEGRATION.md`（说明同步）

## 13. 范围外 / 未来

- 多币种汇率折算/统一展示（D1 已否决，单模型不做）。
- Cached input 折扣（§2.3-1 接口观测不到，不做）。
- 其他 example-gateway 模型（gpt-5.5 / gemini-3.5-flash）CNY 价（独立工作）。
- gpt-image-2 `n>1`（当前恒 1；将来若启用，`image_count` 须按真实张数取，且 usage 已是整次聚合，无需按张拆）。
- new-api 对账（保留列，休眠）。

## 14. 待关闭的验证闸门（实现前）

- [ ] fugue 提供一次真实 gpt-image-2（经 NewAPI）响应的 `data.usage`，确认含 `input_tokens_details.{text_tokens,image_tokens}` 且字段名一致。闸门通过后，§6 计价数学与 §7 映射即可定稿进 plan。
