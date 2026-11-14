# Raspberry Pi GPS 송신 가이드 (race-stack)

라즈베리파이에서 **GPS 위도·경도**를 MQTT로내면 서버가 LIVE 지도·주행 경로·랩타임·분석실 랩 경로에 반영합니다.

> **Cursor에 붙여넣을 프롬프트**는 아래 [Cursor 프롬프트](#cursor-프롬프트) 섹션을 통째로 복사하세요.

---

## 한 줄 요약

| 항목 | 값 |
|------|-----|
| MQTT 브로커 | `3.34.46.165` (서버 IP, 변경 시 팀에 확인) |
| 포트 | `1883` (안 되면 `1884`) |
| **권장 토픽** | `race/gps` |
| **필수 필드** | `lat`, `lon` (WGS84 float) |
| **권장 주기** | **1Hz 이상** (1초에 1회+) |
| QoS | `0` |

---

## 서버가 GPS를 받는 방식

```
라즈베리 Pi
  └─ MQTT publish (race/gps 또는 envelope에 gps_lat/gps_lon)
        ↓
Mosquitto (서버 :1883 / :1884)
        ↓
race-backend (mqtt.py 구독: race/#, race/sensor/#)
        ↓
├─ WebSocket → LIVE HUD (지도 화살표, 속도, 경로)
├─ JSONL/Influx → 데이터 기록 (기록 ON일 때)
└─ track 파일 → 분석실 랩 경로 지도
```

백엔드는 아래 **두 가지 형식** 모두 처리합니다.

### 방법 1 — GPS 전용 토픽 (권장, 구현이 단순)

**토픽:** `race/gps`

```json
{
  "lat": 35.9696200,
  "lon": 126.5677200,
  "speed_kmh": 42.5,
  "course_deg": 180.0,
  "sats": 9,
  "hdop": 1.0,
  "status": "fix",
  "utc": 1783171143
}
```

| 필드 | 필수 | 설명 |
|------|------|------|
| `lat` | ✅ | 위도 (WGS84) |
| `lon` | ✅ | 경도 (WGS84) |
| `speed_kmh` | 권장 | km/h — LIVE 속도 게이지 |
| `course_deg` | 선택 | 진행 방향 0~360° — 지도 화살표 회전 |
| `sats`, `hdop`, `status` | 선택 | 위성 수, 정밀도, fix 상태 |

서버 처리 코드: `server/app/backend/mqtt.py` → `on_mqtt_message()` → `lat`/`lon` 있으면 `_ingest_gps_payload()`

### 방법 2 — 기존 telemetry envelope에 GPS 추가

이미 `race/sensor/telemetry`로 IMU·속도 등을 보내고 있다면, **`values`에 GPS만 추가**해도 됩니다. 기존 센서 코드는 건드리지 않아도 됩니다.

**토픽:** `race/sensor/telemetry`

```json
{
  "schema": "race.telemetry.v1",
  "seq": 12345,
  "ts_ms": 1783171143110,
  "device_id": "raspberry-pi-01",
  "values": {
    "speed": 42.5,
    "gps_lat": 35.9696200,
    "gps_lon": 126.5677200
  },
  "units": {
    "speed": "km/h",
    "gps_lat": "",
    "gps_lon": ""
  }
}
```

- `speed`만 있고 `gps_lat`/`gps_lon` 없음 → 속도 게이지만 동작, **지도·경로·랩 불가**
- `gps_lat` + `gps_lon` 둘 다 있어야 지도·경로·랩 동작

---

## 구현 요구사항 (라즈베리 Pi)

1. GPS 모듈에서 **fix 된 좌표만** 송신 (`status: "no_fix"`이면 생략 가능)
2. `race/gps`는 **1Hz 이상** 독립 주기로 송신 (기존 20ms telemetry와 분리해도 됨)
3. JSON UTF-8, compact 한 줄
4. 토픽명 임의 변경 금지 — 반드시 `race/gps` 또는 `race/sensor/telemetry`
5. STM32/CAN 레거시 hex 프로토콜 사용 금지 (현재 서버는 Pi envelope + GPS 사용)

---

## 바로 실행 가능한 예제 (Python)

의존성: `pip install paho-mqtt`

```python
#!/usr/bin/env python3
"""GPS → MQTT (race/gps) 최소 예제"""

import json
import time

import paho.mqtt.client as mqtt

MQTT_HOST = "3.34.46.165"   # 서버 IP
MQTT_PORT = 1883            # 안 되면 1884
GPS_TOPIC = "race/gps"
INTERVAL_SEC = 1.0          # 1Hz


def read_gps_fix():
    """
  TODO: 실제 GPS 모듈에서 읽기.
  예: gpsd, pyserial+NMEA, Neo-6M 라이브러리 등

  fix 없으면 None 반환.
  """
    # --- 테스트용 더미 (실전에서는 삭제) ---
    return {
        "lat": 35.9696200,
        "lon": 126.5677200,
        "speed_kmh": 10.0,
        "course_deg": 90.0,
        "sats": 8,
        "hdop": 1.2,
        "status": "fix",
        "utc": int(time.time()),
    }


def main():
    client = mqtt.Client()
    client.connect(MQTT_HOST, MQTT_PORT, 60)
    client.loop_start()
    print(f"MQTT {MQTT_HOST}:{MQTT_PORT} → topic={GPS_TOPIC}")

    try:
        while True:
            fix = read_gps_fix()
            if fix and fix.get("status") == "fix":
                payload = json.dumps(fix, separators=(",", ":"))
                client.publish(GPS_TOPIC, payload, qos=0)
            time.sleep(INTERVAL_SEC)
    except KeyboardInterrupt:
        pass
    finally:
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
```

---

## 테스트 방법

### 1) mosquitto_pub로 1건 전송 (Pi 또는 PC)

```bash
mosquitto_pub -h 3.34.46.165 -p 1883 -t race/gps -m \
'{"lat":35.96962,"lon":126.56772,"speed_kmh":10,"course_deg":90,"status":"fix","sats":8}'
```

### 2) LIVE 화면 확인

- 브라우저: `http://3.34.46.165:5173` (또는 팀이 안내한 URL)
- GPS 좌표가 바뀌고 지도 화살표가 이동하면 성공
- 「데이터 기록」ON → 경로 선 표시 → 「1랩 수동 기록」 → 기록 종료

### 3) 분석실 확인

- 분석실 → 기록 선택 → **랩 경로** 탭에서 주행 경로·랩타임·거리(m) 확인

### 4) 서버 측 수신 로그 (문제 시)

```bash
sudo journalctl -u race-backend -f | grep -i mqtt
```

---

## 서버 참고 스크립트 (시뮬레이터)

서버 저장소에 테스트용 GPS 시뮬레이터가 있습니다.

```bash
# 서버에서 실행 예시
python3 server/app/backend/tools/saemangeum_loop_gps.py --host localhost --port 1883 --interval-sec 1
```

- 파일: `server/app/backend/tools/saemangeum_loop_gps.py`
- `race/gps` 페이로드 형식 참고용

---

## 자주 하는 실수

| 실수 | 결과 |
|------|------|
| `speed`만 보내고 `lat`/`lon` 없음 | 속도만 표시, 지도 안 됨 |
| 토픽을 `gps`, `sensor/gps` 등으로 변경 | 서버가 무시 |
| fix 전 좌표(0,0) 송신 | 지도가 이상한 위치로 튐 |
| 1Hz 미만 (너무 느림) | 경로가 끊기고 랩 측정 부정확 |
| 포트 1883 막힘 | **1884**로 재시도 |

---

## Cursor 프롬프트

아래 블록 전체를 라즈베리 Pi Cursor에 붙여넣으세요.

```markdown
# 작업: Raspberry Pi GPS → race-stack 서버 MQTT 송신 구현

## 목표
기존 센서(telemetry envelope) 송신은 유지하고, **GPS 위도·경도(lat/lon)** 를 MQTT로 추가 송신한다.
서버가 LIVE 지도·주행 경로·랩타임·분석실 랩 경로에 사용한다.

## MQTT 연결
- 브로커 호스트: `3.34.46.165` (환경변수 `RACE_MQTT_HOST`로 빼도 됨)
- 포트: `1883` (실패 시 `1884`)
- 프로토콜: MQTT v3.1.1, JSON payload, QoS 0

## 권장 구현: race/gps 토픽 (1Hz 이상)
토픽: `race/gps`

페이로드 예시:
{
  "lat": 35.9696200,
  "lon": 126.5677200,
  "speed_kmh": 42.5,
  "course_deg": 180.0,
  "sats": 9,
  "hdop": 1.0,
  "status": "fix",
  "utc": 1783171143
}

필수: lat, lon (WGS84 float, fix된 값만)
권장: speed_kmh, course_deg
선택: sats, hdop, status, utc

## 대안: 기존 envelope에 GPS 필드 추가
토픽: `race/sensor/telemetry` (schema: race.telemetry.v1)
values에 gps_lat, gps_lon 추가 (speed는 km/h):
{
  "schema": "race.telemetry.v1",
  "seq": 12345,
  "ts_ms": 1783171143110,
  "device_id": "raspberry-pi-01",
  "values": {
    "speed": 42.5,
    "gps_lat": 35.9696200,
    "gps_lon": 126.5677200
  },
  "units": { "speed": "km/h", "gps_lat": "", "gps_lon": "" }
}

## 구현 요구사항
1. GPS fix 없으면 lat/lon 송신하지 않기 (0,0 금지)
2. race/gps는 1초에 1회 이상 (기존 20ms telemetry 루프와 별도 스레드/타이머 OK)
3. JSON UTF-8 compact
4. 토픽명 race/gps 고정 (임의 변경 금지)
5. 기존 IMU/리니어/G-force telemetry 코드는 깨지지 않게 유지

## 완료 기준
- [ ] mosquitto_pub 1건으로 LIVE 지도 좌표 변경 확인
- [ ] 1Hz 연속 송신 시 지도 화살표 이동
- [ ] LIVE 「데이터 기록」ON → 경로 선 → 「1랩 수동 기록」 → 기록 종료
- [ ] 분석실 「랩 경로」탭에서 경로·랩타임·거리(m) 표시

## 참고
- 서버 수신: mqtt.py → lat/lon 있으면 _ingest_gps_payload()
- 서버 구독 토픽: race/#, race/sensor/#
- 시뮬레이터 참고: saemangeum_loop_gps.py (race/gps 형식)

## 하지 말 것
- STM32 hex/CAN 레거시 프로토콜 사용
- speed만 보내고 lat/lon 없이 지도 기대
- 토픽명 gps, sensor/gps 등으로 변경
```

---

## 관련 파일 (서버 측)

| 파일 | 역할 |
|------|------|
| `server/app/backend/mqtt.py` | MQTT 수신, GPS 파싱, WebSocket 브로드캐스트 |
| `server/app/backend/config.py` | `MOSQUITTO_HOST`, `MQTT_TOPICS` |
| `server/app/backend/tools/saemangeum_loop_gps.py` | GPS 시뮬레이터 |
| `server/app/frontend/src/pages/LivePage.jsx` | LIVE 지도·경로·랩 |
| `server/app/frontend/src/components/LapTrackView.jsx` | 분석실 랩 경로 |

---

## 문의 시 확인할 것

1. Pi에서 `ping 3.34.46.165` / `nc -zv 3.34.46.165 1883` 연결 여부
2. `mosquitto_pub` 테스트 1건이 LIVE에 반영되는지
3. GPS 모듈 fix LED / `gpsmon` / NMEA 로그에 유효 좌표가 나오는지
