import time
from chobo.transport import Transport


def _ev(i):
    return {"event_id": f"f{i}", "service": "s", "provider": "p", "operation": "chat",
            "request_model": "m", "identity_source": "header", "start_time": 1,
            "usage_source": "measured", "status": "success",
            "sdk_lang": "python", "sdk_version": "0.1.3"}


def test_flush_blocks_until_delivered(ingest_stub, tmp_path):
    # Long flush_interval: without flush(), nothing would be sent yet.
    t = Transport(ingest_url=ingest_stub.url, queue_maxsize=100, batch_max=100,
                  flush_interval=30.0, spool_dir=str(tmp_path), max_spool_bytes=10**7)
    for i in range(10):
        t.enqueue(_ev(i))
    assert t.flush(timeout=3) is True
    assert len(ingest_stub.received) == 10
    t.shutdown(timeout=3)


def test_shutdown_drains_remaining(ingest_stub, tmp_path):
    t = Transport(ingest_url=ingest_stub.url, queue_maxsize=100, batch_max=100,
                  flush_interval=30.0, spool_dir=str(tmp_path), max_spool_bytes=10**7)
    for i in range(7):
        t.enqueue(_ev(i))
    t.shutdown(timeout=3)   # must drain even without an explicit flush
    assert len(ingest_stub.received) == 7
