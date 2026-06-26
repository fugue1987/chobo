# Plan 6 — `account` 多租户维度 + CRM 部署 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 chobo 全链路加一个可空 `account` 维度区分"哪个 app"(Model B 一套共享多租户 CRM),并把 CRM 容器化部署到生产。

**Architecture:** `account` = SDK init 配置项(与 `service` 平级,部署期常量,每事件盖戳,缺则 null;**不进 identity ALS**)。契约先认 `account`,SDK 才发,CRM 才存——故 Task 1(契约)是所有 SDK/CRM 任务的前置。CRM 作为中立独立服务 `chobo-crm` 容器,复用宿主 `postgres18`(独立 `chobo` 库),挂 `postgres18_default` 网络,nginx 子域名 basic-auth 暴露看板。

**Tech Stack:** 契约 JSON Schema(draft-2020-12);Node SDK(TS,vitest,双格式);Python SDK(stdlib,pytest);CRM(Fastify 5 + postgres.js,vitest+testcontainers);看板(React18+Vite,vitest+RTL);five-elements(Node/CJS,jest);部署(多阶段 Dockerfile + docker compose + nginx,贴 fugue 现有 ship.sh 房规)。

**权威 spec:** [`docs/superpowers/specs/2026-06-25-account-multitenancy-and-crm-deploy-design.md`](../specs/2026-06-25-account-multitenancy-and-crm-deploy-design.md)

---

## 关键约束(实现前必读)

1. **契约 `additionalProperties:false`** —— 必须先把 `account` 加进 `contracts/event.schema.json`(Task 1),否则 Node SDK 的 `event.test.ts`、Python 的 `test_event.py`、CRM 的 ingest 校验都会拒绝带 `account` 的事件。**Task 1 必须最先做。**
2. **版本号不同轨:** Node SDK 0.1.1 → **0.1.2**(five-elements vendor 的就是它);Python SDK 独立轨 0.1.0 → **0.1.1**。两者从不锁步(Node 当初为 ingestSecret 单独 bump 过)。
3. **`account` 是配置级(init 一次),`project` 是请求级(identity ALS)** —— 两套管线,别混。`getIdentity()` 不带 account。
4. **测试目录约定各包不同:** sdk-node = `test/`(单数);sdk-python = `tests/`;server = `test/`(单数);web = `test/`;five-elements = `tests/chobo/`。
5. **五行 vendor 的 0.1.2 tarball 依赖 chobo Node SDK 先改完打包**(Task 2+3 → Task 9)。
6. **Part 2 部署为非 TDD**(spec §8):产出件 → 本地 `docker build`/lint 冒烟 → commit;真实上线是 fugue 手动跑 runbook。

## 分支(两仓各开功能分支,勿在 master 直接做)

- chobo:`feat/account-multitenancy-crm-deploy`
- five-elements:`feat/chobo-account-dimension`

## 文件触面总览

| 仓 | 文件 | 改动 |
|---|---|---|
| chobo | `contracts/event.schema.json` | +`account` 可空属性 |
| chobo | `packages/sdk-node/src/{config,event,capture,index}.ts` | account 透传 + 盖戳 + 版本 0.1.2 |
| chobo | `packages/sdk-node/test/{helpers,public-api,event}.*` | fixture + 断言 |
| chobo | `packages/sdk-python/src/chobo/{config,_runtime,event,capture}.py` | account 透传 + 盖戳 + 版本 0.1.1 |
| chobo | `packages/sdk-python/{pyproject.toml,src/chobo/__init__.py}` | 版本 0.1.1 |
| chobo | `packages/sdk-python/tests/test_*.py` | 断言 |
| chobo | `server/migrations/0002_account.sql` | 新增列 + 索引 |
| chobo | `server/src/{types,ingest,filters,stats}.ts` | EventInput/ROW_COLS/toRow/filters/DIM_COL |
| chobo | `server/test/*.test.ts` | account 持久化 + by-account |
| chobo | `web/src/api/types.ts`、`components/{FilterBar,DimensionRanking}.tsx`、`App.tsx` | filter/dim/drill |
| chobo | `web/test/*.test.tsx` | 断言 |
| chobo | `.dockerignore`、`price-seed.json`、`ci/Dockerfile`、`deploy/{ship-crm.sh,docker-compose.crm.yml,chobo-init-db.sql,nginx.chobo.conf,CRM_DEPLOY_RUNBOOK.md}` | 部署件(新增) |
| chobo | `docs/dev-log.md`、`CLAUDE.md` | 状态同步 |
| five-elements | `server/src/lib/choboMeter.js` | account + project=null |
| five-elements | `server/package.json` + `server/vendor/chobo-sdk-0.1.2.tgz` | 重 vendor |
| five-elements | `server/tests/chobo/*.test.js` | 断言翻 |
| five-elements | `server/.env.example`、`docker-compose.prod.yml` | env 修正 + spool 卷 |

---

## Part 1 — `account` 维度(TDD)

### Task 1: 契约加 `account` 字段

**Files:**
- Modify: `C:\Code\chobo\contracts\event.schema.json`

- [ ] **Step 1: 加属性**

在 `properties` 里、`service` 行附近加(`account` 可空、**不进 `required` 数组**):

```json
    "account": { "type": ["string", "null"] },
```

- [ ] **Step 2: 验证 JSON 合法且属性已加**

Run(chobo 根目录):
```bash
node -e "const s=require('./contracts/event.schema.json'); if(!s.properties.account) throw new Error('account 属性缺失'); if(s.required.includes('account')) throw new Error('account 不该进 required'); console.log('account 属性已加且为可选:', JSON.stringify(s.properties.account))"
```
Expected: `account 属性已加且为可选: {"type":["string","null"]}`。

