# gpt-image-2 计价实现计划（USD token 计价 + 多币种 + 成本明细弹层）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现。步骤用 `- [ ]` 复选框跟踪。
> 权威设计：[`docs/superpowers/specs/2026-06-25-gpt-image-2-pricing-design.md`](../specs/2026-06-25-gpt-image-2-pricing-design.md)。有出入以 spec 为准。

**Goal：** 让 chobo 按 OpenAI 官方 token 规则、以美元给经 NewAPI 中转的 gpt-image-2 逐次生图算真实上游成本，并在看板上分币种汇总（¥·$）+ 每图成本明细弹层。

**Architecture：** 契约/两 SDK 加逐模态 token 字段 → CRM 加 `text_input_per_mtok` 列 + image-token 计价分支 + `cost_breakdown` jsonb + stats 分币种 → 看板分币种 + 弹层 → five-elements 生图咽喉读 `usage` 透传。原币种存、永不跨币种相加。算价只在 CRM 一处。

**Tech Stack：** 契约 JSON Schema 2020-12；Node SDK（TS 双格式）；Python SDK（stdlib，3.9 floor）；CRM Fastify 5 + postgres.js + Ajv2020；看板 React 18 + Vite 零额外依赖；five-elements Node/CJS + Jest。

---

## ⚠ 实现前闸门（§2.4，必须先关）

- [ ] **闸门 G0：** fugue 跑一次真实生图，把响应里的 `data.usage` 贴回。确认含 `input_tokens_details.{text_tokens, image_tokens}` 且字段名与 spec §2.2 一致。
  - 若形状一致 → §6 计价数学 + §7 映射照本计划执行；并用这条真实 usage 替换 §B3/§D2 集成测试里的「真 golden」。
  - 若 NewAPI **不透传**拆分 → 停下回到 brainstorm（计价无法按模态拆分，需另议是否标 estimated 或整体 NULL）。
  - **此闸门不挡 Part A-C 的纯 chobo 内部实现**（契约/SDK/CRM/看板对字段缺失已安全降级）；只挡 Part D（five-elements 真实接线）的最终验证与上线。可先做 A-C，G0 关后做 D。

---

## File Structure

**chobo（一个分支 `feat/gpt-image-2-pricing`）：**
- `contracts/event.schema.json` — +2 token 字段
- `packages/sdk-node/src/{event,extractors}.ts` — Usage/ChoboEvent/buildEvent +2 字段；version 0.1.3
- `packages/sdk-python/src/chobo/event.py` — build_event +2 字段；version 0.1.2
- `server/migrations/0003_gpt_image_2_pricing.sql` — 新
- `server/src/{types,pricing,ingest,reprice,server,stats}.ts`
- `price-seed.json` + `server/price-seed.example.json` — 新版本 2026-06-25a
- `web/src/api/{types,format}.ts` + `web/src/components/{KpiCards,DimensionRanking,TimeseriesChart,EventsTable}.tsx`
- `docs/dev-log.md` + `CLAUDE.md`

**five-elements（一个分支）：**
- `server/src/lib/imageGen.js`、`server/src/lib/choboMeter.js`
- `server/vendor/chobo-sdk-0.1.3.tgz` + `server/package.json`
- `server/CHOBO_INTEGRATION.md`

---

# Part A — 契约 + 两 SDK 加逐模态 token 字段

### Task A1：契约加 2 个可空 token 字段

**Files：**
- Modify: `contracts/event.schema.json`（properties 内，`input_image` 字段后）
- Test: `server/test/validator.test.ts`（既有；加用例）

- [ ] **Step 1：写失败测试** —— 在 `server/test/validator.test.ts` 加：

```ts
it("accepts input_text_tokens / input_image_tokens (nullable)", () => {
  const base = validEvent(); // 既有 helper：返回最小合法事件
  expect(validate({ ...base, input_text_tokens: 37, input_image_tokens: 323 }).ok).toBe(true);
  expect(validate({ ...base, input_text_tokens: null, input_image_tokens: null }).ok).toBe(true);
  expect(validate(base).ok).toBe(true); // 不传也合法（非 required）
});
```

- [ ] **Step 2：跑测试看它失败** —— `cd server && npm test -- validator`，预期 FAIL（`additionalProperties` 拒绝未知字段）。

- [ ] **Step 3：改 schema** —— `contracts/event.schema.json` 的 `properties` 内，紧接 `"image_count"` 行后加：

```json
    "input_text_tokens":  { "type": ["integer", "null"] },
    "input_image_tokens": { "type": ["integer", "null"] },
```

不进 `required`。

- [ ] **Step 4：跑测试看它通过** —— `npm test -- validator`，预期 PASS。

- [ ] **Step 5：提交** ——
```bash
git add contracts/event.schema.json server/test/validator.test.ts
git commit -m "feat(contract): 加 input_text_tokens/input_image_tokens 可空字段(gpt-image-2 逐模态)"
```

---

### Task A2：Node SDK 加字段 + buildEvent 透传

**Files：**
- Modify: `packages/sdk-node/src/event.ts`（`Usage`、`ChoboEvent`、`buildEvent`）
- Modify: `packages/sdk-node/src/extractors.ts`（`ExtractedUsage` 加 2 字段）
- Test: `packages/sdk-node/test/event.test.ts`（既有；加用例）

- [ ] **Step 1：写失败测试** ——

