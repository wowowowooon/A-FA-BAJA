import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import {
  cumulativePathDistances,
  distanceMeters,
  enrichTrackPointsWithSpeed,
  findNearestPointOnTrack,
  formatDistanceMeters,
  formatLapTime,
  formatSpeedKmh,
  pathDistanceBetweenIndices,
  pathLengthMeters,
  slicePathBetweenIndices,
} from '../utils/lapTracking'
import { colorForSegment } from '../hooks/useMap'
import { addTrackPolylines, createLapLabelIcon, createMeasureIcon, initDarkMap } from '../utils/mapTheme'
import { API_URL } from '../utils/apiBase'

const SNAP_RADIUS_M = 30
const DOUBLE_TAP_MS = 300
const CLICK_DELAY_MS = 250

function formatPointTime(ts, recordingStartedAt) {
  if (!ts) return '--'
  if (recordingStartedAt) {
    const elapsed = Math.max(0, ts - recordingStartedAt)
    return formatLapTime(elapsed)
  }
  return new Date(ts).toLocaleTimeString()
}

function buildSnapInfo(nearest, cumulative, totalM, cursorLat, cursorLon) {
  return {
    lat: nearest.lat,
    lon: nearest.lon,
    ts: nearest.ts,
    index: nearest.index,
    speed_kmh: nearest.speed_kmh,
    speed_estimated: nearest.speed_estimated,
    distanceAlongM: cumulative[nearest.index] ?? 0,
    totalM,
    cursorLat,
    cursorLon,
  }
}

function snapToTrack(lat, lon, points, cumulative, totalM, cursorLat, cursorLon) {
  const nearest = findNearestPointOnTrack(points, lat, lon)
  if (!nearest) return null
  const dist = distanceMeters({ lat, lon }, nearest)
  if (dist > SNAP_RADIUS_M) return null
  return buildSnapInfo(nearest, cumulative, totalM, cursorLat, cursorLon)
}

