"""Never-blocking delivery: bounded queue -> background flusher thread -> batch POST.

This task implements in-memory delivery + flush/shutdown. Disk spill + backoff are added in
the resilience task. The flusher is a daemon thread using only stdlib urllib, so it is agnostic
to the host's event loop (works in sync and asyncio hosts, across uvicorn workers).
"""
import json
import os
import queue
import threading
import urllib.error
import urllib.request


class Transport:
    def __init__(self, ingest_url, queue_maxsize, batch_max, flush_interval,
                 spool_dir, max_spool_bytes, timeout=5.0, ingest_secret=None):
        self.ingest_url = ingest_url
        self.ingest_secret = ingest_secret
        self.batch_max = batch_max
        self.flush_interval = flush_interval
        self.spool_dir = spool_dir
        self.max_spool_bytes = max_spool_bytes
        self.timeout = timeout
        self._q = queue.Queue(maxsize=queue_maxsize)
        self._stop = threading.Event()
        self._flush_now = threading.Event()
        self._idle = threading.Event()
        self._idle.set()
        self._spool_lock = threading.Lock()
        self.stats = {"enqueued": 0, "sent": 0, "spilled": 0, "dropped": 0, "post_failures": 0}
        os.makedirs(spool_dir, exist_ok=True)
        self._spool_path = os.path.join(spool_dir, f"events-{os.getpid()}.jsonl")
        self._thread = threading.Thread(target=self._run, name="chobo-flusher", daemon=True)
        self._thread.start()

    # ---- producer side (called on the business thread; must be instant) ----
    def enqueue(self, event):
        self.stats["enqueued"] += 1
        self._idle.clear()
        try:
            self._q.put_nowait(event)
        except queue.Full:
            self._spill([event])

    # ---- consumer side (flusher thread) ----
    def _run(self):
        while not self._stop.is_set():
            fired = self._flush_now.wait(timeout=self.flush_interval)
            if fired:
                self._flush_now.clear()
            self._drain_once()
        self._drain_once()  # final drain on shutdown

    def _take_batch(self):
        batch = []
        for _ in range(self.batch_max):
            try:
                batch.append(self._q.get_nowait())
            except queue.Empty:
                break
        return batch

    def _spill(self, events):
        with self._spool_lock:
            with open(self._spool_path, "a", encoding="utf-8") as f:
                for e in events:
                    f.write(json.dumps(e, ensure_ascii=False) + "\n")
            self.stats["spilled"] += len(events)
            self._enforce_spool_cap()

    def _enforce_spool_cap(self):
        # caller holds _spool_lock
        try:
            if os.path.getsize(self._spool_path) <= self.max_spool_bytes:
                return
        except OSError:
            return
        with open(self._spool_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
        size = sum(len(x.encode("utf-8")) for x in lines)
        while lines and size > self.max_spool_bytes:
            dropped = lines.pop(0)              # drop OLDEST (never silent)
            size -= len(dropped.encode("utf-8"))
            self.stats["dropped"] += 1
        with open(self._spool_path, "w", encoding="utf-8") as f:
            f.writelines(lines)

    def _spool_nonempty(self):
        try:
            return os.path.getsize(self._spool_path) > 0
        except OSError:
            return False

    def _drain_spool(self):
        # Consume the spool atomically: read all lines AND truncate under a single lock hold,
        # so a concurrent _spill() during the (unlocked) POST window cannot be erased by a later
        # truncate. Unsent leftover is re-appended afterwards (append-only, lock-guarded).
        with self._spool_lock:
            if not self._spool_nonempty():
                return
            with open(self._spool_path, "r", encoding="utf-8") as f:
                lines = [ln for ln in f.read().splitlines() if ln.strip()]
            open(self._spool_path, "w", encoding="utf-8").close()  # consume: truncate now
        i = 0
        while i < len(lines):
            chunk = lines[i:i + self.batch_max]
            try:
                events = [json.loads(x) for x in chunk]
            except json.JSONDecodeError:
                i += len(chunk)
                continue
            if self._post(events):
                i += len(chunk)
            else:
                break
        leftover = lines[i:]
        if leftover:
            with self._spool_lock:
                with open(self._spool_path, "a", encoding="utf-8") as f:
                    for ln in leftover:
                        f.write(ln + "\n")

    def _drain_once(self):
        self._idle.clear()
        while True:
            batch = self._take_batch()
            if not batch:
                break
            if not self._post(batch):
                self.stats["post_failures"] += 1
                self._spill(batch)     # failed in-memory batch -> disk, retry next cycle
                break
        self._drain_spool()
        if self._q.empty() and not self._spool_nonempty():
            self._idle.set()

    def _post(self, events):
        body = json.dumps({"events": events}, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.ingest_secret:
            headers["x-chobo-secret"] = self.ingest_secret
        req = urllib.request.Request(self.ingest_url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                if 200 <= resp.status < 300:
                    self.stats["sent"] += len(events)
                    return True
                return False
        except (urllib.error.URLError, OSError):
            return False

    # ---- lifecycle ----
    def flush(self, timeout=5.0):
        self._idle.clear()
        self._flush_now.set()
        return self._idle.wait(timeout=timeout)

    def shutdown(self, timeout=5.0):
        self.flush(timeout=timeout)
        self._stop.set()
        self._flush_now.set()
        self._thread.join(timeout=timeout)