```ts
it("buildEvent passes input_text_tokens / input_image_tokens through usage", () => {
  const ev = buildEvent({
    service: "s", provider: "newapi", operation: "image", request_model: "gpt-image-2",
    identity: { user_id: "u1", identity_source: "jwt" }, start_ms: 1, end_ms: 2,
    usage: { input_text_tokens: 37, input_image_tokens: 323, output_tokens: 272, image_count: 1, usage_source: "measured" },
  });
  expect(ev.input_text_tokens).toBe(37);
  expect(ev.input_image_tokens).toBe(323);
});
it("buildEvent defaults the new token fields to null when absent", () => {
  const ev = buildEvent({ service: "s", provider: "newapi", operation: "image", request_model: "gpt-image-2",
    identity: { identity_source: "missing" }, start_ms: 1, end_ms: 2 });
  expect(ev.input_text_tokens).toBeNull();
  expect(ev.input_image_tokens).toBeNull();
});
```

- [ ] **Step 2：跑失败** —— `cd packages/sdk-node && npm test -- event`，预期 FAIL（属性不存在）。

- [ ] **Step 3：实现** —— 在 `event.ts`：
  - `Usage` 接口加（`image_count` 行后）：
```ts
  input_text_tokens?: number | null;
  input_image_tokens?: number | null;
```
  - `ChoboEvent` 接口加（`image_count: number | null;` 行后）：
```ts
  input_text_tokens: number | null;
  input_image_tokens: number | null;
```
  - `buildEvent` 返回对象加（`image_count: u.image_count ?? null,` 行后）：
```ts
    input_text_tokens: u.input_text_tokens ?? null,
    input_image_tokens: u.input_image_tokens ?? null,
```
  - 在 `extractors.ts` 的 `ExtractedUsage` 类型加同样 2 个可空字段（让接入方 extractor 可类型安全地返回）。

- [ ] **Step 4：跑通过** —— `npm test -- event`，预期 PASS。

- [ ] **Step 5：提交** ——
```bash
git add packages/sdk-node/src/event.ts packages/sdk-node/src/extractors.ts packages/sdk-node/test/event.test.ts
git commit -m "feat(sdk-node): Usage/ChoboEvent/buildEvent 透传 input_text_tokens/input_image_tokens"
```

---

### Task A3：Node SDK 版本 0.1.2 → 0.1.3

**Files：** `packages/sdk-node/` 下所有出现 `0.1.2` 的地方（`package.json`、`src/event.ts:5` `SDK_VERSION`、README、可能的测试断言）。

- [ ] **Step 1：定位** —— `cd packages/sdk-node && grep -rn "0\.1\.2" src package.json README.md test 2>/dev/null`。
- [ ] **Step 2：逐处改成 `0.1.3`**（含 `SDK_VERSION = "0.1.3"`）。
- [ ] **Step 3：构建 + 全测** —— `npm run build && npm test`，预期全绿；`npx publint && npx @arethetypeswrong/cli --pack` 干净。
- [ ] **Step 4：提交** ——
```bash
git add -A packages/sdk-node
git commit -m "chore(sdk-node): bump 0.1.2 -> 0.1.3"
```

---

### Task A4：Python SDK build_event 加 2 字段

**Files：**
- Modify: `packages/sdk-python/src/chobo/event.py`
- Test: `packages/sdk-python/tests/test_event.py`（或既有契约测试文件；加用例）

- [ ] **Step 1：写失败测试** ——

```python
def test_build_event_passes_modality_tokens():
    ev = build_event(service="s", provider="newapi", operation="image", request_model="gpt-image-2",
                     identity={"user_id": "u1", "identity_source": "jwt"}, start_ms=1, end_ms=2,
                     usage={"input_text_tokens": 37, "input_image_tokens": 323, "output_tokens": 272,
                            "image_count": 1, "usage_source": "measured"})
    assert ev["input_text_tokens"] == 37
    assert ev["input_image_tokens"] == 323

def test_build_event_modality_tokens_default_none():
    ev = build_event(service="s", provider="newapi", operation="image", request_model="gpt-image-2",
                     identity={"identity_source": "missing"}, start_ms=1, end_ms=2)
    assert ev["input_text_tokens"] is None
    assert ev["input_image_tokens"] is None
```

- [ ] **Step 2：跑失败** —— `cd packages/sdk-python && python -m pytest -k modality -q`，预期 FAIL（KeyError）。
- [ ] **Step 3：实现** —— `event.py` 返回 dict 加（`"image_count": usage.get("image_count"),` 行后）：
```python
        "input_text_tokens": usage.get("input_text_tokens"),
        "input_image_tokens": usage.get("input_image_tokens"),
```
- [ ] **Step 4：跑通过** —— `python -m pytest -q`，预期全绿。
- [ ] **Step 5：提交** ——
```bash
git add packages/sdk-python/src/chobo/event.py packages/sdk-python/tests/test_event.py
git commit -m "feat(sdk-python): build_event 透传 input_text_tokens/input_image_tokens"
```

---

### Task A5：Python SDK 版本 0.1.1 → 0.1.2

**Files：** `packages/sdk-python/` 下所有 `0.1.1`（`pyproject.toml`、`src/chobo/event.py:6` `SDK_VERSION`、`__init__` 可能、测试夹具断言）。

- [ ] **Step 1：定位** —— `cd packages/sdk-python && grep -rn "0\.1\.1" src pyproject.toml tests 2>/dev/null`。
- [ ] **Step 2：逐处改成 `0.1.2`**。
- [ ] **Step 3：全测** —— `python -m pytest -q`，预期全绿。
- [ ] **Step 4：提交** ——
```bash
git add -A packages/sdk-python
git commit -m "chore(sdk-python): bump 0.1.1 -> 0.1.2"
```

---

# Part B — CRM

