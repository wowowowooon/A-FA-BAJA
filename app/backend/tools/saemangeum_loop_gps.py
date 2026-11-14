#!/usr/bin/env python3
"""새만금 어린이랜드 녹색지대(잔디광장) 루프를 10km/h로 도는 가상 GPS 퍼블리셔."""

import argparse
import json
import math
import time

import paho.mqtt.client as mqtt

GPS_TOPIC = "race/gps"
TELEMETRY_TOPIC = "race/sensor/telemetry"

# 새만금 어린이랜드 잔디광장·생태연못 주변 (시계방향 폐루프, 약 450m)
SAEMANGEUM_LOOP = [
    (35.96962, 126.56772),
    (35.96968, 126.56818),
    (35.96955, 126.56862),
    (35.96912, 126.56878),
    (35.96878, 126.56848),
    (35.96872, 126.56802),
    (35.96888, 126.56758),
    (35.96928, 126.56748),
]

EARTH_RADIUS_M = 6371000.0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlon = math.radians(lon2 - lon1)
    y = math.sin(dlon) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def build_route(waypoints: list[tuple[float, float]]) -> list[dict]:
    if len(waypoints) < 2:
        raise ValueError("waypoints 2개 이상 필요")
    closed = list(waypoints) + [waypoints[0]]
    segments = []
    total = 0.0
    for i in range(len(closed) - 1):
        lat1, lon1 = closed[i]
        lat2, lon2 = closed[i + 1]
        dist = haversine_m(lat1, lon1, lat2, lon2)
        segments.append({
            "start": (lat1, lon1),
            "end": (lat2, lon2),
            "distance_m": dist,
            "course_deg": bearing_deg(lat1, lon1, lat2, lon2),
        })
        total += dist
    return segments, total


def interpolate(segments: list[dict], distance_along: float) -> tuple[float, float, float]:
    if distance_along < 0:
        distance_along = 0
    remain = distance_along
    for seg in segments:
        if remain <= seg["distance_m"] or seg is segments[-1]:
            ratio = 0 if seg["distance_m"] == 0 else min(1.0, remain / seg["distance_m"])
            lat1, lon1 = seg["start"]
            lat2, lon2 = seg["end"]
            lat = lat1 + (lat2 - lat1) * ratio
            lon = lon1 + (lon2 - lon1) * ratio
            return lat, lon, seg["course_deg"]
        remain -= seg["distance_m"]
    last = segments[-1]
    return last["end"][0], last["end"][1], last["course_deg"]


def make_gps(lat: float, lon: float, course_deg: float, speed_kmh: float) -> dict:
    return {
        "lat": round(lat, 7),
        "lon": round(lon, 7),
        "status": "sim",
        "sats": 10,
        "hdop": 0.9,
        "utc": int(time.time()),
        "speed_kmh": round(speed_kmh, 1),
        "course_deg": round(course_deg, 1),
    }


def make_envelope(seq: int, lat: float, lon: float, speed_kmh: float, ts_ms: int) -> dict:
    return {
        "schema": "race.telemetry.v1",
        "seq": seq,
        "ts_ms": ts_ms,
        "device_id": "saemangeum-loop-sim",
        "topic": TELEMETRY_TOPIC,
        "values": {
            "speed": round(speed_kmh, 1),
            "gps_lat": round(lat, 7),
            "gps_lon": round(lon, 7),
            "steering": 0,
            "imu_acc_z": 9.81,
            "pitch": 0,
            "roll": 0,
            "yaw": 0,
        },
        "units": {
            "speed": "km/h",
            "gps_lat": "",
            "gps_lon": "",
            "steering": "°",
            "imu_acc_z": "g",
            "pitch": "°",
            "roll": "°",
            "yaw": "°",
        },
    }


def main():
    parser = argparse.ArgumentParser(description="새만금 어린이랜드 10km/h GPS 루프 시뮬레이터")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=1883)
    parser.add_argument("--speed-kmh", type=float, default=10.0)
    parser.add_argument("--interval-sec", type=float, default=1.0, help="GPS 송신 주기(초)")
    parser.add_argument("--duration-sec", type=float, default=0, help="0이면 무한")
    parser.add_argument("--with-telemetry", action="store_true", help="envelope(speed+gps)도 함께 송신")
    args = parser.parse_args()

    segments, loop_length_m = build_route(SAEMANGEUM_LOOP)
    speed_mps = max(args.speed_kmh, 0.1) / 3.6
    step_m = speed_mps * args.interval_sec

    print("=== 새만금 어린이랜드 GPS 루프 시뮬레이터 ===")
    print(f"루프 길이: {loop_length_m:.0f}m | 속도: {args.speed_kmh} km/h")
    print(f"예상 1랩: {loop_length_m / speed_mps:.0f}초 | GPS 주기: {args.interval_sec}s")
    print(f"MQTT: {args.host}:{args.port} topic={GPS_TOPIC}")
    print("중지: Ctrl+C")

    client = mqtt.Client()
    client.connect(args.host, args.port, 60)
    client.loop_start()

    seq = 0
    distance_along = 0.0
    started = time.time()
    gps_sent = 0

    try:
        while True:
            now = time.time()
            if args.duration_sec > 0 and (now - started) >= args.duration_sec:
                break

            lat, lon, course = interpolate(segments, distance_along)
            ts_ms = int(now * 1000)
            gps_payload = make_gps(lat, lon, course, args.speed_kmh)
            client.publish(GPS_TOPIC, json.dumps(gps_payload), qos=0)
            gps_sent += 1

            if args.with_telemetry:
                seq += 1
                client.publish(
                    TELEMETRY_TOPIC,
                    json.dumps(make_envelope(seq, lat, lon, args.speed_kmh, ts_ms)),
                    qos=0,
                )

            lap_no = int(distance_along // loop_length_m) + 1
            if gps_sent % 10 == 0:
                print(
                    f"[{gps_sent:4d}] lat={lat:.6f} lon={lon:.6f} "
                    f"speed={args.speed_kmh}km/h lap~{lap_no} dist={distance_along % loop_length_m:.0f}m"
                )

            distance_along = (distance_along + step_m) % loop_length_m
            time.sleep(args.interval_sec)
    except KeyboardInterrupt:
        print("\n중지 요청")
    finally:
        client.loop_stop()
        client.disconnect()
        elapsed = max(time.time() - started, 0.001)
        print(f"완료: gps={gps_sent} elapsed={elapsed:.1f}s")


if __name__ == "__main__":
    main()
