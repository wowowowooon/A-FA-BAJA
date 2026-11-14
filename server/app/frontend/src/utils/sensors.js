export const getNumericValueFromData = (data) => {
  if (!data) return null
  if (typeof data.value === 'number') return data.value
  if (data.parsed && typeof data.parsed === 'object') {
    if (typeof data.parsed.speed === 'number') return data.parsed.speed
    if (typeof data.parsed.motor_speed === 'number') return data.parsed.motor_speed
    if (typeof data.parsed.soc === 'number') return data.parsed.soc
    if (typeof data.parsed.voltage === 'number') return data.parsed.voltage
    if (typeof data.parsed.current === 'number') return data.parsed.current
    if (typeof data.parsed.angle === 'number') return data.parsed.angle
  }
  if (typeof data.parsed === 'number') return data.parsed
  if (typeof data === 'number') return data
  return null
}

const lastAccelCache = { x: 0, y: 0, z: 0 }
const lastImuAccelCache = { x: 0, y: 0, z: 0 }
const lastImuOrientationCache = { roll: 0, pitch: 0, yaw: 0 }

export const resetSensorDisplayCaches = () => {
  lastAccelCache.x = 0
  lastAccelCache.y = 0
  lastAccelCache.z = 0
  lastImuAccelCache.x = 0
  lastImuAccelCache.y = 0
  lastImuAccelCache.z = 0
  lastImuOrientationCache.roll = 0
  lastImuOrientationCache.pitch = 0
  lastImuOrientationCache.yaw = 0
}

export const getAccelerationValues = (sensorData) => {
  const entries = Object.entries(sensorData)
  const match = entries.find(([, data]) => data?.sensor_info?.type === 'acceleration')
  if (!match) return { ...lastAccelCache }
  const data = match[1]
  const parsed = data?.parsed
  if (parsed && typeof parsed === 'object') {
    const next = {
      x: typeof parsed.x === 'number' ? parsed.x : 0,
      y: typeof parsed.y === 'number' ? parsed.y : 0,
      z: typeof parsed.z === 'number' ? parsed.z : 0,
    }
    lastAccelCache.x = next.x
    lastAccelCache.y = next.y
    lastAccelCache.z = next.z
    return next
  }
  return { ...lastAccelCache }
}

export const getImuAccelerationValues = (sensorData) => {
  const entries = Object.entries(sensorData)
  const match = entries.find(([, data]) => data?.sensor_info?.type === 'imu_acceleration')
  if (!match) return { ...lastImuAccelCache }
  const parsed = match[1]?.parsed
  if (parsed && typeof parsed === 'object') {
    const next = {
      x: typeof parsed.x === 'number' ? parsed.x : 0,
      y: typeof parsed.y === 'number' ? parsed.y : 0,
      z: typeof parsed.z === 'number' ? parsed.z : 0,
    }
    lastImuAccelCache.x = next.x
    lastImuAccelCache.y = next.y
    lastImuAccelCache.z = next.z
    return next
  }
  return { ...lastImuAccelCache }
}

export const getImuOrientationValues = (sensorData) => {
  const entries = Object.entries(sensorData)
  const match = entries.find(([, data]) => data?.sensor_info?.type === 'imu_orientation')
  if (!match) return { ...lastImuOrientationCache }
  const parsed = match[1]?.parsed
  if (parsed && typeof parsed === 'object') {
    const next = {
      roll: typeof parsed.roll === 'number' ? parsed.roll : 0,
      pitch: typeof parsed.pitch === 'number' ? parsed.pitch : 0,
      yaw: typeof parsed.yaw === 'number' ? parsed.yaw : 0,
    }
    lastImuOrientationCache.roll = next.roll
    lastImuOrientationCache.pitch = next.pitch
    lastImuOrientationCache.yaw = next.yaw
    return next
  }
  return { ...lastImuOrientationCache }
}

export const formatSensorValue = (topic, data) => {
  if (!data) return 'N/A'

  if (typeof data === 'object') {
    if (data.parsed && typeof data.parsed === 'object') {
      const { x, y, z } = data.parsed
      if ([x, y, z].every((v) => typeof v === 'number')) {
        const unit = data.sensor_info?.unit || data.unit || 'g'
        const fmt = (v) => (v % 1 === 0 ? v : v.toFixed(2))
        return `x:${fmt(x)} y:${fmt(y)} z:${fmt(z)} ${unit}`
      }
    }

    if (data.value !== undefined && data.value !== null) {
      if (typeof data.value === 'number') {
        return data.value % 1 === 0 ? data.value : data.value.toFixed(1)
      }
      return data.value
    }

    if (data.parsed) {
      const parsed = data.parsed
      if (typeof parsed === 'number') return parsed
      if (typeof parsed === 'object') {
        if (parsed.speed !== undefined) return parsed.speed
        if (parsed.motor_speed !== undefined) return parsed.motor_speed
        if (parsed.soc !== undefined) return parsed.soc
        if (parsed.voltage !== undefined) return parsed.voltage
        if (parsed.current !== undefined) return parsed.current
        if (parsed.angle !== undefined) return parsed.angle
        if (parsed.temperature) {
          const temp = parsed.temperature
          if (typeof temp === 'object' && temp.max && temp.max.value !== undefined) {
            return temp.max.value
          }
          if (typeof temp === 'number') return temp
        }
      }
    }

    const { sensor_info, timestamp, parsed, name, type, position, unit, ...other } = data
    for (const value of Object.values(other)) {
      if (typeof value === 'number') {
        return value
      }
    }

    return 'N/A'
  }

  return data
}