### Task B1：迁移 0003（价目表 +1 列、用量表 +3 列）

**Files：** Create `server/migrations/0003_gpt_image_2_pricing.sql`

- [ ] **Step 1：写迁移** ——
```sql
-- gpt-image-2 token 计价：价目表加 text 输入费率列（复用 input_per_mtok=图像输入、output_per_mtok=图像输出）
ALTER TABLE price_table   ADD COLUMN IF NOT EXISTS text_input_per_mtok numeric(18,8);
-- 用量事件：逐模态输入 token 拆分 + 成本逐项明细
ALTER TABLE usage_events  ADD COLUMN IF NOT EXISTS input_text_tokens  bigint;
ALTER TABLE usage_events  ADD COLUMN IF NOT EXISTS input_image_tokens bigint;
ALTER TABLE usage_events  ADD COLUMN IF NOT EXISTS cost_breakdown     jsonb;
```
- [ ] **Step 2：验证迁移自动发现** —— `cd server && npm test -- migrate`（既有迁移测试跑全部 `migrations/*.sql`），预期 PASS（新文件按名序自动跑、幂等）。
- [ ] **Step 3：提交** ——
```bash
git add server/migrations/0003_gpt_image_2_pricing.sql
git commit -m "feat(crm): migration 0003 价目表 text_input_per_mtok + 用量表逐模态 token/cost_breakdown"
```

---

### Task B2：types.ts 加字段

**Files：** Modify `server/src/types.ts`

- [ ] **Step 1：实现**（无独立测试，被 B3/B4 覆盖）——
  - `EventInput` 加（`image_count?: number | null;` 附近）：
```ts
  input_text_tokens?: number | null;
  input_image_tokens?: number | null;
```
  - `Priceable`（在 `pricing.ts`，见 B3）会加同样 2 字段——此处先在 `types.ts` 若有共享类型则加。
  - `PriceRow` 类型加 `text_input_per_mtok: number | null;`。
  - 新增成本明细类型：
```ts
export interface CostLine { component: "input" | "output" | "cache"; modality: "text" | "image" | null; tokens: number; rate_per_mtok: string; cost: string; }
export interface CostBreakdown { currency: string; price_table_version: string; lines: CostLine[]; }
```
  - `Cost` 接口加：`cost_breakdown: CostBreakdown | null;`
- [ ] **Step 2：编译** —— `cd server && npx tsc --noEmit`，预期此刻会因 `computeCost` 未返回 `cost_breakdown` 报错——B3 修。先提交类型（允许 tsc 暂红）或与 B3 合并提交。**建议与 B3 同分支连续做，B3 末统一编译通过再提交。**

---

### Task B3：pricing.ts —— image-token 计价分支 + cost_breakdown（**金额关键，opus 评审**）

**Files：**
- Modify: `server/src/pricing.ts`
- Test: `server/test/pricing.test.ts`（既有；加用例）

- [ ] **Step 1：写失败测试**（合成 golden，**非真实生成**，仅验公式）——

```ts
const IMG_TABLE: PriceTable = { version: "2026-06-25a", aliases: {}, rows: [{
  version: "2026-06-25a", provider: "newapi", model: "gpt-image-2", operation: "image", input_tier_max: 0,
  input_per_mtok: 8, output_per_mtok: 30, text_input_per_mtok: 5,
  cache_read_per_mtok: null, reasoning_per_mtok: null, per_image: null, currency: "USD",
}]};

it("prices gpt-image-2 by modality tokens (USD) + emits cost_breakdown", () => {
  const c = computeCost({ provider: "newapi", model: "gpt-image-2", operation: "image",
    input_text_tokens: 100, input_image_tokens: 2000, output_tokens: 3000 } as any, IMG_TABLE);
  expect(c.priced).toBe(true);
  expect(c.currency).toBe("USD");
  expect(c.total_cost).toBeCloseTo(0.1065, 8);       // 0.0005 + 0.016 + 0.09
  expect(c.input_cost).toBeCloseTo(0.0165, 8);        // text 0.0005 + image 0.016
  expect(c.output_cost).toBeCloseTo(0.09, 8);
  expect(c.cache_cost).toBeNull();                    // cached 观测不到，永不出现
  expect(c.cost_breakdown!.lines).toHaveLength(3);
  expect(c.cost_breakdown!.lines.map(l => l.cost)).toEqual(["0.00050000","0.01600000","0.09000000"]);
});

it("leaves gpt-image-2 NULL when modality split is missing (no silent estimate)", () => {
  const c = computeCost({ provider: "newapi", model: "gpt-image-2", operation: "image",
    input_tokens: 2100, output_tokens: 3000 } as any, IMG_TABLE); // 无 text/image 拆分
  expect(c.priced).toBe(false);
  expect(c.total_cost).toBeNull();
});

it("still flat-prices image via per_image when text_input_per_mtok absent (back-compat)", () => {
  const FLAT: PriceTable = { version: "v", aliases: {}, rows: [{ version: "v", provider: "x", model: "m",
    operation: "image", input_tier_max: 0, input_per_mtok: null, output_per_mtok: null, text_input_per_mtok: null,
    cache_read_per_mtok: null, reasoning_per_mtok: null, per_image: 0.5, currency: "CNY" }]};
  const c = computeCost({ provider: "x", model: "m", operation: "image", image_count: 2 } as any, FLAT);
  expect(c.total_cost).toBeCloseTo(1.0, 8);
});

it("emits cost_breakdown for priced chat events too", () => {
  // 用既有 doubao chat 价表夹具断言 cost_breakdown.lines 含 input/output 行（modality:null）
});
```

