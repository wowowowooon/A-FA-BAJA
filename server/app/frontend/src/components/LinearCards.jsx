import React, { memo } from 'react'

function LinearCards({
  linearFl,
  linearFr,
  linearRl,
  linearRr,
  gForceL,
  gForceR,
}) {
  return (
    <>
      <div className="absolute top-6 -left-12 text-xs text-cyan-200 bg-black/60 border border-cyan-500/40 rounded-lg px-2 py-1 shadow-lg">
        <div className="text-[10px] text-cyan-300/80">리니어 FL</div>
        <div className="text-sm font-semibold tabular-nums">
          {linearFl.toFixed(1)}mm
        </div>
      </div>
      <div className="absolute -top-10 left-6 text-xs text-cyan-200 bg-black/60 border border-cyan-500/40 rounded-lg px-2 py-1 shadow-lg text-center">
        <div className="text-[10px] text-cyan-300/80">G-FORCE L</div>
        <div className="text-sm font-semibold tabular-nums">
          {gForceL.toFixed(2)}G
        </div>
      </div>
      <div className="absolute top-6 -right-12 text-xs text-cyan-200 bg-black/60 border border-cyan-500/40 rounded-lg px-2 py-1 shadow-lg text-right">
        <div className="text-[10px] text-cyan-300/80">리니어 FR</div>
        <div className="text-sm font-semibold tabular-nums">
          {linearFr.toFixed(1)}mm
        </div>
      </div>
      <div className="absolute -top-10 right-6 text-xs text-cyan-200 bg-black/60 border border-cyan-500/40 rounded-lg px-2 py-1 shadow-lg text-center">
        <div className="text-[10px] text-cyan-300/80">G-FORCE R</div>
        <div className="text-sm font-semibold tabular-nums">
          {gForceR.toFixed(2)}G
        </div>
      </div>
      <div className="absolute bottom-6 -right-12 text-xs text-cyan-200 bg-black/60 border border-cyan-500/40 rounded-lg px-2 py-1 shadow-lg text-right">
        <div className="text-[10px] text-cyan-300/80">리니어 RR</div>
        <div className="text-sm font-semibold tabular-nums">
          {linearRr.toFixed(1)}mm
        </div>
      </div>
      <div className="absolute bottom-6 -left-12 text-xs text-cyan-200 bg-black/60 border border-cyan-500/40 rounded-lg px-2 py-1 shadow-lg">
        <div className="text-[10px] text-cyan-300/80">리니어 RL</div>
        <div className="text-sm font-semibold tabular-nums">
          {linearRl.toFixed(1)}mm
        </div>
      </div>
    </>
  )
}

export default memo(LinearCards)
