import json
import os
import queue
import threading
import time
from datetime import datetime, timezone
from typing import List, Dict, Any

from fastapi import HTTPException
from influxdb_client import Point

from config import INFLUXDB_BUCKET, INFLUXDB_ORG
from influx import write_api, query_api, influx_client
from api_models import RecordingRequest, AnalysisQueryRequest, StreamStartRequest, StreamAppendRequest, StreamStopRequest, TrackSaveRequest
from telemetry import NormalizedTelemetry

STREAM_SESSIONS: Dict[str, Dict[str, Any]] = {}
ACTIVE_RECORDING: Dict[str, Any] | None = None
_recording_session_ref: Dict[str, Any] | None = None
RECORDING_QUEUE_MAXSIZE = 50000
RECORDING_BATCH_SIZE = 200
RECORDING_LOG_DIR = os.path.join(os.path.dirname(__file__), "recording_logs")
_recording_lock = threading.Lock()
_recording_queue: "queue.Queue[tuple[NormalizedTelemetry, Dict[str, Any], dict]]" = queue.Queue(
    maxsize=RECORDING_QUEUE_MAXSIZE
)
_recording_writer_started = False
_recording_dropped = 0
_recording_meta_cache: Dict[str, tuple[float, Dict[str, Any]]] = {}
_META_CACHE_TTL_SEC = 120
DEFAULT_ANALYSIS_LIMIT = 1500


def _analysis_value_keys(field: str) -> list[str]:
    if field.startswith("extra."):
        return [field[6:]]
    return []


def _scalar_values(values: Dict[str, Any]) -> Dict[str, float]:
    result: Dict[str, float] = {}
    if not isinstance(values, dict):
        return result
    for key, value in values.items():
        if isinstance(value, bool) or value is None:
            continue
        if isinstance(value, (int, float)):
            result[key] = float(value)
            continue
        try:
            result[key] = float(value)
        except (TypeError, ValueError):
            continue
    return result


def _extract_telemetry_values(telemetry: Dict[str, Any]) -> Dict[str, float]:
    return _scalar_values(telemetry.get("values"))


def _jsonl_path(recording_id: str) -> str:
    return os.path.join(RECORDING_LOG_DIR, f"{recording_id}.jsonl")


def _track_path(recording_id: str) -> str:
    return os.path.join(RECORDING_LOG_DIR, f"{recording_id}_track.json")


