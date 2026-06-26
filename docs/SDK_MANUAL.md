# chobo SDK 接入手册（权威 · Node + Python）

> 一份手册讲清「怎么把任意服务接上 chobo 计量」。Node SDK = `@chobo/sdk`，Python SDK = `chobo`，
> 二者遵循同一 [事件契约](../contracts/event.schema.json)。**改行为前以本手册 + 契约为准。**

---

## 0. 不变量（铁律 · 接入前先读）

1. **永不阻塞业务**：SDK 在响应返回**之后**异步落账（有界队列 → 溢出落盘 → 退避重投 → 退出 flush）。CRM 挂了只丢计量，业务零影响。
2. **env 闸门**：不配 `ingest_url` / `CHOBO_INGEST_URL` → 所有包装**透传 no-op**，接入前后字节等同（零风险接入）。
3. **SDK 不算价**：只采集「身份 / 时间 / 用量 / provider / model」，成本由 **CRM** 用带版本价目表算。
4. **不静默**：丢事件必计数；取不到 usage 标 `usage_source` 而非编造；缺身份标 `identity_source=missing` 并告警。
5. **幂等**：每事件带 `event_id`，CRM 去重，重投不重复计费。

---

## 1. 三步接入

1. **装 SDK**（vendored，见 §2）。
2. **`init` 一次**（进程启动，见 §3）+ 在 `.env` 配 `CHOBO_*`（见 §4）。
3. **包住每个 LLM 调用咽喉**（见 §6）+ 进程退出 `shutdown`（见 §8）。

> 没有部署 CRM 也能先做 1–2 步：`CHOBO_INGEST_URL` 不配则全程 no-op。等 CRM 就绪、改 env 重启即活。

---

## 2. 安装（vendored，零额外运行时依赖）

**Node**（产物 ESM+CJS 双格式，Node ≥18）：
```bash
# chobo 团队产出 tarball：cd packages/sdk-node && npm run build && npm pack
cp chobo-sdk-<ver>.tgz <你的服务>/vendor/
# package.json: "dependencies": { "@chobo/sdk": "file:vendor/chobo-sdk-<ver>.tgz" }
npm i
```

**Python**（stdlib-only，≥3.9，基准 3.12）：
```bash
# chobo 团队产出 wheel：cd packages/sdk-python && python -m build
cp chobo-<ver>-py3-none-any.whl <你的服务>/vendor/
# requirements.txt 加一行：./vendor/chobo-<ver>-py3-none-any.whl
pip install -r requirements.txt
```

---

## 3. 初始化 `init`（进程启动一次）

**Node**
```ts
import * as chobo from "@chobo/sdk";
chobo.init({
  ingestUrl: process.env.CHOBO_INGEST_URL!,   // 不传 → no-op
  service: "node-ai-proxy",
  account: "adopter-a",                        // 多租户维度（可空）
  ingestSecret: process.env.CHOBO_INGEST_SECRET, // 配则每次 POST 带 x-chobo-secret
  spoolDir: process.env.CHOBO_SPOOL_DIR ?? "./.chobo-spool",
});
```

**Python**
```python
import chobo
chobo.init(
    ingest_url=os.environ["CHOBO_INGEST_URL"],   # 不传 → no-op
    service="python-lesson-parser",
    account="adopter-a",
    ingest_secret=os.getenv("CHOBO_INGEST_SECRET") or None,
    spool_dir=os.getenv("CHOBO_SPOOL_DIR") or "./.chobo-spool",
)
```

### 全部 `init` 参数

