# Contracts + Python SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build chobo's shared event contract and a dependency-light, never-blocking Python metering SDK that captures LLM calls and reliably delivers usage events to an ingest endpoint.

**Architecture:** A decorator (`@chobo.meter`) wraps a host service's call chokepoints. On each call it reads process-local identity (`contextvars`), times the call, runs a provider-specific usage extractor on the response, builds a contract-shaped event, and hands it to a transport. The transport is a background daemon thread with a bounded in-memory queue → spills to a per-process JSONL file on backpressure → batch-POSTs via stdlib `urllib` with backoff → flushes on shutdown. The SDK never blocks the business call and never silently loses an event.

**Tech Stack:** Python ≥3.9 (dev/CI on 3.12.10), **stdlib-only runtime** (`contextvars`, `threading`, `queue`, `urllib`, `uuid`, `json`), `pytest` + `jsonschema` as dev-only deps, src layout, JSON Schema 2020-12 for the contract.

**Scope boundaries:**
- This plan does NOT build the CRM, does NOT compute cost (SDK never prices), does NOT touch AdopterA source. The SDK is generic; applying it to AdopterA's three chokepoints is Plan 5.
- All transport tests run against a local stdlib HTTP stub (in `conftest.py`), not a real CRM.

---

## File Structure

```
contracts/
  README.md                 # wire envelope (POST /v1/events body+response) + field notes
  event.schema.json         # JSON Schema 2020-12 for one usage event
  price-table.schema.json   # structure only (no fabricated prices; CRM seeds values in Plan 2)

packages/sdk-python/
  .python-version           # 3.12.10  (dev/CI baseline)
  pyproject.toml            # name=chobo, requires-python>=3.9, no runtime deps, dev: pytest+jsonschema
  README.md                 # install, quickstart, config, AdopterA integration recipe
  src/chobo/
    __init__.py             # public API: init, set_identity/get_identity, meter, flush, shutdown, get_stats, extractors
    _runtime.py             # global singleton: Config + Transport wiring (init/get_transport/flush/shutdown)
    config.py               # Config dataclass
    identity.py             # contextvars set/get/clear identity
    event.py                # build_event() -> contract-shaped dict; now_ms()
    extractors.py           # openai_chat_usage(), image_usage(), _get()
    capture.py              # @meter decorator (async + sync), failure path
    transport.py            # _Transport: queue + flusher thread + spill + backoff + flush/shutdown + stats
  tests/
    conftest.py             # ingest_stub fixture (stdlib HTTP server recording events, settable status)
    test_contract.py        # sample event validates against event.schema.json
    test_identity.py
    test_event.py
    test_extractors.py
    test_config.py
    test_transport_delivery.py
    test_transport_flush.py
    test_transport_resilience.py
    test_capture.py
    test_public_api.py
    test_end_to_end.py
```

Each file has one responsibility; transport (the reliability spine) is isolated from capture (the wrapping logic) and from identity. All are unit-testable in isolation.

---

## Task 1: Package + contract skeleton

**Files:**
- Create: `packages/sdk-python/.python-version`
- Create: `packages/sdk-python/pyproject.toml`
- Create: `packages/sdk-python/src/chobo/__init__.py`
- Create: `packages/sdk-python/tests/conftest.py`
- Create: `contracts/event.schema.json`
- Create: `contracts/price-table.schema.json`
- Create: `contracts/README.md`

- [ ] **Step 1: Create the Python version pin**

`packages/sdk-python/.python-version`:
```
3.12.10
```

- [ ] **Step 2: Create `pyproject.toml`**

`packages/sdk-python/pyproject.toml`:
```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "chobo"
version = "0.1.0"
description = "chobo — low-intrusion LLM usage metering SDK (Python)"
requires-python = ">=3.9"
dependencies = []

[project.optional-dependencies]
dev = ["pytest>=8", "jsonschema>=4"]

[tool.setuptools.packages.find]
where = ["src"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

- [ ] **Step 3: Create the contract — event schema**

`contracts/event.schema.json`:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://chobo.dev/contracts/event.schema.json",
  "title": "chobo usage event",
  "type": "object",
  "required": [
    "event_id", "identity_source", "start_time",
    "service", "provider", "operation", "request_model",
    "usage_source", "status", "sdk_lang", "sdk_version"
  ],
  "additionalProperties": false,
  "properties": {
    "event_id":        { "type": "string", "minLength": 1 },
    "request_id":      { "type": ["string", "null"] },
    "parent_id":       { "type": ["string", "null"] },
    "user_id":         { "type": ["string", "null"] },
    "org_id":          { "type": ["string", "null"] },
    "project":         { "type": ["string", "null"] },
    "identity_source": { "enum": ["header", "jwt", "missing"] },
    "start_time":      { "type": "integer" },
    "end_time":        { "type": ["integer", "null"] },
    "latency_ms":      { "type": ["integer", "null"] },
    "service":         { "type": "string", "minLength": 1 },
    "provider":        { "type": "string", "minLength": 1 },
    "operation":       { "enum": ["chat", "image", "video", "embedding"] },
    "request_model":   { "type": "string", "minLength": 1 },
    "response_model":  { "type": ["string", "null"] },
    "input_tokens":    { "type": ["integer", "null"] },
    "output_tokens":   { "type": ["integer", "null"] },
    "total_tokens":    { "type": ["integer", "null"] },
    "cached_tokens":   { "type": ["integer", "null"] },
    "reasoning_tokens":{ "type": ["integer", "null"] },
    "image_count":     { "type": ["integer", "null"] },
    "usage_source":    { "enum": ["measured", "estimated", "none"] },
    "status":          { "enum": ["success", "failure"] },
    "error_type":      { "type": ["string", "null"] },
    "finish_reason":   { "type": ["string", "null"] },
    "payload":         { "type": ["object", "null"] },
    "sdk_lang":        { "enum": ["python", "node"] },
    "sdk_version":     { "type": "string", "minLength": 1 }
  }
}
```

- [ ] **Step 4: Create the contract — price-table schema (structure only, no prices)**

`contracts/price-table.schema.json`:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://chobo.dev/contracts/price-table.schema.json",
  "title": "chobo price table seed",
  "type": "object",
  "required": ["version", "rows"],
  "additionalProperties": false,
  "properties": {
    "version": { "type": "string", "minLength": 1 },
    "rows": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["provider", "model", "operation"],
        "additionalProperties": false,
        "properties": {
          "provider":            { "type": "string" },
          "model":               { "type": "string" },
          "operation":           { "enum": ["chat", "image", "video", "embedding"] },
          "input_tier_max":      { "type": ["integer", "null"] },
          "input_per_mtok":      { "type": ["number", "null"] },
          "output_per_mtok":     { "type": ["number", "null"] },
          "cache_read_per_mtok": { "type": ["number", "null"] },
          "reasoning_per_mtok":  { "type": ["number", "null"] },
          "per_image":           { "type": ["number", "null"] },
          "currency":            { "type": "string", "default": "CNY" }
        }
      }
    }
  }
}
```

- [ ] **Step 5: Create `contracts/README.md`**

`contracts/README.md`:
```markdown
# chobo contracts

The single coupling point between SDKs and the CRM. SDK and CRM both conform to these files.

## Event (`event.schema.json`)
One LLM call = one event. `cost_*` fields are **computed by the CRM**, never sent by the SDK,
and so are absent from the event schema. See spec §4.

