from influxdb_client import InfluxDBClient, Point
from influxdb_client.client.write_api import WriteOptions
import queue
import threading
import time as _time

from config import INFLUXDB_URL, INFLUXDB_TOKEN, INFLUXDB_ORG, INFLUXDB_BUCKET

influx_client = None
write_api = None
query_api = None

# raw MQTT → InfluxDB 저장 큐.
# 50,000 항목 ≈ 50Hz × 6 토픽 기준 약 2분 30초 분량 버퍼. InfluxDB 가 일시적
# 느려져도 이 시간 안에 회복되면 데이터 소실 0.
INFLUX_QUEUE_MAXSIZE = 50000

_write_queue: "queue.Queue[tuple[str, dict]]" = queue.Queue(maxsize=INFLUX_QUEUE_MAXSIZE)
_writer_thread_started = False

# 모니터링용 카운터/워터마크 (drop 발생 시 즉시 감지하기 위함).
_dropped_count = 0
_dropped_last_logged = 0
_high_watermark_logged = 0  # 마지막으로 경고를 출력한 점유율 구간 (10000 단위)

try:
    influx_client = InfluxDBClient(
        url=INFLUXDB_URL,
        token=INFLUXDB_TOKEN,
        org=INFLUXDB_ORG,
        timeout=120000,
    )
    write_api = influx_client.write_api(
        write_options=WriteOptions(
            batch_size=1000,
            flush_interval=1000,
            jitter_interval=200,
            retry_interval=5000,
        )
    )
    query_api = influx_client.query_api()
    print(f"InfluxDB 연결 성공: {INFLUXDB_URL}")
except Exception as e:
    print(f"InfluxDB 연결 실패: {e} (선택적 서비스 - 계속 진행)")
    influx_client = None
    write_api = None
    query_api = None


def _build_point(topic: str, data: dict) -> Point:
    parts = topic.split("/")
    measurement = parts[1] if len(parts) > 1 else "mqtt"
    point = Point(measurement)
    point = point.tag("topic", topic)
    for i, part in enumerate(parts):
        point = point.tag(f"topic_part_{i}", part)
    if isinstance(data, dict):
        skip_keys = {
            "timestamp",
            "datetime",
            "raw",
            "raw_bytes",
            "raw_hex",
            "sensor_info",
            "parsed",
        }
        for key, value in data.items():
            if key in skip_keys:
                continue
            if isinstance(value, (int, float)):
                point = point.field(key, float(value))
            elif isinstance(value, bool):
                point = point.field(key, value)
            else:
                point = point.field(key, str(value))
    else:
        point = point.field("value", str(data))
    return point


def _start_writer_thread() -> None:
    global _writer_thread_started
    if _writer_thread_started:
        return
    _writer_thread_started = True

    def _writer_loop() -> None:
        while True:
            topic, data = _write_queue.get()
            if not write_api:
                _write_queue.task_done()
                continue
            try:
                point = _build_point(topic, data)
                write_api.write(bucket=INFLUXDB_BUCKET, org=INFLUXDB_ORG, record=point)
            except Exception as e:
                print(f"InfluxDB 저장 오류: {e}")
            finally:
                _write_queue.task_done()

    thread = threading.Thread(target=_writer_loop, name="influx-writer", daemon=True)
    thread.start()


def save_mqtt_to_influxdb(topic: str, data: dict) -> None:
    global _dropped_count, _dropped_last_logged, _high_watermark_logged
    if not write_api:
        return
    _start_writer_thread()
    try:
        _write_queue.put_nowait((topic, data))
    except queue.Full:
        # 큐가 꽉 찬 경우(InfluxDB 가 오래 멈춤)는 드롭. 절대 일어나면 안 되는
        # 상황이므로 즉시 로그로 감지 가능하게 한다.
        _dropped_count += 1
        if _dropped_count - _dropped_last_logged >= 50:
            _dropped_last_logged = _dropped_count
            print(
                f"🚨 InfluxDB 큐 가득참 — drop 누적 {_dropped_count}건 "
                f"(maxsize={INFLUX_QUEUE_MAXSIZE}). InfluxDB 응답 지연 의심."
            )
        return

    # 큐 점유율 워터마크 — 10,000 단위 구간을 새로 넘어설 때마다 1회 경고
    qsize = _write_queue.qsize()
    level = qsize // 10000
    if level > _high_watermark_logged:
        _high_watermark_logged = level
        print(f"⚠️ InfluxDB 큐 점유율 ≈ {qsize}/{INFLUX_QUEUE_MAXSIZE}")
    elif level + 1 < _high_watermark_logged:
        # 다시 안정화되면 워터마크 리셋해서 추후 경고 가능하게.
        _high_watermark_logged = level


def get_influx_stats() -> dict:
    return {
        "size": _write_queue.qsize(),
        "maxsize": INFLUX_QUEUE_MAXSIZE,
        "dropped": _dropped_count,
    }


def drain_influx_queue(timeout: float = 10.0) -> int:
    """
    종료 직전 큐가 비워질 때까지 최대 timeout 초 대기 후 write_api flush.
    잔여로 인한 데이터 소실 방지.
    """
    start = _time.monotonic()
    initial = _write_queue.qsize()
    while not _write_queue.empty() and (_time.monotonic() - start) < timeout:
        _time.sleep(0.05)
    if write_api:
        try:
            write_api.flush()
        except Exception as e:
            print(f"InfluxDB flush 오류: {e}")
    drained = initial - _write_queue.qsize()
    print(f"InfluxDB 큐 drain 완료 — {drained}/{initial} 처리, 잔여 {_write_queue.qsize()}")
    return drained


def close_influx() -> None:
    if influx_client:
        influx_client.close()
