import json
import time
import paho.mqtt.client as mqtt

from config import MOSQUITTO_HOST, MOSQUITTO_PORTS, MQTT_TOPICS
from ws import ordered_dispatcher
from recordings import record_telemetry_if_active
from telemetry import NormalizedTelemetry, now_ms, sanitize_latest_payload

mqtt_clients: list[mqtt.Client] = []
main_event_loop = None
LATEST_SENSOR_DATA: dict = {}
LAST_SEQ_BY_TOPIC: dict[str, int] = {}
LAST_TS_MS_BY_TOPIC: dict[str, int] = {}


def _is_stale_telemetry(topic: str, seq: int | None, ts_ms: int) -> bool:
    if seq is None:
        return False
    last_seq = LAST_SEQ_BY_TOPIC.get(topic)
    if last_seq is None:
        return False
    last_ts = LAST_TS_MS_BY_TOPIC.get(topic)
    newer_ts = last_ts is None or ts_ms > last_ts
    newer_seq = seq > last_seq
    if newer_ts or newer_seq:
        return False
    return seq <= last_seq


FIELD_META = {
    "speed": ("속도", "speed", "left", "km/h"),
    "speed_kmh": ("속도", "speed", "left", "km/h"),
    "rpm": ("RPM", "rpm", "left", "rpm"),
    "motor_speed": ("RPM", "rpm", "left", "rpm"),
    "gear": ("기어", "gear", "left", ""),
    "throttle": ("스로틀", "throttle", "left", "%"),
    "brake": ("브레이크", "brake", "left", "%"),
    "steering": ("조향각", "angle", "left", "°"),
    "angle": ("조향각", "angle", "left", "°"),
    "torque": ("토크", "torque", "left", "Nm"),
    "battery": ("배터리", "battery", "right", "%"),
    "soc": ("배터리", "battery", "right", "%"),
    "voltage": ("전압", "voltage", "right", "V"),
    "current": ("전류", "current", "right", "A"),
    "temperature": ("냉각수", "temperature", "right", "°C"),
    "pressure": ("압력", "pressure", "right", "bar"),
    "linear_fl": ("리니어 FL", "suspension", "right", "mm"),
    "linear_fr": ("리니어 FR", "suspension", "right", "mm"),
    "linear_rl": ("리니어 RL", "suspension", "right", "mm"),
    "linear_rr": ("리니어 RR", "suspension", "right", "mm"),
    "g_force_l": ("G-FORCE L", "gforce_l", "right", "G"),
    "g_force_r": ("G-FORCE R", "gforce_r", "right", "G"),
    "yaw_l": ("G-FORCE L", "gforce_l", "right", "G"),
    "yaw_r": ("G-FORCE R", "gforce_r", "right", "G"),
    "acc_x": ("가속도", "acceleration", "right", "g"),
    "acc_y": ("가속도", "acceleration", "right", "g"),
    "acc_z": ("가속도", "acceleration", "right", "g"),
    "imu_acc_x": ("IMU 가속도", "imu_acceleration", "right", "g"),
    "imu_acc_y": ("IMU 가속도", "imu_acceleration", "right", "g"),
    "imu_acc_z": ("IMU 가속도", "imu_acceleration", "right", "g"),
    "imu_pitch": ("IMU 자세", "imu_orientation", "right", "°"),
    "imu_roll": ("IMU 자세", "imu_orientation", "right", "°"),
    "imu_yaw": ("IMU 자세", "imu_orientation", "right", "°"),
    "pitch": ("IMU 자세", "imu_orientation", "right", "°"),
    "roll": ("IMU 자세", "imu_orientation", "right", "°"),
    "yaw": ("IMU 자세", "imu_orientation", "right", "°"),
    "gps_lat": ("GPS", "gps", "other", ""),
    "gps_lon": ("GPS", "gps", "other", ""),
    "lat": ("GPS", "gps", "other", ""),
    "lon": ("GPS", "gps", "other", ""),
}


def _meta_for_field(field: str, fallback_topic: str = "race/sensor/unknown"):
    name, typ, position, unit = FIELD_META.get(field, (field, "unknown", "other", ""))
    topic = fallback_topic
    if fallback_topic == "race/sensor/unknown":
        topic = f"race/sensor/{field}"
    return name, typ, position, unit, topic


