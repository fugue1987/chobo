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
                account=cfg.account if cfg else None,
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
                account=cfg.account if cfg else None,
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