| Node | Python | 默认 | 含义 |
|---|---|---|---|
| `ingestUrl` | `ingest_url` | — | CRM `POST /v1/events`；**不配 = no-op** |
| `service` | `service` | — | 事件里的来源服务名 |
| `account` | `account` | `null` | 多租户/客户维度（看板可按它过滤、下钻） |
| `ingestSecret` | `ingest_secret` | `null` | 配则每次 ingest 带 `x-chobo-secret`，对接设了 `CHOBO_INGEST_SECRET` 的 CRM |
| `bufferMax` | `queue_maxsize` | 10000 | 内存队列上限，超出落盘 |
| `batchMax` | `batch_max` | 100 | 每次 POST 最多事件数 |
| `flushAt` | — | 20 | （Node）按缓冲量触发 flush |
| `flushIntervalMs` | `flush_interval` | 2000 / 2.0 | 定时 flush（Node 毫秒、Python 秒） |
| `spoolDir` | `spool_dir` | `./.chobo-spool` | 溢出落盘 JSONL（`events-<pid>.jsonl`） |
| `maxSpoolBytes` | `max_spool_bytes` | 50 MiB | 落盘上限，超限丢**最旧**并计数（不静默） |
| — | `payload` | `metadata` | 请求 payload 落库模式 `off\|metadata\|truncated` |
| `timeoutMs` | `timeout` | 5000 / 5.0 | POST 超时 |
| `fetchImpl` | — | 全局 `fetch` | （Node）注入点，便于测试 |

---

## 4. `.env` 固定块（与 five-elements / AdopterA 一致）

```bash
CHOBO_INGEST_URL=http://chobo-crm:8787/v1/events   # 公网验证用 https://<域名>/v1/events;不配=no-op
CHOBO_INGEST_SECRET=<与 CRM 同一个强随机串>          # CRM 设了才需要;不设则 ingest 不校验
CHOBO_SPOOL_DIR=./.chobo-spool                      # 容器内常用 /app/.chobo-spool
```
`account` / 身份等不在 `.env` —— 在 `init`（`account`）与请求边界（身份，见 §5）设。

---

## 5. 身份（谁在用 · 决定 Tier-2 归因粒度）

身份是 **contextvar / AsyncLocalStorage**，在**请求边界**设一次，自动传播到该请求内的所有咽喉调用。

| 字段 | 含义 |
|---|---|
| `user_id` | 终端用户（接入方的下级，如某老师）。chobo 的核心价值就在这层归因 |
| `org_id` | 机构/组（可空） |
| `project` | 业务线/路由特征（可空） |
| `source` / `identity_source` | 身份来源：`header` / `jwt` / `default` / `missing` |

**`identity_source` 语义（铁律）：** 真有身份 → `header`/`jwt`；接入方**不提供 per-user、刻意走整体粗粒度** → `default`（**不告警**）；**本该有却没取到** → `missing`（**告警**）。**绝不编造身份。**

**Node**（请求中间件）
```ts
app.use((req, res, next) =>
  chobo.runWithIdentity(
    { user_id: req.header("X-Chobo-User"), org_id: null, project: req.path, identity_source: "header" },
    next,
  ),
);
// 也可 chobo.updateIdentity({...}) 在已有上下文里改;chobo.getIdentity() 读当前。
```

**Python**（纯 ASGI 中间件 —— 别用 `BaseHTTPMiddleware`，它在独立 task 跑下游、contextvar 不传播）
```python
class ChoboIdentityMiddleware:
    def __init__(self, app): self.app = app
    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http":
            chobo.set_identity(user_id="default", org_id=None,
                               project=scope.get("path"), source="default")
        await self.app(scope, receive, send)
app.add_middleware(ChoboIdentityMiddleware)
# 背景/worker 任务（无请求上下文）：在 init 后模块级 set_identity 一次做进程默认身份。
```

---

## 6. 计量原语 —— 选哪个

| 场景 | Node | Python |
|---|---|---|
| **缓冲调用**（一次拿到完整响应，响应含 `usage`） | `meter(opts, fn)` | `@meter(...)` 装饰器 |
| **流式**（响应是 async-iterable，usage 在尾包/末次） | `meterStream(opts, source)` | 包成 async-iterable 后同上，或用手动 span 思路 |
| **命令式流**（手写 SSE 解析循环，无法表达成 iterable） | `meterManual(opts)` | （同 `@meter` 包最外层函数，让其返回含 usage 的 dict） |

`opts`（Node `MeterOptions`）：`{ operation, provider, requestModel, extract?, requestId?, parentId? }`。
`operation` ∈ `chat | image | video | embedding`（契约枚举）；`provider` = **计费来源**（不是模型厂商，见 §7）。

### Node — `meter`（缓冲）
```ts
const data = await chobo.meter(
  { operation: "chat", provider: "doubao", requestModel: model, extract: chobo.extractors.openaiChatUsage },
  () => callUpstream(),          // 返回上游响应（含 usage）
);
```

