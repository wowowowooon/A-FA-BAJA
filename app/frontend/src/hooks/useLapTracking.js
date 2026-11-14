import { useCallback, useRef, useState } from 'react'

import {
  buildCompletedTrackSegments,
  buildTrackSegments,
  completeLapManually,
  createInitialLapState,
  processGpsForLap,
} from '../utils/lapTracking'

export default function useLapTracking() {
  const [laps, setLaps] = useState([])
  const [currentLap, setCurrentLap] = useState(() => createInitialLapState().currentLap)
  const [segments, setSegments] = useState([])
  const stateRef = useRef(createInitialLapState())

  const syncFromState = useCallback((state) => {
    stateRef.current = state
    setLaps(state.laps)
    setCurrentLap(state.currentLap)
    setSegments(buildTrackSegments(state.laps, state.currentLap))
  }, [])

  const ingestGps = useCallback(
    (lat, lon, ts = Date.now(), speedKmh) => {
      if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat)) return null
      const result = processGpsForLap(stateRef.current, lat, lon, ts, speedKmh)
      syncFromState(result.state)
      return result.lapCompleted
    },
    [syncFromState]
  )

  const resetTracking = useCallback(() => {
    syncFromState(createInitialLapState())
  }, [syncFromState])

  const recordLapManually = useCallback(
    (lat, lon, ts = Date.now(), speedKmh) => {
      const result = completeLapManually(stateRef.current, lat, lon, ts, speedKmh)
      syncFromState(result.state)
      return result.lapCompleted
    },
    [syncFromState]
  )

  const getTrackPayload = useCallback(() => {
    const state = stateRef.current
    return {
      laps: state.laps.map((lap) => ({
        lap: lap.lap,
        durationMs: lap.durationMs,
        startedAt: lap.startedAt,
        endedAt: lap.endedAt,
        manual: Boolean(lap.manual),
        points: lap.points,
      })),
      segments: buildCompletedTrackSegments(state.laps).map((seg) => ({
        lap: seg.lap,
        isCurrent: false,
        manual: seg.manual,
        points: seg.points,
      })),
      allPoints: state.allPoints,
    }
  }, [])

  return {
    laps,
    currentLap,
    segments,
    ingestGps,
    recordLapManually,
    resetTracking,
    getTrackPayload,
  }
}