## Wire envelope — `POST /v1/events`
Request body:
```json
{ "events": [ <event>, <event>, ... ] }
```
- `events` is always an array (a batch of 1+). The SDK batches.
- Response `200`/`2xx`: `{ "accepted": <int>, "duplicates": <int> }`.
- Idempotency: CRM dedups by `event_id`. At-least-once delivery from the SDK must never double-bill.
- Any non-2xx (or unreachable) → SDK treats the whole batch as undelivered and retries/spills.

## Price table (`price-table.schema.json`)
Structure only. Actual price numbers are looked up from official pricing pages and seeded by
the CRM (Plan 2) — never fabricated here.
```

- [ ] **Step 6: Create the package init placeholder and the test stub server**

`packages/sdk-python/src/chobo/__init__.py`:
```python
"""chobo — low-intrusion LLM usage metering SDK (Python)."""
__version__ = "0.1.0"
```

`packages/sdk-python/tests/conftest.py`:
```python
import json
import threading
import http.server
import pytest


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        status = self.server.next_status
        if 200 <= status < 300:
            try:
                payload = json.loads(raw)
                self.server.received.extend(payload.get("events", []))
            except Exception:
                pass
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"accepted":0,"duplicates":0}')

    def log_message(self, *args):
        pass  # silence test server logs


class _Stub:
    def __init__(self):
        self.httpd = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
        self.httpd.received = []
        self.httpd.next_status = 200
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/v1/events"
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self._thread.start()

    @property
    def received(self):
        return self.httpd.received

    def set_status(self, code):
        self.httpd.next_status = code

    def stop(self):
        self.httpd.shutdown()


@pytest.fixture
def ingest_stub():
    stub = _Stub()
    yield stub
    stub.stop()
```

- [ ] **Step 7: Install editable + verify collection**

Run:
```bash
cd packages/sdk-python && python -m venv .venv && . .venv/Scripts/activate && pip install -e ".[dev]" && pytest -q
```
Expected: install succeeds; pytest reports `no tests ran` (no test files yet) with exit code 5. That is fine.

> Note (Windows bash): the venv activate path is `.venv/Scripts/activate`. On Linux/macOS it is `.venv/bin/activate`.

- [ ] **Step 8: Commit**

```bash
git add contracts packages/sdk-python
git commit -m "feat(contracts,sdk-py): 契约 schema + Python SDK 包骨架与测试桩"
```

---

## Task 2: Contract validation test

**Files:**
- Create: `packages/sdk-python/tests/test_contract.py`

- [ ] **Step 1: Write the failing test**

`packages/sdk-python/tests/test_contract.py`:
```python
import json
import pathlib
import jsonschema

SCHEMA_PATH = (
    pathlib.Path(__file__).resolve().parents[3] / "contracts" / "event.schema.json"
)


def _schema():
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def _valid_event():
    return {
        "event_id": "abc123",
        "request_id": None,
        "parent_id": None,
        "user_id": "t-1",
        "org_id": "s-9",
        "project": "goal_generation",
        "identity_source": "header",
        "start_time": 1750000000123,
        "end_time": 1750000002456,
        "latency_ms": 2333,
        "service": "python-lesson-parser",
        "provider": "doubao",
        "operation": "chat",
        "request_model": "doubao-seed-2-0-pro-260215",
        "response_model": "doubao-seed-2-0-pro-260215",
        "input_tokens": 1234,
        "output_tokens": 567,
        "total_tokens": 1801,
        "cached_tokens": 0,
        "reasoning_tokens": 0,
        "image_count": None,
        "usage_source": "measured",
        "status": "success",
        "error_type": None,
        "finish_reason": "stop",
        "payload": None,
        "sdk_lang": "python",
        "sdk_version": "0.1.0",
    }


def test_valid_event_passes_schema():
    jsonschema.validate(_valid_event(), _schema())


def test_missing_required_field_fails():
    ev = _valid_event()
    del ev["event_id"]
    try:
        jsonschema.validate(ev, _schema())
        assert False, "expected ValidationError"
    except jsonschema.ValidationError:
        pass


def test_bad_enum_fails():
    ev = _valid_event()
    ev["operation"] = "transcription"
    try:
        jsonschema.validate(ev, _schema())
        assert False, "expected ValidationError"
    except jsonschema.ValidationError:
        pass
```

- [ ] **Step 2: Run the test**

Run: `cd packages/sdk-python && pytest tests/test_contract.py -v`
Expected: PASS (the schema already exists from Task 1). This test locks the contract so later event-building stays conformant.

- [ ] **Step 3: Commit**

```bash
git add packages/sdk-python/tests/test_contract.py
git commit -m "test(contracts): 事件样例校验通过 JSON Schema"
```

---

## Task 3: Identity context

**Files:**
- Create: `packages/sdk-python/src/chobo/identity.py`
- Create: `packages/sdk-python/tests/test_identity.py`

- [ ] **Step 1: Write the failing test**

`packages/sdk-python/tests/test_identity.py`:
```python
from chobo import identity


def test_default_identity_is_missing():
    identity.clear_identity()
    got = identity.get_identity()
    assert got == {
        "user_id": None, "org_id": None, "project": None,
        "identity_source": "missing",
    }


def test_set_and_get_identity():
    identity.set_identity(user_id="t-1", org_id="s-9", project="ggb")
    got = identity.get_identity()
    assert got["user_id"] == "t-1"
    assert got["org_id"] == "s-9"
    assert got["project"] == "ggb"
    assert got["identity_source"] == "header"


def test_get_returns_a_copy():
    identity.set_identity(user_id="t-1")
    got = identity.get_identity()
    got["user_id"] = "mutated"
    assert identity.get_identity()["user_id"] == "t-1"


def test_clear_resets_to_missing():
    identity.set_identity(user_id="t-1")
    identity.clear_identity()
    assert identity.get_identity()["identity_source"] == "missing"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_identity.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'chobo.identity'`

- [ ] **Step 3: Write minimal implementation**

`packages/sdk-python/src/chobo/identity.py`:
```python
"""Process-local identity context. Set once at the request boundary, read at capture time."""
import contextvars

_identity = contextvars.ContextVar("chobo_identity", default=None)


def set_identity(user_id=None, org_id=None, project=None, source="header"):
    _identity.set({
        "user_id": user_id,
        "org_id": org_id,
        "project": project,
        "identity_source": source,
    })


def get_identity():
    val = _identity.get()
    if val is None:
        return {
            "user_id": None, "org_id": None, "project": None,
            "identity_source": "missing",
        }
    return dict(val)


def clear_identity():
    _identity.set(None)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_identity.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-python/src/chobo/identity.py packages/sdk-python/tests/test_identity.py
git commit -m "feat(sdk-py): 进程内身份上下文 (contextvars)"
```

---

## Task 4: Event builder

**Files:**
- Create: `packages/sdk-python/src/chobo/event.py`
- Create: `packages/sdk-python/tests/test_event.py`

- [ ] **Step 1: Write the failing test**

`packages/sdk-python/tests/test_event.py`:
```python
import json
import pathlib
import jsonschema
from chobo import event

SCHEMA_PATH = (
    pathlib.Path(__file__).resolve().parents[3] / "contracts" / "event.schema.json"
)
SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

IDENTITY = {"user_id": "t-1", "org_id": "s-9", "project": "ggb", "identity_source": "header"}