export default function LapTrackView({ recordingId, recordingStartedAt }) {
  const mapContainerRef = useRef(null)
  const mapRef = useRef(null)
  const polylinesRef = useRef([])
  const lapLabelMarkersRef = useRef([])
  const overlayGroupRef = useRef(null)
  const hoverPointsRef = useRef([])
  const pathDistanceMetaRef = useRef({ cumulative: [], totalM: 0 })
  const selectedLapTotalRef = useRef(0)
  const measureStateRef = useRef(null)
  const clickTimerRef = useRef(null)
  const lastTapRef = useRef(0)

  const [track, setTrack] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedLap, setSelectedLap] = useState('all')
  const [hoverInfo, setHoverInfo] = useState(null)
  const [measureState, setMeasureState] = useState(null)

  const lapDistances = useMemo(() => {
    const map = new Map()
    for (const lap of track?.laps || []) {
      map.set(lap.lap, pathLengthMeters(lap.points))
    }
    return map
  }, [track?.laps])

  const resetInteraction = useCallback(() => {
    setMeasureState(null)
  }, [])

  useEffect(() => {
    measureStateRef.current = measureState
  }, [measureState])

  useEffect(() => {
    if (!recordingId) {
      setTrack(null)
      return
    }
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const response = await fetch(
          `${API_URL}/api/analysis/track?recordingId=${encodeURIComponent(recordingId)}`
        )
        if (!response.ok) throw new Error('경로 데이터를 불러오지 못했습니다.')
        const data = await response.json()
        setTrack(data)
        setSelectedLap('all')
        setHoverInfo(null)
        setMeasureState(null)
      } catch (err) {
        setError(err?.message || '경로 로드 실패')
        setTrack(null)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [recordingId, API_URL])

  const completedSegments = useMemo(() => {
    if (!track) return []
    const fromSegments = (track.segments || []).filter((seg) => !seg.isCurrent && seg.points?.length)
    if (fromSegments.length) return fromSegments
    return (track.laps || [])
      .filter((lap) => lap.points?.length)
      .map((lap, index) => ({
        lap: lap.lap,
        points: lap.points,
        isCurrent: false,
        colorIndex: index,
        manual: lap.manual,
      }))
  }, [track])

  const totalDurationMs = useMemo(() => {
    const laps = track?.laps || []
    if (laps.length) {
      const sum = laps.reduce((acc, lap) => acc + (Number(lap.durationMs) || 0), 0)
      if (sum > 0) return sum
    }
    const points = track?.allPoints
    if (points?.length >= 2) {
      return Math.max(0, points[points.length - 1].ts - points[0].ts)
    }
    const flat = []
    for (const seg of completedSegments) {
      for (const pt of seg.points || []) flat.push(pt)
    }
    if (flat.length >= 2) {
      return Math.max(0, flat[flat.length - 1].ts - flat[0].ts)
    }
    return null
  }, [track?.laps, track?.allPoints, completedSegments])

  const visibleSegments = useMemo(() => {
    if (!completedSegments.length) return []
    if (selectedLap === 'all') {
      return completedSegments.map((seg, index) => ({
        ...seg,
        colorIndex: seg.colorIndex ?? index,
      }))
    }
    const lapNum = Number(selectedLap)
    return completedSegments.filter((seg) => Number(seg.lap) === lapNum)
  }, [completedSegments, selectedLap])

  const hoverPoints = useMemo(() => {
    const points = []
    const laps = track?.laps || []
    for (const seg of visibleSegments) {
      const lapMeta = laps.find((lap) => lap.lap === seg.lap)
      const enriched = enrichTrackPointsWithSpeed(seg.points || [], lapMeta?.durationMs)
      for (const pt of enriched) points.push(pt)
    }
    return points
  }, [visibleSegments, track?.laps])

  const pathDistanceMeta = useMemo(() => {
    const cumulative = cumulativePathDistances(hoverPoints)
    const totalM = cumulative.length ? cumulative[cumulative.length - 1] : 0
    return { cumulative, totalM }
  }, [hoverPoints])

  const selectedLapTotalM = useMemo(() => {
    if (selectedLap === 'all') return pathDistanceMeta.totalM
    const lapNum = Number(selectedLap)
    return lapDistances.get(lapNum) ?? 0
  }, [selectedLap, lapDistances, pathDistanceMeta.totalM])

  useEffect(() => {
    hoverPointsRef.current = hoverPoints
    pathDistanceMetaRef.current = pathDistanceMeta
    selectedLapTotalRef.current = selectedLapTotalM
  }, [hoverPoints, pathDistanceMeta, selectedLapTotalM])

  useEffect(() => {
    resetInteraction()
    setHoverInfo(null)
  }, [selectedLap, resetInteraction])

  useEffect(() => {
    if (!mapContainerRef.current) return

    if (mapRef.current) {
      mapRef.current.remove()
      mapRef.current = null
      overlayGroupRef.current = null
    }

    const map = initDarkMap(mapContainerRef.current, {
      center: [35.9692, 126.5681],
      zoom: 17,
      zoomControl: true,
      doubleClickZoom: false,
    })
    map.zoomControl.setPosition('bottomright')
    map.getContainer().classList.add('cursor-crosshair')
    mapRef.current = map

    const overlay = L.layerGroup().addTo(map)
    overlayGroupRef.current = overlay

    const handleMeasureClick = (snap) => {
      const current = measureStateRef.current
      if (!current?.start) {
        setMeasureState({ start: snap, end: null, segmentDistanceM: 0 })
        return
      }
      if (!current.end) {
        const segmentDistanceM = pathDistanceBetweenIndices(
          pathDistanceMetaRef.current.cumulative,
          current.start.index,
          snap.index
        )
        setMeasureState({ start: current.start, end: snap, segmentDistanceM })
        return
      }
      setMeasureState({ start: snap, end: null, segmentDistanceM: 0 })
    }

    const handleMove = (event) => {
      const { cumulative } = pathDistanceMetaRef.current
      const snap = snapToTrack(
        event.latlng.lat,
        event.latlng.lng,
        hoverPointsRef.current,
        cumulative,
        selectedLapTotalRef.current,
        event.latlng.lat,
        event.latlng.lng
      )
      setHoverInfo(snap)
    }

    const handleClick = (event) => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
      clickTimerRef.current = setTimeout(() => {
        clickTimerRef.current = null
        const { cumulative } = pathDistanceMetaRef.current
        const snap = snapToTrack(
          event.latlng.lat,
          event.latlng.lng,
          hoverPointsRef.current,
          cumulative,
          selectedLapTotalRef.current,
          event.latlng.lat,
          event.latlng.lng
        )
        if (!snap) return
        handleMeasureClick(snap)
      }, CLICK_DELAY_MS)
    }

    const handleDoubleClick = (event) => {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current)
        clickTimerRef.current = null
      }
      L.DomEvent.stop(event)
      resetInteraction()
    }

    const handleTouchEnd = (event) => {
      if (event.touches.length > 0) return
      const now = Date.now()
      if (now - lastTapRef.current < DOUBLE_TAP_MS) {
        resetInteraction()
      }
      lastTapRef.current = now
    }

    map.on('mousemove', handleMove)
    map.on('click', handleClick)
    map.on('dblclick', handleDoubleClick)
    map.on('mouseout', () => setHoverInfo(null))

    const mapContainer = map.getContainer()
    mapContainer.addEventListener('touchend', handleTouchEnd, { passive: true })

    setTimeout(() => map.invalidateSize(), 0)

    return () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
      map.off('mousemove', handleMove)
      map.off('click', handleClick)
      map.off('dblclick', handleDoubleClick)
      map.off('mouseout')
      mapContainer.removeEventListener('touchend', handleTouchEnd)
      map.remove()
      mapRef.current = null
      overlayGroupRef.current = null
    }
  }, [recordingId, resetInteraction])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    polylinesRef.current.forEach((line) => line.remove())
    polylinesRef.current = []
    lapLabelMarkersRef.current.forEach((marker) => marker.remove())
    lapLabelMarkersRef.current = []

    const bounds = []
    for (const segment of visibleSegments) {
      if (!segment.points || segment.points.length < 2) continue
      const latlngs = segment.points.map((pt) => [pt.lat, pt.lon])
      latlngs.forEach((pos) => bounds.push(pos))
      const color = colorForSegment(segment)
      const lines = addTrackPolylines(map, latlngs, {
        color,
        weight: 5,
        opacity: 0.92,
      })
      polylinesRef.current.push(...lines)

      const midIdx = Math.floor(segment.points.length / 2)
      const mid = segment.points[midIdx]
      const lapLabel = L.marker([mid.lat, mid.lon], {
        icon: createLapLabelIcon(segment.lap, color),
        interactive: false,
      }).addTo(map)
      lapLabelMarkersRef.current.push(lapLabel)
    }

    if (bounds.length >= 2) {
      map.fitBounds(bounds, { padding: [40, 40] })
      setTimeout(() => map.invalidateSize(), 50)
    }
  }, [visibleSegments])

  useEffect(() => {
    const group = overlayGroupRef.current
    if (!group) return

    group.clearLayers()

    if (measureState?.start && measureState?.end) {
      const segmentPoints = slicePathBetweenIndices(
        hoverPoints,
        measureState.start.index,
        measureState.end.index
      )
      if (segmentPoints.length >= 2) {
        L.polyline(
          segmentPoints.map((pt) => [pt.lat, pt.lon]),
          {
            color: '#fbbf24',
            weight: 3,
            opacity: 0.95,
            lineCap: 'round',
            lineJoin: 'round',
          }
        ).addTo(group)
      }
    }

    if (measureState?.start) {
      L.marker([measureState.start.lat, measureState.start.lon], {
        icon: createMeasureIcon('A'),
        interactive: false,
      }).addTo(group)
    }
    if (measureState?.end) {
      L.marker([measureState.end.lat, measureState.end.lon], {
        icon: createMeasureIcon('B'),
        interactive: false,
      }).addTo(group)
    }

    if (hoverInfo) {
      L.circleMarker([hoverInfo.lat, hoverInfo.lon], {
        radius: 6,
        color: '#67e8f9',
        weight: 2,
        fillColor: '#22d3ee',
        fillOpacity: 1,
      }).addTo(group)

      if (
        typeof hoverInfo.cursorLat === 'number' &&
        typeof hoverInfo.cursorLon === 'number'
      ) {
        L.polyline(
          [
            [hoverInfo.cursorLat, hoverInfo.cursorLon],
            [hoverInfo.lat, hoverInfo.lon],
          ],
          {
            color: 'rgba(255,255,255,0.55)',
            weight: 1,
            dashArray: '4 5',
            opacity: 0.9,
          }
        ).addTo(group)
      }
    }
  }, [hoverInfo, measureState, hoverPoints])

  if (!recordingId) {
    return (
      <div className="flex h-[420px] items-center justify-center rounded-xl border border-white/10 bg-black/40 text-sm text-zinc-500">
        기록을 선택하면 주행 경로를 볼 수 있습니다.
      </div>
    )
  }

  const lapList = track?.laps || []
  const activeInfo = hoverInfo || measureState?.end || measureState?.start

  return (
    <div className="rounded-xl border border-white/10 bg-black/40 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-white">랩 경로</div>
          <div className="text-xs text-zinc-500">
            마우스로 지점 확인 · 클릭 2회 구간 거리 · 「전체」는 랩별 색상 · 더블탭/더블클릭 초기화
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setSelectedLap('all')}
            className={`rounded-full px-3 py-1 text-xs border ${
              selectedLap === 'all'
                ? 'border-cyan-400/60 bg-cyan-950/60 text-cyan-100'
                : 'border-white/10 bg-black/50 text-zinc-300'
            }`}
          >
            전체
            {totalDurationMs != null ? ` · ${formatLapTime(totalDurationMs)}` : ''}
          </button>
          {lapList.map((lap) => {
            const lapTotalM = lapDistances.get(lap.lap) ?? pathLengthMeters(lap.points)
            return (
              <button
                key={lap.lap}
                type="button"
                onClick={() => setSelectedLap(String(lap.lap))}
                className={`rounded-full px-3 py-1 text-xs border ${
                  selectedLap === String(lap.lap)
                    ? 'border-cyan-400/60 bg-cyan-950/60 text-cyan-100'
                    : 'border-white/10 bg-black/50 text-zinc-300'
                }`}
              >
                Lap {lap.lap}
                {lap.manual ? ' (수동)' : ''} · {formatLapTime(lap.durationMs)} ·{' '}
                {formatDistanceMeters(lapTotalM)}
              </button>
            )
          })}
        </div>
      </div>

      {loading && <div className="px-4 py-3 text-sm text-zinc-400">경로 불러오는 중...</div>}
      {error && <div className="px-4 py-3 text-sm text-red-300">{error}</div>}
      {!loading && lapList.length === 0 && (
        <div className="px-4 py-2 text-xs text-amber-200/90">
          완료된 랩이 없습니다. LIVE에서 「1랩 수동 기록」 후 기록을 종료하세요.
        </div>
      )}

      <div className="relative h-[480px]">
        <div ref={mapContainerRef} className="absolute inset-0" />
        {activeInfo && (
          <div className="pointer-events-none absolute left-4 top-4 z-[500] rounded-lg border border-cyan-400/40 bg-black/80 px-3 py-2 text-xs text-cyan-100 shadow-lg">
            <div>경과: {formatPointTime(activeInfo.ts, recordingStartedAt)}</div>
            <div className="mt-1 tabular-nums">
              속도:{' '}
              {formatSpeedKmh(activeInfo.speed_kmh, {
                estimated: Boolean(activeInfo.speed_estimated),
              })}
            </div>
            <div className="mt-1 tabular-nums">
              거리: {formatDistanceMeters(activeInfo.distanceAlongM)}
              <span className="text-zinc-500">
                {' '}
                / {selectedLap === 'all' ? '전체' : '랩'}{' '}
                {formatDistanceMeters(activeInfo.totalM)}
              </span>
            </div>
            <div className="text-zinc-400 mt-1 tabular-nums">
              {activeInfo.lat.toFixed(6)}, {activeInfo.lon.toFixed(6)}
            </div>
            {measureState?.end && (
              <div className="mt-2 border-t border-amber-400/30 pt-2 text-amber-200 tabular-nums">
                A→B 구간: {formatDistanceMeters(measureState.segmentDistanceM)}
              </div>
            )}
            {measureState?.start && !measureState?.end && (
              <div className="mt-2 border-t border-white/10 pt-2 text-zinc-400">
                두 번째 지점을 클릭하세요 (A 선택됨)
              </div>
            )}
          </div>
        )}
        {selectedLap === 'all' && visibleSegments.length > 0 && (
          <div className="pointer-events-none absolute right-4 bottom-4 z-[500] rounded-lg border border-white/10 bg-black/85 px-3 py-2 shadow-lg">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 mb-2">
              랩 색상
            </div>
            {totalDurationMs != null && (
              <div className="mb-2 text-xs tabular-nums text-cyan-100">
                전체 시간: {formatLapTime(totalDurationMs)}
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              {visibleSegments.map((seg) => {
                const color = colorForSegment(seg)
                return (
                  <div key={seg.lap} className="flex items-center gap-2 text-xs text-white">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-white/30"
                      style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}` }}
                    />
                    <span>
                      Lap {seg.lap}
                      {seg.manual ? ' (수동)' : ''}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        {!loading && track && visibleSegments.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-sm text-zinc-400">
            GPS 경로 데이터가 없습니다.
          </div>
        )}
      </div>
    </div>
  )
}
