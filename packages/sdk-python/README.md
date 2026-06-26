# chobo — Python SDK

> **接入请以权威手册为准：[`docs/SDK_MANUAL.md`](../../docs/SDK_MANUAL.md)**（Node + Python 统一、完整无二义）。
> 本文件是包内开发速记。

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
