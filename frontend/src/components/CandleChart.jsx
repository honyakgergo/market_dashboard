// ============================================================
// components/CandleChart.jsx
// TradingView-style price chart: candles + optional MA50/MA200/BB/regime,
// three separated + labeled panes (price / volume / RSI), a themed dotted
// crosshair, and a pinned top-left OHLC legend that tracks the crosshair.
//
// NEW:
//   - volume + RSI panes are smaller and brighter (more chart to price)
//   - click a candle to set an ENTRY; click a later candle to set an EXIT.
//     The held window is shaded and marked; parent gets onCandleClick(index).
//
// Toggles/props: showBB, showRegime, showMA50, showMA200,
//                onCandleClick(index), entryIndex, exitIndex.
// ============================================================

import React, { useEffect, useRef, useState } from 'react'
import Plotly from 'plotly.js-dist-min'

const COL = {
  bull: '#089981', bear: '#f23645',
  ma50: '#5b9cf3', ma200: '#e0a23a', bb: '94,156,243',
  grid: '#2a2e39', sep: '#363b48', text: '#787b86', dim: '#5a5d68', crosshair: '#6b7080',
  entry: '#089981', exit: '#2962ff',
  volUp: 'rgba(8,153,129,0.72)', volDn: 'rgba(242,54,69,0.72)',   // brighter
  rsi: '#b9a5d0',                                                  // brighter
}
const WASH = { Bull: 'rgba(8,153,129,0.06)', Bear: 'rgba(242,54,69,0.06)', Sideways: 'rgba(224,162,58,0.045)' }

// pane vertical layout (paper coords) — price gets more room; vol/RSI shrunk
const PRICE = [0.32, 1.0], VOL = [0.17, 0.29], RSI = [0.0, 0.15]
const SEP1 = 0.305, SEP2 = 0.16

function regimeShapes(history, show) {
  if (!show) return []
  const out = []
  let start = 0
  for (let i = 1; i <= history.length; i++) {
    if (i === history.length || history[i].regime !== history[start].regime) {
      out.push({ type: 'rect', xref: 'x', yref: 'paper', x0: history[start].date, x1: history[i - 1].date,
        y0: PRICE[0], y1: PRICE[1], fillcolor: WASH[history[start].regime] || 'transparent', line: { width: 0 }, layer: 'below' })
      start = i
    }
  }
  return out
}

function selectionShapes(history, entryIndex, exitIndex) {
  if (entryIndex == null || !history.length) return []
  const x = history.map((d) => d.date)
  const endIdx = exitIndex != null ? exitIndex : history.length - 1
  const out = [
    // held-window shading across the price pane
    { type: 'rect', xref: 'x', yref: 'paper', x0: x[entryIndex], x1: x[endIdx],
      y0: PRICE[0], y1: PRICE[1], fillcolor: 'rgba(41,98,255,0.07)', line: { width: 0 }, layer: 'below' },
    // entry marker
    { type: 'line', xref: 'x', yref: 'paper', x0: x[entryIndex], x1: x[entryIndex],
      y0: PRICE[0], y1: PRICE[1], line: { color: COL.entry, width: 1.4 } },
  ]
  if (exitIndex != null) {
    out.push({ type: 'line', xref: 'x', yref: 'paper', x0: x[exitIndex], x1: x[exitIndex],
      y0: PRICE[0], y1: PRICE[1], line: { color: COL.exit, width: 1.4 } })
  }
  return out
}

// Analyst price-target overlay on the price pane: a faint band between the
// low and high targets + a dashed line at the mean. Purely additive; drawn
// only when targets are supplied (single US equities).
function targetShapes(pt) {
  if (!pt || pt.mean == null) return []
  const out = []
  if (pt.low != null && pt.high != null) {
    out.push({ type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: pt.low, y1: pt.high,
      fillcolor: 'rgba(41,98,255,0.06)', line: { width: 0 }, layer: 'below' })
  }
  out.push({ type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: pt.mean, y1: pt.mean,
    line: { color: '#2962ff', width: 1, dash: 'dash' } })
  return out
}