> 契约对 `account` 的真正放行/拒绝由下游硬验证:Task 2 的 `event.test.ts`(Ajv 编译契约校验带 account 的事件)与 Task 6 的 ingest 校验——它们是 `additionalProperties:false` 是否放行 account 的实测门。

- [ ] **Step 3: Commit**

```bash
git add contracts/event.schema.json
git commit -m "feat(contracts): 事件契约加可空 account 维度(多租户区分 app)"
```

---

### Task 2: Node SDK — account 透传 + 盖戳

**Files:**
- Modify: `C:\Code\chobo\packages\sdk-node\src\config.ts`
- Modify: `C:\Code\chobo\packages\sdk-node\src\event.ts`
- Modify: `C:\Code\chobo\packages\sdk-node\src\capture.ts`
- Modify: `C:\Code\chobo\packages\sdk-node\test\helpers.ts`
- Test: `C:\Code\chobo\packages\sdk-node\test\event.test.ts`

- [ ] **Step 1: 写失败测试**

在 `test/event.test.ts` 末尾加(模仿本文件既有 success 测试的 `buildEvent({...})` 调用形状,只多一个 `account`;`IDENTITY`/`validate` 是本文件已有的 fixture):

```ts
describe("account", () => {
  it("stamps account from input and stays contract-valid", () => {
    const ev = buildEvent({
      service: "s", provider: "p", operation: "chat", request_model: "m",
      identity: IDENTITY, start_ms: 0, end_ms: 1, account: "acme",
    });
    expect(ev.account).toBe("acme");
    expect(validate(ev)).toBe(true);
  });
  it("defaults account to null when omitted", () => {
    const ev = buildEvent({
      service: "s", provider: "p", operation: "chat", request_model: "m",
      identity: IDENTITY, start_ms: 0, end_ms: 1,
    });
    expect(ev.account).toBeNull();
    expect(validate(ev)).toBe(true);
  });
});
```
> 若 `buildEvent` 还需其它必填字段,照搬本文件既有 success 测试那次调用里的字段,只加 `account`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/sdk-node && npx vitest run test/event.test.ts`
Expected: FAIL —— TS 报 `account` 不在 `BuildEventInput`,或运行期 `ev.account` 为 undefined。

- [ ] **Step 3: config.ts 加 account(可选,镜像 ingestSecret)**

`ChoboConfig` 在 `ingestSecret?: string;` 之后加:
```ts
  account?: string;
```
`ChoboConfigInput` 在 `ingestSecret?: string;` 之后加:
```ts
  account?: string;
```
`resolveConfig` 返回对象在 `ingestSecret: input.ingestSecret,` 之后加(**无 `?? 默认`,透传**):
```ts
    account: input.account,
```

- [ ] **Step 4: event.ts 加 account 字段 + 盖戳**

`ChoboEvent` 在 `project: string | null;` 之后加:
```ts
  account: string | null;
```
`BuildEventInput` 在 `service: string;` 之后加:
```ts
  account?: string | null;
```
`buildEvent` 返回对象在 `project: input.identity.project ?? null,` 之后加(实现"默认 null"):
```ts
    account: input.account ?? null,
```

- [ ] **Step 5: capture.ts 三处 emit 带上 account**

三个 `buildEvent({...})` 调用点(emitSuccess / emitFailure / meterStream),各自在 `service: getConfig()?.service ?? "unknown",` 之后加一行(注意默认 null 不是 "unknown"):
```ts
    account: getConfig()?.account ?? null,
```

- [ ] **Step 6: helpers.ts 的 `ev()` fixture 补 account**

`ev(i)` 里 `project: null,` 之后加 `account: null,`(因 `ChoboEvent` 新增了必填 `account`,不补则全套 TS 编译失败):
```ts
    user_id: null, org_id: null, project: null, account: null, identity_source: "header",
```
> `cfg()` 不用动(account 在 ChoboConfig 上是可选)。

- [ ] **Step 7: 跑测试确认通过 + 全套绿**

Run: `cd packages/sdk-node && npx vitest run test/event.test.ts && npm test`
Expected: PASS,全套(45+)绿。

- [ ] **Step 8: Commit**

```bash
git add packages/sdk-node/src packages/sdk-node/test
git commit -m "feat(sdk-node): account 配置项透传并盖戳到每条事件(默认 null)"
```

---

### Task 3: Node SDK — 版本 0.1.1 → 0.1.2

**Files:**
- Modify: `C:\Code\chobo\packages\sdk-node\package.json`(line 3 `"version"`)
- Modify: `C:\Code\chobo\packages\sdk-node\src\event.ts`(`SDK_VERSION`)
- Modify: `C:\Code\chobo\packages\sdk-node\src\index.ts`(`VERSION`)
- Modify: `C:\Code\chobo\packages\sdk-node\test\helpers.ts`(fixture `sdk_version`)
- Test: `C:\Code\chobo\packages\sdk-node\test\public-api.test.ts`

- [ ] **Step 1: 改断言制造失败**

`test/public-api.test.ts` 的 VERSION 断言:`expect(chobo.VERSION).toBe("0.1.1");` → 改成 `"0.1.2"`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/sdk-node && npx vitest run test/public-api.test.ts`
Expected: FAIL —— 实际 VERSION 仍是 "0.1.1"。

- [ ] **Step 3: 改全部 4 处版本串**
- `package.json` line 3:`"version": "0.1.2",`
- `src/event.ts` line 5:`export const SDK_VERSION = "0.1.2";`
- `src/index.ts` line 13:`export const VERSION = "0.1.2";`
- `test/helpers.ts` line 16:`sdk_lang: "node", sdk_version: "0.1.2",`

> ⚠ 别碰 `package-lock.json` 里的 `0.1.13`(是无关传递依赖 `ts-interface-checker`)。

- [ ] **Step 4: 跑测试确认通过 + 全套 + 双格式构建/校验**

