import time
from chobo.transport import Transport


def _ev(i):
    return {"event_id": f"e{i}", "service": "s", "provider": "p", "operation": "chat",
            "request_model": "m", "identity_source": "header", "start_time": 1,
            "usage_source": "measured", "status": "success",
            "sdk_lang": "python", "sdk_version": "0.1.3"}


def test_enqueued_events_are_posted(ingest_stub, tmp_path):
    t = Transport(ingest_url=ingest_stub.url, queue_maxsize=100, batch_max=10,
                  flush_interval=0.05, spool_dir=str(tmp_path), max_spool_bytes=10**7)
    for i in range(5):
        t.enqueue(_ev(i))
    deadline = time.time() + 3
    while len(ingest_stub.received) < 5 and time.time() < deadline:
        time.sleep(0.02)
    t.shutdown(timeout=3)
    ids = sorted(e["event_id"] for e in ingest_stub.received)
    assert ids == ["e0", "e1", "e2", "e3", "e4"]
    assert t.stats["sent"] == 5


def test_events_are_batched(ingest_stub, tmp_path):
    t = Transport(ingest_url=ingest_stub.url, queue_maxsize=100, batch_max=100,
                  flush_interval=0.2, spool_dir=str(tmp_path), max_spool_bytes=10**7)
    for i in range(20):
        t.enqueue(_ev(i))
    t.flush(timeout=3)
    t.shutdown(timeout=3)
    assert len(ingest_stub.received) == 20
