import time
from chobo.transport import Transport


def _ev(i):
    return {"event_id": f"r{i}", "service": "s", "provider": "p", "operation": "chat",
            "request_model": "m", "identity_source": "header", "start_time": 1,
            "usage_source": "measured", "status": "success",
            "sdk_lang": "python", "sdk_version": "0.1.3"}


def test_crm_down_then_recovers_no_loss(ingest_stub, tmp_path):
    ingest_stub.set_status(503)   # CRM unreachable/erroring
    t = Transport(ingest_url=ingest_stub.url, queue_maxsize=100, batch_max=10,
                  flush_interval=0.05, spool_dir=str(tmp_path), max_spool_bytes=10**7)
    for i in range(8):
        t.enqueue(_ev(i))
    time.sleep(0.5)                # flusher retries fail; events held (queue or spool)
    assert len(ingest_stub.received) == 0
    ingest_stub.set_status(200)    # CRM recovers
    t.flush(timeout=5)
    t.shutdown(timeout=5)
    ids = sorted(e["event_id"] for e in ingest_stub.received)
    assert ids == [f"r{i}" for i in range(8)]   # all 8, none lost


def test_overflow_spills_to_disk_no_loss(ingest_stub, tmp_path):
    ingest_stub.set_status(503)    # keep events from draining so the queue fills
    t = Transport(ingest_url=ingest_stub.url, queue_maxsize=3, batch_max=3,
                  flush_interval=30.0, spool_dir=str(tmp_path), max_spool_bytes=10**7)
    for i in range(20):            # far exceeds queue_maxsize=3 -> must spill
        t.enqueue(_ev(i))
    assert t.stats["spilled"] > 0
    ingest_stub.set_status(200)
    t.flush(timeout=5)
    t.shutdown(timeout=5)
    ids = sorted(int(e["event_id"][1:]) for e in ingest_stub.received)
    assert ids == list(range(20))   # everything that overflowed was recovered from disk


def test_duplicate_event_ids_not_dropped_by_sdk(ingest_stub, tmp_path):
    # SDK delivers at-least-once; CRM dedups. SDK itself must not silently drop a same-id event.
    t = Transport(ingest_url=ingest_stub.url, queue_maxsize=100, batch_max=100,
                  flush_interval=30.0, spool_dir=str(tmp_path), max_spool_bytes=10**7)
    t.enqueue(_ev(1))
    t.enqueue(_ev(1))
    t.flush(timeout=3)
    t.shutdown(timeout=3)
    assert len(ingest_stub.received) == 2


def test_concurrent_spill_during_drain_not_lost(ingest_stub, tmp_path):
    # A producer spills a NEW event during the unlocked POST window of _drain_spool.
    # The drain must NOT erase that concurrently-appended event.
    import os
    import json as _json
    t = Transport(ingest_url=ingest_stub.url, queue_maxsize=100, batch_max=10,
                  flush_interval=30.0, spool_dir=str(tmp_path), max_spool_bytes=10**7)
    for i in range(5):
        t._spill([_ev(i)])                      # pre-load spool as if previously overflowed
    real_post = t._post
    state = {"first": True}

    def racey_post(events):
        if state["first"]:
            state["first"] = False
            t._spill([_ev(999)])                # concurrent producer appends during post window
        return real_post(events)

    t._post = racey_post
    t._drain_spool()

    delivered = {e["event_id"] for e in ingest_stub.received}
    spool_file = os.path.join(str(tmp_path), f"events-{os.getpid()}.jsonl")
    remaining = set()
    if os.path.exists(spool_file):
        with open(spool_file, encoding="utf-8") as f:
            remaining = {_json.loads(x)["event_id"] for x in f.read().splitlines() if x.strip()}
    all_seen = delivered | remaining
    for i in range(5):
        assert f"r{i}" in all_seen               # originals delivered
    assert "r999" in all_seen                    # concurrently-spilled event survived (not erased)
    t.shutdown(timeout=3)