ENVELOPE_GROUPED_FIELDS = frozenset({
    "imu_acc_x", "imu_acc_y", "imu_acc_z",
    "imu_pitch", "imu_roll", "imu_yaw",
    "pitch", "roll", "yaw",
    "gps_lat", "gps_lon", "lat", "lon",
    "g_force_l", "g_force_r", "yaw_l", "yaw_r",
    "g_acc_l_x", "g_acc_l_y", "g_acc_l_z",
    "g_acc_r_x", "g_acc_r_y", "g_acc_r_z",
    "acc_l_x", "acc_l_y", "acc_l_z",
    "acc_r_x", "acc_r_y", "acc_r_z",
})


def ingest_telemetry(telemetry: NormalizedTelemetry) -> None:
    if _is_stale_telemetry(telemetry.topic, telemetry.seq, telemetry.ts_ms):
        return
    if telemetry.seq is not None:
        LAST_SEQ_BY_TOPIC[telemetry.topic] = telemetry.seq
    LAST_TS_MS_BY_TOPIC[telemetry.topic] = telemetry.ts_ms
    processed_data = telemetry.to_processed_data()
    update_latest_sensor(telemetry.topic, processed_data)
    record_telemetry_if_active(telemetry, processed_data)
    if main_event_loop and main_event_loop.is_running():
        ordered_dispatcher.submit(main_event_loop, telemetry.to_ws_message(processed_data))


def _ingest_gforce_side(
    z_value,
    side: str,
    raw_data: dict,
    *,
    source: str = "",
    key: str = "",
    seq: int | None = None,
    ts_ms: int,
    device_id: str = "",
    unit: str = "G",
) -> None:
    """G-force 전용 가속도: xyz 중 z만 프론트에 표시. IMU 가속도와 분리."""
    if side == "l":
        topic = "race/sensor/yaw_l"
        name = "G-FORCE L"
        typ = "gforce_l"
        value_key = "g_force_l"
    else:
        topic = "race/sensor/yaw_r"
        name = "G-FORCE R"
        typ = "gforce_r"
        value_key = "g_force_r"
    z = float(z_value)
    ingest_telemetry(NormalizedTelemetry(
        topic=topic,
        name=name,
        type=typ,
        position="right",
        unit=unit,
        value=z,
        values={value_key: z},
        units={value_key: unit},
        parsed={"z": z},
        source=source,
        key=key,
        seq=seq,
        ts_ms=ts_ms,
        device_id=device_id,
    ))


def _extract_gforce_z(values: dict, side: str) -> float | None:
    prefix = f"g_acc_{side}_"
    legacy_prefix = f"acc_{side}_"
    for base in (prefix, legacy_prefix):
        z_key = f"{base}z"
        if z_key in values and isinstance(values[z_key], (int, float)):
            return float(values[z_key])
    scalar_keys = (
        ("g_force_l", "yaw_l") if side == "l" else ("g_force_r", "yaw_r")
    )
    for key in scalar_keys:
        if key in values and isinstance(values[key], (int, float)):
            return float(values[key])
    return None


def _ingest_gps_payload(raw_data: dict, topic: str, ts_ms: int | None = None) -> None:
    speed_kmh = raw_data.get("speed_kmh")
    speed_knots = raw_data.get("speed_knots")
    course_deg = raw_data.get("course_deg")
    lat = float(raw_data.get("lat") or raw_data.get("gps_lat"))
    lon = float(raw_data.get("lon") or raw_data.get("gps_lon"))
    resolved_ts_ms = int(ts_ms if ts_ms is not None else time.time() * 1000)
    gps_values = {"gps_lat": lat, "gps_lon": lon}
    if isinstance(speed_kmh, (int, float)):
        gps_values["speed"] = float(speed_kmh)
    if isinstance(course_deg, (int, float)):
        gps_values["course_deg"] = float(course_deg)
    ingest_telemetry(NormalizedTelemetry(
        topic=topic if topic.startswith("race/") else "race/gps",
        name="GPS",
        type="gps",
        position="other",
        unit="",
        value=float(speed_kmh) if isinstance(speed_kmh, (int, float)) else None,
        values=gps_values,
        units={"gps_lat": "", "gps_lon": "", "speed": "km/h", "course_deg": "°"},
        parsed={
            "lat": lat,
            "lon": lon,
            "status": raw_data.get("status"),
            "sats": raw_data.get("sats"),
            "hdop": raw_data.get("hdop"),
            "utc": raw_data.get("utc"),
            "speed": float(speed_kmh) if isinstance(speed_kmh, (int, float)) else None,
            "speed_kmh": speed_kmh,
            "speed_knots": speed_knots,
            "course_deg": course_deg,
        },
        ts_ms=resolved_ts_ms,
    ))


