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


def test_build_event_image_token_fields_passthrough():
    ev = event.build_event(
        service="node-ai-proxy", provider="newapi", operation="image_generation",
        request_model="gpt-image-2", identity=IDENTITY,
        start_ms=1000, end_ms=2000,
        usage={
            "input_text_tokens": 37,
            "input_image_tokens": 323,
            "output_tokens": 272,
            "image_count": 1,
            "usage_source": "measured",
        },
    )
    assert ev["input_text_tokens"] == 37
    assert ev["input_image_tokens"] == 323


def test_build_event_image_token_fields_default_none():
    ev = event.build_event(
        service="s", provider="p", operation="chat", request_model="m",
        identity=IDENTITY, start_ms=1, end_ms=2,
    )
    assert ev["input_text_tokens"] is None
    assert ev["input_image_tokens"] is None
