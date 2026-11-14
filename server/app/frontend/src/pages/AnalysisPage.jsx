import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import LapTrackView from '../components/LapTrackView'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { API_URL } from '../utils/apiBase'


const ELAPSED_TIME_FIELD = '__elapsedSeconds'
const MAX_CHART_POINTS = 1200
const MAX_FETCH_POINTS = 1500
const Y_AXIS_RAIL_WIDTH = 64
const Y_AXIS_GAP = 8
const PLOT_MARGIN = { top: 16, right: 16, bottom: 44, left: 16 }
const X_DOMAIN_PAD_RATIO = 0.01
const DOMAIN_PAD_RATIO = 0.28
const STROKE_PAD_RATIO = 0.02

const META_ELAPSED_KEY = 'meta.recordingElapsedSeconds'

const colorPalette = [
  '#38bdf8',
  '#f59e0b',
  '#10b981',
  '#a78bfa',
  '#ef4444',
  '#22d3ee',
  '#f472b6',
  '#84cc16',
]

function formatFieldLabel(field) {
  const raw = String(field || '')
  const stripped = raw.startsWith('extra.') ? raw.slice(6) : raw
  const parts = stripped.split('.')
  return parts[parts.length - 1] || stripped
}

function isZAxisField(field) {
  const key = String(field || '').toLowerCase()
  return (
    key.endsWith('.imu_acc_z') ||
    key === 'imu_acc_z' ||
    key.endsWith('.acc_z') ||
    key === 'acc_z'
  )
}

function isOneBaselineField(field) {
  const key = String(field || '').toLowerCase()
  return (
    isZAxisField(field) ||
    key.includes('g_force') ||
    key.endsWith('.yaw_l') ||
    key === 'yaw_l' ||
    key.endsWith('.yaw_r') ||
    key === 'yaw_r'
  )
}

function isZeroBaselineFieldKey(field) {
  return !isOneBaselineField(field)
}

/** 속도·RPM 등 절대값 지표는 첫 샘플 기준 상대값으로 바꾸지 않음 (LIVE HUD와 동일). */
function isAbsoluteQuantityField(field) {
  const key = String(field || '').toLowerCase()
  return (
    key.includes('speed') ||
    key.includes('rpm') ||
    key.includes('motor_speed') ||
    key.includes('throttle') ||
    key.includes('brake') ||
    key.includes('gear') ||
    key.includes('steering') ||
    key.includes('angle') ||
    key.includes('torque') ||
    key.includes('voltage') ||
    key.includes('current') ||
    key.includes('battery') ||
    key.includes('soc') ||
    key.includes('temperature') ||
    key.includes('pressure') ||
    key.includes('linear_') ||
    key.includes('gps_') ||
    key.includes('course_deg')
  )
}

function applyDisplayBaseline(series, fields) {
  if (!Array.isArray(series) || series.length === 0 || !fields.length) return series

  const baselines = {}
  for (const field of fields) {
    if (isAbsoluteQuantityField(field)) continue
    for (const row of series) {
      const value = row[field]
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      baselines[field] = isOneBaselineField(field) ? value - 1 : value
      break
    }
  }
  if (!Object.keys(baselines).length) return series

  return series.map((row) => {
    const next = { ...row }
    for (const [field, baseline] of Object.entries(baselines)) {
      const value = row[field]
      if (typeof value === 'number' && Number.isFinite(value)) {
        next[field] = value - baseline
      }
    }
    return next
  })
}

function buildAnchoredDomain(min, max, anchorAtZero = true) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  let lo = min
  let hi = max
  if (lo > hi) {
    const swap = lo
    lo = hi
    hi = swap
  }
  if (lo === hi) {
    const half = Math.max(Math.abs(lo) * 0.15, 0.5)
    if (anchorAtZero && lo >= 0) return [0, hi + half]
    return [lo - half, hi + half]
  }
  const span = Math.max(hi - lo, 1e-9)
  const pad = Math.max(
    span * DOMAIN_PAD_RATIO,
    Math.max(Math.abs(lo), Math.abs(hi)) * STROKE_PAD_RATIO,
    Math.min(0.5, span * 0.12)
  )
  if (anchorAtZero) {
    if (lo >= 0) return [0, hi + pad]
    if (hi <= 0) return [lo - pad, 0]
    return [lo - pad, hi + pad]
  }
  return [lo - pad, hi + pad]
}

function computeFieldDomain(field, rows) {
  let min = Infinity
  let max = -Infinity
  for (const row of rows) {
    const value = row[field]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (value < min) min = value
    if (value > max) max = value
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  return buildAnchoredDomain(min, max, true)
}

function getDomainSpan(domain) {
  if (!Array.isArray(domain) || domain.length < 2) return 1
  return Math.max(Math.abs(domain[1] - domain[0]), 1e-9)
}

function getDecimalPlacesForSpan(span) {
  if (!Number.isFinite(span) || span <= 0) return 2
  if (span >= 100) return 0
  if (span >= 20) return 1
  if (span >= 2) return 2
  if (span >= 0.2) return 3
  if (span >= 0.02) return 4
  return 5
}

function formatDomainValue(value, domain) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  const decimals = getDecimalPlacesForSpan(getDomainSpan(domain))
  return value.toFixed(decimals)
}

