"""Global SDK runtime: holds the active Config + Transport, wires lifecycle helpers."""
from .config import Config
from .transport import Transport

_transport = None
_config = None


def init(ingest_url, service, account=None, **kwargs):
    global _transport, _config
    if _transport is not None:
        reset()
    _config = Config(ingest_url=ingest_url, service=service, account=account, **kwargs)
    _transport = Transport(
        ingest_url=_config.ingest_url,
        queue_maxsize=_config.queue_maxsize,
        batch_max=_config.batch_max,
        flush_interval=_config.flush_interval,
        spool_dir=_config.spool_dir,
        max_spool_bytes=_config.max_spool_bytes,
        timeout=_config.timeout,
        ingest_secret=_config.ingest_secret,
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
