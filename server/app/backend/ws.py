import asyncio
from typing import List

from fastapi import WebSocket, WebSocketDisconnect


# 좀비 연결(상대가 FIN/RST을 보냈으나 send 시스템콜이 즉시 실패하지 않는 경우)에
# broadcast 가 영원히 매달리지 않도록 강제 시간 제한을 둡니다.
BROADCAST_SEND_TIMEOUT_SEC = 1.0

# WS broadcast 처리 대기 큐 최대 크기. 가득 차면 가장 오래된 항목을 drop 하여
# 메인 이벤트 루프 task 누적으로 인한 starvation 을 차단합니다.
# InfluxDB 저장 경로(save_mqtt_to_influxdb)와는 독립이라 저장에는 영향이 없습니다.
BROADCAST_QUEUE_MAXSIZE = 5000
ORDERED_DISPATCH_MAXSIZE = 5000
ORDERED_DISPATCH_INTERVAL_SEC = 0.02


class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        async with self._lock:
            self.active_connections.append(websocket)

    async def disconnect(self, websocket: WebSocket):
        async with self._lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)
        try:
            await websocket.close()
        except Exception:
            pass

    async def broadcast(self, message: dict):
        async with self._lock:
            connections = list(self.active_connections)
        if not connections:
            return

        async def _safe_send(ws: WebSocket):
            try:
                await asyncio.wait_for(
                    ws.send_json(message),
                    timeout=BROADCAST_SEND_TIMEOUT_SEC,
                )
                return None
            except Exception:
                return ws

        results = await asyncio.gather(
            *[_safe_send(ws) for ws in connections],
            return_exceptions=False,
        )
        dead = [ws for ws in results if ws is not None]
        if dead:
            async with self._lock:
                for ws in dead:
                    if ws in self.active_connections:
                        self.active_connections.remove(ws)
            for ws in dead:
                try:
                    await ws.close()
                except Exception:
                    pass


manager = ConnectionManager()


class BroadcastQueue:
    """
    MQTT 콜백 스레드에서 던지는 broadcast 요청을 메인 이벤트 루프의 단일 워커가
    소비하는 bounded async queue. drop-oldest 정책으로 어떤 경우에도 task 가
    무제한 누적되어 루프를 마비시키지 않도록 한다.

    저장(save_mqtt_to_influxdb / 녹화 stream) 경로와는 완전히 독립이며 화면
    표시(WS) 부하만 흡수한다.
    """

    def __init__(self, mgr: ConnectionManager, max_pending: int = BROADCAST_QUEUE_MAXSIZE):
        self._manager = mgr
        self._max = max_pending
        self._queue: "asyncio.Queue[dict] | None" = None
        self._worker_future = None
        self._dropped = 0
        self._dropped_last_logged = 0

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        if self._worker_future is not None:
            return
        self._worker_future = asyncio.run_coroutine_threadsafe(self._run(), loop)

    async def _run(self) -> None:
        self._queue = asyncio.Queue(maxsize=self._max)
        while True:
            try:
                msg = await self._queue.get()
            except asyncio.CancelledError:
                return
            try:
                await self._manager.broadcast(msg)
            except Exception as e:
                print(f"❌ broadcast worker err: {e}")

    def submit(self, loop: asyncio.AbstractEventLoop, message: dict) -> None:
        """다른 스레드(특히 MQTT 콜백)에서 안전하게 호출."""
        loop.call_soon_threadsafe(self._enqueue, message)

    def _enqueue(self, message: dict) -> None:
        if self._queue is None:
            return
        if self._queue.full():
            try:
                self._queue.get_nowait()
                self._dropped += 1
                if self._dropped - self._dropped_last_logged >= 100:
                    self._dropped_last_logged = self._dropped
                    print(
                        f"⚠️ WS broadcast 큐 가득참 — drop 누적 {self._dropped}건 "
                        f"(maxsize={self._max}). 저장 경로엔 영향 없음."
                    )
            except asyncio.QueueEmpty:
                pass
        try:
            self._queue.put_nowait(message)
        except asyncio.QueueFull:
            # 동시성 경합으로 여전히 full 인 매우 드문 케이스 — 이번 메시지는 drop
            self._dropped += 1

    def stats(self) -> dict:
        return {
            "size": self._queue.qsize() if self._queue else 0,
            "maxsize": self._max,
            "dropped": self._dropped,
        }


broadcast_queue = BroadcastQueue(manager)


class OrderedTelemetryDispatcher:
    """
    수신된 텔레메트리를 짧은 시간 단위로 모아 ts_ms/seq 순서대로 WS 큐에 넣는다.
    같은 토픽은 최신값 1개만 유지해 화면 표시용 지연/누적을 막는다.
    """

    def __init__(
        self,
        out_queue: BroadcastQueue,
        max_pending: int = ORDERED_DISPATCH_MAXSIZE,
        flush_interval: float = ORDERED_DISPATCH_INTERVAL_SEC,
    ):
        self._out_queue = out_queue
        self._max = max_pending
        self._interval = flush_interval
        self._pending: dict[str, dict] = {}
        self._worker_future = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._dropped = 0

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        if self._worker_future is not None:
            return
        self._loop = loop
        self._worker_future = asyncio.run_coroutine_threadsafe(self._run(), loop)

    def submit(self, loop: asyncio.AbstractEventLoop, message: dict) -> None:
        loop.call_soon_threadsafe(self._ingest, message)

    def _ingest(self, message: dict) -> None:
        topic = message.get("topic") or message.get("data", {}).get("topic") or "_unknown"
        if len(self._pending) >= self._max and topic not in self._pending:
            oldest_topic = min(
                self._pending,
                key=lambda key: (
                    self._pending[key].get("ts_ms") or 0,
                    self._pending[key].get("seq") or 0,
                ),
            )
            self._pending.pop(oldest_topic, None)
            self._dropped += 1
        self._pending[topic] = message

    async def _run(self) -> None:
        while True:
            try:
                await asyncio.sleep(self._interval)
            except asyncio.CancelledError:
                return
            if not self._pending or self._loop is None:
                continue
            items = sorted(
                self._pending.values(),
                key=lambda item: (item.get("ts_ms") or 0, item.get("seq") or 0),
            )
            self._pending.clear()
            for item in items:
                self._out_queue.submit(self._loop, item)

    def stats(self) -> dict:
        return {
            "size": len(self._pending),
            "maxsize": self._max,
            "dropped": self._dropped,
            "out_of_order_dropped": 0,
            "flush_interval_ms": int(self._interval * 1000),
        }


ordered_dispatcher = OrderedTelemetryDispatcher(broadcast_queue)


async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        await websocket.send_json({
            "type": "connection",
            "status": "connected",
            "message": "WebSocket 연결 성공",
        })
        while True:
            try:
                data = await websocket.receive_text()
                if data == "ping":
                    await websocket.send_json({"type": "pong"})
            except WebSocketDisconnect:
                break
            except Exception as e:
                print(f"WebSocket 오류: {e}")
                break
    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(websocket)
