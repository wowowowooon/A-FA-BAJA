import asyncio
from threading import Thread
from fastapi import FastAPI, HTTPException, WebSocket
from starlette.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware

import mqtt
from ws import websocket_endpoint, broadcast_queue, ordered_dispatcher

from influx import (
    influx_client,
    write_api,
    query_api,
    close_influx,
    get_influx_stats,
    drain_influx_queue,
)
from config import INFLUXDB_URL, INFLUXDB_ORG, INFLUXDB_BUCKET
from api_models import (
    SensorData,
    QueryRequest,
    RecordingRequest,
    AnalysisQueryRequest,
    StreamStartRequest,
    StreamAppendRequest,
    StreamStopRequest,
    TrackSaveRequest,
)
from recordings import (
    save_recording,
    list_recordings,
    get_recording,
    get_analysis_fields,
    query_analysis_data,
    delete_recording,
    start_stream_recording,
    append_stream_recording,
    stop_stream_recording,
    drain_recording_queue,
    get_recording_queue_stats,
    save_recording_track,
    get_recording_track,
)
from influxdb_client import Point

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup_event():
    loop = asyncio.get_event_loop()
    mqtt.set_event_loop(loop)
    broadcast_queue.start(loop)
    ordered_dispatcher.start(loop)
    mqtt_thread = Thread(target=mqtt.start_mqtt_client, daemon=True)
    mqtt_thread.start()


@app.on_event("shutdown")
async def shutdown_event():
    mqtt.stop_mqtt_client()
    drain_recording_queue(timeout=10.0)
    drain_influx_queue(timeout=10.0)
    close_influx()


@app.get("/health")
def health():
    db_status = "connected" if influx_client else "disconnected"
    mqtt_clients = getattr(mqtt, "mqtt_clients", None) or []
    mqtt_status = "connected" if any(c.is_connected() for c in mqtt_clients) else "disconnected"
    return {
        "ok": True,
        "influxdb": db_status,
        "mqtt": mqtt_status,
        "url": INFLUXDB_URL,
        "influx_queue": get_influx_stats(),
        "recording_queue": get_recording_queue_stats(),
        "broadcast_queue": broadcast_queue.stats(),
        "ordered_dispatcher": ordered_dispatcher.stats(),
    }


@app.post("/api/data")
async def write_data(data: SensorData):
    if not write_api:
        return {
            "success": True,
            "message": "데이터 수신 완료 (InfluxDB 미연결)",
            "measurement": data.measurement,
        }
    try:
        point = Point(data.measurement)
        for key, value in data.tags.items():
            point = point.tag(key, str(value))
        for key, value in data.fields.items():
            if isinstance(value, (int, float)):
                point = point.field(key, value)
            elif isinstance(value, bool):
                point = point.field(key, value)
            else:
                point = point.field(key, str(value))
        if data.timestamp:
            point = point.time(data.timestamp)
        write_api.write(bucket=INFLUXDB_BUCKET, org=INFLUXDB_ORG, record=point)
        return {
            "success": True,
            "message": "데이터 저장 완료",
            "measurement": data.measurement,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"데이터 저장 실패: {str(e)}")


@app.post("/api/recordings")
async def save_recording_endpoint(payload: RecordingRequest):
    return save_recording(payload)


@app.post("/api/recordings/stream/start")
async def start_stream_recording_endpoint(payload: StreamStartRequest):
    return await run_in_threadpool(start_stream_recording, payload)


@app.post("/api/recordings/stream/append")
async def append_stream_recording_endpoint(payload: StreamAppendRequest):
    return await run_in_threadpool(append_stream_recording, payload)


@app.post("/api/recordings/stream/stop")
async def stop_stream_recording_endpoint(payload: StreamStopRequest):
    return await run_in_threadpool(stop_stream_recording, payload)


@app.get("/api/recordings")
async def list_recordings_endpoint():
    return list_recordings()


@app.get("/api/recordings/{recording_id:path}")
async def get_recording_endpoint(recording_id: str):
    return get_recording(recording_id)


@app.delete("/api/recordings/{recording_id:path}")
async def delete_recording_endpoint(recording_id: str):
    return delete_recording(recording_id)


@app.get("/api/analysis/fields")
async def get_analysis_fields_endpoint(recordingId: str):
    return get_analysis_fields(recordingId)


@app.get("/api/sensors/latest")
async def get_latest_sensors():
    return {"success": True, "data": mqtt.LATEST_SENSOR_DATA}


@app.post("/api/analysis/query")
async def query_analysis_data_endpoint(request: AnalysisQueryRequest):
    return await run_in_threadpool(query_analysis_data, request)


@app.get("/api/analysis/track")
async def get_recording_track_endpoint(recordingId: str):
    return await run_in_threadpool(get_recording_track, recordingId)


@app.put("/api/recordings/{recording_id:path}/track")
async def save_recording_track_endpoint(recording_id: str, payload: TrackSaveRequest):
    return await run_in_threadpool(save_recording_track, recording_id, payload)


@app.post("/api/query")
async def query_data(request: QueryRequest):
    if not query_api:
        raise HTTPException(status_code=503, detail="InfluxDB 연결되지 않음")
    try:
        query = f'''
        from(bucket: "{INFLUXDB_BUCKET}")
          |> range(start: {request.start or "-1h"}, stop: {request.stop or "now()"})
          |> filter(fn: (r) => r["_measurement"] == "{request.measurement}")
          |> limit(n: {request.limit or 100})
        '''
        result = query_api.query(org=INFLUXDB_ORG, query=query)
        data = []
        for table in result:
            for record in table.records:
                data.append({
                    "time": record.get_time().isoformat(),
                    "measurement": record.get_measurement(),
                    "field": record.get_field(),
                    "value": record.get_value(),
                    **record.values,
                })
        return {
            "success": True,
            "count": len(data),
            "data": data,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"데이터 조회 실패: {str(e)}")


@app.get("/api/data/{measurement}")
async def get_measurement_data(measurement: str, limit: int = 100):
    if not query_api:
        raise HTTPException(status_code=503, detail="InfluxDB 연결되지 않음")
    try:
        query = f'''
        from(bucket: "{INFLUXDB_BUCKET}")
          |> range(start: -1h)
          |> filter(fn: (r) => r["_measurement"] == "{measurement}")
          |> limit(n: {limit})
          |> sort(columns: ["_time"], desc: true)
        '''
        result = query_api.query(org=INFLUXDB_ORG, query=query)
        data = []
        for table in result:
            for record in table.records:
                data.append({
                    "time": record.get_time().isoformat(),
                    "field": record.get_field(),
                    "value": record.get_value(),
                    **{k: v for k, v in record.values.items() if k not in ["_time", "_measurement", "_field", "_value"]},
                })
        return {
            "success": True,
            "measurement": measurement,
            "count": len(data),
            "data": data,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"데이터 조회 실패: {str(e)}")


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket_endpoint(websocket)