function buildDomainTicks(domain, count = 5) {
  const lo = domain[0]
  const hi = domain[1]
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1]
  const span = Math.max(hi - lo, 1e-9)
  const tickCount =
    span < 0.05 ? 9 : span < 0.5 ? 7 : span < 2 ? 6 : Math.max(2, count)
  if (tickCount <= 1) return [lo]
  return Array.from({ length: tickCount }, (_, i) => lo + (span * i) / (tickCount - 1))
}

function YAxisRail({ field, domain, color, unit, align }) {
  const ticks = useMemo(() => buildDomainTicks(domain, 5), [domain])
  const label = `${formatFieldLabel(field)}${unit ? ` (${unit})` : ''}`
  return (
    <div
      className="flex shrink-0 flex-col border-white/10 bg-zinc-950/80"
      style={{
        width: Y_AXIS_RAIL_WIDTH,
        marginRight: align === 'left' ? Y_AXIS_GAP : 0,
        marginLeft: align === 'right' ? Y_AXIS_GAP : 0,
        borderRightWidth: align === 'left' ? 1 : 0,
        borderLeftWidth: align === 'right' ? 1 : 0,
      }}
      title={field}
    >
      <div
        className="shrink-0 px-1 py-1.5 text-center text-[9px] font-medium leading-tight break-all"
        style={{ color }}
      >
        {label}
      </div>
      <div className="flex flex-1 flex-col justify-between py-2 px-1 min-h-0">
        {[...ticks].reverse().map((tick, i) => (
          <span
            key={i}
            className={`text-[10px] tabular-nums leading-none ${align === 'left' ? 'text-right' : 'text-left'}`}
            style={{ color: 'rgba(255,255,255,0.55)' }}
          >
            {formatDomainValue(tick, domain)}
          </span>
        ))}
      </div>
    </div>
  )
}

function rowHasPlottedValue(row, fields) {
  if (!row || !fields?.length) return false
  return fields.some((field) => {
    const value = row[field]
    return typeof value === 'number' && Number.isFinite(value)
  })
}

function getElapsedRange(series, fields = null) {
  if (!Array.isArray(series) || series.length === 0) {
    return { start: 0, end: 0 }
  }
  let min = Infinity
  let max = -Infinity
  for (const row of series) {
    if (fields?.length && !rowHasPlottedValue(row, fields)) continue
    const value = row[ELAPSED_TIME_FIELD]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (value < min) min = value
    if (value > max) max = value
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    if (fields?.length) return getElapsedRange(series, null)
    return { start: 0, end: 0 }
  }
  return { start: min, end: max }
}

function getRecordingWallElapsedSeconds(recording) {
  if (!recording?.startedAt || !recording?.endedAt) return null
  const started = Number(recording.startedAt)
  const ended = Number(recording.endedAt)
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended <= started) {
    return null
  }
  return (ended - started) / 1000
}

function trimSeriesPreservingEnds(sorted, maxPoints) {
  if (!Array.isArray(sorted) || sorted.length <= maxPoints) return sorted
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (maxPoints <= 2) return [first, last]

  const middle = sorted.slice(1, -1)
  const slots = maxPoints - 2
  const out = [first]
  const step = middle.length / slots
  for (let i = 0; i < slots; i += 1) {
    const idx = Math.min(middle.length - 1, Math.floor(i * step))
    const row = middle[idx]
    const prev = out[out.length - 1]
    if (row && row[ELAPSED_TIME_FIELD] !== prev?.[ELAPSED_TIME_FIELD]) {
      out.push(row)
    }
  }
  if (out[out.length - 1]?.[ELAPSED_TIME_FIELD] !== last[ELAPSED_TIME_FIELD]) {
    out.push(last)
  }
  return out
}

function downsampleByTime(series, maxPoints) {
  if (!Array.isArray(series) || series.length <= maxPoints) return series

  const pushUnique = (target, seen, row) => {
    if (!row) return
    const key = row[ELAPSED_TIME_FIELD]
    if (seen.has(key)) return
    seen.add(key)
    target.push(row)
  }

  const result = []
  const seen = new Set()
  pushUnique(result, seen, series[0])

  const innerTarget = Math.max(1, maxPoints - 2)
  const bucketCount = innerTarget
  const bucketSize = (series.length - 1) / bucketCount

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor(bucket * bucketSize)
    const end = Math.floor((bucket + 1) * bucketSize)
    const chunk = series.slice(start, Math.max(start + 1, end + 1))
    if (chunk.length === 0) continue

    let minRow = chunk[0]
    let maxRow = chunk[0]
    let minVal = Infinity
    let maxVal = -Infinity

    for (const row of chunk) {
      for (const key of Object.keys(row)) {
        if (key === ELAPSED_TIME_FIELD || key === 'time') continue
        const value = row[key]
        if (typeof value !== 'number' || !Number.isFinite(value)) continue
        if (value < minVal) {
          minVal = value
          minRow = row
        }
        if (value > maxVal) {
          maxVal = value
          maxRow = row
        }
      }
    }

    const mid = chunk[Math.floor(chunk.length / 2)]
    pushUnique(result, seen, mid)
    if (minRow !== mid) pushUnique(result, seen, minRow)
    if (maxRow !== mid && maxRow !== minRow) pushUnique(result, seen, maxRow)
  }

  pushUnique(result, seen, series[series.length - 1])
  const sorted = result.sort(
    (a, b) => a[ELAPSED_TIME_FIELD] - b[ELAPSED_TIME_FIELD]
  )
  return trimSeriesPreservingEnds(sorted, maxPoints)
}

