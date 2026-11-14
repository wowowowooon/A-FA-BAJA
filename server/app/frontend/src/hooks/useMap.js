import { useCallback, useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import {
  addTrackPolylines,
  createVehicleIcon,
  initDarkMap,
} from '../utils/mapTheme'

const DEFAULT_CENTER = [37.5665, 126.978]

const LAP_COLORS = [
  '#38bdf8',
  '#f59e0b',
  '#10b981',
  '#a78bfa',
  '#ef4444',
  '#22d3ee',
  '#f472b6',
  '#84cc16',
]

function colorForSegment(segment) {
  if (segment.isCurrent) return '#22d3ee'
  return LAP_COLORS[segment.colorIndex % LAP_COLORS.length]
}

export default function useMap({ gpsState, trackSegments = [] }) {
  const mapContainerRef = useRef(null)
  const mapRef = useRef(null)
  const markerRef = useRef(null)
  const hasInitialViewRef = useRef(false)
  const polylinesRef = useRef([])

  useEffect(() => {
    if (!mapContainerRef.current) return
    if (mapRef.current) return

    const map = initDarkMap(mapContainerRef.current, {
      center: DEFAULT_CENTER,
      zoom: 17,
      zoomControl: false,
    })

    const marker = L.marker(DEFAULT_CENTER, { icon: createVehicleIcon() }).addTo(map)

    mapRef.current = map
    markerRef.current = marker

    setTimeout(() => {
      map.invalidateSize()
    }, 0)
  }, [])

  useEffect(() => {
    const handleResize = () => {
      if (!mapRef.current) return
      mapRef.current.invalidateSize()
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    if (!gpsState || !mapRef.current || !markerRef.current) return
    const pos = [gpsState.lat, gpsState.lon]
    markerRef.current.setLatLng(pos)
    markerRef.current.setIcon(
      createVehicleIcon(gpsState.course_deg, gpsState.speed_kmh)
    )
    if (!hasInitialViewRef.current) {
      mapRef.current.setView(pos, mapRef.current.getZoom(), { animate: false })
      hasInitialViewRef.current = true
    }
  }, [gpsState?.lat, gpsState?.lon, gpsState?.course_deg, gpsState?.speed_kmh])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    polylinesRef.current.forEach((line) => line.remove())
    polylinesRef.current = []

    for (const segment of trackSegments) {
      if (!segment.points || segment.points.length < 2) continue
      const latlngs = segment.points.map((pt) => [pt.lat, pt.lon])
      const lines = addTrackPolylines(map, latlngs, {
        color: colorForSegment(segment),
        weight: segment.isCurrent ? 5 : 4,
        opacity: segment.isCurrent ? 0.95 : 0.8,
        isCurrent: segment.isCurrent,
      })
      polylinesRef.current.push(...lines)
    }
  }, [trackSegments])

  const clearVehicleMarker = useCallback(() => {
    hasInitialViewRef.current = false
    if (markerRef.current) {
      markerRef.current.setLatLng(DEFAULT_CENTER)
    }
    polylinesRef.current.forEach((line) => line.remove())
    polylinesRef.current = []
  }, [])

  return {
    mapContainerRef,
    clearVehicleMarker,
  }
}

export { LAP_COLORS, colorForSegment }
