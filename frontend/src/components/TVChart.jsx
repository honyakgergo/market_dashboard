// ============================================================
// components/TVChart.jsx
// The price chart, built on TradingView's own lightweight-charts engine
// rather than on Plotly. That is the whole point: pan/zoom, the price scale,
// the crosshair and the last-price tag are TradingView's real implementations,
// so the chart FEELS like TradingView instead of imitating it.
//
// What that buys us over the old Plotly candlestick:
//   · wheel = zoom around the cursor, shift+wheel / drag = scroll, and
//     ctrl+wheel = scale the price axis — the actual TradingView bindings
//   · a live price scale on the RIGHT with the last-price tag, the MA values
//     and (optionally) the analyst target, each drawn in its series colour
//   · true panes: price / volume / RSI are separate panes with their own
//     price scales, so volume no longer squashes the candles
//   · the series keeps rendering while you pan past the loaded range instead
//     of re-laying-out the entire figure on every interaction
//
// Props mirror the old CandleChart so the page didn't have to change shape:
//   history, showBB, showMA50, showMA200, showRegime, priceTargets,
//   onCandleClick(index), onClearSelection, entryIndex, exitIndex
// ============================================================

import React, { useEffect, useRef, useState, useCallback } from 'react'
import {
  createChart, CandlestickSeries, HistogramSeries, LineSeries, AreaSeries,
  CrosshairMode, LineStyle, createSeriesMarkers,
} from 'lightweight-charts'

// TradingView's own dark-theme palette, not an approximation of it.
const TV = {
  // A solid chart ground, distinct from the surrounding panel, is half of what
  // makes a TradingView chart read as a chart rather than as part of the page.
  bg: '#131722',
  text: '#b2b5be',
  textDim: '#787b86',
  // TradingView's actual dark grid value. The near-invisible grid this replaced
  // gave a flat black rectangle with candles floating in it; at this weight the
  // horizontal and vertical lines read as the square grid you expect, and give
  // the eye something to measure moves against.
  grid: '#2a2e39',
  border: '#363a45',
  up: '#26a69a',            // TradingView teal — the real one, not #089981
  down: '#ef5350',          // TradingView red
  upFill: 'rgba(38,166,154,0.55)',
  downFill: 'rgba(239,83,80,0.55)',
  ma50: '#2962ff',          // TV blue
  ma200: '#ff6d00',         // TV orange
  bb: '#787b86',
  rsi: '#7e57c2',           // TV's default RSI purple
  rsiBand: 'rgba(126,87,194,0.10)',
  crosshair: '#758696',
  target: '#2962ff',
  entry: '#26a69a',
  exit: '#2962ff',
}

const WASH = {
  Bull: 'rgba(38,166,154,0.055)',
  Bear: 'rgba(239,83,80,0.055)',
  Sideways: 'rgba(255,109,0,0.04)',
}

// Pane heights as a share of the chart. Price keeps the bulk; volume gets
// enough room that the bars have shape and you can compare one day to the next,
// and RSI only needs enough to see where it sits between 30 and 70.
const VOL_SHARE = 0.17
const RSI_SHARE = 0.11

const toTime = (d) => d                       // 'YYYY-MM-DD' is a valid BusinessDay string
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

// Price precision that suits the instrument: an index at 5,900 does not want
// four decimals, and a sub-dollar name does not want two.
function precisionFor(history) {
  const last = history?.[history.length - 1]?.close
  if (!isNum(last)) return { precision: 2, minMove: 0.01 }
  const a = Math.abs(last)
  if (a >= 1000) return { precision: 2, minMove: 0.01 }
  if (a >= 1) return { precision: 2, minMove: 0.01 }
  if (a >= 0.01) return { precision: 4, minMove: 0.0001 }
  return { precision: 6, minMove: 0.000001 }
}