def ingest_envelope(raw_data: dict) -> int:
    values = raw_data.get("values")
    if not isinstance(values, dict):
        return 0
    values = remap_linear_channels(dict(values))
    units_raw = raw_data.get("units")
    units = remap_linear_channels(dict(units_raw)) if isinstance(units_raw, dict) else {}
    seq = raw_data.get("seq")
    ts_ms = int(raw_data.get("ts_ms") or now_ms())
    source = str(raw_data.get("source") or "")
    key = str(raw_data.get("key") or "")
    device_id = str(raw_data.get("device_id") or "")
    count = 0

    def submit_one(field: str, value, topic: str | None = None) -> None:
        nonlocal count
        field_topic = topic or f"race/sensor/{field}"
        name, typ, position, default_unit, resolved_topic = _meta_for_field(field, field_topic)
        unit = str(units.get(field) or default_unit)
        ingest_telemetry(NormalizedTelemetry(
            topic=resolved_topic,
            name=name,
            type=typ,
            position=position,
            unit=unit,
            value=value,
            values={field: value},
            units={field: unit},
            parsed={field: value},
            source=source,
            key=key,
            seq=seq if isinstance(seq, int) else None,
            ts_ms=ts_ms,
            device_id=device_id,
        ))
        count += 1

    if all(field in values for field in ("imu_acc_x", "imu_acc_y", "imu_acc_z")):
        ingest_telemetry(NormalizedTelemetry(
            topic="race/sensor/imu_acc",
            name="IMU 가속도",
            type="imu_acceleration",
            position="right",
            unit="g",
            value=values.get("imu_acc_x"),
            values={
                "imu_acc_x": values.get("imu_acc_x"),
                "imu_acc_y": values.get("imu_acc_y"),
                "imu_acc_z": values.get("imu_acc_z"),
            },
            units={field: str(units.get(field) or "g") for field in ("imu_acc_x", "imu_acc_y", "imu_acc_z")},
            parsed={
                "x": values.get("imu_acc_x"),
                "y": values.get("imu_acc_y"),
                "z": values.get("imu_acc_z"),
            },
            source=source,
            key=key,
            seq=seq if isinstance(seq, int) else None,
            ts_ms=ts_ms,
            device_id=device_id,
        ))
        count += 1

    eul_fields = (
        ("imu_pitch", "imu_roll", "imu_yaw")
        if all(field in values for field in ("imu_pitch", "imu_roll", "imu_yaw"))
        else ("pitch", "roll", "yaw")
    )
    if all(field in values for field in eul_fields):
        pitch_field, roll_field, yaw_field = eul_fields
        ingest_telemetry(NormalizedTelemetry(
            topic="race/sensor/imu_eul",
            name="IMU 자세",
            type="imu_orientation",
            position="right",
            unit="°",
            value=values.get(roll_field),
            values={
                "imu_pitch": values.get(pitch_field),
                "imu_roll": values.get(roll_field),
                "imu_yaw": values.get(yaw_field),
            },
            units={
                "imu_pitch": str(units.get(pitch_field) or "°"),
                "imu_roll": str(units.get(roll_field) or "°"),
                "imu_yaw": str(units.get(yaw_field) or "°"),
            },
            parsed={
                "pitch": values.get(pitch_field),
                "roll": values.get(roll_field),
                "yaw": values.get(yaw_field),
            },
            source=source,
            key=key,
            seq=seq if isinstance(seq, int) else None,
            ts_ms=ts_ms,
            device_id=device_id,
        ))
        count += 1

    for side in ("l", "r"):
        g_z = _extract_gforce_z(values, side)
        if g_z is not None:
            unit = str(
                units.get(f"g_force_{side}")
                or units.get(f"yaw_{side}")
                or units.get(f"g_acc_{side}_z")
                or units.get(f"acc_{side}_z")
                or "G"
            )
            _ingest_gforce_side(
                g_z,
                side,
                raw_data,
                source=source,
                key=key,
                seq=seq if isinstance(seq, int) else None,
                ts_ms=ts_ms,
                device_id=device_id,
                unit=unit,
            )
            count += 1

    gps_lat = values.get("gps_lat", values.get("lat"))
    gps_lon = values.get("gps_lon", values.get("lon"))
    if isinstance(gps_lat, (int, float)) and isinstance(gps_lon, (int, float)):
        gps_payload = dict(raw_data)
        gps_payload["lat"] = gps_lat
        gps_payload["lon"] = gps_lon
        if isinstance(values.get("speed"), (int, float)):
            gps_payload["speed_kmh"] = values.get("speed")
        _ingest_gps_payload(gps_payload, "race/gps", ts_ms)
        count += 1

    for field, value in values.items():
        if field in ENVELOPE_GROUPED_FIELDS:
            continue
        submit_one(field, value)
    return count


