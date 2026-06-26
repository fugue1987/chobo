# five-elements 接入 chobo 实现计划(Plan 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `@chobo/sdk` 以最小侵入接进 fugue 自有的 five-elements server(Node/CJS),让其 doubao 文本 + gpt-image-2 生图调用被真实计量、归因(per user)、算价、上看板。

**Architecture:** 两 funnel 原地 `meter` 包装(`lib/llm.js`、`lib/imageGen.js`),env 闸门化(`CHOBO_INGEST_URL` 未配则字节等同);身份用 `runWithIdentity` 在 `devAuth`(请求路径)+ 两个 worker(`forumAiWorker`/`visualJobWorker`,worker 路径)注入,`user_id` 来自 `req.user.id`/`job.user_id`,`project` 常量、`identity_source=jwt`;SDK 先补 `ingestSecret`(发 `x-chobo-secret`)再以 tarball vendoring 装入。

**Tech Stack:** chobo 侧 = `@chobo/sdk`(TS,vitest);five-elements 侧 = Node CommonJS · Express 4.21 · Jest+supertest · 零新增运行时依赖(只加 `@chobo/sdk` tarball)。

**权威依据:** spec `docs/superpowers/specs/2026-06-25-five-elements-integration-design.md`。有出入以 spec 为准。

---

## 跨仓说明(重要)

本计划横跨**两个 git 仓库**:

- **Phase A** 改 **chobo**(`C:\Code\chobo`)—— SDK 补 `ingestSecret` + 出 tarball。在 chobo 起功能分支 `plan5-sdk-ingest-secret`,各 Task 提交到该分支。
- **Phase B** 改 **five-elements**(`C:\Code\five-elements\server`)—— 真正的接入。在 five-elements 起功能分支 `chobo-metering`,各 Task 提交到该分支。
- **Phase C** 回 **chobo** 收尾文档(同分支或 master 文档提交,见任务)。

**每个 Task 标注 `CWD:`。** Phase A→B 有依赖(B 装的 tarball 由 A 产出),必须按序。

---

## 文件结构(改动地图)

### chobo 仓(Phase A)
| 文件 | 责任 | 动作 |
|---|---|---|
| `packages/sdk-node/src/config.ts` | 加 `ingestSecret?` 字段 | 改 |
| `packages/sdk-node/src/transport.ts` | `post()` 发 `x-chobo-secret` 头 | 改 |
| `packages/sdk-node/src/event.ts` · `src/index.ts` · `test/helpers.ts` | 版本 0.1.0→0.1.1 | 改 |
| `packages/sdk-node/package.json` | version 0.1.1 | 改 |
| `packages/sdk-node/test/transport.secret.test.ts` | 密钥头测试 | 建 |
| `packages/sdk-node/README.md` | config 表加行 | 改 |
| `five-elements/server/vendor/chobo-sdk-0.1.1.tgz` | pack 产物(交付给 Phase B) | 建 |

### five-elements 仓(Phase B)
| 文件 | 责任 | 动作 |
|---|---|---|
| `server/package.json` | 加 `@chobo/sdk` tarball 依赖 | 改 |
| `server/src/lib/choboMeter.js` | **唯一接入点**:init/shutdown/runIdentity/meterChat/meterImage,全 env 闸门 | 建 |
| `server/src/lib/llm.js` | `chatComplete` 内层包 `meterChat` | 改 |
| `server/src/lib/imageGen.js` | `generateImage` 派发处包 `meterImage` | 改 |
| `server/src/middleware/devAuth.js` | 设 `req.user` 后 `runIdentity` 包 `next` | 改 |
| `server/src/lib/forumAiWorker.js` | 包 `generateReply(job)`(`job.user_id`) | 改 |
| `server/src/lib/visualJobWorker.js` | 包 `processJob(job)`(`job.user_id`) | 改 |
| `server/src/index.js` | 启动 `initChobo()` + SIGTERM `shutdownChobo()` | 改 |
| `server/.env.example` | 加 chobo env 项 | 改/建 |
| `server/test/chobo/*.test.js` | 接入单测(stub ingest) | 建 |

### chobo 仓(Phase C)
| 文件 | 动作 |
|---|---|
| `docs/dev-log.md` · `CLAUDE.md` | Plan 5 状态同步 | 改 |
| `server/price-seed.example.json` | 注释说明 gpt-image-2(newapi)待价行 | 改 |

---

## Phase A — chobo SDK 补 `ingestSecret`

> **执行前(一次性):** `CWD: C:\Code\chobo` · `git switch -c plan5-sdk-ingest-secret`

### Task A1: SDK 发送 `x-chobo-secret`

**Files:**
- Modify: `packages/sdk-node/src/config.ts`
- Modify: `packages/sdk-node/src/transport.ts:79-84`
- Create: `packages/sdk-node/test/transport.secret.test.ts`
- Modify: `packages/sdk-node/README.md`

- [ ] **Step 1: 写失败测试**