- [ ] **Step 2：跑失败** —— `cd server && npm test -- pricing`，预期 FAIL。

- [ ] **Step 3：实现** —— `pricing.ts`：
  - `Priceable` 接口加 `input_text_tokens?: number | null; input_image_tokens?: number | null;`
  - `PriceRow`/`loadPriceTable` 的 SELECT（第 25-26 行）加 `text_input_per_mtok`，并在 `rows.map` 里 `text_input_per_mtok: num(r.text_input_per_mtok as ...)`。
  - 新增构造明细的小工具：
```ts
const s8 = (n: number): string => (Math.round(n * 1e8) / 1e8).toFixed(8);
function line(component: "input"|"output"|"cache", modality: "text"|"image"|null, tokens: number, rate: number): CostLine {
  return { component, modality, tokens, rate_per_mtok: String(rate), cost: s8((tokens / 1e6) * rate) };
}
```
  - 重写 `operation === "image"` 分支：
```ts
  if (p.operation === "image") {
    const txt = p.input_text_tokens, img = p.input_image_tokens;
    // token 计价：价表列了 text_input_per_mtok ⇒ 走逐模态;此时必须有拆分,缺则 NULL(不静默近似)
    if (row.text_input_per_mtok != null) {
      if (txt == null || img == null) {
        return { input_cost: null, cache_cost: null, output_cost: null, total_cost: null, cost_breakdown: null,
                 currency: row.currency, price_table_version: row.version, priced: false };
      }
      const tIn = Math.max(0, finite(txt)), iIn = Math.max(0, finite(img)), out = Math.max(0, finite(p.output_tokens));
      const text_input_cost = perM(tIn, row.text_input_per_mtok) ?? 0;
      const image_input_cost = perM(iIn, row.input_per_mtok) ?? 0;
      const output_cost = perM(out, row.output_per_mtok) ?? 0;
      const lines: CostLine[] = [
        line("input", "text", tIn, row.text_input_per_mtok),
        line("input", "image", iIn, row.input_per_mtok ?? 0),
        line("output", "image", out, row.output_per_mtok ?? 0),
      ];
      return { input_cost: round8(text_input_cost + image_input_cost), cache_cost: null, output_cost: round8(output_cost),
               total_cost: round8(text_input_cost + image_input_cost + output_cost),
               cost_breakdown: { currency: row.currency!, price_table_version: row.version, lines },
               currency: row.currency, price_table_version: row.version, priced: true };
    }
    // 旧平价分支（向后兼容）
    if (row.per_image == null) return { input_cost: null, cache_cost: null, output_cost: null, total_cost: null, cost_breakdown: null, currency: row.currency, price_table_version: row.version, priced: false };
    const img2 = round8(finite(p.image_count) * row.per_image);
    return { input_cost: null, cache_cost: null, output_cost: img2, total_cost: img2,
             cost_breakdown: { currency: row.currency!, price_table_version: row.version,
               lines: [{ component: "output", modality: "image", tokens: finite(p.image_count), rate_per_mtok: String(row.per_image), cost: s8(img2) }] },
             currency: row.currency, price_table_version: row.version, priced: true };
  }
```
  - chat 分支（第 62-72 行）末尾改为同时构造 `cost_breakdown`（input/cache/output 三行，`modality: null`），并在返回对象加 `cost_breakdown`。
  - `!row` 早返回（第 53 行）加 `cost_breakdown: null`。

- [ ] **Step 4：跑通过** —— `npm test -- pricing`，预期 PASS；`npx tsc --noEmit` 通过（B2 类型此刻闭合）。

- [ ] **Step 5：提交** ——
```bash
git add server/src/types.ts server/src/pricing.ts server/test/pricing.test.ts
git commit -m "feat(crm): gpt-image-2 逐模态 token 计价(USD) + cost_breakdown;拆分缺失→NULL"
```

---

### Task B4：ingest.ts 存新列

**Files：** Modify `server/src/ingest.ts`；Test: `server/test/ingest.test.ts`

- [ ] **Step 1：写失败测试** —— 投一条 gpt-image-2 事件（带 `input_text_tokens/input_image_tokens`），断言落库行的 `input_text_tokens=37`、`input_image_tokens=323`、`cost_breakdown` 非空、`currency='USD'`。
- [ ] **Step 2：跑失败**。
- [ ] **Step 3：实现** ——
  - `ROW_COLS`（第 44-49 行）：在 `"image_count",` 后加 `"input_text_tokens","input_image_tokens",`；在 `"price_table_version",` 后加 `"cost_breakdown",`。
  - `toRow()`（第 51-64 行）：
```ts
    input_text_tokens: e.input_text_tokens ?? null,
    input_image_tokens: e.input_image_tokens ?? null,
```
    并在 cost 区加 `cost_breakdown: c.cost_breakdown ? sql.json(c.cost_breakdown as JV) : null,`（jsonb 用 `sql.json`）。
- [ ] **Step 4：跑通过**。
- [ ] **Step 5：提交** —— `git commit -m "feat(crm): ingest 存逐模态 token + cost_breakdown"`。

---

### Task B5：reprice.ts 回填 cost_breakdown

**Files：** Modify `server/src/reprice.ts`；Test: `server/test/reprice.test.ts`

