from dataclasses import dataclass, field
from typing import Any, Dict, Optional

_STRIP_WS_KEYS = frozenset({"raw", "raw_hex", "raw_bytes"})
_STRIP_LATEST_KEYS = frozenset({"raw", "raw_hex", "raw_bytes"})


def now_ms() -> int:
    import time

    return int(time.time() * 1000)


def strip_heavy_fields(data: dict, keys: frozenset = _STRIP_WS_KEYS) -> dict:
    if not keys.intersection(data):
        return data
    return {key: value for key, value in data.items() if key not in keys}


@dataclass
class NormalizedTelemetry:
    topic: str
    name: str
    type: str
    position: str
    unit: str
    value: Optional[float | int | str]
    values: Dict[str, Any]
    units: Dict[str, str] = field(default_factory=dict)
    parsed: Any = None
    source: str = ""
    key: str = ""
    seq: Optional[int] = None
    ts_ms: int = field(default_factory=now_ms)
    server_received_ms: int = field(default_factory=now_ms)
    device_id: str = ""
    raw: Any = None
    raw_hex: str = ""

    @property
    def timestamp_seconds(self) -> float:
        return self.ts_ms / 1000.0

    def to_processed_data(self) -> dict:
        return {
            "name": self.name,
            "type": self.type,
            "position": self.position,
            "unit": self.unit,
            "value": self.value,
            "values": self.values,
            "parsed": self.parsed if self.parsed is not None else self.values,
            "units": self.units,
            "source": self.source,
            "key": self.key,
            "seq": self.seq,
            "ts_ms": self.ts_ms,
            "timestamp": self.timestamp_seconds,
            "server_received_ms": self.server_received_ms,
            "device_id": self.device_id,
            "raw": self.raw,
            "raw_hex": self.raw_hex,
            "topic": self.topic,
            "datetime": self.server_received_ms / 1000.0,
        }

    def to_ws_message(self, processed: dict | None = None) -> dict:
        data = strip_heavy_fields(processed if processed is not None else self.to_processed_data())
        return {
            "type": "mqtt",
            "topic": self.topic,
            "data": data,
            "sensor_info": {
                "name": self.name,
                "type": self.type,
                "position": self.position,
                "unit": self.unit,
            },
            "timestamp": self.timestamp_seconds,
            "ts_ms": self.ts_ms,
            "seq": self.seq,
            "server_received_ms": self.server_received_ms,
        }

    def to_storage_payload(self, processed: dict | None = None) -> dict:
        return strip_heavy_fields(
            processed if processed is not None else self.to_processed_data(),
            _STRIP_WS_KEYS,
        )


def sanitize_latest_payload(processed: dict) -> dict:
    return strip_heavy_fields(processed, _STRIP_LATEST_KEYS)