Create `packages/sdk-node/test/transport.secret.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Transport } from "../src/transport.js";
import { cfg, ev } from "./helpers.js";

/** 用 fetchImpl 注入桩,捕获 SDK 真正发出的请求头。 */
function capturingFetch() {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url: String(url), headers: init.headers });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe("transport ingestSecret -> x-chobo-secret header", () => {
  it("sends the secret header when configured", async () => {
    const { calls, impl } = capturingFetch();
    const t = new Transport(cfg("http://x/v1/events", { ingestSecret: "s3cret", fetchImpl: impl }));
    t.enqueue(ev(0));
    await t.flush();
    await t.shutdown();
    expect(calls.length).toBe(1);
    expect(calls[0].headers["x-chobo-secret"]).toBe("s3cret");
  });

  it("omits the secret header when not configured", async () => {
    const { calls, impl } = capturingFetch();
    const t = new Transport(cfg("http://x/v1/events", { fetchImpl: impl }));
    t.enqueue(ev(0));
    await t.flush();
    await t.shutdown();
    expect(calls.length).toBe(1);
    expect("x-chobo-secret" in calls[0].headers).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/sdk-node && npx vitest run test/transport.secret.test.ts`
Expected: FAIL —— 第一例 `x-chobo-secret` 为 `undefined`(因 `ingestSecret` 还不是合法配置字段 / 头未发)。

- [ ] **Step 3: config 加字段**

Modify `packages/sdk-node/src/config.ts` —— 在 `ChoboConfig` 与 `ChoboConfigInput` 各加一行(放在 `service` 之后),并在 `resolveConfig` 返回对象里透传:

```ts
// ChoboConfig 接口内,service 之后:
  ingestSecret?: string;
// ChoboConfigInput 接口内,service 之后:
  ingestSecret?: string;
// resolveConfig 返回对象内,service 之后:
    ingestSecret: input.ingestSecret,
```

- [ ] **Step 4: transport 发头**

Modify `packages/sdk-node/src/transport.ts` 的 `post()`(约 79-84 行)的 `headers`:

```ts
      const res = await this.fetchImpl(this.cfg.ingestUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.cfg.ingestSecret ? { "x-chobo-secret": this.cfg.ingestSecret } : {}),
        },
        body: JSON.stringify({ events }),
        signal: controller.signal,
      });
```

- [ ] **Step 5: 跑测试确认通过 + 全量回归**

Run: `cd packages/sdk-node && npx vitest run`
Expected: PASS —— 新 2 例通过,原有 43 例不回归(共 45)。

- [ ] **Step 6: README 加配置行**

Modify `packages/sdk-node/README.md` 的 Config 表,在 `ingestUrl`/`service` 之后插一行:

```markdown
| `ingestSecret` | — | 可选;配置后每次 ingest POST 带 `x-chobo-secret` 头,对接设了 `CHOBO_INGEST_SECRET` 的 CRM |
```

- [ ] **Step 7: Commit**

```bash
git add packages/sdk-node/src/config.ts packages/sdk-node/src/transport.ts packages/sdk-node/test/transport.secret.test.ts packages/sdk-node/README.md
git commit -m "feat(sdk-node): 支持 ingestSecret,ingest POST 发 x-chobo-secret 头"
```

### Task A2: 版本 bump 到 0.1.1

**Files:**
- Modify: `packages/sdk-node/package.json:3`
- Modify: `packages/sdk-node/src/event.ts:5`
- Modify: `packages/sdk-node/src/index.ts:13`
- Modify: `packages/sdk-node/test/helpers.ts:16`

- [ ] **Step 1: 改四处版本号 0.1.0 → 0.1.1**

```
packages/sdk-node/package.json     : "version": "0.1.0"  → "0.1.1"
packages/sdk-node/src/event.ts     : export const SDK_VERSION = "0.1.0";  → "0.1.1"
packages/sdk-node/src/index.ts     : export const VERSION = "0.1.0";      → "0.1.1"
packages/sdk-node/test/helpers.ts  : sdk_version: "0.1.0",                → "0.1.1"
```

- [ ] **Step 2: 扫残留并修**

Run: `cd packages/sdk-node && grep -rn '0\.1\.0' src test`
Expected: 无业务断言残留(若 `test/public-api.test.ts` 等断言 `VERSION`/`SDK_VERSION` 为 `"0.1.0"`,同步改为 `"0.1.1"`)。

- [ ] **Step 3: 全量测试 + typecheck**

Run: `cd packages/sdk-node && npx vitest run && npx tsc --noEmit`
Expected: PASS,tsc 干净。

- [ ] **Step 4: Commit**

```bash
git add packages/sdk-node/package.json packages/sdk-node/src/event.ts packages/sdk-node/src/index.ts packages/sdk-node/test
git commit -m "chore(sdk-node): bump 0.1.0 -> 0.1.1"
```

### Task A3: 构建并打包 tarball,投放到 five-elements/vendor

**Files:**
- Create: `C:\Code\five-elements\server\vendor\chobo-sdk-0.1.1.tgz`(pack 产物)

- [ ] **Step 1: 构建**

Run: `cd packages/sdk-node && npm run build`
Expected: 产出 `dist/index.js` `dist/index.cjs` `dist/index.d.ts` `dist/index.d.cts`(tsup ESM+CJS+dts)。

