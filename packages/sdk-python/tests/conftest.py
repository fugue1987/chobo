import json
import threading
import http.server
import pytest


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        status = self.server.next_status
        if 200 <= status < 300:
            try:
                payload = json.loads(raw)
                self.server.received.extend(payload.get("events", []))
            except Exception:
                pass
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"accepted":0,"duplicates":0}')

    def log_message(self, *args):
        pass  # silence test server logs


class _Stub:
    def __init__(self):
        self.httpd = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
        self.httpd.received = []
        self.httpd.next_status = 200
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/v1/events"
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self._thread.start()

    @property
    def received(self):
        return self.httpd.received

    def set_status(self, code):
        self.httpd.next_status = code

    def stop(self):
        self.httpd.shutdown()


@pytest.fixture
def ingest_stub():
    stub = _Stub()
    yield stub
    stub.stop()