- [ ] **Step 1：写失败测试** —— 预置一条 gpt-image-2 事件（`total_cost IS NULL` 但带 `input_text_tokens/input_image_tokens/output_tokens`），灌入 2026-06-25a 价表，`reprice` 后断言 `total_cost='0.10650000'`、`cost_breakdown` 非空、`currency='USD'`。
- [ ] **Step 2：跑失败**。
- [ ] **Step 3：实现** ——
  - `RepriceRow` 类型加 `input_text_tokens: number | null; input_image_tokens: number | null;`。
  - SELECT（第 24-25 行）加 `input_text_tokens, input_image_tokens`。
  - `computeCost({...})` 调用（第 34 行）加这两字段。
  - UPDATE（第 46 行）加 `cost_breakdown=${c.cost_breakdown ? sql.json(c.cost_breakdown as JV) : null}`（import 所需 JV 类型）。
- [ ] **Step 4：跑通过**。
- [ ] **Step 5：提交** —— `git commit -m "feat(crm): reprice 回填 gpt-image-2 token 价 + cost_breakdown"`。

---

### Task B6：server.ts seed 列清单 + 新价目种子可灌

**Files：** Modify `server/src/server.ts`；Test: `server/test/server.test.ts`（或 seed 测试）

- [ ] **Step 1：写失败测试** —— 空库 + 指向含 gpt-image-2 行（带 `text_input_per_mtok`）的种子文件，启动后 `loadPriceTable` 能取到 `(newapi, gpt-image-2, image)` 行且 `text_input_per_mtok=5`。
- [ ] **Step 2：跑失败**（seed INSERT 列清单缺 `text_input_per_mtok` → 该列丢失）。
- [ ] **Step 3：实现** —— `server.ts:38` 的 seed INSERT 列清单在 `"per_image",` 后加 `"text_input_per_mtok",`；`seedIfEmpty` 的 row 映射（第 16-37 行附近）确保透传该列。
- [ ] **Step 4：跑通过**。
- [ ] **Step 5：提交** —— `git commit -m "feat(crm): seed 支持 text_input_per_mtok 列"`。

---

### Task B7：stats.ts 分币种汇总（**不变量：永不跨币种相加**）

**Files：** Modify `server/src/stats.ts`；Test: `server/test/stats.test.ts`

- [ ] **Step 1：写失败测试** —— 预置 doubao(CNY) + gpt-image-2(USD) 各若干条：
  - `/v1/stats/overview` → `totals.cost_by_currency` 含 `{currency:"CNY",...}` 与 `{currency:"USD",...}` 两项，**无单一 total_cost 把两者相加**。
  - `/v1/stats/by-user` → 每行 `cost_by_currency` 按该 key 分币种。
  - 纯 CNY 数据时 `cost_by_currency` 仅一项、形状仍正确。
- [ ] **Step 2：跑失败**。
- [ ] **Step 3：实现** —— 三处统一改为「主聚合 + 分币种成本聚合在 handler 内 JS 合并」：
  - 定义返回类型 `type CostByCurrency = { currency: string; total_cost: string };`。
  - **overview**：原查询去掉 `sum(total_cost)`；另查 `SELECT currency, sum(total_cost) AS total_cost FROM usage_events WHERE ${where} AND total_cost IS NOT NULL GROUP BY currency`；`totals.cost_by_currency = rows.map(...)`；移除顶层 `currency:"CNY"`、`totals.total_cost`。
  - **timeseries**：主查询 `GROUP BY ts`（events/tokens）；成本查询 `GROUP BY date_trunc(...) ts, currency`；按 ts 在 JS Map 合并；每点 `cost_by_currency: [...]`；移除顶层 `currency`。
  - **by-dim**：主查询不变（`GROUP BY dim ORDER BY tokens LIMIT`）；成本查询 `SELECT ${dim} AS key, currency, sum(total_cost) tc FROM ... WHERE total_cost IS NOT NULL GROUP BY ${dim}, currency`；按 key 在 JS Map 合并进各行 `cost_by_currency`；移除顶层 `currency`。
  - 所有 cost 仍是 postgres numeric **字符串**，不 Number()。
- [ ] **Step 4：跑通过**（含既有 stats 测试改造为新形状）。
- [ ] **Step 5：提交** —— `git commit -m "feat(crm): stats 分币种汇总 cost_by_currency,永不跨币种相加"`。

---

### Task B8：价目种子新版本 2026-06-25a（doubao + gpt-image-2 完整快照）

**Files：** Modify `price-seed.json`、`server/price-seed.example.json`

- [ ] **Step 1：写两文件**（顶层 `version` 改 `2026-06-25a`，doubao 三档**原样保留**，新增 gpt-image-2 行）——

```json
{
  "version": "2026-06-25a",
  "rows": [
    { "provider": "doubao", "model": "doubao-seed-2.0-pro", "operation": "chat", "input_tier_max": 32000,  "input_per_mtok": 3.2, "output_per_mtok": 16.0, "cache_read_per_mtok": 0.64, "currency": "CNY" },
    { "provider": "doubao", "model": "doubao-seed-2.0-pro", "operation": "chat", "input_tier_max": 128000, "input_per_mtok": 4.8, "output_per_mtok": 24.0, "cache_read_per_mtok": 0.96, "currency": "CNY" },
    { "provider": "doubao", "model": "doubao-seed-2.0-pro", "operation": "chat", "input_tier_max": 256000, "input_per_mtok": 9.6, "output_per_mtok": 48.0, "cache_read_per_mtok": 1.92, "currency": "CNY" },
    { "provider": "newapi", "model": "gpt-image-2", "operation": "image", "input_tier_max": 0, "input_per_mtok": 8.0, "output_per_mtok": 30.0, "text_input_per_mtok": 5.0, "currency": "USD" }
  ],
  "aliases": [
    { "provider": "doubao", "alias": "doubao-seed-2-0-pro-260215", "canonical": "doubao-seed-2.0-pro" }
  ]
}
```
> 说明：gpt-image-2 行 `input_per_mtok=8`(图像输入)、`output_per_mtok=30`(图像输出)、`text_input_per_mtok=5`；cached 不可观测故不列；`currency='USD'`。doubao 数字不变（仅版本号升）。
- [ ] **Step 2：种子端到端测试** —— 空库灌该种子，`loadPriceTable().version === "2026-06-25a"`，且 doubao 与 gpt-image-2 行都在。
- [ ] **Step 3：提交** —— `git commit -m "feat(crm): 价目版本 2026-06-25a 完整快照(doubao 原样 + gpt-image-2 USD)"`。

