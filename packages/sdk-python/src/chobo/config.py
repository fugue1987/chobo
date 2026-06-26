"""SDK configuration."""
from dataclasses import dataclass
from typing import Optional


@dataclass
class Config:
    ingest_url: str
    service: str
    account: Optional[str] = None
    ingest_secret: Optional[str] = None
    queue_maxsize: int = 10000
    batch_max: int = 100
    flush_interval: float = 2.0
    spool_dir: str = "./.chobo-spool"
    max_spool_bytes: int = 50 * 1024 * 1024
    payload: str = "metadata"   # off | metadata | truncated
    timeout: float = 5.0