- [ ] **Step 2: 校验打包面**

Run: `cd packages/sdk-node && npm run validate`
Expected: publint + attw 干净(无错误)。

- [ ] **Step 3: pack 并放入 vendor**

Run(Git Bash):
```bash
cd packages/sdk-node
npm pack            # 产出 chobo-sdk-0.1.1.tgz(因 files:["dist"] 仅含 dist+package.json+README)
mkdir -p /c/Code/five-elements/server/vendor
mv chobo-sdk-0.1.1.tgz /c/Code/five-elements/server/vendor/
ls -la /c/Code/five-elements/server/vendor/chobo-sdk-0.1.1.tgz
```
Expected: tgz 落在 `five-elements/server/vendor/`,数十 KB。

- [ ] **Step 4: 验证 tgz 内容(只含 dist)**

Run: `tar -tzf /c/Code/five-elements/server/vendor/chobo-sdk-0.1.1.tgz | head`
Expected: 仅 `package/package.json`、`package/README.md`、`package/dist/*`,无 `src`/`test`。

> 本 Task 不产生 chobo 仓的 git 提交(tgz 落在 five-elements 仓,随 Phase B 的提交进版本)。

---

## Phase B — five-elements 接入

> **执行前(一次性):** `CWD: C:\Code\five-elements\server` · 确认是 git 仓库:`git rev-parse --git-dir` · `git switch -c chobo-metering`

### Task B1: 安装 SDK tarball 依赖

**Files:**
- Modify: `server/package.json`(dependencies)

- [ ] **Step 1: 加依赖并安装**

Run(`CWD: C:\Code\five-elements\server`):
```bash
npm install vendor/chobo-sdk-0.1.1.tgz
```
Expected: `package.json` 的 `dependencies` 出现 `"@chobo/sdk": "file:vendor/chobo-sdk-0.1.1.tgz"`;`node_modules/@chobo/sdk` 就位。

- [ ] **Step 2: 冒烟 require(CJS 解析)**

Run: `node -e "const c=require('@chobo/sdk'); console.log(typeof c.init, typeof c.meter, typeof c.runWithIdentity, typeof c.extractors.openaiChatUsage)"`
Expected: `function function function function`(证明 CJS `require` 解析到 `dist/index.cjs`,导出齐全)。

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json vendor/chobo-sdk-0.1.1.tgz
git commit -m "chore: 引入 @chobo/sdk(tarball vendoring)"
```

### Task B2: `lib/choboMeter.js` —— 唯一接入点(env 闸门)

**Files:**
- Create: `server/src/lib/choboMeter.js`
- Create: `server/test/chobo/choboMeter.test.js`

- [ ] **Step 1: 写失败测试**

Create `server/test/chobo/choboMeter.test.js`:

```js
// 用本地 http stub 接收 SDK 真实 POST 的事件;metered fn 直接返回 canned data(不打真实 fetch)。
const http = require('http')

function ingestStub() {
  const received = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (Array.isArray(body.events)) received.push(...body.events)
      } catch (_) { /* ignore */ }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ accepted: received.length, duplicates: 0, rejected: 0 }))
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    resolve({ url: `http://127.0.0.1:${port}/v1/events`, received, secrets: server,
      stop: () => new Promise(r => server.close(r)) })
  }))
}

