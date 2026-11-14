import React, { memo } from 'react'

const SPEED_GAUGE_MAX = 360
const RPM_GAUGE_MAX = 14000

function SpeedGauge({ speed, rpm, gear }) {
  const safeSpeed = Math.max(0, Math.min(SPEED_GAUGE_MAX, speed || 0))
  const safeRpm = Math.max(0, Math.min(RPM_GAUGE_MAX, rpm || 0))
  const speedRatio = SPEED_GAUGE_MAX > 0 ? safeSpeed / SPEED_GAUGE_MAX : 0
  const rpmRatio = RPM_GAUGE_MAX > 0 ? safeRpm / RPM_GAUGE_MAX : 0

  const center = 120
  const outerRadius = 100
  const innerRadius = 78
  const circumferenceOuter = 2 * Math.PI * outerRadius
  const circumferenceInner = 2 * Math.PI * innerRadius

  return (
    <div className="flex flex-col items-center">
      <svg width="240" height="240" viewBox="0 0 240 240">
        <g transform={`rotate(-90 ${center} ${center})`}>
          <circle
            cx={center}
            cy={center}
            r={outerRadius}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth="14"
          />
          <circle
            cx={center}
            cy={center}
            r={outerRadius}
            fill="none"
            stroke="rgba(34,211,238,0.9)"
            strokeWidth="14"
            strokeLinecap="round"
            strokeDasharray={`${circumferenceOuter * speedRatio} ${circumferenceOuter}`}
          />
          <circle
            cx={center}
            cy={center}
            r={innerRadius}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth="10"
          />
          <circle
            cx={center}
            cy={center}
            r={innerRadius}
            fill="none"
            stroke="rgba(16,185,129,0.9)"
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={`${circumferenceInner * rpmRatio} ${circumferenceInner}`}
          />
        </g>
        <text
          x={center}
          y="80"
          textAnchor="middle"
          fill="rgba(255,255,255,0.7)"
          fontSize="18"
          fontWeight="600"
        >
          GEAR
        </text>
        <text
          x={center}
          y="110"
          textAnchor="middle"
          fill="white"
          fontSize="36"
          fontWeight="700"
        >
          {gear || '-'}
        </text>
        <text
          x={center}
          y="145"
          textAnchor="middle"
          fill="rgba(255,255,255,0.7)"
          fontSize="14"
        >
          RPM
        </text>
        <text
          x={center}
          y="170"
          textAnchor="middle"
          fill="white"
          fontSize="20"
          fontWeight="600"
        >
          {Math.round(safeRpm)}
        </text>
        <text
          x={center}
          y="200"
          textAnchor="middle"
          fill="white"
          fontSize="32"
          fontWeight="700"
        >
          {Math.round(safeSpeed)}
        </text>
        <text
          x={center}
          y="220"
          textAnchor="middle"
          fill="rgba(255,255,255,0.6)"
          fontSize="12"
        >
          km/h
        </text>
      </svg>
    </div>
  )
}

export default memo(SpeedGauge)
