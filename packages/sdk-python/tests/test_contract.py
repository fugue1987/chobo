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
        "sdk_version": "0.1.3",
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