Run: `cd packages/sdk-node && npm test && npm run build && npm run validate`
Expected: 全套 PASS;tsup 双格式构建成功;publint/attw 干净。

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-node
git commit -m "chore(sdk-node): bump 0.1.1 -> 0.1.2"
```

---

### Task 4: Python SDK — account 透传 + 盖戳

**Files:**
- Modify: `C:\Code\chobo\packages\sdk-python\src\chobo\config.py`
- Modify: `C:\Code\chobo\packages\sdk-python\src\chobo\_runtime.py`
- Modify: `C:\Code\chobo\packages\sdk-python\src\chobo\event.py`
- Modify: `C:\Code\chobo\packages\sdk-python\src\chobo\capture.py`
- Test: `C:\Code\chobo\packages\sdk-python\tests\test_event.py`、`tests\test_config.py`

- [ ] **Step 1: 写失败测试**

`tests/test_config.py` 加:
```python
def test_config_account_default_none():
    c = Config(ingest_url="http://x", service="s")
    assert c.account is None


def test_config_account_set():
    c = Config(ingest_url="http://x", service="s", account="acme")
    assert c.account == "acme"
```
`tests/test_event.py` 加(`SCHEMA` 是本文件已有的契约 fixture):
```python
def test_build_event_stamps_account_and_is_valid():
    ev = event.build_event(
        service="python-lesson-parser", provider="doubao", operation="chat",
        request_model="m", identity={"user_id": "u", "org_id": None,
        "project": None, "identity_source": "header"},
        start_ms=0, end_ms=1, account="acme",
    )
    assert ev["account"] == "acme"
    jsonschema.validate(ev, SCHEMA)


def test_build_event_account_defaults_none():
    ev = event.build_event(
        service="s", provider="doubao", operation="chat", request_model="m",
        identity={"user_id": "u", "org_id": None, "project": None,
        "identity_source": "header"}, start_ms=0, end_ms=1,
    )
    assert ev["account"] is None
    jsonschema.validate(ev, SCHEMA)
```
> 若 `build_event` 还需其它必填 kwargs,照搬本文件既有 `test_build_success_event_is_contract_valid` 的那次调用,只加 `account`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/sdk-python && python -m pytest tests/test_config.py tests/test_event.py -q`
Expected: FAIL —— `Config` 无 `account` 形参 / `ev` 无 `"account"` 键。

- [ ] **Step 3: config.py 加 account**

确保文件顶部有 `from typing import Optional`(没有则加);在 `Config` 的 `service: str` 之后加(带默认,满足 dataclass 有默认字段排在无默认之后):
```python
    account: Optional[str] = None
```

- [ ] **Step 4: _runtime.py 显式透传**

`def init(ingest_url, service, **kwargs):` → 改为 `def init(ingest_url, service, account=None, **kwargs):`;`_config = Config(ingest_url=ingest_url, service=service, **kwargs)` → 改为 `_config = Config(ingest_url=ingest_url, service=service, account=account, **kwargs)`。

- [ ] **Step 5: event.py 加 kwarg + 盖戳**

`build_event(*, ...)` 签名加 `account=None`(放在 kwargs 任意处,如 `payload=None` 旁);返回 dict 在 `"service": service,` 之后加:
```python
        "account": account,
```

- [ ] **Step 6: capture.py 两处带上 account**

`_success_event` 与 `_failure_event` 两处的 `build_event(` 调用,各在 `service=cfg.service if cfg else "unknown",` 之后加:
```python
                account=cfg.account if cfg else None,
```

- [ ] **Step 7: 跑测试确认通过 + 全套**

Run: `cd packages/sdk-python && python -m pytest -q`
Expected: 全套 PASS(注意 test_capture / test_public_api 的版本断言留到 Task 5 再翻——本 Task 不动版本)。

- [ ] **Step 8: Commit**

```bash
git add packages/sdk-python/src packages/sdk-python/tests/test_config.py packages/sdk-python/tests/test_event.py
git commit -m "feat(sdk-python): account 配置项透传并盖戳到每条事件(默认 None)"
```

---

### Task 5: Python SDK — 版本 0.1.0 → 0.1.1

**Files:**
- Modify: `C:\Code\chobo\packages\sdk-python\pyproject.toml`(line 7 `version`)
- Modify: `C:\Code\chobo\packages\sdk-python\src\chobo\__init__.py`(`__version__`)
- Modify: `C:\Code\chobo\packages\sdk-python\src\chobo\event.py`(`SDK_VERSION`)
- Test: `C:\Code\chobo\packages\sdk-python\tests\test_public_api.py`

- [ ] **Step 1: 改断言制造失败**

`tests/test_public_api.py`:`assert chobo.__version__ == "0.1.0"` → 改成 `"0.1.1"`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/sdk-python && python -m pytest tests/test_public_api.py -q`
Expected: FAIL。

- [ ] **Step 3: 改 3 处版本串**
- `pyproject.toml` line 7:`version = "0.1.1"`
- `src/chobo/__init__.py` line 7:`__version__ = "0.1.1"`
- `src/chobo/event.py` line 6:`SDK_VERSION = "0.1.1"`

- [ ] **Step 4: 跑全套确认通过**

Run: `cd packages/sdk-python && python -m pytest -q`
Expected: 全套 PASS(含 test_event 里带 sdk_version 的事件断言)。

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-python
git commit -m "chore(sdk-python): bump 0.1.0 -> 0.1.1"
```

---

### Task 6: CRM — 迁移加列 + ingest 存 account

**Files:**
- Create: `C:\Code\chobo\server\migrations\0002_account.sql`
- Modify: `C:\Code\chobo\server\src\types.ts`(`EventInput`)
- Modify: `C:\Code\chobo\server\src\ingest.ts`(`ROW_COLS` + `toRow`)
- Test: `C:\Code\chobo\server\test\ingest.test.ts`