def test_build_success_event_is_contract_valid():
    ev = event.build_event(
        service="python-lesson-parser", provider="doubao", operation="chat",
        request_model="doubao-x", identity=IDENTITY,
        start_ms=1000, end_ms=3333,
        usage={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15,
               "response_model": "doubao-x", "finish_reason": "stop",
               "usage_source": "measured"},
    )
    jsonschema.validate(ev, SCHEMA)
    assert ev["latency_ms"] == 2333
    assert ev["user_id"] == "t-1"
    assert ev["usage_source"] == "measured"
    assert ev["status"] == "success"
    assert len(ev["event_id"]) > 0
    assert ev["sdk_lang"] == "python"


def test_event_ids_are_unique():
    a = event.build_event(service="s", provider="p", operation="chat",
                          request_model="m", identity=IDENTITY, start_ms=1, end_ms=2)
    b = event.build_event(service="s", provider="p", operation="chat",
                          request_model="m", identity=IDENTITY, start_ms=1, end_ms=2)
    assert a["event_id"] != b["event_id"]


def test_failure_event_defaults_usage_source_none():
    ev = event.build_event(
        service="s", provider="p", operation="chat", request_model="m",
        identity=IDENTITY, start_ms=1, end_ms=2,
        status="failure", error_type="TimeoutError",
    )
    jsonschema.validate(ev, SCHEMA)
    assert ev["status"] == "failure"
    assert ev["error_type"] == "TimeoutError"
    assert ev["usage_source"] == "none"
    assert ev["input_tokens"] is None


def test_missing_identity_marks_missing():
    bare = {"user_id": None, "org_id": None, "project": None, "identity_source": "missing"}
    ev = event.build_event(service="s", provider="p", operation="chat",
                          request_model="m", identity=bare, start_ms=1, end_ms=2)
    assert ev["identity_source"] == "missing"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_event.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'chobo.event'`

- [ ] **Step 3: Write minimal implementation**

`packages/sdk-python/src/chobo/event.py`:
```python
"""Build a contract-shaped event dict (spec §4). The SDK never computes cost_* fields."""
import time
import uuid

SDK_LANG = "python"
SDK_VERSION = "0.1.0"


def now_ms():
    return int(time.time() * 1000)