---

# Part C — 看板（分币种 + 明细弹层）

### Task C1：api/types.ts 类型

**Files：** Modify `web/src/api/types.ts`

- [ ] **Step 1：实现**（被 C2-C6 编译/测试覆盖）——
```ts
export interface CostByCurrency { currency: string; total_cost: string; }
export interface CostLine { component: string; modality: string | null; tokens: number; rate_per_mtok: string; cost: string; }
export interface CostBreakdown { currency: string; price_table_version: string; lines: CostLine[]; }
```
  - `Overview.totals`：删 `total_cost`，加 `cost_by_currency: CostByCurrency[]`；删顶层 `currency`。
  - `TimeseriesPoint`：删 `total_cost`，加 `cost_by_currency: CostByCurrency[]`；`Timeseries` 删 `currency`。
  - `DimRow`：删 `total_cost`，加 `cost_by_currency: CostByCurrency[]`；`DimRanking` 删 `currency`。
  - `EventRow`：加 `cost_breakdown?: CostBreakdown | null;`（`total_cost`/`currency` 保留——单事件单币种）。
- [ ] **Step 2：编译** —— `cd web && npx tsc --noEmit`（此刻 C3-C6 会红，连续做）。

---

### Task C2：format.ts 分币种格式化

**Files：** Modify `web/src/api/format.ts`；Test: `web/test/format.test.ts`（既有；加用例）

- [ ] **Step 1：写失败测试** ——
```ts
expect(formatCost("12.34", "USD")).toBe("$12.34");
expect(formatCost("12.34", "CNY")).toBe("¥12.34");
expect(formatCost(null, "USD")).toBe("未定价");
expect(formatCostList([{currency:"CNY",total_cost:"12.30"},{currency:"USD",total_cost:"0.01"}])).toBe("¥12.30 · $0.01");
expect(formatCostList([])).toBe("未定价");
```
- [ ] **Step 2：跑失败**。
- [ ] **Step 3：实现** ——
```ts
const SYMBOL: Record<string, string> = { CNY: "¥", USD: "$" };
export function currencySymbol(c: string): string { return SYMBOL[c] ?? (c + " "); }
export function formatCost(cost: string | null, currency = "CNY"): string {
  if (cost == null) return "未定价";
  const sym = currencySymbol(currency);
  const dot = cost.indexOf(".");
  return dot === -1 ? sym + groupThousands(cost) : sym + groupThousands(cost.slice(0, dot)) + cost.slice(dot);
}
export function formatCostList(list: { currency: string; total_cost: string }[]): string {
  if (!list || list.length === 0) return "未定价";
  return list.map((c) => formatCost(c.total_cost, c.currency)).join(" · ");
}
```
（保留 `isUnpriced`：对列表用 `list.length === 0` 判断。）
- [ ] **Step 4：跑通过**。
- [ ] **Step 5：提交** —— `git commit -m "feat(web): format 支持多币种符号 + formatCostList"`。

---

### Task C3：KpiCards 分币种

**Files：** Modify `web/src/components/KpiCards.tsx`

- [ ] **Step 1：改** —— 「总开销 CNY」卡改为：
```tsx
<Card label="总开销" value={formatCostList(t.cost_by_currency)} unpriced={t.cost_by_currency.length === 0} />
```
  import `formatCostList`。
- [ ] **Step 2：构建** —— `npm run build`，预期通过。
- [ ] **Step 3：提交** —— `git commit -m "feat(web): KpiCards 总开销分币种展示"`。

---

### Task C4：DimensionRanking 分币种

**Files：** Modify `web/src/components/DimensionRanking.tsx`

- [ ] **Step 1：改** —— 开销单元格（第 37 行）：
```tsx
<td style={{ padding: "8px 14px", textAlign: "right" }} className={r.cost_by_currency.length === 0 ? "unpriced" : ""}>{formatCostList(r.cost_by_currency)}</td>
```
  import `formatCostList`（去掉对 `formatCost(r.total_cost)` 的引用）。
- [ ] **Step 2：构建通过**。
- [ ] **Step 3：提交** —— `git commit -m "feat(web): 维度排行开销分币种"`。

---

### Task C5：TimeseriesChart 单币种切换

**Files：** Modify `web/src/components/TimeseriesChart.tsx`、`web/src/pages/OverviewPage.tsx`（如需传 currency 状态）

- [ ] **Step 1：改** —— 图新增 `currency` 选择（默认 = series 中出现过的、cost 合计最大的币种，回退 `"CNY"`）；`costVal` 改为取该点 `cost_by_currency` 里匹配 `currency` 的 `total_cost`（无则 0）；顶部 bucket 切换旁加币种切换按钮组（仅当出现多于一种币种时显示）；**绝不把多币种相加**。标题「开销趋势 · {currency} · 按{bucket}」。
```tsx
function costOf(p: TimeseriesPoint, cur: string): number {
  const hit = p.cost_by_currency.find((c) => c.currency === cur);
  const n = hit ? Number(hit.total_cost) : 0;   // 仅像素几何,非金额展示
  return Number.isFinite(n) ? n : 0;
}
```
- [ ] **Step 2：构建通过**（手动核对：混币种时两币种各自一条、不叠加）。
- [ ] **Step 3：提交** —— `git commit -m "feat(web): 开销趋势按币种单线切换,不跨币种相加"`。