> 需本机 Docker daemon(testcontainers 拉 `postgres:16-alpine`)。

- [ ] **Step 1: 写失败测试**

在 `test/ingest.test.ts` 里新增一条断言 account 持久化的用例(模仿本文件既有"INSERT 回环"用例:POST 一条带 `account` 的事件,再查库)。最小形态:
```ts
it("persists account from the event", async () => {
  const ev = makeEvent({ event_id: "acc-1", account: "five-elements" });
  await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev] } });
  const [row] = await pg.sql`SELECT account FROM usage_events WHERE event_id = 'acc-1'`;
  expect(row.account).toBe("five-elements");
});
```
> `makeEvent`/`app`/`pg` 用本文件既有的辅助;若无 `makeEvent`,照搬本文件既有 POST 用例构造事件对象,加 `account` 键。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run test/ingest.test.ts`
Expected: FAIL —— `usage_events` 无 `account` 列(或 ingest 未写入)→ row.account undefined / SQL 报错。

- [ ] **Step 3: 新建迁移 `0002_account.sql`**

```sql
-- 0002_account: 多租户 account 维度(可空,区分哪个 app)
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS account text;
CREATE INDEX IF NOT EXISTS ix_usage_account_created ON usage_events (account, created_at);
```
> `migrate()` 自动按文件名字典序发现并执行,无需改 runner。

- [ ] **Step 4: `EventInput` 加 account**

`server/src/types.ts` 的 `EventInput` 在 `project` 字段旁加:
```ts
  account?: string | null;
```

- [ ] **Step 5: ingest.ts 写列**

`ROW_COLS` 在 `"project",` 之后加 `"account",`:
```ts
  "event_id","request_id","parent_id","user_id","org_id","project","account","identity_source",
```
`toRow` 在 `project: e.project ?? null,` 之后加:
```ts
    account: e.account ?? null,
```
> ⚠ ROW_COLS 与 toRow 的键必须与真实列严格对应,否则批量 INSERT 报错。

- [ ] **Step 6: 跑测试确认通过 + ingest 全套**

Run: `cd server && npx vitest run test/ingest.test.ts test/migrate.test.ts`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add server/migrations/0002_account.sql server/src/types.ts server/src/ingest.ts server/test/ingest.test.ts
git commit -m "feat(server): usage_events 加 account 列,ingest 落库"
```

---

### Task 7: CRM — account 过滤 + by-account 维度

**Files:**
- Modify: `C:\Code\chobo\server\src\filters.ts`
- Modify: `C:\Code\chobo\server\src\stats.ts`(`DIM_COL`)
- Create: `C:\Code\chobo\server\test\stats.byaccount.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `test/stats.byaccount.test.ts`,照搬 `test/stats.bydim.test.ts` 的 harness(beforeAll startPg+registerStats、afterAll、beforeEach truncate+seed),seed 行的显式列清单里**加上 `account`**,两条不同 account 的行,断言:

```ts
describe("GET /v1/stats/by-account", () => {
  it("aggregates per account", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/stats/by-account" });
    const rows = res.json().rows;
    expect(rows.find((r: any) => r.key === "five-elements")).toBeTruthy();
  });
  it("?account=X narrows results", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/stats/by-user?account=five-elements" });
    expect(res.statusCode).toBe(200);
    // 仅 account=five-elements 的行计入
  });
});
```
> seed 的 INSERT 必须把 `account` 列加进显式列清单与 VALUES;`total_cost` 断言用 numeric 字符串(8 位小数,计费铁律),`events`/`total_tokens` 为数字。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run test/stats.byaccount.test.ts`
Expected: FAIL —— `/v1/stats/by-account` 404(DIM_COL 无此键);`?account=` 不生效。

- [ ] **Step 3: filters.ts 加 account 过滤**

`Filters` 接口加 `account?: string;`;`parseFilters` 返回对象加 `account: q.account`;`whereFragment` 在 `if (f.project) ...` 之后加:
```ts
  if (f.account) conds.push(sql`account = ${f.account}`);
```

- [ ] **Step 4: stats.ts 加 by-account 维度**

`DIM_COL` 字面量加键(`for...of` 循环会自动注册 `GET /v1/stats/by-account`,`sql(col)` 白名单——键来自 DIM_COL 非用户输入):
```ts
  const DIM_COL: Record<string, string> = { "by-user": "user_id", "by-org": "org_id", "by-project": "project", "by-account": "account" };
```

- [ ] **Step 5: 跑测试确认通过 + stats 全套**

Run: `cd server && npx vitest run test/stats.byaccount.test.ts && npm test`
Expected: 全套 PASS(overview/timeseries/events 因走 whereFragment 自动获得 account 过滤)。

- [ ] **Step 6: Commit**

```bash
git add server/src/filters.ts server/src/stats.ts server/test/stats.byaccount.test.ts
git commit -m "feat(server): account 过滤 + /v1/stats/by-account 维度"
```

---

### Task 8: 看板 — account 过滤项 + by-account 排行 + 下钻

**Files:**
- Modify: `C:\Code\chobo\web\src\api\types.ts`
- Modify: `C:\Code\chobo\web\src\components\FilterBar.tsx`
- Modify: `C:\Code\chobo\web\src\components\DimensionRanking.tsx`
- Modify: `C:\Code\chobo\web\src\App.tsx`
- Test: `C:\Code\chobo\web\test\filterbar.test.tsx`、`ranking.test.tsx`、`smoke.test.tsx`

- [ ] **Step 1: 写失败测试**

