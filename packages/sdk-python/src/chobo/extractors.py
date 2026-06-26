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