describe('choboMeter', () => {
  const ENV = { ...process.env }
  let stub
  beforeEach(async () => { stub = await ingestStub() })
  afterEach(async () => { await stub.stop(); process.env = { ...ENV }; jest.resetModules() })

  test('未配 CHOBO_INGEST_URL 时 meterChat 透传、不落事件', async () => {
    delete process.env.CHOBO_INGEST_URL
    const m = require('../../src/lib/choboMeter')
    m.initChobo()
    const data = await m.meterChat('doubao-x', async () => ({ ok: 1, choices: [{ message: { content: 'hi' } }] }))
    expect(data.ok).toBe(1)
    await m.shutdownChobo()
    expect(stub.received.length).toBe(0)
  })

  test('配了 ingest 时,runIdentity+meterChat 落一条带身份+usage 的 chat 事件', async () => {
    process.env.CHOBO_INGEST_URL = stub.url
    delete process.env.CHOBO_INGEST_SECRET
    const m = require('../../src/lib/choboMeter')
    m.initChobo()
    await m.runIdentity('usr_test_1', async () => {
      return m.meterChat('doubao-seed-2-0-pro-260215', async () => ({
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        model: 'doubao-seed-2-0-pro-260215',
      }))
    })
    await m.shutdownChobo()
    expect(stub.received.length).toBe(1)
    const e = stub.received[0]
    expect(e.operation).toBe('chat')
    expect(e.provider).toBe('doubao')
    expect(e.request_model).toBe('doubao-seed-2-0-pro-260215')
    expect(e.user_id).toBe('usr_test_1')
    expect(e.identity_source).toBe('jwt')
    expect(e.project).toBe('five-elements')
    expect(e.input_tokens).toBe(10)
    expect(e.output_tokens).toBe(5)
  })

  test('meterImage 落一条 image 事件 image_count=1', async () => {
    process.env.CHOBO_INGEST_URL = stub.url
    const m = require('../../src/lib/choboMeter')
    m.initChobo()
    await m.runIdentity('usr_test_2', async () =>
      m.meterImage('newapi', 'gpt-image-2', async () => ({ buffer: Buffer.from('x'), ext: 'png' })))
    await m.shutdownChobo()
    expect(stub.received.length).toBe(1)
    const e = stub.received[0]
    expect(e.operation).toBe('image')
    expect(e.provider).toBe('newapi')
    expect(e.image_count).toBe(1)
    expect(e.user_id).toBe('usr_test_2')
  })

  test('runIdentity 作用域外 -> identity_source missing、user_id null', async () => {
    process.env.CHOBO_INGEST_URL = stub.url
    const m = require('../../src/lib/choboMeter')
    m.initChobo()
    await m.meterChat('doubao-x', async () => ({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    await m.shutdownChobo()
    expect(stub.received[0].identity_source).toBe('missing')
    expect(stub.received[0].user_id).toBe(null)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx jest test/chobo/choboMeter.test.js`
Expected: FAIL —— `Cannot find module '../../src/lib/choboMeter'`。

- [ ] **Step 3: 写实现**

Create `server/src/lib/choboMeter.js`:

```js
// chobo 计量唯一接入点。全 env 闸门:未配 CHOBO_INGEST_URL → 所有包装函数透传,业务字节等同。
// 安全:SDK 永不阻塞(fire-and-forget);本模块绝不抛错影响业务路径。
const chobo = require('@chobo/sdk')

const PROJECT = 'five-elements'
let enabled = false

// 仅当配置了 ingest 地址才启用。重复调用幂等(SDK init 覆盖式配置)。
function initChobo() {
  if (!process.env.CHOBO_INGEST_URL) { enabled = false; return }
  chobo.init({
    ingestUrl: process.env.CHOBO_INGEST_URL,
    service: 'five-elements-server',
    ingestSecret: process.env.CHOBO_INGEST_SECRET || undefined,
    spoolDir: process.env.CHOBO_SPOOL_DIR || './.chobo-spool',
  })
  enabled = true
}

async function shutdownChobo() {
  if (enabled) { try { await chobo.shutdown() } catch (_) { /* 退出期尽力而为 */ } }
}

// 在身份作用域内运行 fn。userId 缺失 → identity_source=missing(诚实)。禁用时直接调 fn。
function runIdentity(userId, fn) {
  if (!enabled) return fn()
  return chobo.runWithIdentity(
    { user_id: userId || null, org_id: null, project: PROJECT, identity_source: userId ? 'jwt' : 'missing' },
    fn,
  )
}

// 包文本调用。fetchAndParse 必须 resolve 为「解析后的 OpenAI 兼容 JSON」(供 extractor 读 usage/choices)。
function meterChat(model, fetchAndParse) {
  if (!enabled) return fetchAndParse()
  return chobo.meter(
    { operation: 'chat', provider: 'doubao', requestModel: model, extract: chobo.extractors.openaiChatUsage },
    fetchAndParse,
  )
}

// 包生图调用。n 恒为 1 → image_count 固定 1(extractor 不依赖响应体形状)。
function meterImage(provider, model, doGenerate) {
  if (!enabled) return doGenerate()
  return chobo.meter(
    { operation: 'image', provider, requestModel: model, extract: () => ({ image_count: 1, usage_source: 'measured' }) },
    doGenerate,
  )
}

module.exports = { initChobo, shutdownChobo, runIdentity, meterChat, meterImage }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx jest test/chobo/choboMeter.test.js`
Expected: PASS(4 例)。

- [ ] **Step 5: Commit**

```bash
git add src/lib/choboMeter.js test/chobo/choboMeter.test.js
git commit -m "feat(chobo): 接入点 choboMeter(init/shutdown/runIdentity/meterChat/meterImage,env 闸门)"
```

### Task B3: 插桩文本咽喉 `lib/llm.js`

**Files:**
- Modify: `server/src/lib/llm.js:17-66`(`chatComplete`)
- Create: `server/test/chobo/llm.metered.test.js`

- [ ] **Step 1: 写失败测试**

Create `server/test/chobo/llm.metered.test.js`:

```js
// 用 mock 的 global.fetch 同时充当「Ark 上游」与「chobo ingest」:按 URL 分流。
const ENV = { ...process.env }
const ARK = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'
const INGEST = 'http://127.0.0.1:59999/v1/events'

afterEach(() => { process.env = { ...ENV }; jest.resetModules(); global.fetch = undefined })

test('chatComplete 成功 → 落一条 chat 事件,usage 来自 data.usage,身份注入', async () => {
  process.env.ARK_API_KEY = 'k'
  process.env.ARK_ENDPOINT = ARK
  process.env.CHOBO_INGEST_URL = INGEST
  const posted = []
  global.fetch = jest.fn(async (url, init) => {
    if (String(url) === INGEST) {
      posted.push(...JSON.parse(init.body).events)
      return new Response('{}', { status: 200 })
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: '你好' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      model: 'doubao-seed-2-0-pro-260215',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const m = require('../../src/lib/choboMeter'); m.initChobo()
  const llm = require('../../src/lib/llm')
  const text = await m.runIdentity('usr_a', () => llm.chatComplete({ system: 's', user: 'u' }))
  expect(text).toBe('你好')          // 返回值不变
  await m.shutdownChobo()
  const chat = posted.find(e => e.operation === 'chat')
  expect(chat).toBeTruthy()
  expect(chat.provider).toBe('doubao')
  expect(chat.input_tokens).toBe(12)
  expect(chat.output_tokens).toBe(7)
  expect(chat.user_id).toBe('usr_a')
  expect(chat.status).toBe('success')
})

test('chatComplete HTTP 失败 → 落 failure 事件且原样抛错', async () => {
  process.env.ARK_API_KEY = 'k'; process.env.ARK_ENDPOINT = ARK; process.env.CHOBO_INGEST_URL = INGEST
  const posted = []
  global.fetch = jest.fn(async (url, init) => {
    if (String(url) === INGEST) { posted.push(...JSON.parse(init.body).events); return new Response('{}', { status: 200 }) }
    return new Response('upstream boom', { status: 500 })
  })
  const m = require('../../src/lib/choboMeter'); m.initChobo()
  const llm = require('../../src/lib/llm')
  await expect(m.runIdentity('usr_b', () => llm.chatComplete({ user: 'u' }))).rejects.toMatchObject({ code: 'LLM_HTTP' })
  await m.shutdownChobo()
  expect(posted.find(e => e.operation === 'chat' && e.status === 'failure')).toBeTruthy()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx jest test/chobo/llm.metered.test.js`
Expected: FAIL —— 无事件落库(`chatComplete` 还没接 meter)。

- [ ] **Step 3: 重构 `chatComplete` 接 `meterChat`**

Modify `server/src/lib/llm.js`:顶部加 require;把 `chatComplete` 的「fetch + ok 校验 + 解析 + 取 content」整体放进 `meterChat` 的内层 fn(返回解析后 `data`,失败抛错落 failure),其后再从 `data` 取 content。完整替换 `chatComplete`(17-66 行):

```js
const { meterChat } = require('./choboMeter')   // 文件顶部、其它常量之后

// 单次对话补全,返回 assistant 文本。任何失败均抛出(带 .code),由调用方决定兜底。
async function chatComplete({ system, user, temperature = 0.7, maxTokens = 900 } = {}) {
  const apiKey = process.env.ARK_API_KEY
  if (!apiKey) { const e = new Error('ARK_API_KEY 未配置'); e.code = 'NO_LLM_KEY'; throw e }

  const endpoint = process.env.ARK_ENDPOINT || DEFAULT_ENDPOINT
  const model = process.env.ARK_MODEL || DEFAULT_MODEL
  const timeout = parseInt(process.env.ARK_TIMEOUT_MS, 10) || 60000

  const messages = []
  if (system) messages.push({ role: 'system', content: [{ type: 'text', text: system }] })
  if (user) messages.push({ role: 'user', content: [{ type: 'text', text: user }] })

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  let data
  try {
    // meterChat 内层:发请求 + 校验 + 解析,返回解析后 JSON(供 extractor 读 usage);任何 throw → failure 事件。
    data = await meterChat(model, async () => {
      let resp
      try {
        resp = await fetch(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, stream: false, thinking: { type: 'disabled' }, temperature, max_tokens: maxTokens }),
          signal: ctrl.signal,
        })
      } catch (err) {
        const e = new Error('LLM 请求失败:' + (err.name === 'AbortError' ? '超时' : err.message)); e.code = 'LLM_NETWORK'; throw e
      }
      if (!resp.ok) {
        let body = ''
        try { body = (await resp.text()).slice(0, 300) } catch (_) { /* ignore */ }
        const e = new Error(`LLM HTTP ${resp.status}: ${body}`); e.code = 'LLM_HTTP'; throw e
      }
      const d = await resp.json().catch(() => null)
      const content = d && d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : null
      if (!content || typeof content !== 'string') { const e = new Error('LLM 返回空内容'); e.code = 'LLM_EMPTY'; throw e }
      return d
    })
  } finally {
    clearTimeout(timer)
  }

  return data.choices[0].message.content.trim()
}
```

> `chatCompleteJSON`(69-80 行)与 `module.exports`(82 行)不变 —— 它调 `chatComplete`,自动覆盖。

- [ ] **Step 4: 跑测试确认通过 + 原有 llm 测试不回归**

Run: `npx jest test/chobo/llm.metered.test.js && npx jest llm`
Expected: 新测试 PASS;若仓库已有 `llm` 相关测试,一并通过(行为对外不变)。

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm.js test/chobo/llm.metered.test.js
git commit -m "feat(chobo): 文本咽喉 chatComplete 接 meterChat(usage 取自 data.usage)"
```

### Task B4: 插桩生图咽喉 `lib/imageGen.js`

**Files:**
- Modify: `server/src/lib/imageGen.js:172-175`(`generateImage`)
- Create: `server/test/chobo/imageGen.metered.test.js`

- [ ] **Step 1: 写失败测试**

Create `server/test/chobo/imageGen.metered.test.js`:

```js
const ENV = { ...process.env }
const INGEST = 'http://127.0.0.1:59998/v1/events'
const GW = 'https://gw.example.com/v1'

afterEach(() => { process.env = { ...ENV }; jest.resetModules(); global.fetch = undefined })

test('生图 openai 路由 → 落 image 事件 provider=newapi image_count=1', async () => {
  process.env.IMAGE_PROVIDER = 'openai'
  process.env.OPENAI_API_KEY = 'k'
  process.env.OPENAI_BASE_URL = GW
  process.env.CHOBO_INGEST_URL = INGEST
  const posted = []
  global.fetch = jest.fn(async (url, init) => {
    if (String(url) === INGEST) { posted.push(...JSON.parse(init.body).events); return new Response('{}', { status: 200 }) }
    // gpt-image-2 generations:返回 b64_json
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('img').toString('base64') }] }), { status: 200 })
  })
  const m = require('../../src/lib/choboMeter'); m.initChobo()
  const imageGen = require('../../src/lib/imageGen')
  const out = await m.runIdentity('usr_img', () => imageGen.generateImage({ prompt: 'p', size: imageGen.SIZE_AVATAR }))
  expect(Buffer.isBuffer(out.buffer)).toBe(true)   // 返回值不变
  await m.shutdownChobo()
  const img = posted.find(e => e.operation === 'image')
  expect(img).toBeTruthy()
  expect(img.provider).toBe('newapi')
  expect(img.request_model).toBe('gpt-image-2')
  expect(img.image_count).toBe(1)
  expect(img.user_id).toBe('usr_img')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx jest test/chobo/imageGen.metered.test.js`
Expected: FAIL —— 无 image 事件。

- [ ] **Step 3: 在 `generateImage` 派发处包 `meterImage`**

Modify `server/src/lib/imageGen.js`:顶部加 require;替换 `generateImage`(172-175 行):

```js
const { meterImage } = require('./choboMeter')   // 文件顶部

async function generateImage(opts = {}) {
  if (!opts.prompt) throw imgErr('缺少 prompt', 'IMG_NO_PROMPT')
  const provider = getProvider()                                   // 'ark' | 'openai'
  const model = provider === 'ark'
    ? (process.env.ARK_IMAGE_MODEL || DEFAULT_ARK_MODEL)
    : (process.env.OPENAI_IMAGE_MODEL || DEFAULT_OPENAI_MODEL)
  const meterProvider = provider === 'ark' ? 'doubao' : 'newapi'   // 计费路由:ark 直连=doubao,网关=newapi
  return meterImage(meterProvider, model, () => (provider === 'ark' ? generateArk(opts) : generateOpenAI(opts)))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx jest test/chobo/imageGen.metered.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/imageGen.js test/chobo/imageGen.metered.test.js
git commit -m "feat(chobo): 生图咽喉 generateImage 接 meterImage(provider=newapi/doubao,按张)"
```

### Task B5: 身份注入 —— devAuth + 两个 worker

**Files:**
- Modify: `server/src/middleware/devAuth.js`
- Modify: `server/src/lib/forumAiWorker.js:84`
- Modify: `server/src/lib/visualJobWorker.js:41`
- Create: `server/test/chobo/identity.test.js`

- [ ] **Step 1: 写失败测试**

Create `server/test/chobo/identity.test.js`:

```js
// devAuth:JWT/dev 兜底两路都把 user_id 注入 chobo 上下文。
const jwt = require('jsonwebtoken')
const ENV = { ...process.env }
afterEach(() => { process.env = { ...ENV }; jest.resetModules() })

function fakeRes() { return { setHeader() {}, fail() { this._failed = true } } }

test('devAuth(JWT 路)→ next 跑在 user_id 身份作用域内', async () => {
  process.env.JWT_SECRET = 'secret'
  process.env.CHOBO_INGEST_URL = 'http://127.0.0.1:1/v1/events' // 仅为 enabled;不真正落库
  const chobo = require('@chobo/sdk')
  const m = require('../../src/lib/choboMeter'); m.initChobo()
  const devAuth = require('../../src/middleware/devAuth')
  const token = jwt.sign({ id: 'usr_jwt' }, 'secret')
  let seen = null
  await new Promise((resolve) => {
    devAuth({ headers: { authorization: `Bearer ${token}` }, get() {} }, fakeRes(), () => {
      seen = chobo.getIdentity(); resolve()
    })
  })
  expect(seen.user_id).toBe('usr_jwt')
  expect(seen.identity_source).toBe('jwt')
  expect(seen.project).toBe('five-elements')
  await m.shutdownChobo()
})

test('devAuth(DEV_AUTH 兜底路)→ 注入兜底 user_id', async () => {
  process.env.DEV_AUTH = '1'; process.env.DEV_USER_ID = 'usr_dev'
  process.env.CHOBO_INGEST_URL = 'http://127.0.0.1:1/v1/events'
  const chobo = require('@chobo/sdk')
  const m = require('../../src/lib/choboMeter'); m.initChobo()
  const devAuth = require('../../src/middleware/devAuth')
  let seen = null
  await new Promise((resolve) => {
    devAuth({ headers: {}, get() {} }, fakeRes(), () => { seen = chobo.getIdentity(); resolve() })
  })
  expect(seen.user_id).toBe('usr_dev')
  await m.shutdownChobo()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx jest test/chobo/identity.test.js`
Expected: FAIL —— `getIdentity()` 返回 missing(devAuth 还没包 runIdentity)。

- [ ] **Step 3: 改 devAuth 用 runIdentity 包 next**

Modify `server/src/middleware/devAuth.js` —— 顶部加 require,两条成功分支的 `return next()` 改为 `return runIdentity(req.user.id, next)`:

```js
const jwt = require('jsonwebtoken')
const { runIdentity } = require('../lib/choboMeter')

function devAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET)
      return runIdentity(req.user.id, next)
    } catch (_) { console.warn('[devAuth] JWT verify failed:', _.message) }
  }
  if (process.env.DEV_AUTH === '1') {
    req.user = { id: process.env.DEV_USER_ID || 'usr_demo_001', dev: true }
    return runIdentity(req.user.id, next)
  }
  return res.fail(401, '未登录', 401)
}

module.exports = devAuth
```

- [ ] **Step 4: 改两个 worker 包 job 处理**

Modify `server/src/lib/forumAiWorker.js`:顶部加 `const { runIdentity } = require('./choboMeter')`;把 84 行 `await generateReply(job)` 改为 `await runIdentity(job.user_id, () => generateReply(job))`。

Modify `server/src/lib/visualJobWorker.js`:顶部加 `const { runIdentity } = require('./choboMeter')`;把 41 行 `await processJob(job)` 改为 `await runIdentity(job.user_id, () => processJob(job))`。

- [ ] **Step 5: 跑测试确认通过 + devAuth 既有测试不回归**

Run: `npx jest test/chobo/identity.test.js && npx jest devAuth`
Expected: 新测试 PASS;若有既有 `devAuth` 测试,一并通过(禁用 chobo 时 `runIdentity` 透传 = 原行为)。

- [ ] **Step 6: Commit**

```bash
git add src/middleware/devAuth.js src/lib/forumAiWorker.js src/lib/visualJobWorker.js test/chobo/identity.test.js
git commit -m "feat(chobo): 身份注入(devAuth 请求路径 + forumAi/visualJob worker 路径)"
```

### Task B6: 接线 `index.js` —— 启动 init + 退出 shutdown

**Files:**
- Modify: `server/src/index.js`

- [ ] **Step 1: 加 init 与优雅退出**

Modify `server/src/index.js`:`require` choboMeter,`start()` 内在 `app.listen` 前调 `initChobo()`,并注册 SIGTERM/SIGINT 退出 flush:

```js
require('dotenv').config()
const app = require('./app')
const db = require('./models/db')
const { seed } = require('./models/seed')
const { startForumAiWorker } = require('./lib/forumAiWorker')
const { startVisualJobWorker } = require('./lib/visualJobWorker')
const { initChobo, shutdownChobo } = require('./lib/choboMeter')

const PORT = process.env.PORT || 3200

async function start() {
  await db.initialize()
  await seed()
  initChobo()                                   // env 未配则休眠,业务字节等同
  app.listen(PORT, () => console.log(`[five-elements-server] listening on :${PORT} · base /api`))
  startForumAiWorker()
  startVisualJobWorker()
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, async () => { await shutdownChobo(); process.exit(0) })
}

start().catch(err => { console.error('Failed to start:', err); process.exit(1) })
```

- [ ] **Step 2: 启动冒烟(未配 chobo → 不应有任何 chobo 副作用)**

Run: `node -e "process.env.CHOBO_INGEST_URL=''; const {initChobo}=require('./src/lib/choboMeter'); initChobo(); console.log('init ok, disabled path')"`
Expected: 打印 `init ok, disabled path`,无异常(证明闸门安全)。

- [ ] **Step 3: 全量测试**

Run: `npx jest`
Expected: 全绿(新增 chobo 测试 + 原有测试均通过)。

- [ ] **Step 4: Commit**

```bash
git add src/index.js
git commit -m "feat(chobo): index.js 接线(启动 initChobo + SIGTERM/SIGINT shutdown flush)"
```

### Task B7: env 样例 + 接入说明文档

**Files:**
- Modify/Create: `server/.env.example`
- Create: `server/CHOBO_INTEGRATION.md`

- [ ] **Step 1: 追加 env 样例**

在 `server/.env.example`(若无则新建)追加:

```bash
# ── chobo 计量(可选;不配则整套休眠,业务字节等同)──
# CHOBO_INGEST_URL=http://127.0.0.1:8787/v1/events   # 配了才启用
# CHOBO_INGEST_SECRET=                                # CRM 设了 x-chobo-secret 才需要
# CHOBO_SPOOL_DIR=./.chobo-spool                      # 投递溢出落盘目录(默认即此)
```

- [ ] **Step 2: 写接入说明**

Create `server/CHOBO_INTEGRATION.md`,内容覆盖:接入点(`lib/choboMeter.js`)、两咽喉、身份注入三处、env 闸门语义、升级 SDK(替换 `vendor/*.tgz` + `npm install`)、端到端验证步骤(见下文 §验收)。

- [ ] **Step 3: Commit**

```bash
git add .env.example CHOBO_INTEGRATION.md
git commit -m "docs(chobo): env 样例 + 接入说明"
```

---

## Phase C — chobo 仓收尾(回到 `C:\Code\chobo`)

> `CWD: C:\Code\chobo`。这些是 chobo 仓文档,提交到 chobo 的 master 或 `plan5-sdk-ingest-secret` 分支(随 Phase A 合并)。

### Task C1: 价格 seed 注释 + 文档同步

**Files:**
- Modify: `server/price-seed.example.json`
- Modify: `docs/dev-log.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: 价格 seed 加 gpt-image-2(newapi)待价说明**

在 `server/price-seed.example.json` 顶部或 rows 旁,以注释/README 说明:gpt-image-2 经 five-elements 的 NewAPI 路由,价格行须为 `{ "provider": "newapi", "model": "gpt-image-2", "operation": "image", "per_image": <fugue 给的元/张>, "currency": "CNY" }`;**fugue 给价前不 seed 该行**(缺行 → `total_cost=NULL`+告警,诚实),给价后加行并 `npm run reprice` 回填。

> JSON 不支持注释 → 在 `docs/research/2026-06-24-plan2-pricing-draft.md` 的 example-gateway 行旁补一句"⚑ five-elements 走 NewAPI,gpt-image-2 价格行 provider=newapi(非 example-gateway)",并在 `price-seed.example.json` 同目录 README/说明里记。

- [ ] **Step 2: dev-log + CLAUDE.md 同步**

`docs/dev-log.md` 加 Plan 5 段落(接入方 five-elements、两咽喉、ingestSecret、tarball、doubao 现成/gpt-image-2 待价);`CLAUDE.md` 状态表 Plan 5 标进行中/完成,接入方记 five-elements、AdopterA 顺延。

- [ ] **Step 3: Commit**

```bash
git add server/price-seed.example.json docs/dev-log.md docs/research/2026-06-24-plan2-pricing-draft.md CLAUDE.md
git commit -m "docs(plan5): five-elements 接入收尾(gpt-image-2 newapi 待价说明 + 状态同步)"
```

---

## 端到端验收(fugue 部署后手动跑;非自动化任务)

1. **CRM 起好**:`@chobo/server` 接 Postgres,seed doubao 价(现成)、设 `CHOBO_INGEST_SECRET`、`CHOBO_WEB_DIR` 发看板。
2. **five-elements 配 env**:`CHOBO_INGEST_URL` 指向 CRM、`CHOBO_INGEST_SECRET` 一致;装好 `vendor/chobo-sdk-0.1.1.tgz`;部署。
3. **真实触发**:走一次 daily-guide(doubao 文本)+ 一次社交生图(gpt-image-2)。
4. **核对**:CRM 收到 ≥2 事件;按 `user_id` 归因、`identity_source=jwt`、`project=five-elements`;operation 分 `chat`/`image`;doubao 事件 `total_cost` 为非空 numeric 字符串、gpt-image-2 事件 `total_cost=NULL`(待价);看板可见。
5. **回归保险**:清空 `CHOBO_INGEST_URL` 重启,确认业务字节等同。
6. **(待 fugue 给 gpt-image-2 单价后)** CRM 加 `provider=newapi` 价格行 → `npm run reprice` 回填 → 看板 gpt-image-2 历史转为非空成本。

---

## 完成后

- **Phase A** 在 chobo `plan5-sdk-ingest-secret` 分支 → 用 superpowers:finishing-a-development-branch 合并。
- **Phase B** 在 five-elements `chobo-metering` 分支 → 同样 finishing 流程合并(独立仓)。
- 两仓各自跑全量测试通过后再合。

---

## 自检(写计划后对照 spec)

- **spec 覆盖:** §5 插桩 → B3/B4;§6 身份 → B5;§7 字段映射 → B3/B4 测试断言;§8 ingestSecret → A1;§9 tarball → A3/B1;§10 算价(doubao 现成/gpt-image-2 待价)→ C1 + 验收;§12 闸门/退出 → B2/B6;§13 验收 → 端到端节;§14 测试 → 各 Task 测试。无遗漏。
- **占位扫描:** 无 TBD/TODO;唯一外部待输入 = gpt-image-2 单价,以"缺行→NULL+reprice"显式处理(非占位)。
- **类型/签名一致:** `meterChat(model, fn)`/`meterImage(provider, model, fn)`/`runIdentity(userId, fn)`/`initChobo()`/`shutdownChobo()` 在 B2 定义,B3/B4/B5/B6 一致引用;`x-chobo-secret` 头名与 CRM `auth.ts:8` 一致;provider 值 `doubao`/`newapi` 全文一致。
