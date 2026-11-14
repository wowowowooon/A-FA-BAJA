#!/usr/bin/env python3
"""라즈베리 telemetry envelope 형식 테스트/부하 퍼블리셔."""

import argparse
import json
import random
import time
import urllib.error
import urllib.request

import paho.mqtt.client as mqtt

TELEMETRY_TOPIC = "race/sensor/telemetry"
GPS_TOPIC = "race/gps"
DEFAULT_API_URL = "http://127.0.0.1:8000"


def make_envelope(seq: int, ts_ms: int | None = None) -> dict:
    return {
        "schema": "race.telemetry.v1",
        "seq": seq,
        "ts_ms": ts_ms if ts_ms is not None else int(time.time() * 1000),
        "device_id": "load-test-pi",
        "topic": TELEMETRY_TOPIC,
        "values": {
            "linear_fl": round(random.uniform(40, 120), 2),
            "linear_fr": round(random.uniform(40, 120), 2),
            "linear_rl": round(random.uniform(40, 120), 2),
            "linear_rr": round(random.uniform(40, 120), 2),
            "imu_acc_x": round(random.uniform(-1.5, 1.5), 3),
            "imu_acc_y": round(random.uniform(-1.5, 1.5), 3),
            "imu_acc_z": round(random.uniform(8.5, 10.5), 3),
            "pitch": round(random.uniform(-15, 15), 2),
            "roll": round(random.uniform(-15, 15), 2),
            "yaw": round(random.uniform(0, 360), 2),
            "speed": round(random.uniform(0, 180), 1),
            "g_acc_l_x": round(random.uniform(-0.2, 0.2), 3),
            "g_acc_l_y": round(random.uniform(-0.2, 0.2), 3),
            "g_acc_l_z": round(random.uniform(-2, 2), 2),
            "g_acc_r_x": round(random.uniform(-0.2, 0.2), 3),
            "g_acc_r_y": round(random.uniform(-0.2, 0.2), 3),
            "g_acc_r_z": round(random.uniform(-2, 2), 2),
            "steering": round(random.uniform(-30, 30), 1),
        },
        "units": {
            "linear_fl": "mm",
            "linear_fr": "mm",
            "linear_rl": "mm",
            "linear_rr": "mm",
            "imu_acc_x": "g",
            "imu_acc_y": "g",
            "imu_acc_z": "g",
            "pitch": "°",
            "roll": "°",
            "yaw": "°",
            "speed": "km/h",
            "g_acc_l_x": "g",
            "g_acc_l_y": "g",
            "g_acc_l_z": "G",
            "g_acc_r_x": "g",
            "g_acc_r_y": "g",
            "g_acc_r_z": "G",
            "steering": "°",
        },
    }


def make_gps() -> dict:
    return {
        "lat": 37.4479 + random.uniform(-0.001, 0.001),
        "lon": 127.1266 + random.uniform(-0.001, 0.001),
        "status": "sim",
        "sats": random.randint(6, 12),
        "hdop": round(random.uniform(0.8, 1.5), 2),
        "utc": int(time.time()),
        "speed_kmh": round(random.uniform(0, 180), 1),
        "course_deg": round(random.uniform(0, 360), 1),
    }


def api_post(api_url: str, path: str, body: dict) -> dict:
    req = urllib.request.Request(
        f"{api_url.rstrip('/')}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_get(api_url: str, path: str) -> dict:
    with urllib.request.urlopen(f"{api_url.rstrip('/')}{path}", timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def start_recording(api_url: str, name: str) -> str:
    started_at = int(time.time() * 1000)
    result = api_post(api_url, "/api/recordings/stream/start", {
        "name": name,
        "startedAt": started_at,
    })
    recording_id = result.get("recordingId") or result.get("recording_id")
    if not recording_id:
        raise RuntimeError(f"기록 시작 실패: {result}")
    print(f"기록 시작: {recording_id}")
    return recording_id


def stop_recording(api_url: str, recording_id: str) -> dict:
    ended_at = int(time.time() * 1000)
    result = api_post(api_url, "/api/recordings/stream/stop", {
        "recordingId": recording_id,
        "endedAt": ended_at,
    })
    print(f"기록 종료: {recording_id}")
    return result


def print_health(api_url: str, label: str) -> None:
    try:
        health = api_get(api_url, "/health")
    except urllib.error.URLError as exc:
        print(f"[{label}] health 조회 실패: {exc}")
        return
    rec = health.get("recording_queue", {})
    influx = health.get("influx_queue", {})
    dispatch = health.get("ordered_dispatcher", {})
    print(
        f"[{label}] recording_q={rec.get('size')}/{rec.get('maxsize')} "
        f"dropped={rec.get('dropped')} active={rec.get('active_recording_id')} | "
        f"influx_q={influx.get('size')}/{influx.get('maxsize')} dropped={influx.get('dropped')} | "
        f"dispatch_q={dispatch.get('size')}/{dispatch.get('maxsize')} "
        f"dropped={dispatch.get('dropped')} ooo={dispatch.get('out_of_order_dropped')}"
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=1883)
    parser.add_argument("--interval-ms", type=int, default=20, help="envelope 송신 주기 (ms)")
    parser.add_argument("--duration-sec", type=float, default=30, help="0이면 무한")
    parser.add_argument("--gps-every", type=int, default=5, help="N번째 envelope마다 GPS 1회")
    parser.add_argument("--api-url", default=DEFAULT_API_URL)
    parser.add_argument("--start-recording", action="store_true", help="송신 전 서버 기록 ON")
    parser.add_argument("--recording-name", default="load_test")
    parser.add_argument("--stop-recording", action="store_true", help="종료 시 서버 기록 OFF")
    parser.add_argument("--stats-every-sec", type=float, default=5)
    args = parser.parse_args()

    recording_id = None
    if args.start_recording:
        recording_id = start_recording(args.api_url, args.recording_name)
        print_health(args.api_url, "start")

    client = mqtt.Client()
    client.connect(args.host, args.port, 60)
    client.loop_start()

    seq = 0
    telemetry_sent = 0
    gps_sent = 0
    started = time.time()
    next_stats = started + args.stats_every_sec

    try:
        while True:
            now = time.time()
            if args.duration_sec > 0 and (now - started) >= args.duration_sec:
                break

            seq += 1
            client.publish(TELEMETRY_TOPIC, json.dumps(make_envelope(seq)), qos=0)
            telemetry_sent += 1
            if args.gps_every > 0 and seq % args.gps_every == 0:
                client.publish(GPS_TOPIC, json.dumps(make_gps()), qos=0)
                gps_sent += 1

            if now >= next_stats:
                elapsed = now - started
                rate = telemetry_sent / elapsed if elapsed > 0 else 0
                print(
                    f"송신 {elapsed:.1f}s | envelope={telemetry_sent} gps={gps_sent} "
                    f"rate={rate:.1f}/s interval={args.interval_ms}ms"
                )
                print_health(args.api_url, "progress")
                next_stats = now + args.stats_every_sec

            time.sleep(args.interval_ms / 1000.0)
    except KeyboardInterrupt:
        pass
    finally:
        client.loop_stop()
        client.disconnect()

        elapsed = max(time.time() - started, 0.001)
        print(
            f"\n완료: envelope={telemetry_sent} gps={gps_sent} "
            f"elapsed={elapsed:.1f}s avg_rate={telemetry_sent / elapsed:.1f}/s"
        )
        print_health(args.api_url, "end")

        if args.stop_recording and recording_id:
            stop_recording(args.api_url, recording_id)
            print_health(args.api_url, "after-stop")


if __name__ == "__main__":
    main()
