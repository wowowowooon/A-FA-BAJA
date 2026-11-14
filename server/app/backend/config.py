import os


def load_env_file(path: str) -> None:
    try:
        if not os.path.exists(path):
            return
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except Exception as e:
        print(f".env 로드 실패: {path} ({e})")


load_env_file("/opt/race-stack/app/backend/.env")
load_env_file("/opt/race-stack/.env")

ACC_CALIBRATION_FILE = os.getenv("ACC_CALIBRATION_FILE", "/opt/race-stack/acc_calibration.json")
DATA_FILES_DIR = os.getenv("DATA_FILES_DIR", "/opt/race-stack/data_files")

# InfluxDB 연결 설정
INFLUXDB_URL = os.getenv("INFLUXDB_URL") or os.getenv("INFLUXDB_V2_URL") or "http://localhost:8086"
INFLUXDB_TOKEN = os.getenv("INFLUXDB_TOKEN") or os.getenv("INFLUXDB_V2_TOKEN") or ""
INFLUXDB_ORG = os.getenv("INFLUXDB_ORG") or os.getenv("INFLUXDB_V2_ORG") or "race"
INFLUXDB_BUCKET = os.getenv("INFLUXDB_BUCKET") or os.getenv("INFLUXDB_V2_BUCKET") or "race-data"

# MQTT 설정
MOSQUITTO_HOST = os.getenv("MOSQUITTO_HOST", "localhost")
_mqtt_ports_raw = os.getenv("MOSQUITTO_PORTS") or os.getenv("MOSQUITTO_PORT") or "1883,1884"
MOSQUITTO_PORTS = [int(port.strip()) for port in _mqtt_ports_raw.split(",") if port.strip().isdigit()]
if not MOSQUITTO_PORTS:
    MOSQUITTO_PORTS = [1883]
MOSQUITTO_PORT = MOSQUITTO_PORTS[0]
MQTT_TOPICS = [
    "race/sensor/#",
    "race/speed",
    "race/temperature",
    "race/#",
]
