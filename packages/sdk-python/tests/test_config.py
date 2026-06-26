from chobo.config import Config


def test_config_requires_url_and_service():
    c = Config(ingest_url="http://x/v1/events", service="python-lesson-parser")
    assert c.ingest_url == "http://x/v1/events"
    assert c.service == "python-lesson-parser"


def test_config_defaults():
    c = Config(ingest_url="http://x", service="s")
    assert c.queue_maxsize == 10000
    assert c.batch_max == 100
    assert c.flush_interval == 2.0
    assert c.payload == "metadata"
    assert c.timeout == 5.0
    assert c.max_spool_bytes == 50 * 1024 * 1024


def test_config_overrides():
    c = Config(ingest_url="http://x", service="s", queue_maxsize=5, batch_max=2,
               flush_interval=0.1, payload="off", spool_dir="/tmp/sp")
    assert c.queue_maxsize == 5
    assert c.batch_max == 2
    assert c.payload == "off"
    assert c.spool_dir == "/tmp/sp"


def test_config_account_default_none():
    c = Config(ingest_url="http://x", service="s")
    assert c.account is None


def test_config_account_set():
    c = Config(ingest_url="http://x", service="s", account="acme")
    assert c.account == "acme"
