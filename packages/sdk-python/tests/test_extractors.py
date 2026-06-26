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
