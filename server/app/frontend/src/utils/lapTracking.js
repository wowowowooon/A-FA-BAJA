/** 두 좌표 간 거리 (미터) */
export function distanceMeters(a, b) {
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

export const MIN_POINT_DISTANCE_M = 2
export const MIN_LAP_DISTANCE_M = 60
export const LAP_CLOSE_RADIUS_M = 1

export function formatLapTime(ms) {
  const totalMs = Math.max(0, Math.floor(ms))
  const minutes = Math.floor(totalMs / 60000)
  const seconds = Math.floor((totalMs % 60000) / 1000)
  const tenths = Math.floor((totalMs % 1000) / 100)
  const ss = String(seconds).padStart(2, '0')
  if (minutes > 0) return `${minutes}:${ss}.${tenths}`
  return `${seconds}.${tenths}s`
}

/** 경로 총 길이 (미터) */
export function pathLengthMeters(points) {
  if (!points || points.length < 2) return 0
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += distanceMeters(points[i - 1], points[i])
  }
  return total
}

/** 각 포인트까지의 누적 거리 배열 (첫 점 = 0m) */
export function cumulativePathDistances(points) {
  if (!points?.length) return []
  const cumulative = [0]
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + distanceMeters(points[i - 1], points[i]))
  }
  return cumulative
}

