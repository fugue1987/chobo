"""Build a contract-shaped event dict (spec §4). The SDK never computes cost_* fields."""
import time
import uuid

SDK_LANG = "python"
SDK_VERSION = "0.1.3"


def now_ms():
    return int(time.time() * 1000)


def build_event(*, service, provider, operation, request_model, identity,
                start_ms, end_ms, usage=None, status="success", error_type=None,
                response_model=None, finish_reason=None,
                request_id=None, parent_id=None, payload=None, account=None):
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
        "account": account,
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
        "input_text_tokens": usage.get("input_text_tokens"),
        "input_image_tokens": usage.get("input_image_tokens"),
        "usage_source": usage.get("usage_source", default_usage_source),
        "status": status,
        "error_type": error_type,
        "finish_reason": finish_reason or usage.get("finish_reason"),
        "payload": payload,
        "sdk_lang": SDK_LANG,
        "sdk_version": SDK_VERSION,
    }