export default function TVChart({
  history,
  showBB = false,
  showRegime = true,
  showMA50 = true,
  showMA200 = true,
  showVolume = true,
  showRSI = true,
  viewBars = null,
  priceTargets = null,
  onCandleClick,
  onClearSelection,
  entryIndex = null,
  exitIndex = null,
}) {
  const holder = useRef(null)
  const chartRef = useRef(null)
  const series = useRef({})
  const markersRef = useRef(null)
  const [legend, setLegend] = useState(null)

  // Entry/exit are read through a ref inside the build effect so that clicking a
  // candle does NOT land in that effect's dependency list — rebuilding every
  // series on each click would re-upload thousands of bars just to move a marker.
  const selRef = useRef({ entryIndex, exitIndex })

  // ── frame the requested window ──────────────────────────────
  // Applied as a LOGICAL range (bar indices), not a time range: logical indices
  // ignore weekends and holidays, so "63 sessions" fills the canvas edge to edge
  // instead of leaving the ragged gaps a calendar range would.
  //
  // Kept behind a ref so the function identity is stable. That matters because
  // the series-build effect has to re-apply the framing after it rebuilds — a
  // rebuild resets the time scale, so toggling an indicator would otherwise
  // silently throw away whichever window you were looking at — and depending on
  // a fresh closure there would rebuild every series on every period click.
  const viewRef = useRef({ history, viewBars })
  const applyViewRef = useRef(null)

  // Refs are synced in an effect, never during render: a render can be thrown
  // away under concurrent React, and a discarded render must not have mutated
  // anything. No dependency array, so this commits before every effect below it
  // and those effects always read current values.
  useEffect(() => {
    selRef.current = { entryIndex, exitIndex }
    viewRef.current = { history, viewBars }
    applyViewRef.current = () => {
      const chart = chartRef.current
      const { history: h, viewBars: vb } = viewRef.current
      const n = h?.length
      if (!chart || !n) return
      const ts = chart.timeScale()
      if (!vb || vb >= n) { ts.fitContent(); return }
      // A right margin of ~4% of the window keeps the last candle off the price
      // axis, the way TradingView does, and scales with the zoom level.
      const pad = Math.max(2, Math.round(vb * 0.04))
      ts.setVisibleLogicalRange({ from: n - vb, to: n - 1 + pad })
    }
  })

  // ── create the chart once ──────────────────────────────────
  useEffect(() => {
    if (!holder.current) return
    const chart = createChart(holder.current, {
      layout: {
        background: { color: TV.bg },
        textColor: TV.text,
        fontSize: 11,
        fontFamily: 'IBM Plex Mono, ui-monospace, monospace',
        panes: { separatorColor: TV.border, separatorHoverColor: 'rgba(41,98,255,0.25)', enableResize: true },
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: TV.grid },
        horzLines: { color: TV.grid },
      },
      rightPriceScale: {
        borderColor: TV.border,
        scaleMargins: { top: 0.08, bottom: 0.08 },
        // Room for the price tag + the MA tags without them overlapping.
        minimumWidth: 68,
      },
      timeScale: {
        borderColor: TV.border,
        // No rightOffset here: the visible window is set explicitly below and
        // carries its own right margin, so letting the time scale add another
        // one on top just pushes the last candle away from the price axis.
        rightOffset: 0,
        minBarSpacing: 0.05,     // zoom out far enough to see decades at once
        fixLeftEdge: false,
        fixRightEdge: false,
        lockVisibleTimeRangeOnResize: true,
        timeVisible: false,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: TV.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#363a45' },
        horzLine: { color: TV.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#363a45' },
      },
      // The TradingView interaction set, explicitly:
      //   wheel zooms about the cursor · drag pans · ctrl/cmd+wheel and dragging
      //   the price axis scale price · double-clicking an axis resets it.
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
      },
      kineticScroll: { touch: true, mouse: false },
      autoSize: true,
    })
    chartRef.current = chart

    return () => {
      chart.remove()
      chartRef.current = null
      series.current = {}
      markersRef.current = null
    }
  }, [])

  // ── (re)build series whenever the data or the toggles change ──
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !history?.length) return

    // Tear down previous series so toggles don't leave orphans behind.
    Object.values(series.current).forEach((s) => {
      try { chart.removeSeries(s) } catch { /* already gone */ }
    })
    series.current = {}
    markersRef.current = null

    const fmt = precisionFor(history)

    // ── price pane (pane 0) ──
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: TV.up, downColor: TV.down,
      borderUpColor: TV.up, borderDownColor: TV.down,
      wickUpColor: TV.up, wickDownColor: TV.down,
      priceFormat: { type: 'price', ...fmt },
      // The last-price tag on the right axis — the "current price" readout.
      priceLineVisible: true,
      priceLineWidth: 1,
      priceLineColor: TV.textDim,
      priceLineStyle: LineStyle.Dashed,
      lastValueVisible: true,
    }, 0)
    candles.setData(history.map((d) => ({
      time: toTime(d.date), open: d.open, high: d.high, low: d.low, close: d.close,
    })))
    series.current.candles = candles

    // Bollinger band: two edges plus a shaded middle, drawn under the candles.
    if (showBB) {
      const mk = (key, width) => {
        const s = chart.addSeries(LineSeries, {
          color: TV.bb, lineWidth: width, lineStyle: LineStyle.Dotted,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
          priceFormat: { type: 'price', ...fmt },
        }, 0)
        s.setData(history.filter((d) => isNum(d[key])).map((d) => ({ time: toTime(d.date), value: d[key] })))
        return s
      }
      series.current.bbU = mk('bb_upper', 1)
      series.current.bbL = mk('bb_lower', 1)
    }

    const addMA = (key, color) => {
      const s = chart.addSeries(LineSeries, {
        color, lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,          // MA value on the price axis, TV-style
        crosshairMarkerVisible: false,
        priceFormat: { type: 'price', ...fmt },
      }, 0)
      s.setData(history.filter((d) => isNum(d[key])).map((d) => ({ time: toTime(d.date), value: d[key] })))
      return s
    }
    if (showMA50) series.current.ma50 = addMA('ma50', TV.ma50)
    if (showMA200) series.current.ma200 = addMA('ma200', TV.ma200)

    // Analyst price-target band + mean line, on the price axis.
    if (priceTargets?.mean != null) {
      const flat = (v) => history.map((d) => ({ time: toTime(d.date), value: v }))
      const mean = chart.addSeries(LineSeries, {
        color: TV.target, lineWidth: 1, lineStyle: LineStyle.Dashed,
        priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false,
        priceFormat: { type: 'price', ...fmt }, title: 'tgt',
      }, 0)
      mean.setData(flat(priceTargets.mean))
      series.current.tgt = mean
      if (isNum(priceTargets.low) && isNum(priceTargets.high)) {
        const band = chart.addSeries(AreaSeries, {
          topColor: 'rgba(41,98,255,0.10)', bottomColor: 'rgba(41,98,255,0.02)',
          lineColor: 'rgba(41,98,255,0.28)', lineWidth: 1,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        }, 0)
        band.setData(flat(priceTargets.high))
        series.current.tgtBand = band
      }
    }

    // ── volume pane ──
    let paneIdx = 1
    if (showVolume) {
      const vol = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceLineVisible: false, lastValueVisible: false,
      }, paneIdx)
      vol.setData(history.map((d) => ({
        time: toTime(d.date),
        value: d.volume ?? 0,
        color: d.close >= d.open ? TV.upFill : TV.downFill,
      })))
      vol.priceScale().applyOptions({ scaleMargins: { top: 0.15, bottom: 0 } })
      series.current.vol = vol
      series.current.volPane = paneIdx
      paneIdx += 1
    }

    // ── RSI pane, with the 30/70 lines drawn as real price lines ──
    if (showRSI) {
      const rsi = chart.addSeries(LineSeries, {
        color: TV.rsi, lineWidth: 2,
        priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
        priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true,
        autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
      }, paneIdx)
      rsi.setData(history.filter((d) => isNum(d.rsi)).map((d) => ({ time: toTime(d.date), value: d.rsi })))
      // The 70/30 guides are drawn but NOT labelled on the axis: the scale
      // already auto-ticks near those values, and adding labels put 80/70 and
      // 40/30 on top of each other in a pane only ~140px tall.
      for (const lvl of [70, 30]) {
        rsi.createPriceLine({
          price: lvl, color: 'rgba(126,87,194,0.4)', lineWidth: 1,
          lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '',
        })
      }
      series.current.rsi = rsi
      series.current.rsiPane = paneIdx
    }

    // ── regime shading ──
    // lightweight-charts has no rectangle shape, so the regime wash is a
    // histogram on its own hidden price scale, drawn full-height behind nothing
    // in particular — at 5% alpha it reads as a background tint.
    if (showRegime && history.some((d) => d.regime)) {
      const wash = chart.addSeries(HistogramSeries, {
        priceScaleId: 'regime-wash',
        priceLineVisible: false, lastValueVisible: false, base: 0,
        // Pin the scale to 0..1 so a bar of value 1 always fills the pane,
        // independent of the price series' range.
        autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 1 } }),
      }, 0)
      wash.setData(history.map((d) => ({
        time: toTime(d.date), value: 1, color: WASH[d.regime] || 'rgba(0,0,0,0)',
      })))
      wash.priceScale().applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false })
      series.current.regime = wash
    }

    // ── entry / exit markers ──
    // Created here rather than in their own effect: rebuilding the series
    // replaces the candle series these are attached to, so markers must be
    // re-bound in the same pass or they vanish on the next indicator toggle.
    markersRef.current = createSeriesMarkers(candles, buildMarkers(history, selRef.current))

    // ── pane sizing: price keeps the lion's share ──
    // Applied after every series exists so pane indices are final.
    const sizePanes = () => {
      const panes = chart.panes()
      if (panes.length < 2) return
      const total = holder.current?.clientHeight || 0
      if (!total) return
      const volH = showVolume ? Math.max(38, Math.round(total * VOL_SHARE)) : 0
      const rsiH = showRSI ? Math.max(46, Math.round(total * RSI_SHARE)) : 0
      if (showVolume && panes[series.current.volPane]) panes[series.current.volPane].setHeight(volH)
      if (showRSI && panes[series.current.rsiPane]) panes[series.current.rsiPane].setHeight(rsiH)
    }
    sizePanes()
    const ro = new ResizeObserver(sizePanes)
    if (holder.current) ro.observe(holder.current)

    // Rebuilding the series resets the time scale, so restore the framing.
    applyViewRef.current?.()

    return () => ro.disconnect()
  }, [history, showBB, showRegime, showMA50, showMA200, showVolume, showRSI, priceTargets])

  // Marker-only updates: clicking a candle just moves the arrows, so this must
  // stay off the rebuild path above.
  useEffect(() => {
    if (!markersRef.current || !history?.length) return
    markersRef.current.setMarkers(buildMarkers(history, { entryIndex, exitIndex }))
  }, [history, entryIndex, exitIndex])

  // ── crosshair legend + click handling ──────────────────────
  const clickRef = useRef(onCandleClick)
  useEffect(() => { clickRef.current = onCandleClick }, [onCandleClick])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !history?.length) return
    const byTime = new Map(history.map((d, i) => [d.date, i]))

    const onMove = (param) => {
      if (!param?.time) { setLegend(null); return }
      const i = byTime.get(String(param.time))
      setLegend(i == null ? null : i)
    }
    const onClick = (param) => {
      if (!param?.time || !clickRef.current) return
      const i = byTime.get(String(param.time))
      if (i != null) clickRef.current(i)
    }
    chart.subscribeCrosshairMove(onMove)
    chart.subscribeClick(onClick)
    return () => {
      chart.unsubscribeCrosshairMove(onMove)
      chart.unsubscribeClick(onClick)
    }
  }, [history])

  useEffect(() => { applyViewRef.current?.() }, [history, viewBars])

  // Reset to the full range — TradingView's "fit" gesture.
  const fit = useCallback(() => chartRef.current?.timeScale().fitContent(), [])
  // Snap back to the framed window after wandering off.
  const reset = useCallback(() => applyViewRef.current?.(), [])

  const bar = history?.length ? history[legend ?? history.length - 1] : null
  const prev = history?.length && (legend ?? history.length - 1) > 0
    ? history[(legend ?? history.length - 1) - 1] : null
  const chg = bar && prev && prev.close ? bar.close / prev.close - 1 : null

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}
         onContextMenu={(e) => { e.preventDefault(); onClearSelection?.() }}>
      {bar && <Legend bar={bar} chg={chg} showMA50={showMA50} showMA200={showMA200} showRSI={showRSI} />}

      <div style={{ position: 'absolute', right: 76, top: 8, zIndex: 3, display: 'flex', gap: 4 }}>
        <GhostBtn onClick={reset} title="Back to the selected window">reset</GhostBtn>
        <GhostBtn onClick={fit} title="Zoom out to every bar loaded">fit all</GhostBtn>
      </div>

      <div ref={holder} style={{ width: '100%', height: '100%' }} />
    </div>
  )
}