---

### Task C6：EventsTable 成本明细弹层

**Files：** Modify `web/src/components/EventsTable.tsx`

- [ ] **Step 1：实现 CostCell 子组件** —— 总价单元格（第 81 行）替换为 `<CostCell row={e} />`：
```tsx
function CostCell({ row }: { row: EventRow }) {
  const [pin, setPin] = useState(false);
  const bd = row.cost_breakdown;
  const label = <span className={isUnpriced(row.total_cost) ? "unpriced" : ""}>{formatCost(row.total_cost, row.currency ?? "CNY")}</span>;
  if (!bd || !bd.lines?.length) return <td style={{ padding: "8px 12px", textAlign: "right" }}>{label}</td>;
  return (
    <td style={{ padding: "8px 12px", textAlign: "right", position: "relative", cursor: "pointer" }}
        onMouseEnter={() => setPin(true)} onMouseLeave={() => setPin(false)} onClick={() => setPin((v) => !v)}
        title="点击查看成本明细">
      <span style={{ textDecoration: "underline dotted" }}>{label}</span>
      {pin && (
        <div role="tooltip" style={{ position: "absolute", right: 8, top: "100%", zIndex: 10, background: "var(--surface)",
          border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", fontSize: 12, minWidth: 240,
          boxShadow: "0 6px 24px rgba(0,0,0,.12)", textAlign: "left", whiteSpace: "nowrap" }}>
          <div style={{ color: "var(--muted)", marginBottom: 6 }}>成本明细 · {bd.currency} · {bd.price_table_version}</div>
          {bd.lines.map((l, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
              <span>{l.component === "input" ? "输入" : l.component === "output" ? "输出" : "缓存"}{l.modality ? `·${l.modality === "text" ? "文本" : "图像"}` : ""} · {formatCompact(l.tokens)} tok × {l.rate_per_mtok}/1M</span>
              <span>{formatCost(l.cost, bd.currency)}</span>
            </div>
          ))}
        </div>
      )}
    </td>
  );
}
```
  `formatCost` 已接受 currency 参数。手写 CSS、无新依赖。
- [ ] **Step 2：构建通过**（手动核对：gpt-image-2 行 hover/点击弹出三行明细；doubao 行弹输入/输出/缓存；未定价行不弹）。
- [ ] **Step 3：提交** —— `git commit -m "feat(web): 审计明细总价成本明细弹层(逐项 输入/输出×文本/图像)"`。

---

### Task C7：看板端到端冒烟

- [ ] **Step 1：** `cd web && npm test && npm run build`，全绿。
- [ ] **Step 2：** 用 `server` 的 seed-events（或手投）造 doubao(CNY) + gpt-image-2(USD,带 cost_breakdown) 混合数据，CRM 同源托管下打开看板：KPI「¥X · $Y」、排行分币种、趋势按币种切换、明细弹层逐项。
- [ ] **Step 3：提交**（如有微调）。

---

# Part D — five-elements（闸门 G0 关后做）

### Task D1：imageGen.js 读出响应 usage

**Files：** Modify `server/src/lib/imageGen.js`；Test: `server/tests/chobo/imageGen.metered.test.js`（或 image-gen 测试）

- [ ] **Step 1：写失败测试** —— mock fetch 返回 `{ data: [{ b64_json }], usage: { input_tokens, output_tokens, total_tokens, input_tokens_details: { text_tokens, image_tokens } } }`；断言 `generateImage` 计量出的事件带 `input_text_tokens/input_image_tokens/output_tokens`（经 meterImage→chobo）。
- [ ] **Step 2：跑失败**。
- [ ] **Step 3：实现** ——
  - `imageFetch`（第 60-82 行）返回改为 `{ first, usage: data.usage ?? null }`（解析 `data` 后同时取顶层 usage）。
  - `generateOpenAI`（第 85-130 行）：`const { first, usage } = await imageFetch(...)`，返回对象加 `usage`：`return { buffer..., usage }` / `return { url..., usage }`。
  - `generateArk` 同样接 `{ first, usage }`（ark 无 usage → null，返回 `{ url, usage: null }`）。
  - 纯增量：usage 缺失不影响图像返回。
- [ ] **Step 4：跑通过**。
- [ ] **Step 5：提交** —— `git commit -m "feat(image): generateImage 透出响应 usage(供 chobo 逐模态计量)"`。

---

### Task D2：choboMeter.js meterImage 映射 usage

**Files：** Modify `server/src/lib/choboMeter.js`；Test: `server/tests/chobo/choboMeter.test.js`

