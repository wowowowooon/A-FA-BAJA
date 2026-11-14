import React, { memo } from 'react'

function AccelWidget({
  x,
  y,
  z,
  pitch = 0,
  roll = 0,
  yaw = 0,
  className = '',
}) {
  const clamp = (val, min, max) => Math.max(min, Math.min(max, val))

  const size = 160
  const half = size / 2
  const targetX = clamp(x / 3, -1, 1)
  const targetY = clamp(y / 3, -1, 1)
  const dotX = half + targetX * (half - 6)
  const dotY = half - targetY * (half - 6)

  return (
    <div
      className={`bg-black/50 backdrop-blur-md px-4 py-4 rounded-2xl border border-white/10 shadow-xl min-w-[200px] ${className}`}
    >
      <div className="grid grid-cols-3 gap-2 text-center mb-3">
        <div className="bg-black/60 border border-cyan-500/40 rounded-lg py-1">
          <div className="text-[10px] text-cyan-300/80">PITCH</div>
          <div className="text-sm font-semibold tabular-nums text-cyan-200">
            {pitch.toFixed(2)}°
          </div>
        </div>
        <div className="bg-black/60 border border-cyan-500/40 rounded-lg py-1">
          <div className="text-[10px] text-cyan-300/80">ROLL</div>
          <div className="text-sm font-semibold tabular-nums text-cyan-200">
            {roll.toFixed(2)}°
          </div>
        </div>
        <div className="bg-black/60 border border-cyan-500/40 rounded-lg py-1">
          <div className="text-[10px] text-cyan-300/80">YAW</div>
          <div className="text-sm font-semibold tabular-nums text-cyan-200">
            {yaw.toFixed(2)}°
          </div>
        </div>
      </div>
      <div
        className="relative mx-auto rounded-full border border-cyan-500/60 bg-black/60"
        style={{ width: size, height: size }}
      >
        <div className="absolute inset-4 border border-white/10 rounded-full" />
        <div className="absolute inset-8 border border-white/10 rounded-full" />
        <div className="absolute inset-0">
          <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/10" />
          <div className="absolute top-1/2 left-0 right-0 h-px bg-white/10" />
        </div>
        <div
          className="absolute w-2.5 h-2.5 rounded-full bg-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.9)]"
          style={{ left: dotX - 5, top: dotY - 5 }}
        />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="bg-black/60 border border-cyan-500/40 rounded-lg py-1">
          <div className="text-[10px] text-cyan-300/80">X</div>
          <div className="text-sm font-semibold tabular-nums text-cyan-200">
            {x.toFixed(2)}g
          </div>
        </div>
        <div className="bg-black/60 border border-cyan-500/40 rounded-lg py-1">
          <div className="text-[10px] text-cyan-300/80">Y</div>
          <div className="text-sm font-semibold tabular-nums text-cyan-200">
            {y.toFixed(2)}g
          </div>
        </div>
        <div className="bg-black/60 border border-cyan-500/40 rounded-lg py-1">
          <div className="text-[10px] text-cyan-300/80">Z</div>
          <div className="text-sm font-semibold tabular-nums text-cyan-200">
            {z.toFixed(2)}g
          </div>
        </div>
      </div>
    </div>
  )
}

export default memo(AccelWidget)