`test/filterbar.test.tsx` 加(照搬既有 "typing a user_id" 用例,换 account):
```tsx
it("typing an account updates filter state", async () => {
  render(<Harness />);
  await userEvent.type(screen.getByPlaceholderText("account"), "five-elements");
  expect(screen.getByTestId("state").textContent).toContain("\"account\":\"five-elements\"");
});
```
`test/ranking.test.tsx` 加(照搬 tab-switch 用例):
```tsx
it("by-account tab fires onTab", async () => {
  const onTab = vi.fn();
  render(<DimensionRanking data={byUser} dimension="by-user" onTab={onTab} onDrill={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "按账户" }));
  expect(onTab).toHaveBeenCalledWith("by-account");
});
```
`test/smoke.test.tsx` 加(照搬既有 drill 用例,验证下钻写 account 而非 project——这正是 App.tsx 三元兜底 bug 的回归):
```tsx
it("drilling a by-account row writes the account filter", async () => {
  mockApi();
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "按账户" }));
  await waitFor(() => expect(screen.getByText("five-elements")).toBeInTheDocument());
  await userEvent.click(screen.getByText("five-elements"));
  expect(screen.getByLabelText("account")).toHaveValue("five-elements");
});
```
> `mockApi()` 既有的 `/v1/stats/by-` 匹配已覆盖任意 by-*,需确保其返回的行里有 `key:"five-elements"`(按 mock 实现微调 fixture)。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run test/filterbar.test.tsx test/ranking.test.tsx test/smoke.test.tsx`
Expected: FAIL —— 无 account 输入框 / 无"按账户"tab / 下钻落到 project。

- [ ] **Step 3: types.ts 三处**

`Filters` 在 identity 组加 `account?: string;`:
```ts
  user_id?: string; org_id?: string; project?: string; account?: string;
```
`EventRow` 加 `account: string | null;`:
```ts
  user_id: string | null; org_id: string | null; project: string | null; account: string | null;
```
`Dimension` 加成员:
```ts
export type Dimension = "by-user" | "by-org" | "by-project" | "by-account";
```

- [ ] **Step 4: FilterBar.tsx 加字段(数据驱动,仅改 FIELDS)**

`FIELDS` 数组在 project 后加:
```ts
  { key: "user_id", ph: "user_id" }, { key: "org_id", ph: "org_id" }, { key: "project", ph: "project" }, { key: "account", ph: "account" },
```

- [ ] **Step 5: DimensionRanking.tsx 加 tab**

`TABS` 数组加:
```ts
  { dim: "by-user", label: "按用户" }, { dim: "by-org", label: "按机构" }, { dim: "by-project", label: "按任务" }, { dim: "by-account", label: "按账户" },
```

- [ ] **Step 6: App.tsx 修三元兜底**

`drill()` 里把会"兜底落 project"的三元链补全(否则 by-account 静默落错列):
```ts
    const col = d === "by-user" ? "user_id" : d === "by-org" ? "org_id" : d === "by-project" ? "project" : "account";
```

- [ ] **Step 7: 跑测试确认通过 + 全套**

Run: `cd web && npm test`
Expected: 全套(35+ → 38+)PASS。

- [ ] **Step 8: Commit**

```bash
git add web/src web/test
git commit -m "feat(web): account 过滤项 + 按账户排行 + 下钻(修 drill 三元兜底)"
```

---

### Task 9: five-elements — account='five-elements' + project=null + 重 vendor 0.1.2

**Files:**
- Build: `C:\Code\chobo\packages\sdk-node`(`npm pack` 出 tarball)
- Replace: `C:\Code\five-elements\server\vendor\chobo-sdk-0.1.2.tgz`(删旧 0.1.1)
- Modify: `C:\Code\five-elements\server\package.json`(line 15 file: 依赖)
- Modify: `C:\Code\five-elements\server\src\lib\choboMeter.js`
- Test: `C:\Code\five-elements\server\tests\chobo\{choboMeter,identity,worker-identity,imageGen.metered}.test.js`

- [ ] **Step 1: 构建并打 0.1.2 tarball,投放 vendor**

Run:
```bash
cd C:/Code/chobo/packages/sdk-node && npm run build && npm pack
# 产出 chobo-sdk-0.1.2.tgz(scope 去掉)
mv chobo-sdk-0.1.2.tgz C:/Code/five-elements/server/vendor/
rm -f C:/Code/five-elements/server/vendor/chobo-sdk-0.1.1.tgz
```

- [ ] **Step 2: package.json 指向 0.1.2 + 重装**

`server/package.json` 依赖:`"@chobo/sdk": "file:vendor/chobo-sdk-0.1.2.tgz",`
Run: `cd C:/Code/five-elements/server && npm install`
Expected: 重解析 file: 依赖,装上 0.1.2。

- [ ] **Step 3: 写失败测试(翻 project 断言 + 加 account)**

改三处既有 `project` 断言为 `null`,并在落库事件的用例里加 account 断言:
- `tests/chobo/choboMeter.test.js`(约 line 63):`expect(e.project).toBe('five-elements')` → `expect(e.project).toBe(null)`,并加 `expect(e.account).toBe('five-elements')`。
- `tests/chobo/identity.test.js`(约 line 23):`expect(seen.project).toBe('five-elements')` → `expect(seen.project).toBe(null)`。(account 在 config 不在 identity,`getIdentity()` 不带,故此处不加 account 断言。)
- `tests/chobo/worker-identity.test.js`(约 line 23):同上翻 null。
- `tests/chobo/imageGen.metered.test.js`(posted image event 用例,约 line 30-33):加 `expect(e.account).toBe('five-elements')` 与 `expect(e.project).toBe(null)`(`e` 用本用例已捕获的 posted event 变量名)。

- [ ] **Step 4: 跑测试确认失败**

Run: `cd C:/Code/five-elements/server && npx jest tests/chobo --runInBand`
Expected: FAIL —— 现仍 `project='five-elements'`、`account` undefined。

- [ ] **Step 5: choboMeter.js 改三处**

- 删除 line 5 `const PROJECT = 'five-elements'`。
- `initChobo()` 的 `chobo.init({...})` 在 `service: 'five-elements-server',` 之后加:
```js
      account: 'five-elements',