function buildMarkers(history, { entryIndex, exitIndex }) {
  const marks = []
  if (entryIndex != null && history[entryIndex]) {
    marks.push({
      time: toTime(history[entryIndex].date), position: 'belowBar',
      color: TV.entry, shape: 'arrowUp', text: 'ENTRY',
    })
  }
  if (exitIndex != null && history[exitIndex]) {
    marks.push({
      time: toTime(history[exitIndex].date), position: 'aboveBar',
      color: TV.exit, shape: 'arrowDown', text: 'EXIT',
    })
  }
  return marks
}

function GhostBtn({ children, ...rest }) {
  return (
    <button {...rest} className="num"
      style={{
        padding: '2px 8px', borderRadius: 3, fontSize: 10,
        background: 'rgba(30,34,45,0.85)', color: TV.textDim,
        border: `1px solid ${TV.border}`, lineHeight: 1.5,
      }}>{children}</button>
  )
}

// TradingView's top-left readout: symbol line, then O/H/L/C tinted by the bar's
// direction, then whichever studies are switched on.
function Legend({ bar, chg, showMA50, showMA200, showRSI }) {
  const up = bar.close >= bar.open
  const c = up ? TV.up : TV.down
  const f = (x) => (isNum(x) ? Number(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—')
  return (
    <div style={{
      position: 'absolute', top: 6, left: 10, zIndex: 3, pointerEvents: 'none',
      fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.6,
      display: 'flex', flexDirection: 'column', gap: 1,
    }}>
      <div style={{ display: 'flex', gap: 9, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ color: TV.textDim }}>{bar.date}</span>
        <span style={{ color: TV.textDim }}>O<span style={{ color: c, marginLeft: 3 }}>{f(bar.open)}</span></span>
        <span style={{ color: TV.textDim }}>H<span style={{ color: c, marginLeft: 3 }}>{f(bar.high)}</span></span>
        <span style={{ color: TV.textDim }}>L<span style={{ color: c, marginLeft: 3 }}>{f(bar.low)}</span></span>
        <span style={{ color: TV.textDim }}>C<span style={{ color: c, marginLeft: 3 }}>{f(bar.close)}</span></span>
        {chg != null && (
          <span style={{ color: c }}>{chg >= 0 ? '+' : ''}{(chg * 100).toFixed(2)}%</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {showMA50 && <span style={{ color: TV.ma50 }}>MA50 {f(bar.ma50)}</span>}
        {showMA200 && <span style={{ color: TV.ma200 }}>MA200 {f(bar.ma200)}</span>}
        {showRSI && isNum(bar.rsi) && <span style={{ color: TV.rsi }}>RSI {bar.rsi.toFixed(1)}</span>}
        {isNum(bar.volume) && <span style={{ color: TV.textDim }}>Vol {compact(bar.volume)}</span>}
      </div>
    </div>
  )
}

function compact(n) {
  if (!isNum(n)) return '—'
  const a = Math.abs(n)
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return `${n}`
}
