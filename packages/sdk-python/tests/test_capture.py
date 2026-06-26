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