function getElapsedDecimalPlacesForSpan(span) {
  if (!Number.isFinite(span) || span <= 0) return 1
  if (span >= 120) return 0
  if (span >= 30) return 1
  if (span >= 3) return 2
  if (span >= 0.3) return 3
  return 4
}

function formatElapsedSeconds(value, viewSpan = null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  const total = Math.max(0, value)
  const decimals =
    viewSpan == null ? 1 : getElapsedDecimalPlacesForSpan(viewSpan)

  if (viewSpan != null && viewSpan < 60 && decimals >= 2) {
    return `${total.toFixed(decimals)}s`
  }

  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes > 0) {
    const secWidth = decimals > 0 ? 4 : 2
    return `${minutes}:${seconds.toFixed(decimals).padStart(secWidth, '0')}`
  }
  return `${seconds.toFixed(decimals)}s`
}

function buildElapsedAxisTicks(domain, viewSpan) {
  const lo = domain[0]
  const hi = domain[1]
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return undefined
  const span = Math.max(hi - lo, 1e-9)
  const tickCount =
    viewSpan < 0.5 ? 9 : viewSpan < 2 ? 8 : viewSpan < 10 ? 7 : 6
  if (tickCount <= 1) return [lo]
  return Array.from({ length: tickCount }, (_, i) => lo + (span * i) / (tickCount - 1))
}

function parseRowElapsed(row, recordingStartedAt) {
  const metaElapsed = row[META_ELAPSED_KEY]
  if (typeof metaElapsed === 'number' && Number.isFinite(metaElapsed)) {
    return metaElapsed
  }

  const rawTime = row.time
  if (rawTime == null) return null

  if (typeof rawTime === 'number' && Number.isFinite(rawTime)) {
    if (recordingStartedAt && rawTime > 1e12) {
      return (rawTime - recordingStartedAt) / 1000
    }
    if (rawTime > 1e12) return rawTime / 1000
    return rawTime
  }

  const parsed = new Date(rawTime).getTime()
  if (Number.isNaN(parsed)) return null
  if (recordingStartedAt) return (parsed - recordingStartedAt) / 1000
  return parsed / 1000
}

function normalizeSeriesRows(series, recordingStartedAt) {
  if (!Array.isArray(series)) return []
  return series
    .map((row) => {
      const elapsed = parseRowElapsed(row, recordingStartedAt)
      if (typeof elapsed !== 'number' || !Number.isFinite(elapsed)) return null
      return { ...row, [ELAPSED_TIME_FIELD]: elapsed }
    })
    .filter(Boolean)
    .sort((a, b) => a[ELAPSED_TIME_FIELD] - b[ELAPSED_TIME_FIELD])
}

function findNearestRowByElapsed(data, elapsed) {
  if (!data.length) return null
  let best = data[0]
  let bestDist = Math.abs(best[ELAPSED_TIME_FIELD] - elapsed)
  for (let i = 1; i < data.length; i += 1) {
    const row = data[i]
    const dist = Math.abs(row[ELAPSED_TIME_FIELD] - elapsed)
    if (dist < bestDist) {
      best = row
      bestDist = dist
    }
  }
  return best
}

function AnalysisTooltip({
  active,
  payload,
  label,
  selectedFields,
  unitsMap,
  axisDomains,
  viewTimeSpan,
  getFieldColor,
}) {
  if (!active || !payload?.length) return null
  const elapsed =
    typeof label === 'number'
      ? label
      : payload[0]?.payload?.[ELAPSED_TIME_FIELD]

  return (
    <div
      className="rounded-lg border border-white/20 bg-zinc-900/95 px-3 py-2 text-xs shadow-lg"
      style={{ minWidth: 160 }}
    >
      <div className="text-zinc-400 mb-1">
        경과: {formatElapsedSeconds(elapsed, viewTimeSpan)}
      </div>
      {selectedFields.map((field) => {
        const item = payload.find((entry) => entry.dataKey === field)
        const value = item?.value ?? item?.payload?.[field]
        const domain = axisDomains?.[field] || [0, 1]
        return (
          <div key={field} style={{ color: getFieldColor(field) }}>
            {formatFieldLabel(field)}:{' '}
            {typeof value === 'number' && Number.isFinite(value)
              ? formatDomainValue(value, domain)
              : '-'}
            {unitsMap[field] ? ` ${unitsMap[field]}` : ''}
          </div>
        )
      })}
    </div>
  )
}

