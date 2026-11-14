import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import SpeedGauge from '../components/SpeedGauge'
import AccelWidget from '../components/AccelWidget'
import LinearCards from '../components/LinearCards'
import useWebSocket from '../hooks/useWebSocket'
import useMap from '../hooks/useMap'
import useLapTracking from '../hooks/useLapTracking'
import { formatLapTime } from '../utils/lapTracking'
import {
  formatElapsed,
  getGearValue,
  getGForceValue,
  getImuAccelerationValues,
  getImuOrientationValues,
  getLatestGps,
  getLinearValue,
  getRpmValue,
  getSpeedValue,
} from '../utils/sensors'
import { FIXED_GPS_ITEMS, FIXED_LEFT_ITEMS } from '../constants/hudItems'

const HOSTNAME = window.location.hostname
const IS_DEV_SERVER = window.location.port === '5173' || window.location.port === '4173'
const HTTP_PROTOCOL = window.location.protocol
const WS_PROTOCOL = HTTP_PROTOCOL === 'https:' ? 'wss:' : 'ws:'
const WS_ORIGIN = window.location.origin.replace(/^http/, 'ws')

const DEFAULT_API_URL = IS_DEV_SERVER
  ? `${HTTP_PROTOCOL}//${HOSTNAME}:8000`
  : window.location.origin
const DEFAULT_WS_URL = IS_DEV_SERVER
  ? `${WS_PROTOCOL}//${HOSTNAME}:8000`
  : WS_ORIGIN
const API_URL = import.meta.env.VITE_API_URL || DEFAULT_API_URL
const WS_URL = import.meta.env.VITE_WS_URL || DEFAULT_WS_URL
const APP_PASSWORD = import.meta.env.VITE_APP_PASSWORD || 'race'

