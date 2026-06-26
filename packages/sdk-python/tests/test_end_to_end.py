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