### Node — `meterStream`（流式 async-iterable）
```ts
for await (const chunk of chobo.meterStream(
  { operation: "chat", provider: "newapi", requestModel: model, extractChunkUsage: chobo.extractors.openaiStreamChunkUsage },
  upstreamChunks,                // AsyncIterable;原样透传,末次非空 usage 胜出
)) forwardToClient(chunk);
```
> 记 `stream_options:{include_usage:true}`（OpenAI 流式默认不发 usage）。

### Node — `meterManual`（手写 SSE 循环）
```ts
const span = chobo.meterManual({ operation: "chat", provider: "newapi", requestModel: model });
try {
  for (const line of sseLines) {
    const parsed = parse(line);
    span.observe(chobo.extractors.openaiStreamChunkUsage(parsed)); // 喂 usage(可多次,末次胜)
    res.write(line);
  }
  span.done();                   // 成功:落一条;只 emit 一次
} catch (e) { span.fail(e); throw e; }
```

### Python — `@meter` 装饰器（同时支持 async/def）
```python
@chobo.meter(operation="chat", provider="doubao",
             extract=chobo.extractors.openai_chat_usage,
             model_from=lambda args, kwargs: kwargs.get("model"))
async def request_upstream(*, model, **kw): ...
```
- `extract`：响应 → usage dict（见 §7）。
- `request_model` 或 `model_from=lambda args,kwargs: ...`：定 `request_model`（per-call 覆盖）。
- `request_id_from=lambda args,kwargs: ...`：可选，关联 new-api 对账。
- 不改返回值、不吞异常；异常时落 `failure` 事件再 re-raise。

> 包不住装饰器时（如本地建 httpx 的 leaf），用「内部 `async def _do()` 返回含 usage 的响应 + 在外层调用一个 `meter(...)(_do)`」的等价写法（见 AdopterA `chobo_meter.meter_chat`）。

---

## 7. 提取器（response → usage）

SDK 不懂各家响应形状，靠 `extract` 把上游响应映射成统一 usage 字段。

**内置（Node `chobo.extractors.*` / Python `chobo.extractors.*`）：**

| 形状 | Node | Python |
|---|---|---|
| OpenAI 兼容 chat（缓冲） | `openaiChatUsage` | `openai_chat_usage` |
| OpenAI 兼容 chat（流 chunk） | `openaiStreamChunkUsage` | — |
| Gemini `generateContent` | `geminiUsage` | （自写，见下） |
| Gemini 流 chunk | `geminiStreamChunkUsage` | — |
| 图像生成 | `imageUsage` | `image_usage` |

**usage 字段**（提取器返回的 partial dict，缺的留空）：`input_tokens` / `output_tokens` / `total_tokens` / `cached_tokens` / `reasoning_tokens` / `image_count` / `input_text_tokens` / `input_image_tokens` / `response_model` / `finish_reason` / `usage_source`。

**`usage_source` 语义（铁律）：** 真读到 token → `measured`；上游没给 usage → `none`（**不编造**）；自行估算 → `estimated`（标记出来）。

**自写提取器**（按上游真实形状；如 Gemini「thoughts 不含在 candidates、但按 output 价计」→ 单列 `reasoning_tokens` 配价表 `reasoning_per_mtok`）：
```python
def gemini_usage(resp):
    um = resp.get("usageMetadata") or {}
    return {"input_tokens": um.get("promptTokenCount"),
            "output_tokens": um.get("candidatesTokenCount"),
            "reasoning_tokens": um.get("thoughtsTokenCount"),  # 按 output 价计
            "cached_tokens": um.get("cachedContentTokenCount"),
            "usage_source": "measured" if um else "none"}
```

---

## 8. 关闭 / flush（优雅退出保证）

退出前 flush 是**最终落账的唯一保证**：

**Node** —— `'exit'` 只跑同步、`'beforeExit'` 在 `process.exit()` 不触发。SDK 注册 best-effort `beforeExit`，并提供 **awaitable `shutdown()`**；在你的退出路径**显式 `await`**：
```ts
process.once("SIGTERM", async () => { await chobo.shutdown(); process.exit(0); });
```
**Python**
```python
@app.on_event("shutdown")   # 或 lifespan
def _():
    chobo.shutdown(timeout=3)
```
`chobo.flush()` 可在不退出时强制冲刷；`shutdown` = flush + 停后台线程/计时器。