def build_event(*, service, provider, operation, request_model, identity,
                start_ms, end_ms, usage=None, status="success", error_type=None,
                response_model=None, finish_reason=None,
                request_id=None, parent_id=None, payload=None):
    usage = usage or {}
    latency = (end_ms - start_ms) if (end_ms is not None and start_ms is not None) else None
    default_usage_source = "none" if status == "failure" else "measured"
    return {
        "event_id": uuid.uuid4().hex,
        "request_id": request_id,
        "parent_id": parent_id,
        "user_id": identity.get("user_id"),
        "org_id": identity.get("org_id"),
        "project": identity.get("project"),
        "identity_source": identity.get("identity_source", "missing"),
        "start_time": start_ms,
        "end_time": end_ms,
        "latency_ms": latency,
        "service": service,
        "provider": provider,
        "operation": operation,
        "request_model": request_model,
        "response_model": response_model or usage.get("response_model"),
        "input_tokens": usage.get("input_tokens"),
        "output_tokens": usage.get("output_tokens"),
        "total_tokens": usage.get("total_tokens"),
        "cached_tokens": usage.get("cached_tokens"),
        "reasoning_tokens": usage.get("reasoning_tokens"),
        "image_count": usage.get("image_count"),
        "usage_source": usage.get("usage_source", default_usage_source),
        "status": status,
        "error_type": error_type,
        "finish_reason": finish_reason or usage.get("finish_reason"),
        "payload": payload,
        "sdk_lang": SDK_LANG,
        "sdk_version": SDK_VERSION,
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_event.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-python/src/chobo/event.py packages/sdk-python/tests/test_event.py
git commit -m "feat(sdk-py): 事件构造器 build_event,契约对齐"
```

---

## Task 5: Usage extractors

**Files:**
- Create: `packages/sdk-python/src/chobo/extractors.py`
- Create: `packages/sdk-python/tests/test_extractors.py`

- [ ] **Step 1: Write the failing test**

`packages/sdk-python/tests/test_extractors.py`:
```python
from chobo import extractors


def test_openai_chat_usage_from_dict():
    # OpenAI-compatible chat completion shape (doubao / GLM / MiniMax return this).
    # NOTE: confirm exact field names against a real captured doubao response at integration (Plan 5).
    resp = {
        "model": "doubao-seed-2-0-pro-260215",
        "choices": [{"finish_reason": "stop", "message": {"content": "hi"}}],
        "usage": {
            "prompt_tokens": 1234,
            "completion_tokens": 567,
            "total_tokens": 1801,
            "prompt_tokens_details": {"cached_tokens": 100},
            "completion_tokens_details": {"reasoning_tokens": 42},
        },
    }
    out = extractors.openai_chat_usage(resp)
    assert out["input_tokens"] == 1234
    assert out["output_tokens"] == 567
    assert out["total_tokens"] == 1801
    assert out["cached_tokens"] == 100
    assert out["reasoning_tokens"] == 42
    assert out["response_model"] == "doubao-seed-2-0-pro-260215"
    assert out["finish_reason"] == "stop"
    assert out["usage_source"] == "measured"


def test_openai_chat_usage_from_object():
    class U:
        prompt_tokens = 3
        completion_tokens = 4
        total_tokens = 7
        prompt_tokens_details = None
        completion_tokens_details = None

    class R:
        model = "m"
        usage = U()
        choices = []

    out = extractors.openai_chat_usage(R())
    assert out["input_tokens"] == 3
    assert out["output_tokens"] == 4
    assert out["cached_tokens"] is None
    assert out["usage_source"] == "measured"


def test_openai_chat_usage_no_usage_is_none():
    out = extractors.openai_chat_usage({"model": "m", "choices": []})
    assert out["usage_source"] == "none"
    assert out["input_tokens"] is None


def test_image_usage_counts_data_list():
    out = extractors.image_usage({"data": [{"url": "a"}, {"url": "b"}]})
    assert out["image_count"] == 2
    assert out["usage_source"] == "measured"


def test_image_usage_explicit_count_overrides():
    out = extractors.image_usage({"data": []}, count=4)
    assert out["image_count"] == 4
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_extractors.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'chobo.extractors'`

- [ ] **Step 3: Write minimal implementation**

`packages/sdk-python/src/chobo/extractors.py`:
```python
"""Provider-specific response -> usage-fields extractors.

Each extractor reads defensively (dict OR attribute objects) and returns a partial usage dict
consumed by build_event(). Keep provider-shape knowledge here, small and unit-tested.
"""


def _get(obj, key):
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


def openai_chat_usage(response):
    """Usage from an OpenAI-compatible chat completion (doubao/GLM/MiniMax)."""
    u = _get(response, "usage")
    ptd = _get(u, "prompt_tokens_details")
    ctd = _get(u, "completion_tokens_details")
    choices = _get(response, "choices") or []
    finish = _get(choices[0], "finish_reason") if choices else None
    return {
        "input_tokens": _get(u, "prompt_tokens"),
        "output_tokens": _get(u, "completion_tokens"),
        "total_tokens": _get(u, "total_tokens"),
        "cached_tokens": _get(ptd, "cached_tokens"),
        "reasoning_tokens": _get(ctd, "reasoning_tokens"),
        "response_model": _get(response, "model"),
        "finish_reason": finish,
        "usage_source": "measured" if u is not None else "none",
    }


def image_usage(response, *, count=None):
    """Image-generation usage. Counts `data` entries unless an explicit count is given."""
    if count is not None:
        n = count
    else:
        data = _get(response, "data")
        n = len(data) if isinstance(data, list) else None
    return {"image_count": n, "usage_source": "measured" if n is not None else "none"}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_extractors.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-python/src/chobo/extractors.py packages/sdk-python/tests/test_extractors.py
git commit -m "feat(sdk-py): usage 提取器 (OpenAI 兼容 chat + 生图)"
```

---

## Task 6: Config

**Files:**
- Create: `packages/sdk-python/src/chobo/config.py`
- Create: `packages/sdk-python/tests/test_config.py`

- [ ] **Step 1: Write the failing test**

`packages/sdk-python/tests/test_config.py`:
```python
from chobo.config import Config


def test_config_requires_url_and_service():
    c = Config(ingest_url="http://x/v1/events", service="python-lesson-parser")
    assert c.ingest_url == "http://x/v1/events"
    assert c.service == "python-lesson-parser"


def test_config_defaults():
    c = Config(ingest_url="http://x", service="s")
    assert c.queue_maxsize == 10000
    assert c.batch_max == 100
    assert c.flush_interval == 2.0
    assert c.payload == "metadata"
    assert c.timeout == 5.0
    assert c.max_spool_bytes == 50 * 1024 * 1024


def test_config_overrides():
    c = Config(ingest_url="http://x", service="s", queue_maxsize=5, batch_max=2,
               flush_interval=0.1, payload="off", spool_dir="/tmp/sp")
    assert c.queue_maxsize == 5
    assert c.batch_max == 2
    assert c.payload == "off"
    assert c.spool_dir == "/tmp/sp"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'chobo.config'`

- [ ] **Step 3: Write minimal implementation**

`packages/sdk-python/src/chobo/config.py`:
```python
"""SDK configuration."""
from dataclasses import dataclass


@dataclass
class Config:
    ingest_url: str
    service: str
    queue_maxsize: int = 10000
    batch_max: int = 100
    flush_interval: float = 2.0
    spool_dir: str = "./.chobo-spool"
    max_spool_bytes: int = 50 * 1024 * 1024
    payload: str = "metadata"   # off | metadata | truncated
    timeout: float = 5.0
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_config.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-python/src/chobo/config.py packages/sdk-python/tests/test_config.py
git commit -m "feat(sdk-py): Config 数据类"
```

---

## Task 7: Transport — delivery (queue + flusher thread + batch POST)

**Files:**
- Create: `packages/sdk-python/src/chobo/transport.py`
- Create: `packages/sdk-python/tests/test_transport_delivery.py`

- [ ] **Step 1: Write the failing test**

`packages/sdk-python/tests/test_transport_delivery.py`:
```python
import time
from chobo.transport import Transport


def _ev(i):
    return {"event_id": f"e{i}", "service": "s", "provider": "p", "operation": "chat",
            "request_model": "m", "identity_source": "header", "start_time": 1,
            "usage_source": "measured", "status": "success",
            "sdk_lang": "python", "sdk_version": "0.1.0"}


def test_enqueued_events_are_posted(ingest_stub, tmp_path):
    t = Transport(ingest_url=ingest_stub.url, queue_maxsize=100, batch_max=10,
                  flush_interval=0.05, spool_dir=str(tmp_path), max_spool_bytes=10**7)
    for i in range(5):
        t.enqueue(_ev(i))
    deadline = time.time() + 3
    while len(ingest_stub.received) < 5 and time.time() < deadline:
        time.sleep(0.02)
    t.shutdown(timeout=3)
    ids = sorted(e["event_id"] for e in ingest_stub.received)
    assert ids == ["e0", "e1", "e2", "e3", "e4"]
    assert t.stats["sent"] == 5


def test_events_are_batched(ingest_stub, tmp_path):
    t = Transport(ingest_url=ingest_stub.url, queue_maxsize=100, batch_max=100,
                  flush_interval=0.2, spool_dir=str(tmp_path), max_spool_bytes=10**7)
    for i in range(20):
        t.enqueue(_ev(i))
    t.flush(timeout=3)
    t.shutdown(timeout=3)
    assert len(ingest_stub.received) == 20
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_transport_delivery.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'chobo.transport'`

- [ ] **Step 3: Write minimal implementation**

`packages/sdk-python/src/chobo/transport.py`:
```python
"""Never-blocking delivery: bounded queue -> background flusher thread -> batch POST.

This task implements in-memory delivery + flush/shutdown. Disk spill + backoff are added in
the resilience task. The flusher is a daemon thread using only stdlib urllib, so it is agnostic
to the host's event loop (works in sync and asyncio hosts, across uvicorn workers).
"""
import json
import os
import queue
import threading
import urllib.error
import urllib.request


class Transport:
    def __init__(self, ingest_url, queue_maxsize, batch_max, flush_interval,
                 spool_dir, max_spool_bytes, timeout=5.0):
        self.ingest_url = ingest_url
        self.batch_max = batch_max
        self.flush_interval = flush_interval
        self.spool_dir = spool_dir
        self.max_spool_bytes = max_spool_bytes
        self.timeout = timeout
        self._q = queue.Queue(maxsize=queue_maxsize)
        self._stop = threading.Event()
        self._flush_now = threading.Event()
        self._idle = threading.Event()
        self._idle.set()
        self._spool_lock = threading.Lock()
        self.stats = {"enqueued": 0, "sent": 0, "spilled": 0, "dropped": 0, "post_failures": 0}
        os.makedirs(spool_dir, exist_ok=True)
        self._spool_path = os.path.join(spool_dir, f"events-{os.getpid()}.jsonl")
        self._thread = threading.Thread(target=self._run, name="chobo-flusher", daemon=True)
        self._thread.start()

    # ---- producer side (called on the business thread; must be instant) ----
    def enqueue(self, event):
        self.stats["enqueued"] += 1
        self._idle.clear()
        try:
            self._q.put_nowait(event)
        except queue.Full:
            # Replaced by disk-spill in the resilience task. For now, count as dropped (never silent).
            self.stats["dropped"] += 1

    # ---- consumer side (flusher thread) ----
    def _run(self):
        while not self._stop.is_set():
            fired = self._flush_now.wait(timeout=self.flush_interval)
            if fired:
                self._flush_now.clear()
            self._drain_once()
        self._drain_once()  # final drain on shutdown

    def _take_batch(self):
        batch = []
        for _ in range(self.batch_max):
            try:
                batch.append(self._q.get_nowait())
            except queue.Empty:
                break
        return batch

    def _drain_once(self):
        while True:
            batch = self._take_batch()
            if not batch:
                break
            if not self._post(batch):
                self.stats["post_failures"] += 1
                # Re-queue best-effort; disk spill is added in the resilience task.
                for e in batch:
                    try:
                        self._q.put_nowait(e)
                    except queue.Full:
                        self.stats["dropped"] += 1
                break
        if self._q.empty():
            self._idle.set()

    def _post(self, events):
        body = json.dumps({"events": events}, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            self.ingest_url, data=body,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                if 200 <= resp.status < 300:
                    self.stats["sent"] += len(events)
                    return True
                return False
        except (urllib.error.URLError, OSError):
            return False

    # ---- lifecycle ----
    def flush(self, timeout=5.0):
        self._idle.clear()
        self._flush_now.set()
        return self._idle.wait(timeout=timeout)

    def shutdown(self, timeout=5.0):
        self.flush(timeout=timeout)
        self._stop.set()
        self._flush_now.set()
        self._thread.join(timeout=timeout)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_transport_delivery.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-python/src/chobo/transport.py packages/sdk-python/tests/test_transport_delivery.py
git commit -m "feat(sdk-py): transport 投递 — 有界队列+后台 flusher+批量 POST"
```

---

## Task 8: Transport — flush/shutdown semantics

**Files:**
- Modify: `packages/sdk-python/src/chobo/transport.py` (no code change expected; verify behavior)
- Create: `packages/sdk-python/tests/test_transport_flush.py`

- [ ] **Step 1: Write the failing test**

`packages/sdk-python/tests/test_transport_flush.py`:
```python
import time
from chobo.transport import Transport


def _ev(i):
    return {"event_id": f"f{i}", "service": "s", "provider": "p", "operation": "chat",
            "request_model": "m", "identity_source": "header", "start_time": 1,
            "usage_source": "measured", "status": "success",
            "sdk_lang": "python", "sdk_version": "0.1.0"}


def test_flush_blocks_until_delivered(ingest_stub, tmp_path):
    # Long flush_interval: without flush(), nothing would be sent yet.
    t = Transport(ingest_url=ingest_stub.url, queue_maxsize=100, batch_max=100,
                  flush_interval=30.0, spool_dir=str(tmp_path), max_spool_bytes=10**7)
    for i in range(10):
        t.enqueue(_ev(i))
    assert t.flush(timeout=3) is True
    assert len(ingest_stub.received) == 10
    t.shutdown(timeout=3)


def test_shutdown_drains_remaining(ingest_stub, tmp_path):
    t = Transport(ingest_url=ingest_stub.url, queue_maxsize=100, batch_max=100,
                  flush_interval=30.0, spool_dir=str(tmp_path), max_spool_bytes=10**7)
    for i in range(7):
        t.enqueue(_ev(i))
    t.shutdown(timeout=3)   # must drain even without an explicit flush
    assert len(ingest_stub.received) == 7
```

- [ ] **Step 2: Run test**

Run: `pytest tests/test_transport_flush.py -v`
Expected: PASS (2 passed) — the delivery implementation from Task 7 already satisfies this. If `test_flush_blocks_until_delivered` is flaky, it indicates an `_idle` race; proceed to Step 3.

- [ ] **Step 3: Harden the idle signal (only if Step 2 was flaky)**

If flush returned before delivery, make `_drain_once` clear idle at entry so a concurrent enqueue can't be missed. Replace `_drain_once` in `transport.py` with:
```python
    def _drain_once(self):
        self._idle.clear()
        while True:
            batch = self._take_batch()
            if not batch:
                break
            if not self._post(batch):
                self.stats["post_failures"] += 1
                for e in batch:
                    try:
                        self._q.put_nowait(e)
                    except queue.Full:
                        self.stats["dropped"] += 1
                break
        if self._q.empty():
            self._idle.set()
```

- [ ] **Step 4: Re-run to confirm green**

Run: `pytest tests/test_transport_flush.py tests/test_transport_delivery.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-python/src/chobo/transport.py packages/sdk-python/tests/test_transport_flush.py
git commit -m "test(sdk-py): flush/shutdown 清空缓冲语义"
```

---

## Task 9: Transport — resilience (disk spill, backoff, no loss / no dup)

**Files:**
- Modify: `packages/sdk-python/src/chobo/transport.py`
- Create: `packages/sdk-python/tests/test_transport_resilience.py`

- [ ] **Step 1: Write the failing test**

`packages/sdk-python/tests/test_transport_resilience.py`:
```python
import time
from chobo.transport import Transport


def _ev(i):
    return {"event_id": f"r{i}", "service": "s", "provider": "p", "operation": "chat",
            "request_model": "m", "identity_source": "header", "start_time": 1,
            "usage_source": "measured", "status": "success",
            "sdk_lang": "python", "sdk_version": "0.1.0"}


def test_crm_down_then_recovers_no_loss(ingest_stub, tmp_path):
    ingest_stub.set_status(503)   # CRM unreachable/erroring
    t = Transport(ingest_url=ingest_stub.url, queue_maxsize=100, batch_max=10,
                  flush_interval=0.05, spool_dir=str(tmp_path), max_spool_bytes=10**7)
    for i in range(8):
        t.enqueue(_ev(i))
    time.sleep(0.5)                # flusher retries fail; events held (queue or spool)
    assert len(ingest_stub.received) == 0
    ingest_stub.set_status(200)    # CRM recovers
    t.flush(timeout=5)
    t.shutdown(timeout=5)
    ids = sorted(e["event_id"] for e in ingest_stub.received)
    assert ids == [f"r{i}" for i in range(8)]   # all 8, none lost


def test_overflow_spills_to_disk_no_loss(ingest_stub, tmp_path):
    ingest_stub.set_status(503)    # keep events from draining so the queue fills
    t = Transport(ingest_url=ingest_stub.url, queue_maxsize=3, batch_max=3,
                  flush_interval=30.0, spool_dir=str(tmp_path), max_spool_bytes=10**7)
    for i in range(20):            # far exceeds queue_maxsize=3 -> must spill
        t.enqueue(_ev(i))
    assert t.stats["spilled"] > 0
    ingest_stub.set_status(200)
    t.flush(timeout=5)
    t.shutdown(timeout=5)
    ids = sorted(int(e["event_id"][1:]) for e in ingest_stub.received)
    assert ids == list(range(20))   # everything that overflowed was recovered from disk


def test_duplicate_event_ids_not_dropped_by_sdk(ingest_stub, tmp_path):
    # SDK delivers at-least-once; CRM dedups. SDK itself must not silently drop a same-id event.
    t = Transport(ingest_url=ingest_stub.url, queue_maxsize=100, batch_max=100,
                  flush_interval=30.0, spool_dir=str(tmp_path), max_spool_bytes=10**7)
    t.enqueue(_ev(1))
    t.enqueue(_ev(1))
    t.flush(timeout=3)
    t.shutdown(timeout=3)
    assert len(ingest_stub.received) == 2


def test_concurrent_spill_during_drain_not_lost(ingest_stub, tmp_path):
    # A producer spills a NEW event during the unlocked POST window of _drain_spool.
    # The drain must NOT erase that concurrently-appended event (atomic-consume invariant).
    import os
    import json as _json
    t = Transport(ingest_url=ingest_stub.url, queue_maxsize=100, batch_max=10,
                  flush_interval=30.0, spool_dir=str(tmp_path), max_spool_bytes=10**7)
    for i in range(5):
        t._spill([_ev(i)])                      # pre-load spool as if previously overflowed
    real_post = t._post
    state = {"first": True}

    def racey_post(events):
        if state["first"]:
            state["first"] = False
            t._spill([_ev(999)])                # concurrent producer appends during post window
        return real_post(events)

    t._post = racey_post
    t._drain_spool()

    delivered = {e["event_id"] for e in ingest_stub.received}
    spool_file = os.path.join(str(tmp_path), f"events-{os.getpid()}.jsonl")
    remaining = set()
    if os.path.exists(spool_file):
        with open(spool_file, encoding="utf-8") as f:
            remaining = {_json.loads(x)["event_id"] for x in f.read().splitlines() if x.strip()}
    all_seen = delivered | remaining
    for i in range(5):
        assert f"r{i}" in all_seen               # originals delivered
    assert "r999" in all_seen                    # concurrently-spilled event survived (not erased)
    t.shutdown(timeout=3)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_transport_resilience.py -v`
Expected: FAIL — `test_overflow_spills_to_disk_no_loss` fails because Task 7's `enqueue` drops on Full instead of spilling (`stats["spilled"]` is 0 and events are lost).

- [ ] **Step 3: Add spill + spool drain to `transport.py`**

In `enqueue`, replace the `except queue.Full` branch:
```python
    def enqueue(self, event):
        self.stats["enqueued"] += 1
        self._idle.clear()
        try:
            self._q.put_nowait(event)
        except queue.Full:
            self._spill([event])
```

Add these methods to the `Transport` class:
```python
    def _spill(self, events):
        with self._spool_lock:
            with open(self._spool_path, "a", encoding="utf-8") as f:
                for e in events:
                    f.write(json.dumps(e, ensure_ascii=False) + "\n")
            self.stats["spilled"] += len(events)
            self._enforce_spool_cap()

    def _enforce_spool_cap(self):
        # caller holds _spool_lock
        try:
            if os.path.getsize(self._spool_path) <= self.max_spool_bytes:
                return
        except OSError:
            return
        with open(self._spool_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
        size = sum(len(x.encode("utf-8")) for x in lines)
        while lines and size > self.max_spool_bytes:
            dropped = lines.pop(0)              # drop OLDEST (never silent)
            size -= len(dropped.encode("utf-8"))
            self.stats["dropped"] += 1
        with open(self._spool_path, "w", encoding="utf-8") as f:
            f.writelines(lines)

    def _spool_nonempty(self):
        try:
            return os.path.getsize(self._spool_path) > 0
        except OSError:
            return False

    def _drain_spool(self):
        # Consume the spool atomically: read all lines AND truncate under a single lock hold,
        # so a concurrent _spill() during the (unlocked) POST window cannot be erased by a later
        # truncate. Unsent leftover is re-appended afterwards (append-only, lock-guarded).
        with self._spool_lock:
            if not self._spool_nonempty():
                return
            with open(self._spool_path, "r", encoding="utf-8") as f:
                lines = [ln for ln in f.read().splitlines() if ln.strip()]
            open(self._spool_path, "w", encoding="utf-8").close()  # consume: truncate now
        i = 0
        while i < len(lines):
            chunk = lines[i:i + self.batch_max]
            try:
                events = [json.loads(x) for x in chunk]
            except json.JSONDecodeError:
                i += len(chunk)   # skip corrupt lines rather than wedge forever
                continue
            if self._post(events):
                i += len(chunk)
            else:
                break             # backoff: stop, retry next cycle
        leftover = lines[i:]
        if leftover:
            with self._spool_lock:
                with open(self._spool_path, "a", encoding="utf-8") as f:
                    for ln in leftover:
                        f.write(ln + "\n")
```

Update `_drain_once` to also drain the spool and to count the idle state across both queue and spool. Replace `_drain_once` with:
```python
    def _drain_once(self):
        self._idle.clear()
        while True:
            batch = self._take_batch()
            if not batch:
                break
            if not self._post(batch):
                self.stats["post_failures"] += 1
                self._spill(batch)     # failed in-memory batch -> disk, retry next cycle
                break
        self._drain_spool()
        if self._q.empty() and not self._spool_nonempty():
            self._idle.set()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_transport_resilience.py tests/test_transport_flush.py tests/test_transport_delivery.py -v`
Expected: PASS (8 passed) — spill recovers all overflowed events; CRM-down→recover loses nothing; duplicates pass through (CRM dedups, not the SDK).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-python/src/chobo/transport.py packages/sdk-python/tests/test_transport_resilience.py
git commit -m "feat(sdk-py): transport 韧性 — 溢出落盘/退避重投/不丢不重"
```

---

## Task 10: Capture decorator (`@meter`)

**Files:**
- Create: `packages/sdk-python/src/chobo/capture.py`
- Create: `packages/sdk-python/src/chobo/_runtime.py`
- Create: `packages/sdk-python/tests/test_capture.py`

- [ ] **Step 1: Write the failing test**

`packages/sdk-python/tests/test_capture.py`:
```python
import asyncio
import pytest
import chobo
from chobo import identity


@pytest.fixture(autouse=True)
def fresh_runtime(ingest_stub, tmp_path):
    chobo.init(ingest_url=ingest_stub.url, service="python-lesson-parser",
               queue_maxsize=100, batch_max=100, flush_interval=30.0,
               spool_dir=str(tmp_path))
    identity.clear_identity()
    yield
    chobo.shutdown(timeout=3)
    chobo._runtime.reset()


def _doubao_response():
    return {"model": "doubao-x",
            "choices": [{"finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}


def test_meter_wraps_async_and_captures(ingest_stub):
    @chobo.meter(operation="chat", provider="doubao",
                 extract=chobo.extractors.openai_chat_usage,
                 model_from=lambda a, k: k["model"])
    async def request_upstream(*, model, prompt):
        return _doubao_response()

    identity.set_identity(user_id="t-1", org_id="s-9", project="goal_generation")
    out = asyncio.run(request_upstream(model="doubao-x", prompt="hi"))
    assert out == _doubao_response()        # business return value untouched

    chobo.flush(timeout=3)
    assert len(ingest_stub.received) == 1
    ev = ingest_stub.received[0]
    assert ev["status"] == "success"
    assert ev["provider"] == "doubao"
    assert ev["operation"] == "chat"
    assert ev["request_model"] == "doubao-x"
    assert ev["response_model"] == "doubao-x"
    assert ev["input_tokens"] == 10
    assert ev["output_tokens"] == 5
    assert ev["user_id"] == "t-1"
    assert ev["project"] == "goal_generation"
    assert ev["latency_ms"] is not None


def test_meter_wraps_sync(ingest_stub):
    @chobo.meter(operation="chat", provider="doubao",
                 extract=chobo.extractors.openai_chat_usage, request_model="doubao-x")
    def call():
        return _doubao_response()

    call()
    chobo.flush(timeout=3)
    assert len(ingest_stub.received) == 1
    assert ingest_stub.received[0]["request_model"] == "doubao-x"


def test_meter_records_failure_and_reraises(ingest_stub):
    @chobo.meter(operation="chat", provider="doubao",
                 extract=chobo.extractors.openai_chat_usage, request_model="doubao-x")
    async def boom():
        raise TimeoutError("upstream timeout")

    with pytest.raises(TimeoutError):
        asyncio.run(boom())
    chobo.flush(timeout=3)
    assert len(ingest_stub.received) == 1
    ev = ingest_stub.received[0]
    assert ev["status"] == "failure"
    assert ev["error_type"] == "TimeoutError"
    assert ev["usage_source"] == "none"


def test_missing_identity_marked_missing(ingest_stub):
    @chobo.meter(operation="chat", provider="doubao",
                 extract=chobo.extractors.openai_chat_usage, request_model="doubao-x")
    async def call():
        return _doubao_response()

    asyncio.run(call())          # no set_identity
    chobo.flush(timeout=3)
    assert ingest_stub.received[0]["identity_source"] == "missing"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_capture.py -v`
Expected: FAIL with `AttributeError: module 'chobo' has no attribute 'init'`

- [ ] **Step 3: Write the runtime singleton**

`packages/sdk-python/src/chobo/_runtime.py`:
```python
"""Global SDK runtime: holds the active Config + Transport, wires lifecycle helpers."""
from .config import Config
from .transport import Transport

_transport = None
_config = None


def init(ingest_url, service, **kwargs):
    global _transport, _config
    if _transport is not None:
        reset()
    _config = Config(ingest_url=ingest_url, service=service, **kwargs)
    _transport = Transport(
        ingest_url=_config.ingest_url,
        queue_maxsize=_config.queue_maxsize,
        batch_max=_config.batch_max,
        flush_interval=_config.flush_interval,
        spool_dir=_config.spool_dir,
        max_spool_bytes=_config.max_spool_bytes,
        timeout=_config.timeout,
    )
    return _config


def get_config():
    return _config


def emit(event):
    if _transport is None:
        return
    _transport.enqueue(event)


def flush(timeout=5.0):
    if _transport is None:
        return True
    return _transport.flush(timeout=timeout)


def shutdown(timeout=5.0):
    if _transport is not None:
        _transport.shutdown(timeout=timeout)


def get_stats():
    return dict(_transport.stats) if _transport is not None else {}


def reset():
    """Test helper: tear down the active transport."""
    global _transport, _config
    if _transport is not None:
        _transport.shutdown(timeout=2)
    _transport = None
    _config = None
```

- [ ] **Step 4: Write the capture decorator**

`packages/sdk-python/src/chobo/capture.py`:
```python
"""@meter — wrap a call chokepoint; capture identity+timing+usage into an event.

Works on both `async def` and `def`. Never alters the wrapped function's return value or
exception. On exception it records a failure event, then re-raises.
"""
import asyncio
import functools

from . import _runtime
from .identity import get_identity
from .event import build_event, now_ms


def meter(*, operation, provider, extract=None, request_model=None,
          model_from=None, request_id_from=None):
    def decorator(func):
        is_async = asyncio.iscoroutinefunction(func)

        def _resolve_request_model(args, kwargs):
            if model_from is not None:
                try:
                    return model_from(args, kwargs)
                except Exception:
                    return request_model
            return request_model

        def _resolve_request_id(args, kwargs):
            if request_id_from is not None:
                try:
                    return request_id_from(args, kwargs)
                except Exception:
                    return None
            return None

        def _success_event(args, kwargs, response, start, end):
            usage = {}
            if extract is not None:
                try:
                    usage = extract(response) or {}
                except Exception:
                    usage = {"usage_source": "none"}
            cfg = _runtime.get_config()
            return build_event(
                service=cfg.service if cfg else "unknown",
                provider=provider, operation=operation,
                request_model=_resolve_request_model(args, kwargs),
                identity=get_identity(), start_ms=start, end_ms=end,
                usage=usage, status="success",
                request_id=_resolve_request_id(args, kwargs),
            )

        def _failure_event(args, kwargs, exc, start, end):
            cfg = _runtime.get_config()
            return build_event(
                service=cfg.service if cfg else "unknown",
                provider=provider, operation=operation,
                request_model=_resolve_request_model(args, kwargs),
                identity=get_identity(), start_ms=start, end_ms=end,
                status="failure", error_type=type(exc).__name__,
                request_id=_resolve_request_id(args, kwargs),
            )

        if is_async:
            @functools.wraps(func)
            async def awrapper(*args, **kwargs):
                start = now_ms()
                try:
                    response = await func(*args, **kwargs)
                except Exception as exc:
                    _runtime.emit(_failure_event(args, kwargs, exc, start, now_ms()))
                    raise
                _runtime.emit(_success_event(args, kwargs, response, start, now_ms()))
                return response
            return awrapper

        @functools.wraps(func)
        def swrapper(*args, **kwargs):
            start = now_ms()
            try:
                response = func(*args, **kwargs)
            except Exception as exc:
                _runtime.emit(_failure_event(args, kwargs, exc, start, now_ms()))
                raise
            _runtime.emit(_success_event(args, kwargs, response, start, now_ms()))
            return response
        return swrapper

    return decorator
```

- [ ] **Step 5: Wire the public API**

Replace `packages/sdk-python/src/chobo/__init__.py`:
```python
"""chobo — low-intrusion LLM usage metering SDK (Python)."""
from . import extractors, identity, _runtime
from ._runtime import init, flush, shutdown, get_stats, get_config
from .identity import set_identity, get_identity, clear_identity
from .capture import meter

__version__ = "0.1.0"

__all__ = [
    "init", "flush", "shutdown", "get_stats", "get_config",
    "set_identity", "get_identity", "clear_identity",
    "meter", "extractors", "identity",
]
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pytest tests/test_capture.py -v`
Expected: PASS (4 passed)

- [ ] **Step 7: Commit**

```bash
git add packages/sdk-python/src/chobo/capture.py packages/sdk-python/src/chobo/_runtime.py packages/sdk-python/src/chobo/__init__.py packages/sdk-python/tests/test_capture.py
git commit -m "feat(sdk-py): @meter 拦截装饰器 (async/sync) + 运行时单例 + 公共 API"
```

---

## Task 11: Public API surface test + full suite green

**Files:**
- Create: `packages/sdk-python/tests/test_public_api.py`

- [ ] **Step 1: Write the test**

`packages/sdk-python/tests/test_public_api.py`:
```python
import chobo


def test_public_surface_present():
    for name in ["init", "set_identity", "get_identity", "clear_identity",
                 "meter", "flush", "shutdown", "get_stats", "extractors"]:
        assert hasattr(chobo, name), f"missing public symbol: {name}"


def test_version_string():
    assert isinstance(chobo.__version__, str)
    assert chobo.__version__ == "0.1.0"


def test_flush_and_shutdown_safe_before_init():
    # Calling lifecycle helpers before init() must not raise.
    import chobo._runtime as rt
    rt.reset()
    assert chobo.flush(timeout=0.1) is True
    chobo.shutdown(timeout=0.1)
    assert chobo.get_stats() == {}
```

- [ ] **Step 2: Run the full suite**

Run: `cd packages/sdk-python && pytest -q`
Expected: PASS (all tests across all files green).

- [ ] **Step 3: Commit**

```bash
git add packages/sdk-python/tests/test_public_api.py
git commit -m "test(sdk-py): 公共 API 面与 init 前生命周期安全"
```

---

## Task 12: End-to-end SDK test (fake chokepoint → stub ingest)

**Files:**
- Create: `packages/sdk-python/tests/test_end_to_end.py`

- [ ] **Step 1: Write the test**

`packages/sdk-python/tests/test_end_to_end.py`:
```python
import asyncio
import json
import pathlib
import jsonschema
import chobo
from chobo import identity

SCHEMA = json.loads(
    (pathlib.Path(__file__).resolve().parents[3] / "contracts" / "event.schema.json")
    .read_text(encoding="utf-8")
)


def test_full_path_chat_and_image(ingest_stub, tmp_path):
    chobo.init(ingest_url=ingest_stub.url, service="python-lesson-parser",
               flush_interval=30.0, spool_dir=str(tmp_path))
    identity.clear_identity()

    @chobo.meter(operation="chat", provider="doubao",
                 extract=chobo.extractors.openai_chat_usage,
                 model_from=lambda a, k: k["model"])
    async def request_upstream(*, model, prompt):
        return {"model": model, "choices": [{"finish_reason": "stop"}],
                "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}}

    @chobo.meter(operation="image", provider="doubao",
                 extract=chobo.extractors.image_usage, request_model="seedream-x")
    async def generate_image(*, prompt):
        return {"data": [{"url": "a"}, {"url": "b"}]}

    identity.set_identity(user_id="t-7", org_id="s-3", project="report-action-cards")
    asyncio.run(request_upstream(model="doubao-x", prompt="hi"))
    asyncio.run(generate_image(prompt="a cat"))

    chobo.flush(timeout=5)
    chobo.shutdown(timeout=5)

    assert len(ingest_stub.received) == 2
    for ev in ingest_stub.received:
        jsonschema.validate(ev, SCHEMA)        # every delivered event is contract-valid
        assert ev["user_id"] == "t-7"
        assert ev["org_id"] == "s-3"

    by_op = {e["operation"]: e for e in ingest_stub.received}
    assert by_op["chat"]["input_tokens"] == 100
    assert by_op["chat"]["request_model"] == "doubao-x"
    assert by_op["image"]["image_count"] == 2

    import chobo._runtime as rt
    rt.reset()
```

- [ ] **Step 2: Run the test**

Run: `pytest tests/test_end_to_end.py -v`
Expected: PASS (1 passed) — proves identity → capture → transport → (stub) ingest, with both chat and image operations, all contract-valid.

- [ ] **Step 3: Commit**

```bash
git add packages/sdk-python/tests/test_end_to_end.py
git commit -m "test(sdk-py): 端到端 — 假咽喉→桩 ingest,chat+image 全契约通过"
```

---

## Task 13: SDK README (install, quickstart, AdopterA integration recipe)

**Files:**
- Create: `packages/sdk-python/README.md`

- [ ] **Step 1: Write the README**

`packages/sdk-python/README.md`:
```markdown
# chobo — Python SDK

Low-intrusion LLM usage metering. Wrap a call chokepoint with `@chobo.meter`; the SDK captures
identity + timing + usage, builds a [contract](../../contracts/event.schema.json) event, and
delivers it to the CRM without ever blocking the business call.

- **Runtime:** Python ≥3.9, developed/CI'd on 3.12.10. No third-party runtime deps (stdlib only).
- **Never blocks, never silently loses:** bounded queue → disk spill → backoff retry → flush on exit.
  The SDK does NOT compute cost (the CRM prices events).

## Install (dev)
```bash
cd packages/sdk-python
python -m venv .venv && . .venv/Scripts/activate   # Linux/macOS: . .venv/bin/activate
pip install -e ".[dev]"
pytest -q
```

## Quickstart
```python
import chobo

chobo.init(
    ingest_url="http://localhost:4000/v1/events",
    service="python-lesson-parser",
    flush_interval=2.0,
    spool_dir="./.chobo-spool",
)

# At the HTTP request boundary (e.g. FastAPI middleware/dependency):
chobo.set_identity(user_id=teacher_id, org_id=school_id, project="goal_generation")

# Wrap each chokepoint once:
@chobo.meter(operation="chat", provider="doubao",
             extract=chobo.extractors.openai_chat_usage,
             model_from=lambda a, k: k.get("model"))
async def request_upstream(*, model, **kw): ...

# On process exit (FastAPI lifespan shutdown):
chobo.shutdown()
```

## Config
| Field | Default | Meaning |
|---|---|---|
| `ingest_url` | — | CRM `POST /v1/events` URL |
| `service` | — | host service name in events |
| `queue_maxsize` | 10000 | in-memory buffer cap before spilling to disk |
| `batch_max` | 100 | max events per POST |
| `flush_interval` | 2.0 | flusher cycle seconds |
| `spool_dir` | `./.chobo-spool` | per-process JSONL overflow files (`events-<pid>.jsonl`) |
| `max_spool_bytes` | 50 MiB | spool cap; over cap drops OLDEST + counts (never silent) |
| `payload` | `metadata` | `off` \| `metadata` \| `truncated` (payload capture lands with CRM payload table) |
| `timeout` | 5.0 | POST timeout seconds |

`chobo.get_stats()` → `{enqueued, sent, spilled, dropped, post_failures}`.

## AdopterA integration recipe (first adopter — applied in Plan 5, not here)
`python-lesson-parser` has three chokepoints (spec §5.1). Wrap them without touching call sites:
- `app/services/upstream_api.py::request_upstream` → `@meter(operation="chat", extract=openai_chat_usage)`
- `app/services/providers/upstream.py::UpstreamProvider.complete` → same
- `app/services/providers/image.py::ImageProvider.generate` → `@meter(operation="image", extract=image_usage)`

Set identity in a FastAPI dependency reading `X-Chobo-User` / `X-Chobo-Org` / `X-Chobo-Project`
headers; call `chobo.shutdown()` in the lifespan shutdown hook. The exact header names and the
real doubao response shape are confirmed against the live service during Plan 5.
```

- [ ] **Step 2: Verify the full suite still passes**

Run: `cd packages/sdk-python && pytest -q`
Expected: PASS (all green).

- [ ] **Step 3: Commit**

```bash
git add packages/sdk-python/README.md
git commit -m "docs(sdk-py): README — 安装/快速上手/AdopterA 接入配方"
```

---

## Self-Review

**Spec coverage:**
- §4 event contract → Task 1 (schema) + Task 2 (validation) + every event-emitting test validates against it. ✓
- §5.1 Python chokepoints → `@meter` (Task 10) handles async chokepoints; README maps the three real ones (applied in Plan 5). ✓
- §6 identity (header v1, missing→unattributed) → Task 3 + capture marks `missing` (Task 10 test). ✓ (JWT swap is out of v1 scope per §2.)
- §8 pricing → correctly ABSENT (SDK never prices; CRM is Plan 2). ✓
- §9 delivery reliability (bounded queue → spill → backoff → flush/shutdown → idempotent) → Tasks 7–9; `event_id` uniqueness in Task 4; duplicates pass through for CRM dedup (Task 9). ✓
- §10.3 failures fully logged → Task 10 failure path. ✓
- §13 SDK public API (`init`/`set_identity`/`meter`/`flush`/`shutdown`) → Task 10/11. `meter()` escape-hatch for manual reporting is covered by the same decorator + direct `_runtime.emit`; a standalone `report_event()` helper is deferred (not needed until a non-decoratable call appears). ✓
- §13 runtime constraints (≥3.9, 3.12 baseline, stdlib-only, no 3.13 syntax) → `pyproject.toml` + `.python-version` + zero runtime deps. ✓

**Placeholder scan:** No TBD/TODO; every code step is complete and runnable. Price numbers and exact doubao field names are explicitly deferred with named follow-ups (Plan 2 / Plan 5), not left as silent gaps. ✓

**Type/name consistency:** `Transport(...)` constructor args match `_runtime.init` call (Task 7 ↔ Task 10). `extractors.openai_chat_usage`/`image_usage` names match capture tests and README. `_runtime.reset()` used consistently in test teardown. `meter(operation, provider, extract, request_model, model_from, request_id_from)` signature matches all call sites. ✓

**Deferred to later plans (intentional, noted):** payload capture/truncation/redaction (lands with the CRM `event_payloads` table, Plan 2); `usage_source="estimated"` fallback (a Python concern only if a chokepoint lacks usage — none do per §5.1; the Node SDK owns estimation, Plan 3); real AdopterA wiring (Plan 5).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-24-contracts-and-python-sdk.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.