export default function LivePage() {
  const navigate = useNavigate()
  const [gpsState, setGpsState] = useState(null)
  const [timerRunning, setTimerRunning] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [timerReady, setTimerReady] = useState(false)
  const [isUnlocked, setIsUnlocked] = useState(
    () => window.sessionStorage.getItem('raceHudUnlocked') === 'true'
  )
  const [passwordInput, setPasswordInput] = useState('')
  const [authError, setAuthError] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const [recordName, setRecordName] = useState('')
  const [recordModalOpen, setRecordModalOpen] = useState(false)
  const [recordError, setRecordError] = useState('')
  const [recordNotice, setRecordNotice] = useState('')

  const timerStartRef = useRef(null)
  const elapsedMsRef = useRef(0)
  const recordingIdRef = useRef(null)

  const {
    sensorData,
    isConnected,
    accelData,
    imuAccelData,
    imuOrientation,
    clearDisplayState,
  } = useWebSocket(`${WS_URL}/ws`, API_URL)

  const { laps, segments, ingestGps, recordLapManually, resetTracking, getTrackPayload } =
    useLapTracking()

  const { mapContainerRef, clearVehicleMarker } = useMap({
    gpsState,
    trackSegments: isRecording ? segments : [],
  })

  const latestGps = getLatestGps(sensorData)
  const liveSpeed = useMemo(
    () => getSpeedValue(sensorData, FIXED_LEFT_ITEMS),
    [sensorData]
  )

  useEffect(() => {
    if (!latestGps) return
    const speed =
      typeof latestGps.speed_kmh === 'number' ? latestGps.speed_kmh : liveSpeed
    setGpsState({ ...latestGps, speed_kmh: speed })
  }, [latestGps?.lat, latestGps?.lon, latestGps?.ts, latestGps?.speed_kmh, liveSpeed])

  useEffect(() => {
    if (!isRecording || !latestGps) return
    const speed =
      typeof latestGps.speed_kmh === 'number' ? latestGps.speed_kmh : undefined
    ingestGps(latestGps.lat, latestGps.lon, latestGps.ts, speed)
  }, [isRecording, latestGps?.lat, latestGps?.lon, latestGps?.ts, latestGps?.speed_kmh, ingestGps])

  const handleManualLap = () => {
    if (!isRecording || !gpsState) return
    recordLapManually(
      gpsState.lat,
      gpsState.lon,
      gpsState.ts || Date.now(),
      gpsState.speed_kmh
    )
  }

  const saveTrackData = useCallback(async (recordingId) => {
    if (!recordingId) return false
    try {
      const response = await fetch(
        `${API_URL}/api/recordings/${encodeURIComponent(recordingId)}/track`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(getTrackPayload()),
        }
      )
      return response.ok
    } catch (e) {
      return false
    }
  }, [getTrackPayload])

  const handleClearDisplay = () => {
    clearDisplayState()
    setGpsState(null)
    clearVehicleMarker()
    resetTracking()
    timerStartRef.current = null
    elapsedMsRef.current = 0
    setElapsedMs(0)
    setTimerRunning(false)
    setTimerReady(false)
  }

  useEffect(() => {
    elapsedMsRef.current = elapsedMs
  }, [elapsedMs])

  useEffect(() => {
    if (!timerRunning) return
    if (timerStartRef.current === null) {
      timerStartRef.current = performance.now() - elapsedMsRef.current
    }
    const tick = () => {
      setElapsedMs(performance.now() - timerStartRef.current)
    }
    const id = setInterval(tick, 100)
    return () => clearInterval(id)
  }, [timerRunning])

  const startTimer = () => {
    timerStartRef.current = performance.now()
    setElapsedMs(0)
    setTimerRunning(true)
    setTimerReady(true)
  }

  const togglePauseResume = () => {
    if (timerRunning) {
      setTimerRunning(false)
      return
    }
    timerStartRef.current = performance.now() - elapsedMs
    setTimerRunning(true)
  }

  const resetTimer = () => {
    setElapsedMs(0)
    setTimerRunning(false)
    setTimerReady(false)
    if (timerRunning) {
      timerStartRef.current = performance.now()
    } else {
      timerStartRef.current = null
    }
  }

  const handleUnlock = (event) => {
    event.preventDefault()
    if (passwordInput === APP_PASSWORD) {
      setIsUnlocked(true)
      window.sessionStorage.setItem('raceHudUnlocked', 'true')
      setAuthError('')
    } else {
      setAuthError('비밀번호가 올바르지 않습니다.')
    }
  }

  const startRecording = async () => {
    if (!recordName.trim()) {
      setRecordError('기록 이름을 입력하세요.')
      return
    }
    setRecordError('')
    setRecordNotice('')
    try {
      const response = await fetch(`${API_URL}/api/recordings/stream/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: recordName.trim(),
          startedAt: Date.now(),
        }),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => null)
        throw new Error(detail?.detail || `기록 시작 실패: ${response.status}`)
      }
      const data = await response.json()
      recordingIdRef.current = data.recordingId || data.recording?.id || null
      if (!recordingIdRef.current) {
        throw new Error('서버에서 recordingId를 받지 못했습니다.')
      }
      setRecordModalOpen(false)
      setIsRecording(true)
      resetTracking()
      setRecordNotice('서버가 수신되는 센서 데이터를 기록 중입니다. (화면 전송과 분리)')
    } catch (error) {
      setRecordError(
        error?.message ? `기록 시작 실패: ${error.message}` : '기록을 시작하지 못했습니다.'
      )
    }
  }

  const stopRecording = async () => {
    const recordingId = recordingIdRef.current
    if (!recordingId) {
      setRecordError('진행 중인 기록이 없습니다.')
      setIsRecording(false)
      return
    }
    setRecordError('')
    try {
      const response = await fetch(`${API_URL}/api/recordings/stream/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recordingId,
          endedAt: Date.now(),
        }),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => null)
        const message =
          typeof detail?.detail === 'string'
            ? detail.detail
            : Array.isArray(detail?.detail)
              ? detail.detail.map((item) => item?.msg).filter(Boolean).join(', ')
              : `기록 종료 실패: ${response.status}`
        throw new Error(message)
      }
      const data = await response.json()
      const savedName = data.recording?.name || recordName.trim() || recordingId
      const trackSaved = await saveTrackData(recordingId)
      resetTracking()
      setRecordNotice(
        trackSaved
          ? `기록 저장 완료: ${savedName}. 수동 랩 포함 — 분석실 랩 경로에서 확인하세요.`
          : `기록 저장 완료: ${savedName}. (랩 경로는 서버가 GPS로 자동 생성합니다)`
      )
    } catch (error) {
      setRecordError(
        error?.message ? `기록 종료 실패: ${error.message}` : '기록을 종료하지 못했습니다.'
      )
    } finally {
      recordingIdRef.current = null
      setIsRecording(false)
      setRecordName('')
    }
  }

  useEffect(() => {
    if (!isRecording || !recordingIdRef.current) return undefined
    const timer = setInterval(() => {
      saveTrackData(recordingIdRef.current)
    }, 5000)
    return () => clearInterval(timer)
  }, [isRecording, saveTrackData])

  useEffect(() => {
    if (!recordNotice) return undefined
    const timer = setTimeout(() => setRecordNotice(''), 8000)
    return () => clearTimeout(timer)
  }, [recordNotice])

  const hudValues = useMemo(() => {
    const imuAcceleration = imuAccelData
      ? { x: imuAccelData.x, y: imuAccelData.y, z: imuAccelData.z }
      : getImuAccelerationValues(sensorData)
    const imuEuler = imuOrientation
      ? {
          roll: imuOrientation.roll,
          pitch: imuOrientation.pitch,
          yaw: imuOrientation.yaw,
        }
      : getImuOrientationValues(sensorData)
    return {
      speed: getSpeedValue(sensorData, FIXED_LEFT_ITEMS),
      rpm: getRpmValue(sensorData, FIXED_LEFT_ITEMS),
      gear: getGearValue(sensorData, FIXED_LEFT_ITEMS),
      imuAcceleration,
      imuEuler,
      linearFl: getLinearValue(sensorData, 'linear_fl'),
      linearFr: getLinearValue(sensorData, 'linear_fr'),
      linearRl: getLinearValue(sensorData, 'linear_rl'),
      linearRr: getLinearValue(sensorData, 'linear_rr'),
      gForceL: getGForceValue(sensorData, 'l'),
      gForceR: getGForceValue(sensorData, 'r'),
    }
  }, [sensorData, imuAccelData, imuOrientation])

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black">
      {!isUnlocked && (
        <div className="absolute inset-0 z-[999] flex items-center justify-center bg-gradient-to-br from-black via-zinc-950 to-black/95 backdrop-blur-sm">
          <div className="relative w-[360px]">
            <div className="absolute -inset-0.5 rounded-2xl bg-gradient-to-r from-cyan-500/40 via-blue-500/20 to-purple-500/40 blur" />
            <form
              onSubmit={handleUnlock}
              className="relative w-full rounded-2xl border border-white/10 bg-black/70 p-6 shadow-2xl"
            >
              <div className="text-xs text-cyan-300 tracking-[0.3em] mb-2">TEAM A-FA BAJA</div>
              <div className="text-white text-xl font-bold mb-1">접속 비밀번호</div>
              <div className="text-zinc-400 text-sm mb-5">
                권한이 있는 사용자만 입장할 수 있습니다.
              </div>
              <input
                type="password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-black/60 text-white border border-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-500/60"
                placeholder="비밀번호 입력"
                autoFocus
              />
              {authError && <div className="text-red-400 text-xs mt-2">{authError}</div>}
              <button
                type="submit"
                className="mt-5 w-full rounded-xl bg-gradient-to-r from-cyan-400 to-blue-500 text-black font-bold py-3 hover:from-cyan-300 hover:to-blue-400 transition"
              >
                접속하기
              </button>
            </form>
          </div>
        </div>
      )}
      {recordModalOpen && (
        <div className="absolute inset-0 z-[998] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-[360px] rounded-2xl border border-white/10 bg-black/80 p-6 shadow-2xl">
            <div className="text-white text-lg font-bold mb-2">데이터 기록</div>
            <div className="text-zinc-400 text-sm mb-4">
              기록 이름을 입력하세요. 시작 후 서버가 MQTT로 수신한 센서 데이터를 DB에 저장합니다.
            </div>
            <input
              type="text"
              value={recordName}
              onChange={(e) => setRecordName(e.target.value)}
              className="w-full px-4 py-3 rounded-xl bg-black/60 text-white border border-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-500/60"
              placeholder="예: 테스트 주행 1"
              autoFocus
            />
            {recordError && <div className="text-red-400 text-xs mt-2">{recordError}</div>}
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => setRecordModalOpen(false)}
                className="flex-1 rounded-xl border border-white/10 bg-black/60 py-2 text-white hover:bg-black/80"
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => startRecording()}
                className="flex-1 rounded-xl bg-gradient-to-r from-cyan-400 to-blue-500 py-2 text-black font-semibold hover:from-cyan-300 hover:to-blue-400"
              >
                기록 시작
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 전체 화면 지도 */}
      <div className="absolute inset-0 z-0">
        <div ref={mapContainerRef} className="race-dark-map h-full w-full" />
        <div
          className="pointer-events-none absolute inset-0 z-[1]"
          style={{
            background:
              'radial-gradient(ellipse at center, transparent 45%, rgba(5, 7, 13, 0.55) 100%), linear-gradient(180deg, rgba(5,7,13,0.35) 0%, transparent 18%, transparent 82%, rgba(5,7,13,0.5) 100%)',
          }}
        />
      </div>

      {/* HUD 오버레이 */}
      <div className="absolute inset-0 z-10 pointer-events-none">
        <div className="absolute top-4 left-1/2 -translate-x-1/2">
          <div
            className={`px-4 py-2 rounded-full text-sm font-bold backdrop-blur-md border border-white/10 shadow-lg ${
              isConnected ? 'bg-green-500/80 text-white' : 'bg-red-500/80 text-white'
            }`}
          >
            {isConnected ? '● LIVE' : '● OFFLINE'}
          </div>
        </div>

        <div className="absolute top-4 left-4 pointer-events-auto flex flex-col gap-2 max-h-[85vh] overflow-y-auto">
          {isRecording && (
            <div className="bg-black/70 backdrop-blur-md px-4 py-3 rounded-xl border border-cyan-500/40 shadow-lg min-w-[200px]">
              <div className="text-xs text-cyan-300 uppercase tracking-wider mb-2">랩 타임</div>
              {laps.length === 0 ? (
                <div className="text-xs text-zinc-400">기록 중 · GPS 경로 추적</div>
              ) : (
                <div className="space-y-1">
                  {laps.map((lap) => (
                    <div
                      key={lap.lap}
                      className="flex items-center justify-between text-sm text-white tabular-nums"
                    >
                      <span className="text-zinc-400">
                        Lap {lap.lap}
                        {lap.manual ? ' (수동)' : ''}
                      </span>
                      <span className="font-semibold text-cyan-300">
                        {formatLapTime(lap.durationMs)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {segments.some((seg) => seg.isCurrent && seg.points.length >= 2) && laps.length > 0 && (
                <div className="mt-2 pt-2 border-t border-white/10 text-xs text-zinc-400">
                  Lap {segments.find((seg) => seg.isCurrent)?.lap} 주행 중
                </div>
              )}
              <button
                type="button"
                onClick={handleManualLap}
                disabled={!gpsState}
                className="mt-3 w-full rounded-lg border border-cyan-400/50 bg-cyan-950/50 py-2 text-xs font-semibold text-cyan-100 hover:bg-cyan-900/60 disabled:opacity-40"
              >
                1랩 수동 기록
              </button>
            </div>
          )}

          <div className="bg-black/70 backdrop-blur-md px-4 py-3 rounded-xl border border-white/10 shadow-lg min-w-[200px]">
            <div className="text-xs text-zinc-400 uppercase tracking-wider mb-2">GPS</div>
            {FIXED_GPS_ITEMS.map((item) => (
              <div key={item.id} className="text-xs text-white flex justify-between gap-4">
                <span className="text-zinc-400">{item.label}</span>
                <span className="tabular-nums">{item.value(gpsState)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="absolute top-4 right-4 pointer-events-auto flex flex-col items-end gap-2">
          <div className="flex items-start gap-2 flex-wrap justify-end">
            <button
              type="button"
              onClick={handleClearDisplay}
              className="bg-black/70 text-white text-xs px-3 py-2 rounded-full border border-white/10 hover:bg-black/80"
            >
              화면 청소
            </button>
            <button
              type="button"
              onClick={() => navigate('/analysis')}
              className="bg-black/70 text-white text-xs px-3 py-2 rounded-full border border-white/10 hover:bg-black/80"
            >
              분석실
            </button>
            <button
              type="button"
              onClick={isRecording ? () => stopRecording() : () => setRecordModalOpen(true)}
              className={`text-xs px-3 py-2 rounded-full font-semibold border ${
                isRecording
                  ? 'bg-red-500/90 text-white border-red-300/40 hover:bg-red-500'
                  : 'bg-black/70 text-white border-white/10 hover:bg-black/80'
              }`}
            >
              {isRecording ? '데이터 기록 중지' : '데이터 기록'}
            </button>
            <button
              type="button"
              onClick={timerReady ? resetTimer : startTimer}
              className="bg-gradient-to-r from-cyan-400/90 to-blue-500/90 text-black text-xs px-3 py-2 rounded-full font-semibold hover:from-cyan-300/90 hover:to-blue-400/90"
            >
              {timerReady ? '타이머 초기화' : '타이머 시작'}
            </button>
          </div>
          <div className="bg-black/70 backdrop-blur-md px-4 py-2 rounded-full text-sm font-bold text-white border border-white/10 shadow-lg">
            {formatElapsed(elapsedMs)}
          </div>
          {timerReady && (
            <button
              type="button"
              onClick={togglePauseResume}
              className="bg-black/70 text-white text-xs px-3 py-2 rounded-full border border-white/10 hover:bg-black/80"
            >
              {timerRunning ? '일시정지' : '재개'}
            </button>
          )}
          {isRecording && (
            <div className="rounded-lg border border-red-400/40 bg-red-950/70 px-3 py-1.5 text-[11px] text-red-100">
              서버 센서 기록 중
            </div>
          )}
          {recordNotice && (
            <div className="max-w-[320px] rounded-lg border border-cyan-400/40 bg-cyan-950/70 px-3 py-1.5 text-[11px] text-cyan-100">
              {recordNotice}
            </div>
          )}
          {recordError && (
            <div className="max-w-[320px] rounded-lg border border-red-400/40 bg-red-950/70 px-3 py-1.5 text-[11px] text-red-200">
              {recordError}
            </div>
          )}
        </div>

        <div className="absolute left-4 bottom-4 pointer-events-auto">
          <AccelWidget
            x={hudValues.imuAcceleration.x}
            y={hudValues.imuAcceleration.y}
            z={hudValues.imuAcceleration.z}
            pitch={hudValues.imuEuler.pitch}
            roll={hudValues.imuEuler.roll}
            yaw={hudValues.imuEuler.yaw}
          />
        </div>

        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 pointer-events-auto">
          <div className="relative bg-black/30 backdrop-blur-md p-3 rounded-full border border-cyan-500/70 shadow-2xl">
            <SpeedGauge speed={hudValues.speed} rpm={hudValues.rpm} gear={hudValues.gear} />
            <LinearCards
              linearFl={hudValues.linearFl}
              linearFr={hudValues.linearFr}
              linearRl={hudValues.linearRl}
              linearRr={hudValues.linearRr}
              gForceL={hudValues.gForceL}
              gForceR={hudValues.gForceR}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