export default function AnalysisPage() {
  const navigate = useNavigate()
  const [recordings, setRecordings] = useState([])
  const [recordingId, setRecordingId] = useState('')
  const [fields, setFields] = useState([])
  const [selectedField, setSelectedField] = useState('')
  const [selectedFields, setSelectedFields] = useState([])
  const [unitsMap, setUnitsMap] = useState({})
  const [rawSeriesData, setRawSeriesData] = useState([])
  const [viewRange, setViewRange] = useState({ start: 0, end: 0 })
  const [hoverState, setHoverState] = useState(null)
  const [selectionState, setSelectionState] = useState(null)
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const [viewMode, setViewMode] = useState('chart')

  const chartContainerRef = useRef(null)
  const dragStateRef = useRef({
    active: false,
    mode: 'select',
    startTime: 0,
    endTime: 0,
    lastX: 0,
  })
  const hoverFrameRef = useRef(null)
  const hoverLatestRef = useRef(null)
  const pinchStateRef = useRef({
    active: false,
    startDist: 0,
    startRange: { start: 0, end: 0 },
    centerRatio: 0.5,
  })
  const lastTapRef = useRef(0)

  const loadRecordings = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/recordings`)
      const data = await response.json()
      setRecordings(data.records || [])
    } catch (err) {
      setError('기록 목록을 불러오지 못했습니다.')
    }
  }, [])

  useEffect(() => {
    loadRecordings()
  }, [loadRecordings])

  useEffect(() => {
    if (!recordingId) {
      setFields([])
      setSelectedField('')
      setSelectedFields([])
      setUnitsMap({})
      setRawSeriesData([])
      setViewRange({ start: 0, end: 0 })
      return
    }
    const loadFields = async () => {
      try {
        const response = await fetch(
          `${API_URL}/api/analysis/fields?recordingId=${encodeURIComponent(recordingId)}`
        )
        const data = await response.json()
        setFields(data.fields || [])
      } catch (err) {
        setError('데이터 항목을 불러오지 못했습니다.')
      }
    }
    loadFields()
  }, [recordingId])

  const selectedRecording = useMemo(
    () => recordings.find((record) => record.id === recordingId),
    [recordings, recordingId]
  )

  const recordingStartedAt = selectedRecording?.startedAt
    ? Number(selectedRecording.startedAt)
    : null

  useEffect(() => {
    if (!recordingId || selectedFields.length === 0) {
      setRawSeriesData([])
      setViewRange({ start: 0, end: 0 })
      return
    }
    const loadSeries = async () => {
      setLoading(true)
      setError('')
      try {
        const response = await fetch(`${API_URL}/api/analysis/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recordingId,
            fields: selectedFields,
            limit: MAX_FETCH_POINTS,
          }),
        })
        const data = await response.json()
        const normalized = normalizeSeriesRows(data.series || [], recordingStartedAt)
        const baselined = applyDisplayBaseline(normalized, selectedFields)
        setRawSeriesData(baselined)
        setUnitsMap(data.units || {})
        setViewRange(getElapsedRange(baselined, selectedFields))
      } catch (err) {
        setError('시계열 데이터를 불러오지 못했습니다.')
        setRawSeriesData([])
        setViewRange({ start: 0, end: 0 })
      } finally {
        setLoading(false)
      }
    }
    loadSeries()
  }, [recordingId, selectedFields, recordingStartedAt])

  const fullElapsedRange = useMemo(
    () => getElapsedRange(rawSeriesData, selectedFields),
    [rawSeriesData, selectedFields]
  )

  const recordingWallElapsed = useMemo(
    () => getRecordingWallElapsedSeconds(selectedRecording),
    [selectedRecording]
  )

  const dataTailGapSeconds = useMemo(() => {
    if (!recordingWallElapsed || !fullElapsedRange.end) return 0
    return Math.max(0, recordingWallElapsed - fullElapsedRange.end)
  }, [recordingWallElapsed, fullElapsedRange.end])

  const rawVisibleData = useMemo(() => {
    if (!rawSeriesData.length) return []
    const start = Math.min(viewRange.start, viewRange.end)
    const end = Math.max(viewRange.start, viewRange.end)
    return rawSeriesData.filter((row) => {
      const t = row[ELAPSED_TIME_FIELD]
      if (t < start || t > end) return false
      return rowHasPlottedValue(row, selectedFields)
    })
  }, [rawSeriesData, viewRange, selectedFields])

  const chartData = useMemo(() => {
    if (rawVisibleData.length <= MAX_CHART_POINTS) return rawVisibleData
    return downsampleByTime(rawVisibleData, MAX_CHART_POINTS)
  }, [rawVisibleData])

  const axisDomains = useMemo(() => {
    const domains = {}
    const extentRows = rawVisibleData.length ? rawVisibleData : chartData
    for (const field of selectedFields) {
      domains[field] = computeFieldDomain(field, extentRows)
    }
    return domains
  }, [rawVisibleData, chartData, selectedFields])

  const xAxisKey = ELAPSED_TIME_FIELD

  const xAxisDomain = useMemo(() => {
    const start = Math.min(viewRange.start, viewRange.end)
    const end = Math.max(viewRange.start, viewRange.end)
    const span = Math.max(1e-6, end - start)
    const pad = span * X_DOMAIN_PAD_RATIO
    return [start - pad, end + pad]
  }, [viewRange])

  const viewTimeSpan = useMemo(() => {
    const start = Math.min(viewRange.start, viewRange.end)
    const end = Math.max(viewRange.start, viewRange.end)
    return Math.max(1e-6, end - start)
  }, [viewRange])

  const xAxisTicks = useMemo(
    () => buildElapsedAxisTicks(xAxisDomain, viewTimeSpan),
    [xAxisDomain, viewTimeSpan]
  )

  const formatXAxisTick = useCallback(
    (value) => formatElapsedSeconds(value, viewTimeSpan),
    [viewTimeSpan]
  )

  const leftAxisFields = useMemo(
    () => selectedFields.filter((_, index) => index % 2 === 0),
    [selectedFields]
  )
  const rightAxisFields = useMemo(
    () => selectedFields.filter((_, index) => index % 2 === 1),
    [selectedFields]
  )

  const getPlotMetrics = useCallback(() => {
    if (!chartContainerRef.current) return null
    const rect = chartContainerRef.current.getBoundingClientRect()
    const plotLeft = PLOT_MARGIN.left
    const plotRight = PLOT_MARGIN.right
    const plotTop = PLOT_MARGIN.top
    const plotBottom = PLOT_MARGIN.bottom
    const plotWidth = Math.max(1, rect.width - plotLeft - plotRight)
    const plotHeight = Math.max(1, rect.height - plotTop - plotBottom)
    return {
      rect,
      plotLeft,
      plotRight,
      plotTop,
      plotBottom,
      plotWidth,
      plotHeight,
    }
  }, [])

  const getFieldColor = useCallback(
    (field) => {
      const index = selectedFields.indexOf(field)
      return colorPalette[(index < 0 ? 0 : index) % colorPalette.length]
    },
    [selectedFields]
  )

  const getYAxisId = (field) => field

  const getPlotRatioFromClientX = useCallback(
    (clientX) => {
      const metrics = getPlotMetrics()
      if (!metrics) return 0
      const x = clientX - metrics.rect.left - metrics.plotLeft
      return Math.min(1, Math.max(0, x / metrics.plotWidth))
    },
    [getPlotMetrics]
  )

  const getElapsedFromClientX = useCallback(
    (clientX) => {
      const ratio = getPlotRatioFromClientX(clientX)
      const span = viewRange.end - viewRange.start
      return viewRange.start + ratio * span
    },
    [getPlotRatioFromClientX, viewRange]
  )

  const setRangeClamped = useCallback(
    (start, end) => {
      const full = fullElapsedRange
      const fullSpan = Math.max(1e-6, full.end - full.start)
      const minWindow = Math.min(0.5, fullSpan)
      let nextStart = Math.min(start, end)
      let nextEnd = Math.max(start, end)
      let window = nextEnd - nextStart
      if (window < minWindow) {
        const center = (nextStart + nextEnd) / 2
        nextStart = center - minWindow / 2
        nextEnd = center + minWindow / 2
        window = minWindow
      }
      if (window > fullSpan) {
        setViewRange({ start: full.start, end: full.end })
        return
      }
      if (nextStart < full.start) {
        nextStart = full.start
        nextEnd = full.start + window
      }
      if (nextEnd > full.end) {
        nextEnd = full.end
        nextStart = full.end - window
      }
      setViewRange({ start: nextStart, end: nextEnd })
    },
    [fullElapsedRange]
  )

  const zoomAt = useCallback(
    (ratio, factor) => {
      if (!rawSeriesData.length) return
      const span = viewRange.end - viewRange.start
      const center = viewRange.start + ratio * span
      const nextSpan = Math.max(1e-6, span * factor)
      const nextStart = center - nextSpan * ratio
      setRangeClamped(nextStart, nextStart + nextSpan)
    },
    [rawSeriesData.length, viewRange, setRangeClamped]
  )

  const resetZoom = useCallback(() => {
    if (!rawSeriesData.length) return
    setViewRange(fullElapsedRange)
  }, [rawSeriesData.length, fullElapsedRange])

  const applyDragSelectionZoom = useCallback(
    (startTime, endTime) => {
      const start = Math.min(startTime, endTime)
      const end = Math.max(startTime, endTime)
      const visibleSpan = Math.max(1e-6, viewRange.end - viewRange.start)
      const minSpan = Math.min(0.15, visibleSpan * 0.01)
      if (end - start < minSpan) return
      setRangeClamped(start, end)
    },
    [viewRange, setRangeClamped]
  )

  const finishDragInteraction = useCallback(() => {
    const drag = dragStateRef.current
    if (!drag.active) return
    if (drag.mode === 'select') {
      applyDragSelectionZoom(drag.startTime, drag.endTime)
    }
    dragStateRef.current = {
      active: false,
      mode: 'select',
      startTime: 0,
      endTime: 0,
      lastX: 0,
    }
    setSelectionState(null)
  }, [applyDragSelectionZoom])

  const handleAddField = () => {
    if (!selectedField) return
    if (selectedFields.includes(selectedField)) return
    setSelectedFields((prev) => [...prev, selectedField])
    setSelectedField('')
  }

  const handleRemoveField = (field) => {
    setSelectedFields((prev) => prev.filter((item) => item !== field))
  }

  const handleDeleteRecording = async () => {
    if (!recordingId || deleting) return
    const selected = recordings.find((record) => record.id === recordingId)
    const label = selected?.name || recordingId
    const confirmed = window.confirm(
      `"${label}" 데이터를 삭제할까요?\nInfluxDB 기록과 JSONL 파일이 모두 삭제되며 되돌릴 수 없습니다.`
    )
    if (!confirmed) return

    setDeleting(true)
    setError('')
    try {
      const response = await fetch(
        `${API_URL}/api/recordings/${encodeURIComponent(recordingId)}`,
        { method: 'DELETE' }
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.detail || '데이터 삭제에 실패했습니다.')
      }
      setRecordings((prev) => prev.filter((record) => record.id !== recordingId))
      setRecordingId('')
      setFields([])
      setSelectedField('')
      setSelectedFields([])
      setUnitsMap({})
      setRawSeriesData([])
      setViewRange({ start: 0, end: 0 })
      setHoverState(null)
      setSelectionState(null)
      await loadRecordings()
    } catch (err) {
      setError(err.message || '데이터 삭제에 실패했습니다.')
    } finally {
      setDeleting(false)
    }
  }

  const handleWheel = (event) => {
    if (!chartContainerRef.current || !rawSeriesData.length) return
    event.preventDefault()
    const factor = event.deltaY > 0 ? 1.25 : 0.8
    zoomAt(getPlotRatioFromClientX(event.clientX), factor)
  }

  const handleMouseDown = (event) => {
    if (!chartContainerRef.current || !chartData.length) return
    if (event.button !== 0) return
    event.preventDefault()
    const startTime = getElapsedFromClientX(event.clientX)
    const mode = event.shiftKey ? 'pan' : 'select'
    dragStateRef.current = {
      active: true,
      mode,
      startTime,
      endTime: startTime,
      lastX: event.clientX,
    }
    if (mode === 'select') {
    setSelectionState({ startTime, endTime: startTime })
    }
  }

  const handleMouseMove = (event) => {
    if (!chartContainerRef.current || !chartData.length) return

    hoverLatestRef.current = { clientX: event.clientX, clientY: event.clientY }
    if (!hoverFrameRef.current) {
      hoverFrameRef.current = requestAnimationFrame(() => {
        const latest = hoverLatestRef.current
        hoverFrameRef.current = null
        if (!latest) return
        const metrics = getPlotMetrics()
        if (!metrics) return
        const elapsed = getElapsedFromClientX(latest.clientX)
        const row = findNearestRowByElapsed(chartData, elapsed)
        const ratio = getPlotRatioFromClientX(latest.clientX)
        setHoverState({
          elapsed,
          row,
          plotX: metrics.plotLeft + ratio * metrics.plotWidth,
          plotY: latest.clientY - metrics.rect.top,
        })
      })
    }

    if (!dragStateRef.current.active) return

    if (dragStateRef.current.mode === 'pan') {
      const metrics = getPlotMetrics()
      if (!metrics) return
      const dx = event.clientX - dragStateRef.current.lastX
      dragStateRef.current.lastX = event.clientX
      const span = viewRange.end - viewRange.start
      const delta = (-dx / metrics.plotWidth) * span
      setRangeClamped(viewRange.start + delta, viewRange.end + delta)
      return
    }

    const endTime = getElapsedFromClientX(event.clientX)
    dragStateRef.current.endTime = endTime
    setSelectionState({
      startTime: dragStateRef.current.startTime,
      endTime,
    })
  }

  const handleMouseUp = () => {
    finishDragInteraction()
  }

  const handleTouchStart = (event) => {
    if (!chartContainerRef.current) return
    if (event.touches.length === 2) {
      const [t1, t2] = event.touches
      const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY)
      const centerX = (t1.clientX + t2.clientX) / 2
      pinchStateRef.current = {
        active: true,
        startDist: dist,
        startRange: { ...viewRange },
        centerRatio: getPlotRatioFromClientX(centerX),
      }
    } else if (event.touches.length === 1) {
      const startTime = getElapsedFromClientX(event.touches[0].clientX)
      dragStateRef.current = {
        active: true,
        mode: 'select',
        startTime,
        endTime: startTime,
        lastX: event.touches[0].clientX,
      }
      setSelectionState({ startTime, endTime: startTime })
    }
  }

  const handleTouchMove = (event) => {
    if (!chartContainerRef.current) return
    if (pinchStateRef.current.active && event.touches.length === 2) {
      event.preventDefault()
      const [t1, t2] = event.touches
      const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY)
      const ratio = dist / pinchStateRef.current.startDist
      const startRange = pinchStateRef.current.startRange
      const span = startRange.end - startRange.start
      const nextSpan = Math.max(1e-6, span / ratio)
      const center =
        startRange.start + pinchStateRef.current.centerRatio * span
      const nextStart = center - nextSpan * pinchStateRef.current.centerRatio
      setRangeClamped(nextStart, nextStart + nextSpan)
      return
    }
    if (dragStateRef.current.active && event.touches.length === 1) {
      const endTime = getElapsedFromClientX(event.touches[0].clientX)
      dragStateRef.current.endTime = endTime
      setSelectionState({ startTime: dragStateRef.current.startTime, endTime })
    }
  }

  const handleTouchEnd = (event) => {
    if (event.touches.length === 0) {
      pinchStateRef.current.active = false
      finishDragInteraction()
      const now = Date.now()
      if (now - lastTapRef.current < 300) {
        resetZoom()
      }
      lastTapRef.current = now
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="max-w-[1600px] mx-auto px-6 py-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="text-2xl font-bold">TEAM A-FA BAJA 분석실</div>
            <div className="text-xs text-zinc-400 mt-1">
              기록된 데이터를 선택하고 세부 항목을 분석하세요.
            </div>
          </div>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="bg-black/70 text-white text-xs px-4 py-2 rounded-full border border-white/10 hover:bg-black/80"
            >
              LIVE로 이동
            </button>
        </div>

        <div className="bg-black/60 border border-white/10 rounded-xl p-4 shadow-lg">
          <div className="grid grid-cols-1 md:grid-cols-[1.2fr_1fr_auto] gap-3 items-end">
            <div>
              <label className="text-xs text-zinc-400">데이터 폴더 선택</label>
              <div className="mt-2 flex gap-2">
                <select
                  value={recordingId}
                  onChange={(e) => setRecordingId(e.target.value)}
                  className="min-w-0 flex-1 bg-black/70 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
                >
                  <option value="">데이터 선택</option>
                  {recordings.map((record) => (
                    <option key={record.id} value={record.id}>
                      {record.name} ({new Date(record.createdAt).toLocaleString()})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleDeleteRecording}
                  disabled={!recordingId || deleting}
                  className="shrink-0 rounded-lg border border-red-500/40 bg-red-950/50 px-3 py-2 text-xs font-semibold text-red-200 hover:bg-red-900/60 disabled:opacity-40"
                >
                  {deleting ? '삭제 중...' : '삭제'}
                </button>
              </div>
            </div>
            <div>
              <label className="text-xs text-zinc-400">데이터 항목 선택</label>
              <select
                value={selectedField}
                onChange={(e) => setSelectedField(e.target.value)}
                className="mt-2 w-full bg-black/70 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
                disabled={!recordingId}
              >
                <option value="">항목 선택</option>
                {fields.map((field) => (
                  <option key={field.key} value={field.key}>
                    {formatFieldLabel(field.key)} {field.unit ? `(${field.unit})` : ''}
                  </option>
                ))}
              </select>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleAddField}
                  className="bg-cyan-500 text-black text-xs px-3 py-1.5 rounded-lg font-semibold hover:bg-cyan-400 disabled:opacity-40"
                  disabled={!selectedField}
                >
                  + 추가
                </button>
                <div className="text-xs text-zinc-500">여러 항목을 추가할 수 있습니다.</div>
              </div>
            </div>
            <div className="text-xs text-zinc-400">
              {selectedRecording
                ? `기간: ${new Date(selectedRecording.startedAt).toLocaleTimeString()} ~ ${new Date(
                    selectedRecording.endedAt
                  ).toLocaleTimeString()}`
                : '기간: -'}
            </div>
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => setViewMode('chart')}
            className={`rounded-full px-4 py-2 text-xs font-semibold border ${
              viewMode === 'chart'
                ? 'border-cyan-400/60 bg-cyan-950/60 text-cyan-100'
                : 'border-white/10 bg-black/50 text-zinc-300'
            }`}
          >
            그래프
          </button>
          <button
            type="button"
            onClick={() => setViewMode('track')}
            className={`rounded-full px-4 py-2 text-xs font-semibold border ${
              viewMode === 'track'
                ? 'border-cyan-400/60 bg-cyan-950/60 text-cyan-100'
                : 'border-white/10 bg-black/50 text-zinc-300'
            }`}
          >
            랩 경로
          </button>
        </div>

        {viewMode === 'track' ? (
          <div className="mt-6">
            <LapTrackView recordingId={recordingId} recordingStartedAt={recordingStartedAt} />
          </div>
        ) : (
        <div className="mt-6 bg-black/60 border border-white/10 rounded-xl p-4 shadow-lg">
          <div className="text-xs text-zinc-400 mb-3 flex flex-wrap gap-2">
            {selectedFields.length === 0 && <span>항목: -</span>}
            {selectedFields.map((field) => (
              <span
                key={field}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1"
                style={{ color: getFieldColor(field) }}
              >
                {formatFieldLabel(field)} {unitsMap[field] ? `(${unitsMap[field]})` : ''}
                <button
                  type="button"
                  onClick={() => handleRemoveField(field)}
                  className="text-xs text-zinc-400 hover:text-white"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>

          {hoverState?.row && (
            <div className="text-xs text-zinc-300 mb-3 flex flex-wrap gap-3">
              <span>경과: {formatElapsedSeconds(hoverState.elapsed, viewTimeSpan)}</span>
              {selectedFields.map((field) => (
                <span key={field} style={{ color: getFieldColor(field) }}>
                  {formatFieldLabel(field)}:{' '}
                  {typeof hoverState.row[field] === 'number'
                    ? formatDomainValue(
                        hoverState.row[field],
                        axisDomains[field] || [0, 1]
                      )
                    : '-'}
                  {unitsMap[field] ? ` ${unitsMap[field]}` : ''}
                </span>
              ))}
            </div>
          )}

          <div className="mb-3 rounded-lg bg-slate-700/60 text-slate-200 text-xs px-4 py-2">
            PC: 그래프 위에서 <span className="text-white font-medium">드래그</span>하면 선택한
            시간 구간으로 확대, <span className="text-white font-medium">휠</span>로 줌,
            <span className="text-white font-medium">Shift+드래그</span>로 좌우 이동,
            <span className="text-white font-medium">더블클릭</span>으로 전체 보기. 모바일: 드래그
            확대, 두 손가락 핀치 줌, 더블 탭 초기화.
          </div>

          {dataTailGapSeconds >= 1 && (
            <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-950/40 text-amber-100 text-xs px-4 py-2">
              선택한 항목의 마지막 값은{' '}
              <span className="font-semibold tabular-nums">
                {formatElapsedSeconds(fullElapsedRange.end)}
              </span>
              까지입니다. 기록 종료(
              {formatElapsedSeconds(recordingWallElapsed)})보다 약{' '}
              <span className="font-semibold tabular-nums">
                {dataTailGapSeconds.toFixed(1)}초
              </span>{' '}
              앞에서 끊깁니다. (다른 센서만 계속 들어온 구간일 수 있습니다)
            </div>
          )}

          <div className="flex h-[500px] w-full min-w-0 touch-none">
            {!loading && leftAxisFields.length > 0 && (
              <div className="flex h-full shrink-0 items-stretch pl-1">
                {leftAxisFields.map((field) => (
                  <YAxisRail
                    key={`rail-left-${field}`}
                    field={field}
                    domain={axisDomains[field] || [0, 1]}
                    color={getFieldColor(field)}
                    unit={unitsMap[field] || ''}
                    align="left"
                  />
                ))}
              </div>
            )}

            <div
              className="relative min-w-0 flex-1 h-full select-none cursor-crosshair"
            ref={chartContainerRef}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onDoubleClick={resetZoom}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            {hoverState && (
                <div
                  className="pointer-events-none absolute z-20"
                  style={{
                    left: `${PLOT_MARGIN.left}px`,
                    right: `${PLOT_MARGIN.right}px`,
                    top: `${PLOT_MARGIN.top}px`,
                    bottom: `${PLOT_MARGIN.bottom}px`,
                  }}
                >
                <div
                  className="absolute top-0 bottom-0 w-px bg-white/30"
                    style={{ left: `${hoverState.plotX - PLOT_MARGIN.left}px` }}
                />
              </div>
            )}

              {selectionState &&
                (() => {
                  const metrics = getPlotMetrics()
                  if (!metrics) return null
                  const span = Math.max(1e-6, viewRange.end - viewRange.start)
                  const selStart = Math.min(selectionState.startTime, selectionState.endTime)
                  const selEnd = Math.max(selectionState.startTime, selectionState.endTime)
                  const startRatio = (selStart - viewRange.start) / span
                  const widthRatio = (selEnd - selStart) / span
                  const leftPx = metrics.plotLeft + startRatio * metrics.plotWidth
                  const widthPx = Math.max(1, widthRatio * metrics.plotWidth)
                  return (
                    <div
                      className="pointer-events-none absolute z-20 bg-white/10 border border-white/20"
                  style={{
                        left: `${leftPx}px`,
                        width: `${widthPx}px`,
                        top: `${metrics.plotTop}px`,
                        height: `${metrics.plotHeight}px`,
                      }}
                    />
                  )
                })()}

            {loading ? (
              <div className="h-full flex items-center justify-center text-zinc-500">
                데이터 로딩 중...
              </div>
              ) : chartData.length === 0 ? (
                <div className="h-full flex items-center justify-center text-zinc-500">
                  표시할 데이터가 없습니다.
                </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={PLOT_MARGIN}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                  <XAxis
                    dataKey={xAxisKey}
                    type="number"
                      domain={xAxisDomain}
                    scale="linear"
                      ticks={xAxisTicks}
                      tickFormatter={formatXAxisTick}
                    stroke="rgba(255,255,255,0.5)"
                      tick={{ fill: 'rgba(255,255,255,0.6)', fontSize: 11 }}
                    />
                    {selectedFields.map((field) => (
                      <YAxis
                        key={`axis-${field}`}
                        yAxisId={getYAxisId(field)}
                        domain={axisDomains[field] || [0, 1]}
                        scale="linear"
                        hide
                        width={0}
                      />
                    ))}
                    <Tooltip
                      content={
                        <AnalysisTooltip
                          selectedFields={selectedFields}
                          unitsMap={unitsMap}
                          axisDomains={axisDomains}
                          viewTimeSpan={viewTimeSpan}
                          getFieldColor={getFieldColor}
                        />
                      }
                    />
                  {selectedFields.map((field) => (
                    <Line
                      key={field}
                        type="linear"
                      dataKey={field}
                      stroke={getFieldColor(field)}
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                        yAxisId={getYAxisId(field)}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
              )}
            </div>

            {!loading && rightAxisFields.length > 0 && (
              <div className="flex h-full shrink-0 items-stretch pr-1">
                {rightAxisFields.map((field) => (
                  <YAxisRail
                    key={`rail-right-${field}`}
                    field={field}
                    domain={axisDomains[field] || [0, 1]}
                    color={getFieldColor(field)}
                    unit={unitsMap[field] || ''}
                    align="right"
                  />
                ))}
              </div>
            )}
          </div>
        </div>
        )}

        {error && <div className="mt-4 text-sm text-red-400">{error}</div>}
      </div>
    </div>
  )
}
