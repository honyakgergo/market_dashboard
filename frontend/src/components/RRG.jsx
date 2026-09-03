// ============================================================
// components/RRG.jsx
// Relative Rotation Graph — the four-quadrant rotation view.
//
// How to read it. Both axes are measured against the benchmark (SPY) and
// centred on 100, so the crosshair at (100,100) IS the benchmark:
//
//   x — RS-Ratio     relative STRENGTH. Right of centre = outperforming.
//   y — RS-Momentum  the rate of change of that strength. Above centre = the
//                    outperformance is still building.
//
//        │ IMPROVING          │ LEADING            │
//        │ weak but turning   │ strong and still   │
//        │ up — early entries │ accelerating       │
//   ─────┼────────────────────┼────────────────────┼──── RS-Ratio
//        │ LAGGING            │ WEAKENING          │
//        │ weak and still     │ strong but losing  │
//        │ falling — avoid    │ steam — take profit│
//
// Healthy rotation travels CLOCKWISE: improving → leading → weakening →
// lagging → improving. The tail is the last N weekly readings, so its
// direction and length tell you where a name is heading and how fast; a long
// tail sweeping clockwise out of "lagging" is the setup people actually use
// this chart to find. A name sitting on the crosshair is simply the benchmark.
// ============================================================

import React, { useEffect, useRef, useState, useMemo } from 'react'
import Plotly from 'plotly.js-dist-min'

const QUAD = {
  leading:   { label: 'LEADING',   color: '#26a69a', fill: 'rgba(38,166,154,0.055)' },
  weakening: { label: 'WEAKENING', color: '#e0a23a', fill: 'rgba(224,162,58,0.055)' },
  lagging:   { label: 'LAGGING',   color: '#ef5350', fill: 'rgba(239,83,80,0.055)' },
  improving: { label: 'IMPROVING', color: '#2962ff', fill: 'rgba(41,98,255,0.055)' },
}
const QUAD_ORDER = ['leading', 'improving', 'weakening', 'lagging']