export const getSensorName = (topic, data) => {
  if (data?.sensor_info?.name) {
    return data.sensor_info.name
  }
  const parts = topic.split('/')
  const last = parts[parts.length - 1]
  return last.charAt(0).toUpperCase() + last.slice(1)
}

export const getSensorUnit = (topic, data) => {
  if (data?.sensor_info?.unit) {
    return data.sensor_info.unit
  }
  if (topic.includes('speed')) return 'km/h'
  if (topic.includes('rpm')) return 'rpm'
  if (topic.includes('temperature')) return '°C'
  if (topic.includes('pressure')) return 'bar'
  if (topic.includes('battery') || topic.includes('fuel')) return '%'
  if (topic.includes('voltage')) return 'V'
  if (topic.includes('current')) return 'A'
  if (topic.includes('steering') || topic.includes('angle')) return '°'
  if (topic.includes('torque')) return 'Nm'
  if (topic.includes('throttle') || topic.includes('brake')) return '%'
  return ''
}

export const getFixedItemValue = (sensorData, item) => {
  const entries = Object.entries(sensorData)
  const match = entries.find(([topic, data]) => item.match(topic, data))
  if (!match) {
    return { value: 0, unit: item.unit }
  }
  const [, data] = match
  const formatted = formatSensorValue(match[0], data)
  if (typeof formatted === 'number') {
    return { value: formatted, unit: getSensorUnit(match[0], data) || item.unit }
  }
  return { value: formatted, unit: item.unit }
}

export const getSpeedValue = (sensorData, items) => {
  const speedItem = items.find((item) => item.id === 'speed')
  if (!speedItem) return 0
  const entries = Object.entries(sensorData)
  const match = entries.find(([topic, data]) => speedItem.match(topic, data))
  if (!match) return 0
  const numeric = getNumericValueFromData(match[1])
  return typeof numeric === 'number' ? numeric : 0
}

export const getRpmValue = (sensorData, items) => {
  const rpmItem = items.find((item) => item.id === 'rpm')
  if (!rpmItem) return 0
  const entries = Object.entries(sensorData)
  const match = entries.find(([topic, data]) => rpmItem.match(topic, data))
  if (!match) return 0
  const numeric = getNumericValueFromData(match[1])
  return typeof numeric === 'number' ? numeric : 0
}

export const getGearValue = (sensorData, items) => {
  const gearItem = items.find((item) => item.id === 'gear')
  if (!gearItem) return '-'
  const entries = Object.entries(sensorData)
  const match = entries.find(([topic, data]) => gearItem.match(topic, data))
  if (!match) return '-'
  const data = match[1]
  if (data?.value !== undefined && data?.value !== null) {
    return data.value
  }
  const numeric = getNumericValueFromData(data)
  return numeric !== null ? numeric : '-'
}

export const getLinearValue = (sensorData, key) => {
  const entries = Object.entries(sensorData)
  const match = entries.find(([topic]) => topic.includes(key))
  if (!match) return 0
  const numeric = getNumericValueFromData(match[1])
  return typeof numeric === 'number' ? numeric : 0
}

const G_FORCE_SIDE = {
  l: {
    type: 'gforce_l',
    topics: ['yaw_l', 'g_force_l'],
  },
  r: {
    type: 'gforce_r',
    topics: ['yaw_r', 'g_force_r'],
  },
}

const extractGForceZ = (data) => {
  if (!data) return null
  const parsed = data.parsed
  if (parsed && typeof parsed === 'object' && typeof parsed.z === 'number') {
    return parsed.z
  }
  if (typeof parsed === 'number') return parsed
  if (typeof data.value === 'number') return data.value
  return getNumericValueFromData(data)
}

/** G-force L/R: 별도 가속도 센서 xyz 중 z만 사용. IMU 가속도와 분리. */
export const getGForceValue = (sensorData, side) => {
  const config = G_FORCE_SIDE[side]
  if (!config) return 0
  const entries = Object.entries(sensorData)
  const match = entries.find(([topic, data]) => {
    const sensorType = data?.sensor_info?.type || data?.type
    if (sensorType === config.type) return true
    return config.topics.some((key) => topic.includes(key))
  })
  if (!match) return 0
  const numeric = extractGForceZ(match[1])
  return typeof numeric === 'number' ? numeric : 0
}

export const getLatestGps = (sensorData) => {
  let latest = null
  for (const data of Object.values(sensorData)) {
    const parsed = data?.parsed
    const lat = parsed?.lat
    const lon = parsed?.lon
    if (typeof lat !== 'number' || typeof lon !== 'number') continue
    let ts = data.ts_ms
    if (!ts) {
      const raw = data.timestamp || data.datetime || data.time || 0
      ts = raw > 1e12 ? raw : raw * 1000
    }
    if (!latest || ts > latest.ts) {
      const speed =
        typeof parsed?.speed_kmh === 'number'
          ? parsed.speed_kmh
          : typeof parsed?.speed === 'number'
            ? parsed.speed
            : undefined
      latest = {
        lat,
        lon,
        ts,
        ...(typeof parsed?.course_deg === 'number' ? { course_deg: parsed.course_deg } : {}),
        ...(typeof speed === 'number' ? { speed_kmh: speed } : {}),
      }
    }
  }
  return latest
}

export const getDistanceMeters = (a, b) => {
  const toRad = (deg) => (deg * Math.PI) / 180
  const R = 6371000
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  return 2 * R * Math.asin(Math.sqrt(h))
}

export const formatElapsed = (ms) => {
  const totalMs = Math.max(0, Math.floor(ms))
  const minutes = Math.floor(totalMs / 60000)
  const seconds = Math.floor((totalMs % 60000) / 1000)
  const tenths = Math.floor((totalMs % 1000) / 100)
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  return `${mm}:${ss}.${tenths}`
}