---

## 9. provider / model 怎么对到价（理解计价，便于排错）

CRM 按 **(provider, model, operation)** 命中价目表算 cost：
- **`provider` = 计费来源，不是模型厂商。** 经网关(new-api / example-gateway)中转 → 统一标网关名(如 `newapi`)；直连厂商 → 标厂商(如 Ark 直连 doubao 标 `doubao`)。**接入方据上游 base_url 自行判定并保持一致**，否则价目表 key 命不中 → cost `NULL`。
- **model 别名**：价目表支持 alias（如 `doubao-seed-2-0-pro-260215` → `doubao-seed-2.0-pro`），`request_model` 发真实名即可。
- 命不中价（新模型未配价）→ cost 诚实 `NULL`，不假 0。补价见 [部署 runbook](../deploy/CRM_DEPLOY_RUNBOOK.md)（换镜像即自动 sync 新版本）。

---

## 10. 排错

- `chobo.getStats()` / `chobo.get_stats()` → `{enqueued, sent, spilled, dropped, post_failures}`。`sent` 涨 = 通了；`post_failures` 涨 = CRM 不可达（看 URL/secret/网络）；`dropped` 涨 = 落盘超限。
- **看不到事件**：① `ingest_url` 是否配（没配 = 有意 no-op）② secret 是否与 CRM 一致（不一致 401，体现在 `post_failures`）③ 是否调了 `init` ④ 退出前是否 `shutdown`/`flush`。
- **`identity_source=missing` 意外出现**：身份没在请求上下文设，或 Python 用了 `BaseHTTPMiddleware`（contextvar 不传播）→ 改纯 ASGI 中间件 + 模块级默认身份。
- **cost 为 NULL**：provider/model/operation 未命中价目表（§9），或该用量缺 token（诚实 NULL）。
- **流式中途断开不落账**：`meterStream`/`meterManual` 只在**完整结束**时 emit；客户端中途断开当前不落（v1 已知限制）。

---

## 11. 端到端最小例

**Node**
```ts
import * as chobo from "@chobo/sdk";
chobo.init({ ingestUrl: process.env.CHOBO_INGEST_URL!, service: "my-svc", account: "acme",
             ingestSecret: process.env.CHOBO_INGEST_SECRET });
app.use((req,res,next)=> chobo.runWithIdentity({ user_id: req.header("X-User"), identity_source: "header" }, next));
app.post("/chat", async (req,res) => {
  const data = await chobo.meter(
    { operation: "chat", provider: "newapi", requestModel: "gpt-5.5", extract: chobo.extractors.openaiChatUsage },
    () => callUpstream(req.body));
  res.json(data);
});
process.once("SIGTERM", async ()=>{ await chobo.shutdown(); process.exit(0); });
```

**Python（FastAPI）**
```python
import os, chobo
chobo.init(ingest_url=os.environ["CHOBO_INGEST_URL"], service="my-svc", account="acme",
           ingest_secret=os.getenv("CHOBO_INGEST_SECRET") or None)

class Ident:
    def __init__(self, app): self.app = app
    async def __call__(self, scope, receive, send):
        if scope.get("type")=="http":
            chobo.set_identity(user_id="default", project=scope.get("path"), source="default")
        await self.app(scope, receive, send)
app.add_middleware(Ident)

@chobo.meter(operation="chat", provider="doubao", extract=chobo.extractors.openai_chat_usage,
             model_from=lambda a,k: k.get("model"))
async def call_upstream(*, model, **kw): ...

@app.on_event("shutdown")
def _(): chobo.shutdown(timeout=3)
```

---

**相关：** [事件契约](../contracts/event.schema.json) · [价目表 schema](../contracts) · [CRM 部署 runbook](../deploy/CRM_DEPLOY_RUNBOOK.md) · [客户 turnkey 交付](../deploy/customer/README.md) · 设计权威 [`docs/specs/2026-06-24-billing-sdk-design.md`](specs/2026-06-24-billing-sdk-design.md)。
