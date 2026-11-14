import { useCallback, useEffect, useRef, useState } from 'react'

import { resetSensorDisplayCaches } from '../utils/sensors'

const POLL_SUPPRESS_MS = 3000

const createEmptyBatch = () => ({
  dirty: false,
  accel: undefined,
  imuAccel: undefined,
  imuOrientation: undefined,
})

export default function useWebSocket(wsUrl, apiUrl) {
  const [sensorData, setSensorData] = useState({})
  const [isConnected, setIsConnected] = useState(false)
  const [accelData, setAccelData] = useState(null)
  const [imuAccelData, setImuAccelData] = useState(null)
  const [imuOrientation, setImuOrientation] = useState(null)

  const wsRef = useRef(null)
  const lastMessageRef = useRef(0)
  const pollLockRef = useRef(false)
  const suppressPollUntilRef = useRef(0)
  const sensorDataRef = useRef({})
  const batchRef = useRef(createEmptyBatch())
  const rafRef = useRef(null)

  const flushBatch = useCallback(() => {
    rafRef.current = null
    const batch = batchRef.current
    if (!batch.dirty) return

    batch.dirty = false
    setSensorData({ ...sensorDataRef.current })

    if (batch.accel !== undefined) {
      setAccelData(batch.accel)
      batch.accel = undefined
    }
    if (batch.imuAccel !== undefined) {
      setImuAccelData(batch.imuAccel)
      batch.imuAccel = undefined
    }
    if (batch.imuOrientation !== undefined) {
      setImuOrientation(batch.imuOrientation)
      batch.imuOrientation = undefined
    }
  }, [])

  const scheduleFlush = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(flushBatch)
  }, [flushBatch])

  const ingestMessage = useCallback(
    (message) => {
      if (message.type === 'connection') return
      if (message.type !== 'mqtt' || !message.data) return

      const sensorInfo = message.sensor_info || {
        name: message.data.name,
        type: message.data.type,
        position: message.data.position,
        unit: message.data.unit,
      }
      lastMessageRef.current = Date.now()
      const ts = message.timestamp || message.data.timestamp || Date.now()
      const batch = batchRef.current
      batch.dirty = true

      if (sensorInfo.type === 'acceleration' && message.data?.parsed) {
        batch.accel = {
          x: message.data.parsed?.x ?? 0,
          y: message.data.parsed?.y ?? 0,
          z: message.data.parsed?.z ?? 0,
          timestamp: ts,
        }
        scheduleFlush()
        return
      }
      if (sensorInfo.type === 'imu_acceleration' && message.data?.parsed) {
        batch.imuAccel = {
          x: message.data.parsed?.x ?? 0,
          y: message.data.parsed?.y ?? 0,
          z: message.data.parsed?.z ?? 0,
          timestamp: ts,
        }
        scheduleFlush()
        return
      }
      if (sensorInfo.type === 'imu_orientation' && message.data?.parsed) {
        batch.imuOrientation = {
          roll: message.data.parsed?.roll ?? 0,
          pitch: message.data.parsed?.pitch ?? 0,
          yaw: message.data.parsed?.yaw ?? 0,
          timestamp: ts,
        }
        scheduleFlush()
        return
      }

      sensorDataRef.current[message.topic] = {
        ...message.data,
        sensor_info: sensorInfo,
        timestamp: ts,
      }
      scheduleFlush()
    },
    [scheduleFlush]
  )

  const applyLatestSnapshot = useCallback(
    (data) => {
      if (!data || typeof data !== 'object') return

      sensorDataRef.current = { ...sensorDataRef.current, ...data }
      const batch = batchRef.current
      batch.dirty = true

      for (const item of Object.values(data)) {
        const sensorType = item?.sensor_info?.type || item?.type
        if (!item?.parsed) continue
        if (sensorType === 'acceleration') {
          batch.accel = {
            x: item.parsed?.x ?? 0,
            y: item.parsed?.y ?? 0,
            z: item.parsed?.z ?? 0,
            timestamp: item.timestamp || item.datetime,
          }
        } else if (sensorType === 'imu_acceleration') {
          batch.imuAccel = {
            x: item.parsed?.x ?? 0,
            y: item.parsed?.y ?? 0,
            z: item.parsed?.z ?? 0,
            timestamp: item.timestamp || item.datetime,
          }
        } else if (sensorType === 'imu_orientation') {
          batch.imuOrientation = {
            roll: item.parsed?.roll ?? 0,
            pitch: item.parsed?.pitch ?? 0,
            yaw: item.parsed?.yaw ?? 0,
            timestamp: item.timestamp || item.datetime,
          }
        }
      }
      scheduleFlush()
    },
    [scheduleFlush]
  )

  const clearDisplayState = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    sensorDataRef.current = {}
    batchRef.current = createEmptyBatch()
    setSensorData({})
    setAccelData(null)
    setImuAccelData(null)
    setImuOrientation(null)
    resetSensorDisplayCaches()
    const now = Date.now()
    lastMessageRef.current = now
    suppressPollUntilRef.current = now + POLL_SUPPRESS_MS
  }, [])

  useEffect(() => {
    if (!wsUrl) return
    let reconnectTimeout = null
    let reconnectAttempts = 0

    const connectWebSocket = () => {
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        reconnectAttempts = 0
        setIsConnected(true)
      }

      ws.onmessage = (event) => {
        try {
          ingestMessage(JSON.parse(event.data))
        } catch (e) {
          // ignore malformed packets
        }
      }

      ws.onerror = () => {}

      ws.onclose = () => {
        setIsConnected(false)
        scheduleReconnect()
      }
    }

    const scheduleReconnect = () => {
      if (reconnectTimeout) return
      reconnectAttempts += 1
      const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(reconnectAttempts, 5)))
      reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null
        connectWebSocket()
      }, delay)
    }

    connectWebSocket()

    const pollLatest = async () => {
      if (!apiUrl || pollLockRef.current) return
      if (Date.now() < suppressPollUntilRef.current) return
      if (wsRef.current && wsRef.current.readyState === 1) return

      pollLockRef.current = true
      try {
        const response = await fetch(`${apiUrl}/api/sensors/latest`)
        if (!response.ok) return
        const payload = await response.json()
        applyLatestSnapshot(payload?.data)
      } catch (e) {
        // ignore polling errors
      } finally {
        pollLockRef.current = false
      }
    }

    const pollTimer = setInterval(pollLatest, 3000)

    return () => {
      if (reconnectTimeout) clearTimeout(reconnectTimeout)
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      clearInterval(pollTimer)
      if (wsRef.current) wsRef.current.close()
    }
  }, [wsUrl, apiUrl, ingestMessage, applyLatestSnapshot])

  return {
    sensorData,
    isConnected,
    accelData,
    imuAccelData,
    imuOrientation,
    clearDisplayState,
  }
}