```
- `runIdentity()` 里 `project: PROJECT` → `project: null`。

- [ ] **Step 6: 跑测试确认通过 + 全套**

Run: `cd C:/Code/five-elements/server && npm test`
Expected: 12 chobo 测试 + 全套 PASS。

- [ ] **Step 7: Commit(five-elements 仓)**

```bash
cd C:/Code/five-elements
git add server/src/lib/choboMeter.js server/package.json server/package-lock.json server/vendor tests 2>/dev/null; git add server/tests
git commit -m "feat(chobo): account=five-elements,per-event project 改 null,vendor SDK 0.1.2"
```

---

## Part 2 — CRM 部署(独立中立服务,非 TDD)

### Task 10: chobo 部署基础件 — .dockerignore + 生产 price-seed

**Files:**
- Create: `C:\Code\chobo\.dockerignore`
- Create: `C:\Code\chobo\price-seed.json`

- [ ] **Step 1: 写 `.dockerignore`(repo 根)**

```
.git
**/node_modules
**/.env
**/.env.*
!**/.env.example
docs/
packages/
**/.vite
**/*.tsbuildinfo
.chobo-spool/
```
> 注意**不**排除 `web/dist` / `server/dist` 的源——镜像里在构建阶段现编;但 `packages/`(两 SDK)CRM 不需要,排除掉减小上下文。`contracts/`、`price-seed.json`、`server/`、`web/`、`ci/` 必须可进上下文。

- [ ] **Step 2: 生产 price-seed.json**

把 `server/price-seed.example.json` 内容拷为 repo 根 `price-seed.json`(doubao 行 + alias;gpt-image-2 不进 → 待价 NULL)。校验 JSON 合法:
Run: `node -e "JSON.parse(require('fs').readFileSync('price-seed.json','utf8')); console.log('seed json ok')"`
Expected: `seed json ok`。

- [ ] **Step 3: Commit**

```bash
git add .dockerignore price-seed.json
git commit -m "chore(deploy): chobo .dockerignore + 生产 price-seed(doubao)"
```

---

### Task 11: chobo CRM 多阶段 Dockerfile

**Files:**
- Create: `C:\Code\chobo\ci\Dockerfile`

> 镜像内布局必须满足运行期相对路径:server 在 `/app/server`(`dist/server.js`),`migrations` 在 `/app/server/migrations`(server.ts 读 `dist/../migrations`),`contracts` 在 `/app/contracts`(validator 读 `dist/../../contracts`),web 在 `/app/web`,seed 在 `/app/price-seed.json`。

- [ ] **Step 1: 写 `ci/Dockerfile`**

```dockerfile
# chobo CRM —— 多阶段:server(tsc)+ web(vite)分别构建,runtime 只带生产依赖
FROM node:20-bookworm-slim AS server-build
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --registry=https://registry.npmmirror.com
COPY server/ ./
RUN npm run build

FROM node:20-bookworm-slim AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci --registry=https://registry.npmmirror.com
COPY web/ ./
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app/server
ENV NODE_ENV=production TZ=Asia/Shanghai
COPY server/package*.json ./
RUN npm ci --omit=dev --registry=https://registry.npmmirror.com && npm cache clean --force
COPY --from=server-build /app/server/dist ./dist
COPY server/migrations ./migrations
COPY contracts /app/contracts
COPY --from=web-build /app/web/dist /app/web
COPY price-seed.json /app/price-seed.json
EXPOSE 8787
CMD ["node", "dist/server.js"]
```

- [ ] **Step 2: 本地构建冒烟**

Run(chobo 根):
```bash
docker build -f ci/Dockerfile -t chobo-crm:latest .
```
Expected: 三阶段成功,`chobo-crm:latest` 生成。若 `tsc`/`vite` 报错先修源,不得绕过。

- [ ] **Step 3:(可选,若本机 Docker 可用)起容器 + 端到端冒烟**

Run:
```bash
docker network create chobo-smoke 2>/dev/null || true
docker run -d --rm --name chobo-pg --network chobo-smoke -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=chobo postgres:16-alpine
sleep 6
docker run -d --rm --name chobo-crm-smoke --network chobo-smoke \
  -e CHOBO_DATABASE_URL=postgres://postgres:pw@chobo-pg:5432/chobo \
  -e CHOBO_WEB_DIR=/app/web -e CHOBO_PRICE_SEED=/app/price-seed.json \
  -p 18787:8787 chobo-crm:latest
sleep 5
curl -fs http://127.0.0.1:18787/healthz && echo " <- healthz ok"
curl -fs http://127.0.0.1:18787/v1/stats/by-account && echo " <- by-account ok"
docker stop chobo-crm-smoke chobo-pg; docker network rm chobo-smoke
```
Expected: `/healthz` 返回 `{"ok":true}`;`/v1/stats/by-account` 返回 200 JSON(空 rows)。证明镜像内 migrations/contracts/web 布局正确、自迁移+自 seed 成功。
> 若本机无 Docker,跳过此步,标注"待部署机验证"。

- [ ] **Step 4: Commit**

```bash
git add ci/Dockerfile
git commit -m "feat(deploy): chobo CRM 多阶段 Dockerfile(server+web+contracts 布局)"
```

---

### Task 12: chobo 部署编排件 — compose + 建库 SQL + nginx vhost

**Files:**
- Create: `C:\Code\chobo\deploy\docker-compose.crm.yml`
- Create: `C:\Code\chobo\deploy\chobo-init-db.sql`
- Create: `C:\Code\chobo\deploy\nginx.chobo.conf`

- [ ] **Step 1: `docker-compose.crm.yml`**

```yaml
services:
  chobo-crm:
    image: chobo-crm:latest
    container_name: chobo-crm
    restart: always
    env_file: ./chobo.prod.env          # CHOBO_DATABASE_URL + CHOBO_INGEST_SECRET(宿主手填,gitignored)
    environment:
      NODE_ENV: production
      CHOBO_PORT: "8787"
      CHOBO_HOST: 0.0.0.0
      CHOBO_WEB_DIR: /app/web
      CHOBO_PRICE_SEED: /app/price-seed.json
    ports:
      - "127.0.0.1:8787:8787"           # 只绑本机,nginx/SSH 隧道前置
    networks: [pgnet]
networks:
  pgnet:
    external: true
    name: postgres18_default            # 复用 postgres18 所在外部网,容器名 postgres18 直达 PG
```

- [ ] **Step 2: `chobo-init-db.sql`(fugue 用 pgadmin 跑一次)**

```sql
-- 在宿主:docker exec -i postgres18 psql -U pgadmin -d default_db < chobo-init-db.sql
-- 与 five_elements 库隔离;密码 fugue 改成强随机串
CREATE USER chobo WITH PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
CREATE DATABASE chobo OWNER chobo;
\connect chobo
GRANT ALL ON SCHEMA public TO chobo;
-- 建表/索引由 CRM 启动时自迁移(0001_init + 0002_account),此处只建库+账号
```

- [ ] **Step 3: `nginx.chobo.conf`(复用泛域名证书 + basic-auth)**

```nginx
# chobo 看板(无登录页;鉴权全靠 basic-auth)。复用 *.example.com 泛域名证书。
# ingest(/v1/events)走容器内网 chobo-crm:8787,不经此 vhost,故 basic-auth 不影响接入方上报。
server {
    listen 443 ssl;
    server_name chobo.example.com;

    ssl_certificate     /etc/nginx/cert/example/example.com.pem;
    ssl_certificate_key /etc/nginx/cert/example/example.com.key;

    auth_basic           "chobo";
    auth_basic_user_file /etc/nginx/.htpasswd.chobo;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

- [ ] **Step 4: 校验 compose 语法**

Run: `cd deploy && docker compose -f docker-compose.crm.yml config >/dev/null && echo "compose ok"`
Expected: `compose ok`(external 网络在本机不存在时仅 `config` 校验不报错;`up` 才需要网络)。

- [ ] **Step 5: Commit**

```bash
git add deploy/docker-compose.crm.yml deploy/chobo-init-db.sql deploy/nginx.chobo.conf
git commit -m "feat(deploy): chobo CRM compose + 建库 SQL + nginx 子域名 basic-auth"
```

---

### Task 13: chobo ship 脚本 + 部署 runbook

**Files:**
- Create: `C:\Code\chobo\deploy\ship-crm.sh`
- Create: `C:\Code\chobo\deploy\CRM_DEPLOY_RUNBOOK.md`

- [ ] **Step 1: `ship-crm.sh`(镜像 five-elements ship.sh 房规)**

```bash
#!/usr/bin/env bash
set -euo pipefail
HOST="${HOST:-203.0.113.10}"
SSH_TARGET="root@${HOST}"
REMOTE="${REMOTE_DIR:-/opt/chobo}"
export MSYS_NO_PATHCONV=1                 # Windows Git Bash 防路径转换
cd "$(dirname "$0")/.."                    # repo 根

echo "==> build chobo-crm:latest"
docker build -f ci/Dockerfile -t chobo-crm:latest .

echo "==> save + gzip"
docker save chobo-crm:latest | gzip > /tmp/chobo-crm.tar.gz

echo "==> scp 镜像 + compose"
ssh "$SSH_TARGET" "mkdir -p ${REMOTE}"
scp /tmp/chobo-crm.tar.gz "${SSH_TARGET}:${REMOTE}/"
scp deploy/docker-compose.crm.yml "${SSH_TARGET}:${REMOTE}/"

echo "==> remote load + up"
ssh "$SSH_TARGET" REMOTE="${REMOTE}" bash -s <<'REMOTE_EOF'
set -euo pipefail
cd "${REMOTE}"
docker load < chobo-crm.tar.gz
if [ ! -f chobo.prod.env ]; then
  echo "!! 缺 chobo.prod.env(需含 CHOBO_DATABASE_URL=postgres://chobo:<pw>@postgres18:5432/chobo 与 CHOBO_INGEST_SECRET),中止"; exit 1
fi
docker compose -f docker-compose.crm.yml up -d --force-recreate
check_health() {
  for d in 3 6 9; do sleep "$d"
    if curl -fs http://127.0.0.1:8787/healthz >/dev/null; then echo "health OK"; return 0; fi
  done
  echo "!! health 失败"; docker compose -f docker-compose.crm.yml logs --tail=50; return 1
}
check_health
REMOTE_EOF
echo "==> done. 看板激活见 deploy/CRM_DEPLOY_RUNBOOK.md"
```

- [ ] **Step 2: `CRM_DEPLOY_RUNBOOK.md`**

写明顺序(fugue 手动):①(一次)`docker exec -i postgres18 psql -U pgadmin -d default_db < chobo-init-db.sql`(改强密码);② 宿主 `/opt/chobo/chobo.prod.env` 填 `CHOBO_DATABASE_URL` + `CHOBO_INGEST_SECRET=$(openssl rand -hex 32)`;③ 本地 `bash deploy/ship-crm.sh`;④ 看板:`htpasswd -c /etc/nginx/.htpasswd.chobo <user>` → `cp deploy/nginx.chobo.conf /etc/nginx/sites-available/chobo.example.com` → `ln -s` 到 sites-enabled → `nginx -t && systemctl reload nginx` → 配 `chobo.example.com` A 记录到 `203.0.113.10`;⑤ five-elements 改 `server.prod.env` 三行(`CHOBO_INGEST_URL=http://chobo-crm:8787/v1/events`、`CHOBO_INGEST_SECRET=<同④的共享值>`、`CHOBO_SPOOL_DIR=/app/.chobo-spool`)→ `bash deploy/ship.sh`;⑥ 验证:浏览器开 `https://chobo.example.com`(basic-auth)看到 five-elements 真实流量按 account 归因、doubao 计价、gpt-image-2 NULL。

- [ ] **Step 3: 语法检查**

Run: `bash -n deploy/ship-crm.sh && echo "ship-crm.sh 语法 ok"`
Expected: `ship-crm.sh 语法 ok`。

- [ ] **Step 4: Commit**

```bash
git add deploy/ship-crm.sh deploy/CRM_DEPLOY_RUNBOOK.md
git commit -m "feat(deploy): ship-crm.sh 一键部署 + CRM 部署 runbook"
```

---

### Task 14: five-elements 生产 env 修正(ingest-url + spool 卷)

**Files:**
- Modify: `C:\Code\five-elements\server\.env.example`
- Modify: `C:\Code\five-elements\docker-compose.prod.yml`

- [ ] **Step 1: `.env.example` chobo 三行更正**

把注释块里的 `CHOBO_INGEST_URL=http://127.0.0.1:8787/v1/events` 改为指向容器名,并注明绝对 spool:
```
# ── chobo 计量(可选;不配则整套休眠,业务字节等同)──
# CHOBO_INGEST_URL=http://chobo-crm:8787/v1/events    # 容器间走服务名,勿用 127.0.0.1
# CHOBO_INGEST_SECRET=                                 # 与 CRM 同一共享密钥
# CHOBO_SPOOL_DIR=/app/.chobo-spool                    # 绝对路径 + 挂卷,溢出落盘跨重建不丢
```

- [ ] **Step 2: `docker-compose.prod.yml` server 服务加 chobo env + spool 卷**

`server.environment` 块加(非密钥项可内联;密钥 `CHOBO_INGEST_SECRET` 走 gitignored `server.prod.env`):
```yaml
      CHOBO_INGEST_URL: http://chobo-crm:8787/v1/events
      CHOBO_SPOOL_DIR: /app/.chobo-spool
```
`server` 服务加卷,并在文件末尾加顶层 `volumes:`:
```yaml
    volumes:
      - chobo_spool:/app/.chobo-spool
```
```yaml
volumes:
  chobo_spool:
```
> `CHOBO_INGEST_SECRET` 不写进此文件(gitignored env 里);CRM 容器 `chobo-crm` 与 five-elements 同在 `postgres18_default` 网络才能用服务名直达。

- [ ] **Step 3: 校验 compose 语法**

Run: `cd C:/Code/five-elements && docker compose -f docker-compose.prod.yml config >/dev/null && echo "fe compose ok"`
Expected: `fe compose ok`。

- [ ] **Step 4: Commit(five-elements 仓)**

```bash
cd C:/Code/five-elements
git add server/.env.example docker-compose.prod.yml
git commit -m "fix(chobo): 生产 ingest 指向 chobo-crm 服务名 + spool 持久卷"
```

---

### Task 15: 文档同步 + 终审

**Files:**
- Modify: `C:\Code\chobo\docs\dev-log.md`
- Modify: `C:\Code\chobo\CLAUDE.md`(状态节)

- [ ] **Step 1: dev-log 追加 Plan 6 落地条目**

记:account 维度跨契约/双 SDK/CRM/看板落地(Node 0.1.2 / Python 0.1.1);five-elements account=five-elements、project→null、vendor 0.1.2;CRM 部署件(Dockerfile/compose/ship-crm/建库 SQL/nginx)就绪待 fugue 上线;gpt-image-2 计价仍 NULL 待后续 plan。

- [ ] **Step 2: CLAUDE.md 状态节更新**

Plan 6 标 ✅(实现交付,CRM 待 fugue 部署)。

- [ ] **Step 3: 跑两仓全套测试做终审基线**

Run:
```bash
cd C:/Code/chobo/packages/sdk-node && npm test
cd C:/Code/chobo/packages/sdk-python && python -m pytest -q
cd C:/Code/chobo/server && npm test
cd C:/Code/chobo/web && npm test
cd C:/Code/five-elements/server && npm test
```
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
cd C:/Code/chobo
git add docs/dev-log.md CLAUDE.md
git commit -m "docs(plan6): account 维度 + CRM 部署落地,状态同步"
```

- [ ] **Step 5: 终审(subagent-driven-development 的整体 code review)**

派最终 reviewer 通览两仓全部改动:契约/双 SDK/CRM/看板 account 一致性、ingest ROW_COLS↔列对齐、Dockerfile 三处运行期相对路径、ship-crm 不覆盖 env、计费铁律(cost 仍字符串、缺价 NULL 非 0)。

---

## 自检对照(spec 覆盖)

- spec §4.1 契约 → Task 1 ✅
- spec §4.2 Node SDK + 0.1.2 → Task 2、3 ✅
- spec §4.3 Python SDK → Task 4、5 ✅
- spec §4.4 CRM(迁移/ingest/filters/stats)→ Task 6、7 ✅
- spec §4.5 看板 → Task 8 ✅
- spec §4.6 five-elements → Task 9 ✅
- spec §5.2 Dockerfile → Task 11 ✅
- spec §5.3 部署件(ship/compose/建库/seed/nginx)→ Task 10、12、13 ✅
- spec §5.4 five-elements env 修正 → Task 14 ✅
- spec §8 测试策略(各包 TDD + 部署非 TDD)→ 各 Task 步骤 ✅
- gpt-image-2 计价(非目标,NULL)→ 未排任务,符合 spec ✅