export function formatDistanceMeters(meters) {
  if (!Number.isFinite(meters)) return '-- m'
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(2)} km`
  }
  return `${meters.toFixed(2)} m`
}

export function formatSpeedKmh(speed, { estimated = false } = {}) {
  if (!Number.isFinite(speed)) return '-- km/h'
  const label = `${speed.toFixed(1)} km/h`
  return estimated ? `${label} (추정)` : label
}

/** Baja/오프로드 상한 — 이 값을 넘으면 랩 평균으로 보정 */
export const MAX_TRACK_SPEED_KMH = 85
const LAP_SPEED_MARGIN = 1.35

/** 거리(m)와 시간(ms)로 km/h 추정 */
export function speedKmhFromDistanceAndTime(distanceM, deltaMs) {
  if (!Number.isFinite(distanceM) || !Number.isFinite(deltaMs) || deltaMs <= 0) return null
  return (distanceM * 3600) / deltaMs
}

/** 랩 전체 거리·시간으로 평균 속도(km/h) */
export function averageSpeedKmh(points, durationMs) {
  if (!points?.length || !durationMs || durationMs <= 0) return null
  const dist = pathLengthMeters(points)
  if (dist <= 0) return null
  return (dist / (durationMs / 1000)) * 3.6
}

/** GPS 튐·짧은 구간 오차 등 비현실 속도 보정 (저장된 GPS 값용) */
export function sanitizeSpeedKmh(speed, lapAvgKmh) {
  if (!Number.isFinite(speed)) return lapAvgKmh ?? null
  let maxAllowed = MAX_TRACK_SPEED_KMH
  if (Number.isFinite(lapAvgKmh) && lapAvgKmh > 0) {
    maxAllowed = Math.min(MAX_TRACK_SPEED_KMH, lapAvgKmh * LAP_SPEED_MARGIN)
  }
  if (speed > maxAllowed) {
    return Number.isFinite(lapAvgKmh) ? lapAvgKmh : maxAllowed
  }
  return speed
}

const MIN_SEGMENT_MS = 800
const MAX_SEGMENT_MS = 12000
const SEGMENT_SPIKE_RATIO = 2.0

function isPlausibleSegmentSpeed(raw, lapAvgKmh) {
  if (!Number.isFinite(raw) || raw < 0) return false
  if (raw > MAX_TRACK_SPEED_KMH) return false
  if (Number.isFinite(lapAvgKmh) && lapAvgKmh > 0 && raw > lapAvgKmh * SEGMENT_SPIKE_RATIO) {
    return false
  }
  return true
}

function segmentSpeedKmh(points, index, lapAvgKmh) {
  if (index <= 0 || index >= points.length) return null
  const pt = points[index]
  const prev = points[index - 1]
  if (pt.ts == null || prev.ts == null) return null
  const deltaMs = pt.ts - prev.ts
  if (deltaMs < MIN_SEGMENT_MS || deltaMs > MAX_SEGMENT_MS) return null
  const raw = speedKmhFromDistanceAndTime(distanceMeters(prev, pt), deltaMs)
  if (!isPlausibleSegmentSpeed(raw, lapAvgKmh)) return null
  return raw
}

function interpolateSpeedGaps(points, speeds) {
  const n = speeds.length
  let i = 0
  while (i < n) {
    if (speeds[i] != null) {
      i += 1
      continue
    }
    const gapStart = i
    while (i < n && speeds[i] == null) i += 1
    const gapEnd = i
    const leftIdx = gapStart - 1
    const rightIdx = gapEnd
    const leftSpeed = leftIdx >= 0 ? speeds[leftIdx] : null
    const rightSpeed = rightIdx < n ? speeds[rightIdx] : null
    const leftTs = leftIdx >= 0 ? points[leftIdx].ts : null
    const rightTs = rightIdx < n ? points[rightIdx].ts : null

    for (let j = gapStart; j < gapEnd; j += 1) {
      const ts = points[j].ts
      if (
        leftSpeed != null &&
        rightSpeed != null &&
        leftTs != null &&
        rightTs != null &&
        rightTs > leftTs &&
        ts != null
      ) {
        const ratio = (ts - leftTs) / (rightTs - leftTs)
        speeds[j] = leftSpeed + (rightSpeed - leftSpeed) * ratio
      } else if (leftSpeed != null) {
        speeds[j] = leftSpeed
      } else if (rightSpeed != null) {
        speeds[j] = rightSpeed
      }
    }
  }
}

/**
 * 저장 경로 속도 보강:
 * 1) 저장된 speed_kmh  2) 유효 구간 속도  3) 앵커 간 시간 보간  4) 랩 평균
 */
export function enrichTrackPointsWithSpeed(points, durationMs) {
  if (!points?.length) return []
  const lapAvg = averageSpeedKmh(points, durationMs)
  const n = points.length
  const speeds = new Array(n).fill(null)
  const fromStored = new Array(n).fill(false)

  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(points[i].speed_kmh)) continue
    const sanitized = sanitizeSpeedKmh(points[i].speed_kmh, lapAvg)
    if (sanitized == null) continue
    speeds[i] = sanitized
    fromStored[i] =
      !points[i].speed_estimated &&
      Math.abs(sanitized - points[i].speed_kmh) < 0.05
  }

  for (let i = 1; i < n; i += 1) {
    if (speeds[i] != null) continue
    const incoming = segmentSpeedKmh(points, i, lapAvg)
    const outgoing = i < n - 1 ? segmentSpeedKmh(points, i + 1, lapAvg) : null
    if (incoming != null && outgoing != null) {
      speeds[i] = (incoming + outgoing) / 2
    } else if (incoming != null) {
      speeds[i] = incoming
    } else if (outgoing != null) {
      speeds[i] = outgoing
    }
  }

  interpolateSpeedGaps(points, speeds)

  for (let i = 0; i < n; i += 1) {
    if (speeds[i] == null && lapAvg != null) speeds[i] = lapAvg
  }

  return points.map((pt, i) => {
    const speed = speeds[i]
    if (speed == null) return pt
    const rounded = Math.round(speed * 10) / 10
    const estimated = !fromStored[i]
    if (fromStored[i] && pt.speed_kmh === rounded) return pt
    return { ...pt, speed_kmh: rounded, speed_estimated: estimated }
  })
}

/** 경로 상 두 인덱스 사이 주행 거리 (미터) */
export function pathDistanceBetweenIndices(cumulative, indexA, indexB) {
  if (!cumulative?.length) return 0
  const a = cumulative[indexA] ?? 0
  const b = cumulative[indexB] ?? 0
  return Math.abs(b - a)
}

/** 경로 상 두 인덱스 사이 포인트 슬라이스 */
export function slicePathBetweenIndices(points, indexA, indexB) {
  if (!points?.length) return []
  const start = Math.min(indexA, indexB)
  const end = Math.max(indexA, indexB)
  return points.slice(start, end + 1)
}

export function createTrackPoint(lat, lon, ts, speedKmh) {
  const point = { lat, lon, ts }
  if (typeof speedKmh === 'number' && Number.isFinite(speedKmh)) {
    point.speed_kmh = speedKmh
  }
  return point
}

/** 새 GPS 포인트를 현재 랩에 추가하고 폐루프 여부 판정 */
export function processGpsForLap(state, lat, lon, ts, speedKmh) {
  const point = createTrackPoint(lat, lon, ts, speedKmh)
  const next = {
    laps: [...state.laps],
    currentLap: {
      lapNumber: state.currentLap.lapNumber,
      startedAt: state.currentLap.startedAt,
      points: [...state.currentLap.points],
      distanceM: state.currentLap.distanceM,
      startPoint: state.currentLap.startPoint,
    },
    allPoints: [...state.allPoints],
  }

  const last = next.currentLap.points[next.currentLap.points.length - 1]
  if (last && distanceMeters(last, point) < MIN_POINT_DISTANCE_M) {
    return { state: next, lapCompleted: null }
  }

  if (last) {
    next.currentLap.distanceM += distanceMeters(last, point)
  }

  next.currentLap.points.push(point)
  next.allPoints.push(point)

  const { startPoint, distanceM, points, startedAt, lapNumber } = next.currentLap
  if (
    startPoint &&
    points.length >= 4 &&
    distanceM >= MIN_LAP_DISTANCE_M &&
    distanceMeters(startPoint, point) <= LAP_CLOSE_RADIUS_M
  ) {
    const durationMs = ts - startedAt
    const completedLap = {
      lap: lapNumber,
      durationMs,
      startedAt,
      endedAt: ts,
      points: [...points],
    }
    next.laps.push(completedLap)

    next.currentLap = {
      lapNumber: lapNumber + 1,
      startedAt: ts,
      points: [point],
      distanceM: 0,
      startPoint: point,
    }

    return { state: next, lapCompleted: completedLap }
  }

  if (!next.currentLap.startPoint) {
    next.currentLap.startPoint = point
    next.currentLap.startedAt = ts
  }

  return { state: next, lapCompleted: null }
}

/** 수동 1랩 기록 (자동 폐루프 감지가 어려울 때) */
export function completeLapManually(state, lat, lon, ts = Date.now(), speedKmh) {
  const current = state.currentLap
  if (!current.points.length) {
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat)) {
      return { state, lapCompleted: null }
    }
    const point = createTrackPoint(lat, lon, ts, speedKmh)
    return {
      state: {
        ...state,
        currentLap: {
          ...current,
          startedAt: ts,
          startPoint: point,
          points: [point],
          distanceM: 0,
        },
        allPoints: [...state.allPoints, point],
      },
      lapCompleted: null,
    }
  }

  const lastPoint = current.points[current.points.length - 1]
  const endPoint =
    typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat)
      ? createTrackPoint(lat, lon, ts, speedKmh)
      : lastPoint
  const startedAt = current.startedAt || current.points[0].ts
  const completedLap = {
    lap: current.lapNumber,
    durationMs: Math.max(0, ts - startedAt),
    startedAt,
    endedAt: ts,
    points: [...current.points],
    manual: true,
  }

  const nextPoint = endPoint
  return {
    state: {
      laps: [...state.laps, completedLap],
      currentLap: {
        lapNumber: current.lapNumber + 1,
        startedAt: ts,
        points: [nextPoint],
        distanceM: 0,
        startPoint: nextPoint,
      },
      allPoints: [...state.allPoints],
    },
    lapCompleted: completedLap,
  }
}

export function createInitialLapState() {
  return {
    laps: [],
    currentLap: {
      lapNumber: 1,
      startedAt: null,
      points: [],
      distanceM: 0,
      startPoint: null,
    },
    allPoints: [],
  }
}

export function buildTrackSegments(laps, currentLap) {
  const segments = laps.map((lap, index) => ({
    lap: lap.lap,
    points: lap.points,
    isCurrent: false,
    colorIndex: index,
    manual: Boolean(lap.manual),
  }))
  if (currentLap.points.length >= 2) {
    segments.push({
      lap: currentLap.lapNumber,
      points: currentLap.points,
      isCurrent: true,
      colorIndex: segments.length,
      manual: false,
    })
  }
  return segments
}

/** 분석실 저장용: 완료된 랩만 (수동 포함), 진행 중 랩 제외 */
export function buildCompletedTrackSegments(laps) {
  return laps.map((lap, index) => ({
    lap: lap.lap,
    points: lap.points,
    isCurrent: false,
    colorIndex: index,
    manual: Boolean(lap.manual),
  }))
}

export function findNearestPointOnTrack(points, lat, lon) {
  if (!points?.length) return null
  let best = null
  let bestIndex = -1
  let bestDist = Infinity
  for (let i = 0; i < points.length; i++) {
    const pt = points[i]
    const dist = distanceMeters({ lat, lon }, pt)
    if (dist < bestDist) {
      bestDist = dist
      best = pt
      bestIndex = i
    }
  }
  if (!best) return null
  return { ...best, index: bestIndex }
}

/** JSONL GPS에서 경로 추출 + 랩 재계산 (분석실 폴백) */
export function rebuildLapsFromPoints(rawPoints) {
  let state = createInitialLapState()
  const completed = []
  for (const pt of rawPoints) {
    const result = processGpsForLap(state, pt.lat, pt.lon, pt.ts)
    state = result.state
    if (result.lapCompleted) completed.push(result.lapCompleted)
  }
  return {
    laps: state.laps,
    segments: buildTrackSegments(state.laps, state.currentLap),
    allPoints: state.allPoints,
  }
}