export default function CandleChart({
  history, showBB = false, showRegime = true, showMA50 = true, showMA200 = true,
  onCandleClick, onClearSelection, entryIndex = null, exitIndex = null, priceTargets = null,
}) {
  const ref = useRef(null)
  const [hover, setHover] = useState(null)

  useEffect(() => {
    if (!ref.current || !history?.length) return
    const x = history.map((d) => d.date)

    const bbTraces = showBB ? [
      { type: 'scatter', mode: 'lines', x, y: history.map((d) => d.bb_upper), yaxis: 'y',
        line: { color: `rgba(${COL.bb},0.7)`, width: 1, dash: 'dot' }, hoverinfo: 'skip', showlegend: false },
      { type: 'scatter', mode: 'lines', x, y: history.map((d) => d.bb_lower), yaxis: 'y',
        line: { color: `rgba(${COL.bb},0.7)`, width: 1, dash: 'dot' }, fill: 'tonexty',
        fillcolor: `rgba(${COL.bb},0.08)`, hoverinfo: 'skip', showlegend: false },
    ] : []

    const maTraces = []
    if (showMA50) maTraces.push({ type: 'scatter', mode: 'lines', x, y: history.map((d) => d.ma50), yaxis: 'y',
      line: { color: COL.ma50, width: 1.2 }, hoverinfo: 'skip', showlegend: false })
    if (showMA200) maTraces.push({ type: 'scatter', mode: 'lines', x, y: history.map((d) => d.ma200), yaxis: 'y',
      line: { color: COL.ma200, width: 1.2 }, hoverinfo: 'skip', showlegend: false })

    const candles = {
      type: 'candlestick', x,
      open: history.map((d) => d.open), high: history.map((d) => d.high),
      low: history.map((d) => d.low), close: history.map((d) => d.close),
      increasing: { line: { color: COL.bull }, fillcolor: COL.bull },
      decreasing: { line: { color: COL.bear }, fillcolor: COL.bear },
      yaxis: 'y', showlegend: false, hoverinfo: 'x',
    }
    const vol = { type: 'bar', x, y: history.map((d) => d.volume), yaxis: 'y2',
      marker: { color: history.map((d) => (d.close >= d.open ? COL.volUp : COL.volDn)) },
      hoverinfo: 'skip', showlegend: false }
    const rsi = { type: 'scatter', mode: 'lines', x, y: history.map((d) => d.rsi), yaxis: 'y3',
      line: { color: COL.rsi, width: 1.3 }, hoverinfo: 'skip', showlegend: false }

    // Clean crosshair: one thin SOLID subtle-grey line per axis. No dashes
    // (dashes read as a broken/haloed "margin") and an explicitly non-white
    // colour so the cross never renders as a bright white bar.
    const spike = { showspikes: true, spikecolor: '#4a4f5c', spikethickness: 1, spikedash: 'solid', spikemode: 'across', spikesnap: 'cursor' }

    const layout = {
      margin: { l: 8, r: 58, t: 8, b: 22 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 10, color: COL.text }, showlegend: false,
      dragmode: 'pan', hovermode: 'x',
      hoverlabel: { bgcolor: '#1e222d', bordercolor: COL.sep, font: { family: 'IBM Plex Mono, monospace', size: 10, color: '#d1d4dc' } },
      shapes: [
        ...regimeShapes(history, showRegime),
        ...targetShapes(priceTargets),
        ...selectionShapes(history, entryIndex, exitIndex),
        { type: 'line', xref: 'paper', yref: 'paper', x0: 0, x1: 1, y0: SEP1, y1: SEP1, line: { color: COL.sep, width: 1 } },
        { type: 'line', xref: 'paper', yref: 'paper', x0: 0, x1: 1, y0: SEP2, y1: SEP2, line: { color: COL.sep, width: 1 } },
        { type: 'line', xref: 'paper', yref: 'y3', x0: 0, x1: 1, y0: 70, y1: 70, line: { color: COL.grid, width: 0.8, dash: 'dot' } },
        { type: 'line', xref: 'paper', yref: 'y3', x0: 0, x1: 1, y0: 30, y1: 30, line: { color: COL.grid, width: 0.8, dash: 'dot' } },
      ],
      annotations: [
        ...(priceTargets?.mean != null ? [{
          xref: 'paper', yref: 'y', x: 0.995, y: priceTargets.mean,
          text: `tgt ${Number(priceTargets.mean).toFixed(priceTargets.mean < 20 ? 2 : 0)}`,
          showarrow: false, font: { size: 9, color: '#6fa8dc' }, xanchor: 'right', yanchor: 'bottom',
          bgcolor: 'rgba(19,23,34,0.65)', bordercolor: 'rgba(41,98,255,0.4)', borderpad: 2,
        }] : []),
        { xref: 'paper', yref: 'paper', x: 0.004, y: VOL[1] - 0.006, text: 'VOLUME', showarrow: false, font: { size: 8.5, color: COL.dim }, xanchor: 'left', yanchor: 'top' },
        { xref: 'paper', yref: 'paper', x: 0.004, y: RSI[1] - 0.006, text: 'RSI', showarrow: false, font: { size: 8.5, color: COL.dim }, xanchor: 'left', yanchor: 'top' },
      ],
      xaxis: { gridcolor: COL.grid, rangeslider: { visible: false }, domain: [0, 1], anchor: 'y3', ...spike },
      yaxis: { gridcolor: COL.grid, domain: PRICE, side: 'right', tickformat: '.2f', ...spike },
      yaxis2: { gridcolor: COL.grid, domain: VOL, side: 'right', showgrid: false, nticks: 2 },
      yaxis3: { gridcolor: COL.grid, domain: RSI, side: 'right', range: [0, 100], tickvals: [30, 70] },
    }
    const config = { responsive: true, displayModeBar: false, scrollZoom: true }
    Plotly.react(ref.current, [...bbTraces, ...maTraces, candles, vol, rsi], layout, config)

    const el = ref.current
    const onHover = (e) => {
      const p = e.points?.find((pt) => pt.data?.type === 'candlestick') ?? e.points?.[0]
      if (p) setHover(p.pointNumber)
    }
    const onUnhover = () => setHover(null)
    const onClick = (e) => {
      const p = e.points?.find((pt) => pt.data?.type === 'candlestick') ?? e.points?.[0]
      if (p && onCandleClick) onCandleClick(p.pointNumber)
    }
    el.removeAllListeners?.('plotly_hover'); el.removeAllListeners?.('plotly_unhover'); el.removeAllListeners?.('plotly_click')
    el.on('plotly_hover', onHover); el.on('plotly_unhover', onUnhover); el.on('plotly_click', onClick)

    // right-click anywhere on the chart clears the entry/exit marking
    const onCtx = (ev) => { ev.preventDefault(); if (onClearSelection) onClearSelection() }
    el.addEventListener('contextmenu', onCtx)
    return () => { el.removeEventListener('contextmenu', onCtx) }
  }, [history, showBB, showRegime, showMA50, showMA200, entryIndex, exitIndex, priceTargets, onCandleClick, onClearSelection])

  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])

  const bar = history?.length ? history[hover ?? history.length - 1] : null

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {bar && (
        <div style={{ position: 'absolute', top: 8, left: 12, zIndex: 2, pointerEvents: 'none',
          fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.55, color: 'var(--text-muted)',
          display: 'flex', flexDirection: 'column' }}>
          <span style={{ color: 'var(--text)' }}>{bar.date}</span>
          <OHLC bar={bar} />
          {showMA50 && <span style={{ color: COL.ma50 }}>MA50 {fmt(bar.ma50)}</span>}
          {showMA200 && <span style={{ color: COL.ma200 }}>MA200 {fmt(bar.ma200)}</span>}
        </div>
      )}
      <div ref={ref} style={{ width: '100%', height: '100%' }} />
    </div>
  )
}

function OHLC({ bar }) {
  const c = bar.close >= bar.open ? COL.bull : COL.bear
  return (
    <>
      <span style={{ color: c }}>O {fmt(bar.open)}</span>
      <span style={{ color: c }}>H {fmt(bar.high)}</span>
      <span style={{ color: c }}>L {fmt(bar.low)}</span>
      <span style={{ color: c }}>C {fmt(bar.close)}</span>
    </>
  )
}
const fmt = (x) => (x == null ? '—' : Number(x).toFixed(2))