def _haversine_m(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    from math import asin, cos, radians, sin, sqrt

    r = 6371000.0
    d_lat = radians(b_lat - a_lat)
    d_lon = radians(b_lon - a_lon)
    lat1 = radians(a_lat)
    lat2 = radians(b_lat)
    h = sin(d_lat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(d_lon / 2) ** 2
    return 2 * r * asin(sqrt(h))


MIN_POINT_DISTANCE_M = 2.0
MIN_LAP_DISTANCE_M = 60.0
LAP_CLOSE_RADIUS_M = 1.0
MAX_TRACK_SPEED_KMH = 85.0
LAP_SPEED_MARGIN = 1.35
MIN_SEGMENT_MS = 800
MAX_SEGMENT_MS = 12000
SEGMENT_SPIKE_RATIO = 2.0


def _gps_speed_kmh(parsed: dict) -> float | None:
    if not isinstance(parsed, dict):
        return None
    for key in ("speed_kmh", "speed"):
        value = parsed.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    return None


def _process_gps_for_lap(
    state: dict, lat: float, lon: float, ts: int, speed_kmh: float | None = None
) -> tuple[dict, dict | None]:
    point: dict = {"lat": lat, "lon": lon, "ts": ts}
    if isinstance(speed_kmh, (int, float)):
        point["speed_kmh"] = float(speed_kmh)
    current = state["currentLap"]
    points = list(current["points"])
    last = points[-1] if points else None
    if last and _haversine_m(last["lat"], last["lon"], lat, lon) < MIN_POINT_DISTANCE_M:
        return state, None

    distance_m = float(current.get("distanceM") or 0)
    if last:
        distance_m += _haversine_m(last["lat"], last["lon"], lat, lon)
    points.append(point)
    all_points = list(state.get("allPoints") or [])
    all_points.append(point)

    start_point = current.get("startPoint")
    started_at = current.get("startedAt")
    lap_number = int(current.get("lapNumber") or 1)

    if (
        start_point
        and len(points) >= 4
        and distance_m >= MIN_LAP_DISTANCE_M
        and _haversine_m(start_point["lat"], start_point["lon"], lat, lon) <= LAP_CLOSE_RADIUS_M
    ):
        duration_ms = ts - int(started_at or ts)
        completed = {
            "lap": lap_number,
            "durationMs": duration_ms,
            "startedAt": started_at,
            "endedAt": ts,
            "points": points,
        }
        laps = list(state.get("laps") or [])
        laps.append(completed)
        next_state = {
            "laps": laps,
            "currentLap": {
                "lapNumber": lap_number + 1,
                "startedAt": ts,
                "points": [point],
                "distanceM": 0.0,
                "startPoint": point,
            },
            "allPoints": all_points,
        }
        return next_state, completed

    if not start_point:
        start_point = point
        started_at = ts

    next_state = {
        "laps": list(state.get("laps") or []),
        "currentLap": {
            "lapNumber": lap_number,
            "startedAt": started_at,
            "points": points,
            "distanceM": distance_m,
            "startPoint": start_point,
        },
        "allPoints": all_points,
    }
    return next_state, None


def _initial_lap_state() -> dict:
    return {
        "laps": [],
        "currentLap": {
            "lapNumber": 1,
            "startedAt": None,
            "points": [],
            "distanceM": 0.0,
            "startPoint": None,
        },
        "allPoints": [],
    }


def _build_track_segments(laps: list, current_lap: dict) -> list[dict]:
    segments = []
    for index, lap in enumerate(laps):
        segments.append({
            "lap": lap.get("lap"),
            "points": lap.get("points") or [],
            "isCurrent": False,
            "colorIndex": index,
        })
    current_points = current_lap.get("points") or []
    if len(current_points) >= 2:
        segments.append({
            "lap": current_lap.get("lapNumber"),
            "points": current_points,
            "isCurrent": True,
            "colorIndex": len(segments),
        })
    return segments


def _extract_gps_points_from_jsonl(recording_id: str) -> list[dict]:
    path = _jsonl_path(recording_id)
    if not os.path.isfile(path):
        return []
    points: list[dict] = []
    with open(path, "r", encoding="utf-8") as fp:
        for line in fp:
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            telemetry = obj.get("telemetry")
            if not isinstance(telemetry, dict):
                continue
            if telemetry.get("type") != "gps" and telemetry.get("topic") != "race/gps":
                continue
            parsed = telemetry.get("parsed")
            if not isinstance(parsed, dict):
                continue
            lat = parsed.get("lat")
            lon = parsed.get("lon")
            if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
                continue
            ts_ms = int(telemetry.get("ts_ms") or 0)
            if ts_ms <= 0:
                continue
            pt = {"lat": float(lat), "lon": float(lon), "ts": ts_ms}
            speed = _gps_speed_kmh(parsed)
            if speed is not None:
                pt["speed_kmh"] = speed
            points.append(pt)
    points.sort(key=lambda item: item["ts"])
    return points


def _rebuild_laps_from_points(raw_points: list[dict]) -> dict:
    state = _initial_lap_state()
    for pt in raw_points:
        state, _ = _process_gps_for_lap(
            state, pt["lat"], pt["lon"], pt["ts"], pt.get("speed_kmh")
        )
    laps = state["laps"]
    return {
        "laps": [
            {
                "lap": lap["lap"],
                "durationMs": lap["durationMs"],
                "startedAt": lap["startedAt"],
                "endedAt": lap["endedAt"],
            }
            for lap in laps
        ],
        "segments": _build_track_segments(laps, state["currentLap"]),
        "allPoints": state.get("allPoints") or [],
    }


def save_recording_track(recording_id: str, payload: TrackSaveRequest) -> dict:
    os.makedirs(RECORDING_LOG_DIR, exist_ok=True)
    path = _track_path(recording_id)
    data = {
        "recordingId": recording_id,
        "savedAt": int(time.time() * 1000),
        "laps": payload.laps,
        "segments": payload.segments,
        "allPoints": payload.allPoints,
    }
    with open(path, "w", encoding="utf-8") as fp:
        json.dump(data, fp, ensure_ascii=False)
    return {"success": True, "track": data}


def ensure_track_file_from_jsonl(recording_id: str) -> bool:
    """track 파일이 없으면 JSONL GPS로 경로/랩을 생성해 저장."""
    if os.path.isfile(_track_path(recording_id)):
        return False
    raw_points = _extract_gps_points_from_jsonl(recording_id)
    if not raw_points:
        return False
    rebuilt = _rebuild_laps_from_points(raw_points)
    save_recording_track(
        recording_id,
        TrackSaveRequest(
            laps=rebuilt["laps"],
            segments=rebuilt["segments"],
            allPoints=rebuilt["allPoints"],
        ),
    )
    return True


def _normalize_track_payload(data: dict) -> dict:
    laps = data.get("laps") or []
    if not laps:
        segments = [seg for seg in (data.get("segments") or []) if not seg.get("isCurrent")]
        data["segments"] = segments
        return data
    completed = []
    for index, lap in enumerate(laps):
        points = lap.get("points")
        if not points:
            for seg in data.get("segments") or []:
                if seg.get("lap") == lap.get("lap") and not seg.get("isCurrent"):
                    points = seg.get("points")
                    break
        completed.append({
            "lap": lap.get("lap"),
            "points": points or [],
            "isCurrent": False,
            "colorIndex": index,
            "manual": bool(lap.get("manual")),
        })
    data["segments"] = completed
    return data


def _attach_speed_to_points(points: list[dict], samples: list[dict], max_delta_ms: int = 5000) -> None:
    if not points or not samples:
        return
    for pt in points:
        if pt.get("speed_kmh") is not None:
            continue
        ts = pt.get("ts")
        if not isinstance(ts, (int, float)):
            continue
        best_speed = None
        best_delta = float("inf")
        for sample in samples:
            sample_speed = sample.get("speed_kmh")
            if sample_speed is None:
                continue
            delta = abs(int(sample["ts"]) - int(ts))
            if delta < best_delta:
                best_delta = delta
                best_speed = sample_speed
        if best_speed is not None and best_delta <= max_delta_ms:
            pt["speed_kmh"] = best_speed


def _enrich_track_with_speed_from_jsonl(data: dict, recording_id: str) -> dict:
    needs_speed = False
    for pt in data.get("allPoints") or []:
        if pt.get("speed_kmh") is None:
            needs_speed = True
            break
    if not needs_speed:
        for seg in data.get("segments") or []:
            for pt in seg.get("points") or []:
                if pt.get("speed_kmh") is None:
                    needs_speed = True
                    break
            if needs_speed:
                break
    if needs_speed:
        samples = _extract_gps_points_from_jsonl(recording_id)
        if samples:
            _attach_speed_to_points(data.get("allPoints") or [], samples)
            for seg in data.get("segments") or []:
                _attach_speed_to_points(seg.get("points") or [], samples)
            for lap in data.get("laps") or []:
                _attach_speed_to_points(lap.get("points") or [], samples)
    return _infer_speed_for_track(data)


def _path_length_m(points: list[dict]) -> float:
    total = 0.0
    for i in range(1, len(points)):
        a, b = points[i - 1], points[i]
        total += _haversine_m(a["lat"], a["lon"], b["lat"], b["lon"])
    return total


def _average_speed_kmh(points: list[dict], duration_ms: int | None) -> float | None:
    if not points or not duration_ms or duration_ms <= 0:
        return None
    dist = _path_length_m(points)
    if dist <= 0:
        return None
    return dist / (duration_ms / 1000) * 3.6


def _sanitize_speed_kmh(speed: float, lap_avg_kmh: float | None) -> float:
    max_allowed = MAX_TRACK_SPEED_KMH
    if lap_avg_kmh is not None and lap_avg_kmh > 0:
        max_allowed = min(MAX_TRACK_SPEED_KMH, lap_avg_kmh * LAP_SPEED_MARGIN)
    if speed > max_allowed:
        return lap_avg_kmh if lap_avg_kmh is not None else max_allowed
    return speed


def _is_plausible_segment_speed(raw: float, lap_avg_kmh: float | None) -> bool:
    if raw < 0:
        return False
    if raw > MAX_TRACK_SPEED_KMH:
        return False
    if lap_avg_kmh is not None and lap_avg_kmh > 0 and raw > lap_avg_kmh * SEGMENT_SPIKE_RATIO:
        return False
    return True


def _segment_speed_kmh(points: list[dict], index: int, lap_avg_kmh: float | None) -> float | None:
    if index <= 0 or index >= len(points):
        return None
    pt = points[index]
    prev = points[index - 1]
    ts = pt.get("ts")
    prev_ts = prev.get("ts")
    if ts is None or prev_ts is None:
        return None
    delta_ms = int(ts) - int(prev_ts)
    if delta_ms < MIN_SEGMENT_MS or delta_ms > MAX_SEGMENT_MS:
        return None
    dist = _haversine_m(prev["lat"], prev["lon"], pt["lat"], pt["lon"])
    raw = dist * 3600 / delta_ms
    if not _is_plausible_segment_speed(raw, lap_avg_kmh):
        return None
    return float(raw)


def _interpolate_speed_gaps(points: list[dict], speeds: list[float | None]) -> None:
    n = len(speeds)
    i = 0
    while i < n:
        if speeds[i] is not None:
            i += 1
            continue
        gap_start = i
        while i < n and speeds[i] is None:
            i += 1
        gap_end = i
        left_idx = gap_start - 1
        right_idx = gap_end
        left_speed = speeds[left_idx] if left_idx >= 0 else None
        right_speed = speeds[right_idx] if right_idx < n else None
        left_ts = points[left_idx].get("ts") if left_idx >= 0 else None
        right_ts = points[right_idx].get("ts") if right_idx < n else None
        for j in range(gap_start, gap_end):
            ts = points[j].get("ts")
            if (
                left_speed is not None
                and right_speed is not None
                and left_ts is not None
                and right_ts is not None
                and int(right_ts) > int(left_ts)
                and ts is not None
            ):
                ratio = (int(ts) - int(left_ts)) / (int(right_ts) - int(left_ts))
                speeds[j] = left_speed + (right_speed - left_speed) * ratio
            elif left_speed is not None:
                speeds[j] = left_speed
            elif right_speed is not None:
                speeds[j] = right_speed


def _enrich_points_with_speed(points: list[dict], duration_ms: int | None = None) -> None:
    if not points:
        return
    lap_avg = _average_speed_kmh(points, duration_ms)
    n = len(points)
    speeds: list[float | None] = [None] * n
    from_stored = [False] * n

    for i, pt in enumerate(points):
        speed = pt.get("speed_kmh")
        if not isinstance(speed, (int, float)):
            continue
        sanitized = _sanitize_speed_kmh(float(speed), lap_avg)
        speeds[i] = sanitized
        from_stored[i] = not pt.get("speed_estimated") and abs(sanitized - float(speed)) < 0.05

    for i in range(1, n):
        if speeds[i] is not None:
            continue
        incoming = _segment_speed_kmh(points, i, lap_avg)
        outgoing = _segment_speed_kmh(points, i + 1, lap_avg) if i < n - 1 else None
        if incoming is not None and outgoing is not None:
            speeds[i] = (incoming + outgoing) / 2
        elif incoming is not None:
            speeds[i] = incoming
        elif outgoing is not None:
            speeds[i] = outgoing

    _interpolate_speed_gaps(points, speeds)

    for i in range(n):
        if speeds[i] is None and lap_avg is not None:
            speeds[i] = lap_avg

    for i, pt in enumerate(points):
        speed = speeds[i]
        if speed is None:
            continue
        rounded = round(float(speed), 1)
        estimated = not from_stored[i]
        if from_stored[i] and pt.get("speed_kmh") == rounded:
            continue
        pt["speed_kmh"] = rounded
        if estimated:
            pt["speed_estimated"] = True


def _infer_speed_from_timestamps(points: list[dict], duration_ms: int | None = None) -> None:
    _enrich_points_with_speed(points, duration_ms)


def _sanitize_track_speeds(data: dict) -> dict:
    return data


def _infer_speed_for_track(data: dict) -> dict:
    laps_by_num = {lap.get("lap"): lap for lap in data.get("laps") or []}
    for seg in data.get("segments") or []:
        lap = laps_by_num.get(seg.get("lap"))
        duration = int(lap["durationMs"]) if lap and lap.get("durationMs") else None
        _infer_speed_from_timestamps(seg.get("points") or [], duration)
    for lap in data.get("laps") or []:
        duration = int(lap["durationMs"]) if lap.get("durationMs") else None
        _infer_speed_from_timestamps(lap.get("points") or [], duration)
    all_pts = data.get("allPoints") or []
    total_dur = sum(int(l.get("durationMs") or 0) for l in data.get("laps") or [])
    if total_dur <= 0 and len(all_pts) >= 2:
        total_dur = max(0, int(all_pts[-1]["ts"]) - int(all_pts[0]["ts"]))
    _infer_speed_from_timestamps(all_pts, total_dur or None)
    return _sanitize_track_speeds(data)


def get_recording_track(recording_id: str) -> dict:
    path = _track_path(recording_id)
    if not os.path.isfile(path):
        ensure_track_file_from_jsonl(recording_id)
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as fp:
            data = json.load(fp)
        data = _normalize_track_payload(data)
        data = _enrich_track_with_speed_from_jsonl(data, recording_id)
        return {"success": True, "source": "track_file", **data}

    raw_points = _extract_gps_points_from_jsonl(recording_id)
    if not raw_points:
        return {"success": True, "source": "empty", "laps": [], "segments": [], "allPoints": []}

    rebuilt = _rebuild_laps_from_points(raw_points)
    rebuilt = _infer_speed_for_track(rebuilt)
    return {"success": True, "source": "jsonl_gps", **rebuilt}


def query_analysis_from_jsonl(
    recording_id: str,
    fields: List[str],
    started_at: int | None,
    ended_at: int | None,
    limit: int,
) -> List[Dict[str, Any]] | None:
    path = _jsonl_path(recording_id)
    if not os.path.isfile(path):
        return None

    wanted: Dict[str, str] = {}
    for field in fields:
        if field == "meta.recordingElapsedSeconds":
            continue
        for value_key in _analysis_value_keys(field):
            wanted[value_key] = field

    elapsed_key = "meta.recordingElapsedSeconds"
    need_elapsed = elapsed_key in fields
    if not wanted and not need_elapsed:
        return []

    point_limit = max(100, min(int(limit or DEFAULT_ANALYSIS_LIMIT), 5000))
    if started_at and ended_at and ended_at > started_at:
        total_ms = int(ended_at - started_at)
    else:
        total_ms = None
    bucket_ms = max(20, (total_ms or 600_000) // point_limit)

    buckets: Dict[int, Dict[str, Any]] = {}
    with open(path, "r", encoding="utf-8") as fp:
        for line in fp:
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            telemetry = obj.get("telemetry")
            if not isinstance(telemetry, dict):
                continue
            ts_ms = int(telemetry.get("ts_ms") or 0)
            if ts_ms <= 0:
                continue
            if started_at and ts_ms < int(started_at):
                continue
            if ended_at and ts_ms > int(ended_at):
                continue

            extracted = _extract_telemetry_values(telemetry)
            if wanted and not any(key in extracted for key in wanted):
                if not need_elapsed:
                    continue

            bucket = ts_ms // bucket_ms
            row = buckets.get(bucket)
            if row is None:
                row = {
                    "time": datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc).isoformat(),
                }
                buckets[bucket] = row
            if need_elapsed and started_at:
                row[elapsed_key] = max(0.0, (ts_ms - int(started_at)) / 1000.0)
            for value_key, field_key in wanted.items():
                if value_key in extracted:
                    row[field_key] = extracted[value_key]

    series = [buckets[key] for key in sorted(buckets.keys())]
    if len(series) > point_limit:
        step = (len(series) - 1) / max(1, point_limit - 1)
        series = [series[int(round(i * step))] for i in range(point_limit)]
    return series


def _safe_recording_id(name: str) -> str:
    return f"{int(time.time() * 1000)}_{name.strip().lower().replace(' ', '-')}"


def _start_recording_writer() -> None:
    global _recording_writer_started
    if _recording_writer_started:
        return
    _recording_writer_started = True
    os.makedirs(RECORDING_LOG_DIR, exist_ok=True)

    def _writer_loop() -> None:
        pending_points = []
        pending_json_lines: list[tuple[str, str]] = []
        jsonl_handles: Dict[str, Any] = {}
        last_flush = time.monotonic()

        def flush() -> None:
            nonlocal pending_points, pending_json_lines, last_flush
            if pending_points and write_api:
                try:
                    write_api.write(bucket=INFLUXDB_BUCKET, org=INFLUXDB_ORG, record=pending_points)
                except Exception as e:
                    print(f"recording write 오류: {e}")
                pending_points = []
            if pending_json_lines:
                grouped: Dict[str, list[str]] = {}
                for path, line in pending_json_lines:
                    grouped.setdefault(path, []).append(line)
                for path, lines in grouped.items():
                    try:
                        handle = jsonl_handles.get(path)
                        if handle is None:
                            handle = open(path, "a", encoding="utf-8")
                            jsonl_handles[path] = handle
                        handle.writelines(lines)
                    except Exception as e:
                        print(f"recording jsonl 오류: {e}")
                pending_json_lines = []
            last_flush = time.monotonic()

        while True:
            try:
                telemetry, session, processed = _recording_queue.get(timeout=0.2)
            except queue.Empty:
                if pending_points or pending_json_lines:
                    flush()
                continue
            try:
                pending_points.extend(_telemetry_to_recording_points(telemetry, session))
                path = _jsonl_path(session["recording_id"])
                pending_json_lines.append((
                    path,
                    json.dumps(
                        {
                            "recording_id": session["recording_id"],
                            "telemetry": processed,
                        },
                        ensure_ascii=False,
                        default=str,
                        separators=(",", ":"),
                    )
                    + "\n",
                ))
                if (
                    len(pending_points) >= RECORDING_BATCH_SIZE
                    or time.monotonic() - last_flush >= 1.0
                ):
                    flush()
            finally:
                _recording_queue.task_done()

    thread = threading.Thread(target=_writer_loop, name="recording-writer", daemon=True)
    thread.start()


def _telemetry_to_recording_points(telemetry: NormalizedTelemetry, session: Dict[str, Any]) -> list[Point]:
    field_units = session["field_units"]
    started_at = int(session.get("startedAt") or telemetry.ts_ms)
    elapsed = max(0.0, (telemetry.ts_ms - started_at) / 1000.0)
    timestamp = datetime.fromtimestamp(telemetry.ts_ms / 1000.0, tz=timezone.utc)
    scalars = _scalar_values(telemetry.values)
    points: list[Point] = []
    meta_key = "meta.recordingElapsedSeconds"
    field_units[meta_key] = "s"
    points.append(
        Point("recording_value")
        .tag("recording_id", session["recording_id"])
        .tag("field_key", meta_key)
        .tag("unit", "s")
        .tag("topic", telemetry.topic)
        .tag("source", telemetry.source or "")
        .tag("key", telemetry.key or "")
        .field("value", elapsed)
        .time(timestamp)
    )
    for key, value in scalars.items():
        field_key = f"extra.{key}"
        unit = telemetry.units.get(key) or telemetry.unit or ""
        field_units[field_key] = unit
        points.append(
            Point("recording_value")
            .tag("recording_id", session["recording_id"])
            .tag("field_key", field_key)
            .tag("unit", unit)
            .tag("topic", telemetry.topic)
            .tag("source", telemetry.source or "")
            .tag("key", telemetry.key or "")
            .field("value", value)
            .time(timestamp)
        )
    return points


def record_telemetry_if_active(telemetry: NormalizedTelemetry, processed: dict | None = None) -> None:
    global _recording_dropped
    session = _recording_session_ref
    if session is None:
        return
    _start_recording_writer()
    payload = telemetry.to_storage_payload(processed)
    try:
        _recording_queue.put_nowait((telemetry, session, payload))
    except queue.Full:
        _recording_dropped += 1
        if _recording_dropped % 50 == 0:
            print(f"🚨 recording 큐 가득참 — drop 누적 {_recording_dropped}건")


def drain_recording_queue(timeout: float = 10.0) -> int:
    start = time.monotonic()
    initial = _recording_queue.qsize()
    while not _recording_queue.empty() and time.monotonic() - start < timeout:
        time.sleep(0.05)
    if write_api:
        try:
            write_api.flush()
        except Exception:
            pass
    return initial - _recording_queue.qsize()


def get_recording_queue_stats() -> Dict[str, Any]:
    with _recording_lock:
        active = ACTIVE_RECORDING.get("recording_id") if ACTIVE_RECORDING else None
    return {
        "active_recording_id": active,
        "size": _recording_queue.qsize(),
        "maxsize": RECORDING_QUEUE_MAXSIZE,
        "dropped": _recording_dropped,
    }


def build_recording_field_units(snapshots: List[Dict[str, Any]]) -> Dict[str, str]:
    field_units: Dict[str, str] = {
        "meta.recordingElapsedSeconds": "s",
        "meta.timerElapsedSeconds": "s",
    }
    for snapshot in snapshots:
        update_field_units_from_snapshot(field_units, snapshot)
    return field_units


def update_field_units_from_snapshot(field_units: Dict[str, str], snapshot: Dict[str, Any]) -> None:
    for extra in snapshot.get("extra", []):
        name = extra.get("name")
        if name:
            field_units[f"extra.{name}"] = extra.get("unit") or ""
    for panel in snapshot.get("leftPanel", []):
        name = panel.get("name")
        if name:
            field_units[f"left.{name}"] = panel.get("unit") or ""
    for panel in snapshot.get("rightPanel", []):
        name = panel.get("name")
        if name:
            field_units[f"right.{name}"] = panel.get("unit") or ""


def write_recording_influx(payload: RecordingRequest, recording_id: str, field_units: Dict[str, str]) -> None:
    if not write_api:
        return
    points = []
    chunk_size = 5000
    field_keys = list(field_units.keys())

    def flush():
        nonlocal points
        if points:
            write_api.write(bucket=INFLUXDB_BUCKET, org=INFLUXDB_ORG, record=points)
            points = []

    for snapshot in payload.snapshots:
        ts = snapshot.get("timestamp")
        if not ts:
            continue
        timestamp = datetime.utcfromtimestamp(ts / 1000.0)
        snapshot_values: Dict[str, Any] = {
            "meta.recordingElapsedSeconds": (snapshot.get("recordingElapsedMs") or 0) / 1000.0,
            "meta.timerElapsedSeconds": (snapshot.get("elapsedMs") or 0) / 1000.0,
        }
        for extra in snapshot.get("extra", []):
            name = extra.get("name")
            if name:
                snapshot_values[f"extra.{name}"] = extra.get("value")
        for panel in snapshot.get("leftPanel", []):
            name = panel.get("name")
            if name:
                snapshot_values[f"left.{name}"] = panel.get("value")
        for panel in snapshot.get("rightPanel", []):
            name = panel.get("name")
            if name:
                snapshot_values[f"right.{name}"] = panel.get("value")

        def add_point(field_key: str, value: Any):
            if isinstance(value, bool) or value is None:
                return
            if isinstance(value, (int, float)):
                numeric = float(value)
            else:
                try:
                    numeric = float(value)
                except (TypeError, ValueError):
                    numeric = 0.0
            point = (
                Point("recording_value")
                .tag("recording_id", recording_id)
                .tag("field_key", field_key)
                .tag("unit", field_units.get(field_key, ""))
                .field("value", numeric)
                .time(timestamp)
            )
            points.append(point)
            if len(points) >= chunk_size:
                flush()

        for field_key in field_keys:
            add_point(field_key, snapshot_values.get(field_key, 0))

    flush()


def write_recording_snapshot_influx(snapshot: Dict[str, Any], recording_id: str, field_units: Dict[str, str]) -> None:
    if not write_api:
        return
    ts = snapshot.get("timestamp")
    if not ts:
        return
    timestamp = datetime.utcfromtimestamp(ts / 1000.0)
    snapshot_values: Dict[str, Any] = {
        "meta.recordingElapsedSeconds": (snapshot.get("recordingElapsedMs") or 0) / 1000.0,
        "meta.timerElapsedSeconds": (snapshot.get("elapsedMs") or 0) / 1000.0,
    }
    for extra in snapshot.get("extra", []):
        name = extra.get("name")
        if name:
            snapshot_values[f"extra.{name}"] = extra.get("value")
    for panel in snapshot.get("leftPanel", []):
        name = panel.get("name")
        if name:
            snapshot_values[f"left.{name}"] = panel.get("value")
    for panel in snapshot.get("rightPanel", []):
        name = panel.get("name")
        if name:
            snapshot_values[f"right.{name}"] = panel.get("value")

    points = []

    def add_point(field_key: str, value: Any):
        if isinstance(value, bool) or value is None:
            return
        if isinstance(value, (int, float)):
            numeric = float(value)
        else:
            try:
                numeric = float(value)
            except (TypeError, ValueError):
                return
        point = (
            Point("recording_value")
            .tag("recording_id", recording_id)
            .tag("field_key", field_key)
            .tag("unit", field_units.get(field_key, ""))
            .field("value", numeric)
            .time(timestamp)
        )
        points.append(point)

    for field_key, value in snapshot_values.items():
        add_point(field_key, value)

    if points:
        write_api.write(bucket=INFLUXDB_BUCKET, org=INFLUXDB_ORG, record=points)


def write_recording_meta_influx(recording_id: str, payload: RecordingRequest, field_units: Dict[str, str]) -> Dict[str, Any]:
    if not write_api:
        raise HTTPException(status_code=503, detail="InfluxDB 연결되지 않음")
    created_at = int(time.time() * 1000)
    record_format = payload.format or "influx"
    meta = {
        "id": recording_id,
        "name": payload.name,
        "format": record_format,
        "createdAt": created_at,
        "startedAt": payload.startedAt,
        "endedAt": payload.endedAt,
        "fieldUnits": field_units,
    }
    point = (
        Point("recording_meta")
        .tag("recording_id", recording_id)
        .field("name", payload.name)
        .field("format", record_format)
        .field("createdAt", created_at)
        .field("startedAt", payload.startedAt or 0)
        .field("endedAt", payload.endedAt or 0)
        .field("fieldUnits", json.dumps(field_units, ensure_ascii=False))
        .time(datetime.utcnow())
    )
    write_api.write(bucket=INFLUXDB_BUCKET, org=INFLUXDB_ORG, record=point)
    return meta


def load_recording_meta_influx(recording_id: str) -> Dict[str, Any]:
    cached = _recording_meta_cache.get(recording_id)
    if cached and time.monotonic() - cached[0] < _META_CACHE_TTL_SEC:
        return cached[1]
    if not query_api:
        raise HTTPException(status_code=503, detail="InfluxDB 연결되지 않음")
    query = f'''
    from(bucket: "{INFLUXDB_BUCKET}")
      |> range(start: 0)
      |> filter(fn: (r) => r["_measurement"] == "recording_meta")
      |> filter(fn: (r) => r["recording_id"] == "{recording_id}")
      |> pivot(rowKey: ["recording_id"], columnKey: ["_field"], valueColumn: "_value")
      |> limit(n: 1)
    '''
    try:
        result = query_api.query(org=INFLUXDB_ORG, query=query)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"analysis query 실패: {e}") from e
    for table in result:
        for record in table.records:
            values = record.values
            field_units_raw = values.get("fieldUnits") or "{}"
            try:
                field_units = json.loads(field_units_raw)
            except Exception:
                field_units = {}
            meta = {
                "id": recording_id,
                "name": values.get("name", ""),
                "format": values.get("format", "influx"),
                "createdAt": int(values.get("createdAt") or 0),
                "startedAt": int(values.get("startedAt") or 0) or None,
                "endedAt": int(values.get("endedAt") or 0) or None,
                "fieldUnits": field_units,
            }
            _recording_meta_cache[recording_id] = (time.monotonic(), meta)
            return meta
    raise HTTPException(status_code=404, detail="기록을 찾을 수 없습니다.")


def list_recordings_influx() -> List[Dict[str, Any]]:
    if not query_api:
        raise HTTPException(status_code=503, detail="InfluxDB 연결되지 않음")
    query = f'''
    from(bucket: "{INFLUXDB_BUCKET}")
      |> range(start: 0)
      |> filter(fn: (r) => r["_measurement"] == "recording_meta")
      |> pivot(rowKey: ["recording_id"], columnKey: ["_field"], valueColumn: "_value")
    '''
    result = query_api.query(org=INFLUXDB_ORG, query=query)
    records = []
    for table in result:
        for record in table.records:
            values = record.values
            recording_id = values.get("recording_id")
            if not recording_id:
                continue
            field_units_raw = values.get("fieldUnits") or "{}"
            try:
                field_units = json.loads(field_units_raw)
            except Exception:
                field_units = {}
            records.append({
                "id": recording_id,
                "name": values.get("name", ""),
                "format": values.get("format", "influx"),
                "createdAt": int(values.get("createdAt") or 0),
                "startedAt": int(values.get("startedAt") or 0) or None,
                "endedAt": int(values.get("endedAt") or 0) or None,
                "fieldUnits": field_units,
            })
    records.sort(key=lambda r: r.get("createdAt", 0), reverse=True)
    return records


def save_recording(payload: RecordingRequest):
    if not write_api:
        raise HTTPException(status_code=503, detail="InfluxDB 연결되지 않음")
    recording_id = f"{int(time.time() * 1000)}_{payload.name.strip().lower().replace(' ', '-')}"
    field_units = build_recording_field_units(payload.snapshots)
    write_recording_influx(payload, recording_id, field_units)
    meta = write_recording_meta_influx(recording_id, payload, field_units)
    return {"success": True, "recording": meta}


def start_stream_recording(payload: StreamStartRequest):
    global ACTIVE_RECORDING, _recording_session_ref
    if not write_api:
        raise HTTPException(status_code=503, detail="InfluxDB 연결되지 않음")
    _start_recording_writer()
    recording_id = _safe_recording_id(payload.name)
    field_units = {
        "meta.recordingElapsedSeconds": "s",
    }
    session = {
        "recording_id": recording_id,
        "name": payload.name,
        "startedAt": payload.startedAt,
        "field_units": field_units,
    }
    STREAM_SESSIONS[recording_id] = session
    with _recording_lock:
        ACTIVE_RECORDING = session
        _recording_session_ref = session
    return {"success": True, "recordingId": recording_id}


def append_stream_recording(payload: StreamAppendRequest):
    if not write_api:
        raise HTTPException(status_code=503, detail="InfluxDB 연결되지 않음")
    session = STREAM_SESSIONS.get(payload.recordingId)
    if not session:
        raise HTTPException(status_code=404, detail="스트림 기록을 찾을 수 없습니다.")
    field_units = session["field_units"]
    for snapshot in payload.snapshots:
        update_field_units_from_snapshot(field_units, snapshot)
        write_recording_snapshot_influx(snapshot, payload.recordingId, field_units)
    return {"success": True}


def stop_stream_recording(payload: StreamStopRequest):
    global ACTIVE_RECORDING, _recording_session_ref
    if not write_api:
        raise HTTPException(status_code=503, detail="InfluxDB 연결되지 않음")
    with _recording_lock:
        if ACTIVE_RECORDING and ACTIVE_RECORDING.get("recording_id") == payload.recordingId:
            ACTIVE_RECORDING = None
            _recording_session_ref = None
    session = STREAM_SESSIONS.pop(payload.recordingId, None)
    if not session:
        raise HTTPException(status_code=404, detail="스트림 기록을 찾을 수 없습니다.")
    drain_recording_queue(timeout=10.0)
    record_payload = RecordingRequest(
        name=session["name"],
        format="telemetry",
        startedAt=session.get("startedAt"),
        endedAt=payload.endedAt,
        snapshots=[],
    )
    meta = write_recording_meta_influx(
        payload.recordingId,
        record_payload,
        session["field_units"],
    )
    try:
        write_api.flush()
    except Exception:
        pass
    ensure_track_file_from_jsonl(payload.recordingId)
    return {"success": True, "recording": meta}


def list_recordings():
    records = list_recordings_influx()
    return {"success": True, "records": records}


def get_recording(recording_id: str):
    meta = load_recording_meta_influx(recording_id)
    return {"success": True, "recording": meta}


def get_analysis_fields(recordingId: str):
    meta = load_recording_meta_influx(recordingId)
    field_units = meta.get("fieldUnits", {})
    if not field_units:
        return {"success": True, "fields": []}
    payload = [{"key": key, "unit": field_units.get(key, "")} for key in sorted(field_units.keys())]
    return {"success": True, "fields": payload}


def query_analysis_data(request: AnalysisQueryRequest):
    if not request.fields:
        raise HTTPException(status_code=400, detail="fields가 비어있습니다.")
    meta = load_recording_meta_influx(request.recordingId)
    field_units = meta.get("fieldUnits", {})
    units = {key: field_units.get(key, "") for key in request.fields}
    query_fields = list(dict.fromkeys(request.fields + ["meta.recordingElapsedSeconds"]))
    point_limit = max(100, min(int(request.limit or DEFAULT_ANALYSIS_LIMIT), 5000))
    started_at = meta.get("startedAt")
    ended_at = meta.get("endedAt")

    jsonl_series = query_analysis_from_jsonl(
        request.recordingId,
        query_fields,
        started_at,
        ended_at,
        point_limit,
    )
    if jsonl_series is not None:
        return {"success": True, "series": jsonl_series, "units": units}

    if not query_api:
        raise HTTPException(status_code=503, detail="InfluxDB 연결되지 않음")
    field_keys = ','.join([f'"{key}"' for key in query_fields])
    every_window = None
    if started_at and ended_at and point_limit:
        total_ms = max(0, int(ended_at) - int(started_at))
        if total_ms > 0:
            every_ms = max(20, int(total_ms / max(1, point_limit)))
            every_window = f"{every_ms}ms"
    range_line = '|> range(start: 0)'
    if started_at and ended_at:
        start_iso = datetime.fromtimestamp(started_at / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")
        end_iso = datetime.fromtimestamp(ended_at / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")
        range_line = f'|> range(start: time(v: "{start_iso}"), stop: time(v: "{end_iso}"))'
    aggregate_line = ""
    limit_line = f'|> limit(n: {point_limit})'
    if every_window:
        aggregate_line = (
            f'|> group(columns: ["field_key"])\n'
            f'      |> aggregateWindow(every: {every_window}, fn: last, createEmpty: false)\n'
            f'      |> group()'
        )
    query = f'''
    from(bucket: "{INFLUXDB_BUCKET}")
      {range_line}
      |> filter(fn: (r) => r["_measurement"] == "recording_value")
      |> filter(fn: (r) => r["recording_id"] == "{request.recordingId}")
      |> filter(fn: (r) => contains(value: r["field_key"], set: [{field_keys}]))
      {aggregate_line}
      |> pivot(rowKey: ["_time"], columnKey: ["field_key"], valueColumn: "_value")
      |> sort(columns: ["_time"])
      {limit_line}
    '''
    try:
        result = query_api.query(org=INFLUXDB_ORG, query=query)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"analysis query 실패: {e}") from e
    rows_by_time: Dict[str, Dict[str, Any]] = {}
    elapsed_key = "meta.recordingElapsedSeconds"
    for table in result:
        for record in table.records:
            time_value = record.get_time().isoformat()
            row = rows_by_time.get(time_value)
            if row is None:
                row = {"time": time_value}
                rows_by_time[time_value] = row
            values = record.values
            for field_key in query_fields:
                if field_key in values and values[field_key] is not None:
                    row[field_key] = values[field_key]
    series = [rows_by_time[key] for key in sorted(rows_by_time.keys())]
    if elapsed_key not in request.fields:
        for row in series:
            if elapsed_key not in row:
                row[elapsed_key] = None
    return {"success": True, "series": series, "units": units}


def delete_recording(recording_id: str):
    global ACTIVE_RECORDING, _recording_session_ref
    if not recording_id or not recording_id.strip():
        raise HTTPException(status_code=400, detail="recording_id가 필요합니다.")

    with _recording_lock:
        if ACTIVE_RECORDING and ACTIVE_RECORDING.get("recording_id") == recording_id:
            raise HTTPException(status_code=409, detail="기록 중인 데이터는 삭제할 수 없습니다.")

    deleted_influx = False
    deleted_jsonl = False

    if influx_client:
        delete_api = influx_client.delete_api()
        start = datetime(1970, 1, 1, tzinfo=timezone.utc)
        stop = datetime.now(timezone.utc)
        predicate = f'recording_id="{recording_id}"'
        try:
            delete_api.delete(start, stop, predicate, bucket=INFLUXDB_BUCKET, org=INFLUXDB_ORG)
            deleted_influx = True
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Influx 삭제 실패: {e}") from e

    jsonl_path = _jsonl_path(recording_id)
    track_path = _track_path(recording_id)
    if os.path.isfile(jsonl_path):
        try:
            os.remove(jsonl_path)
            deleted_jsonl = True
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"JSONL 삭제 실패: {e}") from e

    if os.path.isfile(track_path):
        try:
            os.remove(track_path)
        except OSError:
            pass

    STREAM_SESSIONS.pop(recording_id, None)
    _recording_meta_cache.pop(recording_id, None)

    if not deleted_influx and not deleted_jsonl:
        raise HTTPException(status_code=404, detail="삭제할 기록을 찾을 수 없습니다.")

    return {
        "success": True,
        "deletedId": recording_id,
        "deletedInflux": deleted_influx,
        "deletedJsonl": deleted_jsonl,
    }