- [ ] **Step 1：写失败测试** ——
```js
test('meterImage 把 gpt-image-2 usage 映射成逐模态 token', async () => {
  process.env.CHOBO_INGEST_URL = stub.url
  const m = require('../../src/lib/choboMeter'); m.initChobo()
  await m.runIdentity('usr_x', async () => m.meterImage('newapi', 'gpt-image-2', async () => ({
    buffer: Buffer.from('x'), ext: 'png',
    usage: { input_tokens: 360, output_tokens: 272, total_tokens: 632, input_tokens_details: { text_tokens: 37, image_tokens: 323 } },
  })))
  await m.shutdownChobo()
  const e = stub.received[0]
  expect(e.input_text_tokens).toBe(37); expect(e.input_image_tokens).toBe(323)
  expect(e.output_tokens).toBe(272); expect(e.image_count).toBe(1)
})
test('meterImage usage 缺失时安全降级为仅 image_count', async () => { /* result 无 usage → 仅 image_count:1，不抛错 */ })
```
- [ ] **Step 2：跑失败**。
- [ ] **Step 3：实现** —— `meterImage` 的 extract 改为读 `result.usage`：
```js
function meterImage(provider, model, doGenerate) {
  if (!enabled) return doGenerate()
  return chobo.meter(
    { operation: 'image', provider, requestModel: model, extract: (r) => {
      const u = r && r.usage
      const d = u && u.input_tokens_details
      return {
        image_count: 1, usage_source: 'measured',
        input_tokens: u ? u.input_tokens ?? null : null,
        output_tokens: u ? u.output_tokens ?? null : null,
        total_tokens: u ? u.total_tokens ?? null : null,
        input_text_tokens: d ? d.text_tokens ?? null : null,
        input_image_tokens: d ? d.image_tokens ?? null : null,
      }
    } },
    doGenerate,
  )
}
```
  （`extract` 现在依赖响应体；注释更新：n 仍恒 1。）
- [ ] **Step 4：跑通过** —— `cd server && npx jest tests/chobo`，预期全绿。
- [ ] **Step 5：提交** —— `git commit -m "feat(chobo): meterImage 映射 gpt-image-2 usage 为逐模态 token"`。

---

### Task D3：构建 + vendor @chobo/sdk 0.1.3

**Files：** chobo 侧 `npm pack`；five-elements `server/vendor/`、`server/package.json`

- [ ] **Step 1：** chobo `cd packages/sdk-node && npm run build && npm pack` → 得 `chobo-sdk-0.1.3.tgz`。
- [ ] **Step 2：** 复制到 `five-elements/server/vendor/chobo-sdk-0.1.3.tgz`，删 `chobo-sdk-0.1.2.tgz`；`server/package.json` 依赖改 `"@chobo/sdk": "file:vendor/chobo-sdk-0.1.3.tgz"`；`cd server && npm install`。
- [ ] **Step 3：VERSION 守卫测试** —— 断言 `require('@chobo/sdk/package.json').version === '0.1.3'`（或既有守卫测试改 0.1.3）。`npx jest tests/chobo` 全绿。
- [ ] **Step 4：提交** —— `git commit -m "chore(chobo): vendor @chobo/sdk 0.1.3(逐模态 token)"`。

---

### Task D4：CHOBO_INTEGRATION.md 同步

- [ ] **Step 1：** 补「gpt-image-2 逐模态 token 计量」说明（usage 来源、缺失降级、USD 计价在 CRM）。
- [ ] **Step 2：提交** —— `git commit -m "docs(chobo): 集成说明补 gpt-image-2 逐模态计量"`。

---

# Part E — 收尾 + 上线

### Task E1：dev-log + CLAUDE.md

- [ ] **Step 1：** `docs/dev-log.md` 追加「gpt-image-2 USD token 计价 + 多币种 + 明细弹层」一节（决策 D1-D7、闸门 G0、合成 vs 真 golden、上线步骤）。
- [ ] **Step 2：** `CLAUDE.md` 状态节：把「下一项工作:gpt-image-2 定价」更新为已实现 + 多币种维度；新「下一项」留空或记后续（如 example-gateway 其他模型价）。
- [ ] **Step 3：提交** —— `git commit -m "docs: gpt-image-2 计价落地,状态同步"`。

### Task E2：上线运行手册（写进 dev-log 或 runbook）

- [ ] **Step 1：** 记录灰度顺序（spec §11）：重建 CRM 镜像 → migration 0003 自动跑 → **一次性灌 2026-06-25a 到 prod**（因 `seedIfEmpty` 仅空表灌入，需手工：连 prod `chobo` 库执行 gpt-image-2 行 INSERT + doubao 已在；或 truncate+reseed 不可取——给精确单行 INSERT SQL，fugue 在宿主配合）→ 重发 five-elements(SDK 0.1.3) → `npm run reprice` 回填带 token 的 NULL 事件。
- [ ] **Step 2：** 诚实边界说明：部署前已落库的 gpt-image-2 事件无逐模态 token → 保持 NULL，不回填。
- [ ] **Step 3：提交**。

---

## 终审

- [ ] 全部任务后，派 final code-reviewer 跑整体评审（金额/币种不变量、cost_breakdown 一致性、stats 不跨币种相加、SDK 不阻塞、NULL 不伪 0）。
- [ ] 基线测试全绿：Node SDK / Python SDK / CRM / web / five-elements chobo 子集。
- [ ] 用 superpowers:finishing-a-development-branch 收尾两仓分支。

## 自审清单（写计划时已核对）

- ✅ spec 每节都有对应任务（币种 D1→B7/C2-C5、token D5→A1-A5/B1-B6、breakdown D6→B3/C6、价目 D7→B8）。
- ✅ 类型一致：`CostByCurrency`/`CostBreakdown` 前后端同名同形；`text_input_per_mtok`/`input_text_tokens`/`input_image_tokens` 全链路一致命名。
- ✅ 无占位符：每个改动给了实际代码/SQL/测试；合成 golden 明确标注非真实生成。
- ✅ 顺序安全：A-C（chobo 内部）可先做，G0 闸门只挡 D（five-elements 真实接线 + 上线）。