export default function RRG({ rows, benchmark = 'SPY', tailWeeks = 12, onPick, height = 470 }) {
  const ref = useRef(null)
  const [tail, setTail] = useState(6)
  const [hidden, setHidden] = useState(() => new Set())

  const visible = useMemo(
    () => (rows || []).filter((r) => !hidden.has(r.symbol)),
    [rows, hidden],
  )

  // Symmetric bounds around 100 so the quadrants are equal quarters — an
  // asymmetric axis would make one quadrant look bigger than it is.
  const bound = useMemo(() => {
    let m = 1.5
    for (const r of visible) {
      for (const p of r.tail.slice(-tail)) {
        m = Math.max(m, Math.abs(p.ratio - 100), Math.abs(p.mom - 100))
      }
    }
    return m * 1.18
  }, [visible, tail])

  useEffect(() => {
    if (!ref.current) return
    const lo = 100 - bound, hi = 100 + bound

    const traces = []
    for (const r of visible) {
      const pts = r.tail.slice(-tail)
      if (!pts.length) continue
      const col = QUAD[r.quadrant]?.color || '#787b86'
      // The tail: thin, semi-transparent, no markers — context, not the subject.
      if (pts.length > 1) {
        traces.push({
          type: 'scatter', mode: 'lines',
          x: pts.map((p) => p.ratio), y: pts.map((p) => p.mom),
          line: { color: col, width: 1.4, shape: 'spline', smoothing: 0.6 },
          opacity: 0.5, hoverinfo: 'skip', showlegend: false,
        })
      }
      // The head: where the name is NOW.
      const head = pts[pts.length - 1]
      // Label only the names far enough from the crosshair to be legible.
      // Everything clusters around (100,100) by construction, and printing a
      // dozen symbols on top of each other there produces an unreadable smear
      // that hides the very outliers the chart exists to show. The quadrant
      // roster underneath names every member, and hovering identifies any dot.
      const labelled = Math.hypot(head.ratio - 100, head.mom - 100) >= bound * 0.22
      traces.push({
        type: 'scatter', mode: labelled ? 'markers+text' : 'markers',
        x: [head.ratio], y: [head.mom],
        marker: { size: labelled ? 11 : 8, color: col, line: { color: '#131722', width: 1.5 } },
        text: [r.symbol], textposition: 'top center',
        textfont: { size: 9.5, color: '#d1d4dc', family: 'IBM Plex Mono, monospace' },
        customdata: [[r.name, r.quadrant, r.rel_1m, r.ret_1m, r.strength]],
        hovertemplate:
          `<b>${r.symbol}</b> · %{customdata[0]}<br>` +
          'RS-Ratio %{x:.2f} · RS-Mom %{y:.2f}<br>' +
          '%{customdata[1]} · strength %{customdata[4]:.2f}<br>' +
          'vs ' + benchmark + ' 1M %{customdata[2]:+.2%}<extra></extra>',
        showlegend: false,
      })
    }

    const layout = {
      margin: { l: 46, r: 14, t: 10, b: 34 },
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 9.5, color: '#787b86' },
      hovermode: 'closest',
      hoverlabel: { bgcolor: '#1e222d', bordercolor: '#363b48', font: { family: 'IBM Plex Mono, monospace', size: 10, color: '#d1d4dc' } },
      showlegend: false,
      shapes: [
        // quadrant washes
        { type: 'rect', x0: 100, x1: hi, y0: 100, y1: hi, fillcolor: QUAD.leading.fill, line: { width: 0 }, layer: 'below' },
        { type: 'rect', x0: 100, x1: hi, y0: lo, y1: 100, fillcolor: QUAD.weakening.fill, line: { width: 0 }, layer: 'below' },
        { type: 'rect', x0: lo, x1: 100, y0: lo, y1: 100, fillcolor: QUAD.lagging.fill, line: { width: 0 }, layer: 'below' },
        { type: 'rect', x0: lo, x1: 100, y0: 100, y1: hi, fillcolor: QUAD.improving.fill, line: { width: 0 }, layer: 'below' },
        // the benchmark crosshair
        { type: 'line', x0: 100, x1: 100, y0: lo, y1: hi, line: { color: '#4a4f5c', width: 1 } },
        { type: 'line', x0: lo, x1: hi, y0: 100, y1: 100, line: { color: '#4a4f5c', width: 1 } },
      ],
      annotations: [
        quadLabel(hi - 0.04 * bound, hi - 0.04 * bound, 'LEADING', QUAD.leading.color, 'right', 'top'),
        quadLabel(hi - 0.04 * bound, lo + 0.04 * bound, 'WEAKENING', QUAD.weakening.color, 'right', 'bottom'),
        quadLabel(lo + 0.04 * bound, lo + 0.04 * bound, 'LAGGING', QUAD.lagging.color, 'left', 'bottom'),
        quadLabel(lo + 0.04 * bound, hi - 0.04 * bound, 'IMPROVING', QUAD.improving.color, 'left', 'top'),
      ],
      xaxis: {
        range: [lo, hi], gridcolor: '#22262f', zeroline: false,
        title: { text: `RS-Ratio  →  relative strength vs ${benchmark}`, font: { size: 9 } },
      },
      yaxis: {
        range: [lo, hi], gridcolor: '#22262f', zeroline: false,
        title: { text: 'RS-Momentum  →  is it accelerating?', font: { size: 9 } },
      },
    }

    Plotly.react(ref.current, traces, layout, { responsive: true, displayModeBar: false })

    const el = ref.current
    const onClick = (e) => {
      const sym = e.points?.[0]?.text
      if (sym && onPick) onPick(sym)
    }
    el.removeAllListeners?.('plotly_click')
    el.on('plotly_click', onClick)
  }, [visible, tail, bound, benchmark, onPick])

  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])

  const toggle = (sym) => setHidden((prev) => {
    const next = new Set(prev)
    if (next.has(sym)) next.delete(sym); else next.add(sym)
    return next
  })

  if (!rows?.length) {
    return <div className="lbl-dim" style={{ padding: 14 }}>
      Rotation data unavailable — the benchmark or members are missing from the cache.
    </div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="lbl-dim">tail</span>
        <div style={{ display: 'flex', gap: 3 }}>
          {[3, 6, 9, tailWeeks].filter((v, i, a) => a.indexOf(v) === i && v <= tailWeeks).map((w) => (
            <button key={w} onClick={() => setTail(w)} className="num"
              style={{
                padding: '2px 8px', borderRadius: 3, fontSize: 10.5,
                background: tail === w ? 'var(--elevated)' : 'transparent',
                color: tail === w ? 'var(--text)' : 'var(--text-muted)',
                border: `1px solid ${tail === w ? 'var(--border-strong)' : 'transparent'}`,
              }}>{w}w</button>
          ))}
        </div>
        <span className="lbl-dim" style={{ marginLeft: 'auto' }}>
          weekly · vs {benchmark} · click a point to open
        </span>
      </div>

      <div ref={ref} style={{ width: '100%', height }} />

      {/* Quadrant roster — the same information as a list, which is often the
          faster read, and doubles as the show/hide control. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {QUAD_ORDER.map((q) => {
          const members = (rows || []).filter((r) => r.quadrant === q)
          return (
            <div key={q} style={{ border: '1px solid var(--hairline)', borderRadius: 5, padding: '6px 8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                <span className="lbl" style={{ color: QUAD[q].color }}>{QUAD[q].label}</span>
                <span className="num lbl-dim">{members.length}</span>
              </div>
              {members.length === 0
                ? <span className="lbl-dim">none</span>
                : members.map((r) => (
                  <div key={r.symbol} onClick={() => toggle(r.symbol)}
                    title={`${r.name} — click to hide/show on the chart`}
                    style={{
                      display: 'flex', justifyContent: 'space-between', gap: 6,
                      cursor: 'pointer', opacity: hidden.has(r.symbol) ? 0.35 : 1,
                      lineHeight: 1.65,
                    }}>
                    <span className="num" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.symbol}
                    </span>
                    <span className="num" style={{
                      fontSize: 10.5, flexShrink: 0,
                      color: r.rel_1m == null ? 'var(--text-dim)'
                        : r.rel_1m > 0 ? 'var(--bull)' : r.rel_1m < 0 ? 'var(--bear)' : 'var(--text-muted)',
                    }}>
                      {r.rel_1m == null ? '—' : `${r.rel_1m >= 0 ? '+' : ''}${(r.rel_1m * 100).toFixed(1)}`}
                    </span>
                  </div>
                ))}
            </div>
          )
        })}
      </div>
      <div className="lbl-dim" style={{ lineHeight: 1.5, textTransform: 'none', letterSpacing: 0, fontSize: 10.5 }}>
        Numbers are 1-month return <em>relative to {benchmark}</em>, in percentage points. Rotation normally runs
        clockwise: improving → leading → weakening → lagging. Distance from the centre is conviction — a name near
        the crosshair is behaving like the benchmark, whichever quadrant it technically sits in, so only names far
        enough out to be legible are labelled; hover any dot to identify it, or click a name in the lists to hide it.
      </div>
    </div>
  )
}

function quadLabel(x, y, text, color, xanchor, yanchor) {
  return {
    x, y, text, showarrow: false, xanchor, yanchor,
    font: { size: 9, color, family: 'IBM Plex Sans, sans-serif' },
    opacity: 0.75,
  }
}
