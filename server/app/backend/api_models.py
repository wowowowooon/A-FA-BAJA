from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from datetime import datetime


class SensorData(BaseModel):
    measurement: str
    tags: dict = {}
    fields: dict
    timestamp: Optional[datetime] = None


class QueryRequest(BaseModel):
    measurement: str
    start: Optional[str] = None
    stop: Optional[str] = None
    limit: Optional[int] = 100


class RecordingRequest(BaseModel):
    name: str
    format: str
    startedAt: Optional[int] = None
    endedAt: Optional[int] = None
    snapshots: List[Dict[str, Any]] = []


class AnalysisQueryRequest(BaseModel):
    recordingId: str
    fields: List[str] = []
    limit: Optional[int] = 10000


class StreamStartRequest(BaseModel):
    name: str
    startedAt: Optional[int] = None


class StreamAppendRequest(BaseModel):
    recordingId: str
    snapshots: List[Dict[str, Any]] = []


class StreamStopRequest(BaseModel):
    recordingId: str
    endedAt: Optional[int] = None


class TrackSaveRequest(BaseModel):
    laps: List[Dict[str, Any]] = []
    segments: List[Dict[str, Any]] = []
    allPoints: List[Dict[str, Any]] = []


class TelemetryEnvelope(BaseModel):
    schema: str = "race.telemetry.v1"
    device_id: Optional[str] = None
    seq: Optional[int] = None
    ts_ms: Optional[int] = None
    source: Optional[str] = None
    key: Optional[str] = None
    topic: Optional[str] = None
    values: Dict[str, Any] = {}
    units: Dict[str, str] = {}
    payload_hex: Optional[str] = None