def update_latest_sensor(frontend_topic: str, processed_data: dict) -> None:
    LATEST_SENSOR_DATA[frontend_topic] = sanitize_latest_payload(processed_data)


LINEAR_SWAP_PAIRS = (
    ("linear_fl", "linear_fr"),
    ("linear_rl", "linear_rr"),
    ("linear_fl", "linear_rl"),
    ("linear_fr", "linear_rr"),
)


def remap_linear_channels(data: dict) -> dict:
    """라즈베리 송신 위치 보정: FL<->FR, RL<->RR, FL<->RL, FR<->RR."""
    if not data:
        return data
    for left_key, right_key in LINEAR_SWAP_PAIRS:
        if left_key in data and right_key in data:
            data[left_key], data[right_key] = data[right_key], data[left_key]
    return data


def set_event_loop(loop) -> None:
    global main_event_loop
    main_event_loop = loop


def on_mqtt_connect(client, userdata, flags, rc):
    if rc == 0:
        port = userdata.get("port") if isinstance(userdata, dict) else None
        port_label = port if port is not None else "unknown"
        print(f"MQTT 연결 성공: {MOSQUITTO_HOST}:{port_label}")
        for topic in MQTT_TOPICS:
            client.subscribe(topic)
            print(f"MQTT 구독: {topic}")
    else:
        print(f"MQTT 연결 실패: {rc}")


def on_mqtt_disconnect(client, userdata, rc):
    if rc != 0:
        port = userdata.get("port") if isinstance(userdata, dict) else None
        port_label = port if port is not None else "unknown"
        print(f"⚠️ MQTT 연결 끊김 ({MOSQUITTO_HOST}:{port_label}, rc={rc}) - 재연결 시도 예정")


def on_mqtt_message(client, userdata, msg):
    try:
        topic = msg.topic
        payload = msg.payload.decode("utf-8")
        try:
            raw_data = json.loads(payload)
        except json.JSONDecodeError:
            return
        if not isinstance(raw_data, dict):
            return

        if raw_data.get("schema") == "race.telemetry.v1" or isinstance(raw_data.get("values"), dict):
            ingest_envelope(raw_data)
            return

        if "lat" in raw_data and "lon" in raw_data:
            _ingest_gps_payload(raw_data, topic)
    except Exception as e:
        print(f"❌ MQTT 메시지 처리 오류: {e}")


def start_mqtt_client():
    global mqtt_clients
    backoff = 1
    while True:
        clients: list[mqtt.Client] = []
        for port in MOSQUITTO_PORTS:
            try:
                client = mqtt.Client()
                client.user_data_set({"port": port})
                client.on_connect = on_mqtt_connect
                client.on_message = on_mqtt_message
                client.on_disconnect = on_mqtt_disconnect
                client.reconnect_delay_set(min_delay=1, max_delay=30)
                client.connect(MOSQUITTO_HOST, port, 60)
                client.loop_start()
                print(f"MQTT 클라이언트 시작: {MOSQUITTO_HOST}:{port}")
                clients.append(client)
            except Exception as e:
                print(f"MQTT 클라이언트 시작 실패: {MOSQUITTO_HOST}:{port} ({e})")
        if clients:
            mqtt_clients = clients
            return
        time.sleep(backoff)
        backoff = min(backoff * 2, 30)


def stop_mqtt_client():
    global mqtt_clients
    for client in mqtt_clients:
        try:
            client.loop_stop()
            client.disconnect()
        except Exception:
            continue
    mqtt_clients = []
