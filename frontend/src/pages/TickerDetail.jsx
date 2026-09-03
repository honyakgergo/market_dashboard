// ============================================================
// pages/TickerDetail.jsx
// Daily chart (candles + regime/MA/BB overlays, all toggleable) with a
// pinned OHLC legend, an intraday view with resolution + session VWAP, the
// options-as-indicator panel, and a click-to-set ENTRY analyzer:
//   click a candle to mark an entry, click a later candle to mark an exit
//   (or leave open to "now") and see return / days / CAGR / maxDD / max run-up.
// ============================================================

import React, { useEffect, useRef, useCallback } from 'react'
import Plotly from 'plotly.js-dist-min'
import { fetchTicker, fetchIntraday, fetchOptions, fetchAnalysis, fetchFundamentals } from '../api/client'
import { useStore } from '../store/useStore'
import { useFetch, StateView, Panel, Pill, fmtNum, fmtPct, fmtPctU, toneOf } from '../components/ui'
import TVChart from '../components/TVChart'

// The daily chart ALWAYS loads the instrument's entire history, once per
// ticker. The period buttons then only move the visible window — they do not
// refetch.
//
// This is how TradingView behaves and it is the difference between a chart you
// can explore and a chart you can only look at: picking "3M" used to request
// three months of bars, so there was literally nothing behind the left edge to
// scroll back into, and a short series left most of the canvas empty. Now "3M"
// frames the last ~63 sessions across the full width while a decade of bars
// sits off-screen to the left, one drag away.
//
// Value = trading sessions to show. null = the whole history.
const VIEWS = [
  ['1M', 22], ['3M', 63], ['6M', 126], ['1Y', 252],
  ['2Y', 504], ['5Y', 1260], ['10Y', 2520], ['ALL', null],
]
const INTRADAY_RES = ['1m', '5m', '15m', '30m', '60m']
const regimeTone = (r) => (r === 'Bull' ? 'bull' : r === 'Bear' ? 'bear' : 'side')

export default function TickerDetail() {
  const ticker = useStore((s) => s.ticker)
  const back = useStore((s) => s.back)
  const [mode, setMode] = React.useState('daily')

  // How many sessions the chart frames. Not a fetch parameter.
  const [viewBars, setViewBars] = React.useState(252)

  // Regime shading defaults OFF: a plain dark chart with a clean grid is the
  // readable baseline, and the wash competes with the candles. It is one click
  // away when you actually want it.
  const [showRegime, setShowRegime] = React.useState(false)
  const [showMA50, setShowMA50] = React.useState(true)
  const [showMA200, setShowMA200] = React.useState(true)
  const [showBB, setShowBB] = React.useState(false)
  const [showTargets, setShowTargets] = React.useState(false)
  const [showVolume, setShowVolume] = React.useState(true)
  const [showRSI, setShowRSI] = React.useState(true)

  const [res, setRes] = React.useState('5m')

  // entry/exit selection (indices into the daily history)
  const [sel, setSel] = React.useState({ entry: null, exit: null })
  // Reset only when the SERIES changes. Zooming used to clear your markers,
  // because the period was a fetch key; it no longer is.
  useEffect(() => { setSel({ entry: null, exit: null }) }, [ticker])

  const handleCandleClick = useCallback((i) => {
    setSel((s) => {
      if (s.entry == null) return { entry: i, exit: null }
      if (s.exit == null) return i > s.entry ? { entry: s.entry, exit: i } : { entry: i, exit: null }
      return { entry: i, exit: null }
    })
  }, [])

  const clearSel = useCallback(() => setSel({ entry: null, exit: null }), [])

  // One fetch per ticker, for everything the feed has. Cached server-side, so
  // this is a cold-start cost only.
  const daily = useFetch(() => fetchTicker(ticker, 'max'), [ticker])
  const analysis = useFetch(() => fetchAnalysis(ticker), [ticker])
  const priceTargets = analysis.data?.price_target
    ? { low: analysis.data.price_target.low, mean: analysis.data.price_target.mean, high: analysis.data.price_target.high }
    : null
  const data = daily.data
  const hist = data?.history || []
  const last = data?.latest
  const prev = hist.length > 1 ? hist[hist.length - 2] : null
  const chg = last && prev && prev.close ? last.close / prev.close - 1 : null

  const metrics = entryMetrics(hist, sel.entry, sel.exit)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 10 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <button onClick={back} title="Back" className="num"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-muted)', borderRadius: 5, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>‹ back</button>
        <span className="num" style={{ fontSize: 22, fontWeight: 600 }}>{ticker}</span>
        {last && (
          <>
            <span className="num" style={{ fontSize: 20 }}>{fmtNum(last.close)}</span>
            <Pill tone={toneOf(chg)}>{fmtPct(chg)}</Pill>
          </>
        )}
        {data?.regime && <Pill tone={regimeTone(data.regime)}>{data.regime}</Pill>}
        {last?.strategy && <span className="lbl-dim">{last.strategy}</span>}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
          <Toggle value={mode} onChange={setMode} options={[['daily', 'Daily'], ['intraday', 'Intraday'], ['fundamentals', 'Fundamentals']]} />
          {mode === 'daily' ? (
            <>
              <div style={{ display: 'flex', gap: 4 }}>
                <Chip label="Regime" on={showRegime} onClick={() => setShowRegime((v) => !v)} />
                <Chip label="MA50" on={showMA50} onClick={() => setShowMA50((v) => !v)} accent="#2962ff" />
                <Chip label="MA200" on={showMA200} onClick={() => setShowMA200((v) => !v)} accent="#ff6d00" />
                <Chip label="BB" on={showBB} onClick={() => setShowBB((v) => !v)} />
                <Chip label="Vol" on={showVolume} onClick={() => setShowVolume((v) => !v)} accent="#26a69a" />
                <Chip label="RSI" on={showRSI} onClick={() => setShowRSI((v) => !v)} accent="#7e57c2" />
                <Chip label="Tgt" on={showTargets} onClick={() => setShowTargets((v) => !v)} accent="#2962ff" />
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                {VIEWS.map(([label, bars]) => (
                  <button key={label} onClick={() => setViewBars(bars)} className="num"
                    title={`Frame the last ${bars ? `${bars} sessions` : 'entire history'} — the rest stays loaded, scroll left for it`}
                    style={selBtn(bars === viewBars)}>{label}</button>
                ))}
              </div>
            </>
          ) : mode === 'intraday' ? (
            <div style={{ display: 'flex', gap: 4 }}>
              {INTRADAY_RES.map((r) => (
                <button key={r} onClick={() => setRes(r)} className="num" style={selBtn(r === res)}>{r}</button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {/* body */}
      {mode === 'fundamentals' ? (
        <FundamentalsView ticker={ticker} />
      ) : (
      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 260px', gap: 10 }}>
        <Panel
          title={mode === 'daily'
            ? `${ticker} · D${hist.length ? ` · ${hist.length.toLocaleString()} bars loaded · ${hist[0].date} →` : ''}`
            : `Intraday · ${res} · VWAP`}
          right={mode === 'daily'
            ? <span className="lbl-dim" style={{ fontSize: 9.5 }}>
                scroll zoom · drag pan · ctrl+scroll price · click sets entry · right-click clears
              </span>
            : null}
          bodyStyle={{ padding: 0 }}
        >
          {mode === 'daily' ? (
            <StateView loading={daily.loading} error={daily.error} empty={!daily.loading && !daily.error && !hist.length}>
              <div style={{ height: '100%', minHeight: 360 }}>
                <TVChart history={hist} showBB={showBB} showRegime={showRegime}
                  showMA50={showMA50} showMA200={showMA200}
                  showVolume={showVolume} showRSI={showRSI}
                  viewBars={viewBars}
                  onCandleClick={handleCandleClick} onClearSelection={clearSel}
                  entryIndex={sel.entry} exitIndex={sel.exit}
                  priceTargets={showTargets ? priceTargets : null} />
              </div>
            </StateView>
          ) : (
            <IntradayPane ticker={ticker} interval={res} />
          )}
        </Panel>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflowY: 'auto' }}>
          {mode === 'daily' && (
            <EntryPanel metrics={metrics} onClear={clearSel} />
          )}

          <AnalystPanel data={analysis.data} />

          <Panel title="Indicators">
            {last ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Stat label="RSI (14)" value={fmtNum(last.rsi, 1)} tone={last.rsi > 70 ? 'bear' : last.rsi < 30 ? 'bull' : 'flat'} />
                <Stat label="Z-Score (20)" value={fmtNum(last.zscore, 2)} />
                <Stat label="ATR (14)" value={fmtNum(last.atr)} />
                <Stat label="MA50" value={fmtNum(last.ma50)} />
                <Stat label="MA200" value={fmtNum(last.ma200)} />
                <Stat label="Autocorr" value={fmtNum(last.autocorr, 2)} />
              </div>
            ) : <span className="lbl-dim">—</span>}
          </Panel>

          <OptionsPanel ticker={ticker} />
        </div>
      </div>
      )}
    </div>
  )
}

// ── entry analyzer ───────────────────────────────────────────
function daysBetween(a, b) {
  const ms = new Date(b) - new Date(a)
  return Math.max(0, Math.round(ms / 86400000))
}

function entryMetrics(hist, entry, exit) {
  if (entry == null || !hist?.length) return null
  const end = exit != null ? exit : hist.length - 1
  if (end <= entry) return null
  const e = hist[entry], xr = hist[end]
  const ret = xr.close / e.close - 1
  const days = daysBetween(e.date, xr.date)
  const years = days / 365.25
  const cagr = years > 0 ? Math.pow(1 + ret, 1 / years) - 1 : null
  let peak = e.close, trough = e.close, maxDD = 0, maxRun = 0
  for (let i = entry; i <= end; i++) {
    const c = hist[i].close
    if (c > peak) peak = c
    if (c < trough) trough = c
    maxDD = Math.min(maxDD, c / peak - 1)
    maxRun = Math.max(maxRun, c / trough - 1)
  }
  return { entryDate: e.date, entryPx: e.close, exitDate: xr.date, exitPx: xr.close, ret, days, cagr, maxDD, maxRun, open: exit == null }
}

function EntryPanel({ metrics, onClear }) {
  // No empty-state prompt — the chart panel's own title already says
  // "click to set entry · right-click to clear". The panel only appears once a
  // real entry→exit (or entry→latest) window exists.
  if (!metrics) return null
  return (
    <Panel
      title="Entry analysis"
      right={<button onClick={onClear} className="num" style={{ ...selBtn(false), padding: '2px 8px', fontSize: 10.5 }}>clear</button>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span className="lbl" style={{ color: 'var(--bull)' }}>Entry</span>
          <span className="num" style={{ fontSize: 12 }}>{metrics.entryDate} · {fmtNum(metrics.entryPx)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span className="lbl" style={{ color: metrics.open ? 'var(--text-muted)' : 'var(--accent)' }}>{metrics.open ? 'Latest' : 'Exit'}</span>
          <span className="num" style={{ fontSize: 12 }}>{metrics.exitDate} · {fmtNum(metrics.exitPx)}</span>
        </div>
        <div style={{ height: 1, background: 'var(--hairline)', margin: '2px 0' }} />
        <BigStat label="Return" value={fmtPct(metrics.ret)} tone={toneOf(metrics.ret)} />
        <Stat label="Days held" value={`${metrics.days}`} />
        <Stat label="Annualized" value={metrics.cagr != null ? fmtPct(metrics.cagr) : '—'} tone={toneOf(metrics.cagr)} />
        <Stat label="Max drawdown" value={fmtPct(metrics.maxDD)} tone="bear" />
        <Stat label="Max run-up" value={fmtPct(metrics.maxRun)} tone="bull" />
        {metrics.open && <div className="lbl-dim" style={{ marginTop: 2 }}>open position · marked to latest close</div>}
      </div>
    </Panel>
  )
}

function BigStat({ label, value, tone = 'flat' }) {
  const color = tone === 'bull' ? 'var(--bull)' : tone === 'bear' ? 'var(--bear)' : 'var(--text)'
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span className="lbl">{label}</span>
      <span className="num" style={{ color, fontSize: 18, fontWeight: 600 }}>{value}</span>
    </div>
  )
}

const selBtn = (active) => ({
  padding: '4px 10px', borderRadius: 4, fontSize: 11.5,
  background: active ? 'var(--elevated)' : 'transparent',
  color: active ? 'var(--text)' : 'var(--text-muted)',
  border: `1px solid ${active ? 'var(--border-strong)' : 'transparent'}`,
})

function Chip({ label, on, onClick, accent }) {
  return (
    <button onClick={onClick} className="num" title={`Toggle ${label}`}
      style={{
        padding: '4px 9px', borderRadius: 4, fontSize: 11.5,
        background: on ? 'var(--elevated)' : 'transparent',
        color: on ? (accent || 'var(--accent)') : 'var(--text-dim)',
        border: `1px solid ${on ? 'var(--border-strong)' : 'var(--border)'}`,
      }}>{label}</button>
  )
}

function Toggle({ value, onChange, options }) {
  return (
    <div style={{ display: 'flex', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: 2 }}>
      {options.map(([k, l]) => (
        <button key={k} onClick={() => onChange(k)} className="num"
          style={{
            padding: '3px 10px', borderRadius: 3, fontSize: 11.5,
            background: value === k ? 'var(--elevated)' : 'transparent',
            color: value === k ? 'var(--text)' : 'var(--text-muted)',
          }}>{l}</button>
      ))}
    </div>
  )
}

function Stat({ label, value, tone = 'flat' }) {
  const color = tone === 'bull' ? 'var(--bull)' : tone === 'bear' ? 'var(--bear)' : 'var(--text)'
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span className="lbl">{label}</span>
      <span className="num" style={{ color, fontSize: 13 }}>{value}</span>
    </div>
  )
}

// ── intraday candles + VWAP ──────────────────────────────────
function intradayMetrics(bars, entry, exit) {
  if (entry == null || !bars?.length) return null
  const end = exit != null ? exit : bars.length - 1
  if (end <= entry) return null
  const e = bars[entry], xr = bars[end]
  const ret = xr.close / e.close - 1
  let peak = e.close, trough = e.close, maxDD = 0, maxRun = 0
  for (let i = entry; i <= end; i++) {
    const c = bars[i].close
    if (c > peak) peak = c
    if (c < trough) trough = c
    maxDD = Math.min(maxDD, c / peak - 1)
    maxRun = Math.max(maxRun, c / trough - 1)
  }
  const mins = Math.max(0, Math.round((new Date(xr.ts) - new Date(e.ts)) / 60000))
  return { entryTs: e.ts, entryPx: e.close, exitTs: xr.ts, exitPx: xr.close, ret, maxDD, maxRun, open: exit == null, mins }
}

function fmtClock(ts) {
  try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch { return `${ts}` }
}

function OHLC({ label, v, tone }) {
  const c = tone === 'bull' ? 'var(--bull)' : tone === 'bear' ? 'var(--bear)' : 'var(--text)'
  return (
    <span className="num" style={{ fontSize: 11 }}>
      <span className="lbl-dim" style={{ fontSize: 9 }}>{label} </span>
      <span style={{ color: c }}>{fmtNum(v)}</span>
    </span>
  )
}

function IntradayPane({ ticker, interval }) {
  const { data, loading, error } = useFetch(() => fetchIntraday(ticker, interval, 1), [ticker, interval])
  const ref = useRef(null)
  const bars = data?.bars || []
  const [sel, setSel] = React.useState({ entry: null, exit: null })
  const [hover, setHover] = React.useState(null)
  useEffect(() => { setSel({ entry: null, exit: null }); setHover(null) }, [ticker, interval])
  const clearSel = useCallback(() => setSel({ entry: null, exit: null }), [])

  useEffect(() => {
    if (!ref.current || !bars.length) return
    const x = bars.map((b) => b.ts)
    const candle = {
      type: 'candlestick', x,
      open: bars.map((b) => b.open), high: bars.map((b) => b.high),
      low: bars.map((b) => b.low), close: bars.map((b) => b.close),
      increasing: { line: { color: '#089981' }, fillcolor: '#089981' },
      decreasing: { line: { color: '#f23645' }, fillcolor: '#f23645' },
      name: 'price', showlegend: false, hoverinfo: 'x',
    }
    const vwap = {
      type: 'scatter', mode: 'lines', x, y: bars.map((b) => b.vwap),
      line: { color: '#e0a23a', width: 1.3, dash: 'dot' }, name: 'VWAP', hoverinfo: 'skip', showlegend: false,
    }
    const shapes = []
    if (sel.entry != null) {
      const end = sel.exit != null ? sel.exit : bars.length - 1
      const x0 = bars[sel.entry].ts, x1 = bars[Math.max(end, sel.entry)].ts
      shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0, x1, y0: 0, y1: 1, fillcolor: 'rgba(41,98,255,0.07)', line: { width: 0 }, layer: 'below' })
      shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0, x1: x0, y0: 0, y1: 1, line: { color: '#089981', width: 1, dash: 'dot' } })
      if (sel.exit != null) shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0: x1, x1, y0: 0, y1: 1, line: { color: '#2962ff', width: 1, dash: 'dot' } })
    }
    const layout = {
      margin: { l: 8, r: 58, t: 8, b: 24 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 10, color: '#787b86' }, showlegend: false,
      dragmode: 'pan', hovermode: 'x', shapes,
      xaxis: {
        gridcolor: '#2a2e39', rangeslider: { visible: false }, side: 'right',
        showspikes: true, spikecolor: '#4a4f5c', spikethickness: 1, spikedash: 'solid', spikemode: 'across', spikesnap: 'cursor',
      },
      yaxis: {
        gridcolor: '#2a2e39', side: 'right', tickformat: '.2f',
        showspikes: true, spikecolor: '#4a4f5c', spikethickness: 1, spikedash: 'solid', spikemode: 'across', spikesnap: 'cursor',
      },
    }
    const el = ref.current
    Plotly.react(el, [vwap, candle], layout, { responsive: true, displayModeBar: false, scrollZoom: true })
    el.removeAllListeners?.('plotly_hover')
    el.removeAllListeners?.('plotly_click')
    el.on('plotly_hover', (ev) => {
      const pn = ev.points?.[0]?.pointNumber
      if (pn != null) setHover(bars[pn] || null)
    })
    el.on('plotly_click', (ev) => {
      const pn = ev.points?.[0]?.pointNumber
      if (pn == null) return
      setSel((s) => {
        if (s.entry == null) return { entry: pn, exit: null }
        if (s.exit == null) return pn > s.entry ? { entry: s.entry, exit: pn } : { entry: pn, exit: null }
        return { entry: pn, exit: null }
      })
    })
  }, [bars, sel])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])

  const lastVwap = bars.length ? bars[bars.length - 1].vwap : null
  const shownBar = hover || (bars.length ? bars[bars.length - 1] : null)
  const m = intradayMetrics(bars, sel.entry, sel.exit)

  return (
    <StateView loading={loading} error={error} empty={!loading && !error && !bars.length} emptyHint="No intraday bars (market may be closed)">
      <div style={{ height: '100%', minHeight: 360, display: 'flex', flexDirection: 'column' }}>
        {data && (
          <div style={{ padding: '8px 12px 6px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {shownBar && (
              <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span className="num lbl-dim" style={{ fontSize: 10 }}>{fmtClock(shownBar.ts)}</span>
                <OHLC label="O" v={shownBar.open} />
                <OHLC label="H" v={shownBar.high} />
                <OHLC label="L" v={shownBar.low} />
                <OHLC label="C" v={shownBar.close} tone={shownBar.close >= shownBar.open ? 'bull' : 'bear'} />
                {lastVwap != null && <span className="num" style={{ color: '#e0a23a', fontSize: 11 }}>VWAP {fmtNum(lastVwap)}</span>}
                <span className="num" style={{ fontSize: 12, marginLeft: 6 }}>{fmtNum(data.last)}</span>
                <Pill tone={toneOf(data.change)}>{fmtPct(data.change)}</Pill>
              </div>
            )}
            {m ? (
              <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap', borderTop: '1px solid var(--hairline)', paddingTop: 5 }}>
                <span className="lbl" style={{ color: 'var(--bull)' }}>Entry {fmtClock(m.entryTs)} · {fmtNum(m.entryPx)}</span>
                <span className="lbl" style={{ color: m.open ? 'var(--text-muted)' : 'var(--accent)' }}>{m.open ? 'Now' : 'Exit'} {fmtClock(m.exitTs)} · {fmtNum(m.exitPx)}</span>
                <span className="num" style={{ fontSize: 14, fontWeight: 600, color: m.ret >= 0 ? 'var(--bull)' : 'var(--bear)' }}>{fmtPct(m.ret)}</span>
                <span className="num lbl-dim">{m.mins}m</span>
                <span className="num lbl-dim">DD {fmtPct(m.maxDD)}</span>
                <span className="num lbl-dim">run {fmtPct(m.maxRun)}</span>
                <button onClick={clearSel} className="num" style={{ ...selBtn(false), padding: '1px 8px', fontSize: 10 }}>clear</button>
              </div>
            ) : (
              <span className="lbl-dim" style={{ fontSize: 10 }}>click a candle to mark an entry · click a later one for exit · right-click to clear</span>
            )}
          </div>
        )}
        <div ref={ref} onContextMenu={(e) => { e.preventDefault(); clearSel() }} style={{ flex: 1 }} />
      </div>
    </StateView>
  )
}

// ── options-as-indicator panel ───────────────────────────────
function OptionsPanel({ ticker }) {
  const { data, loading, error } = useFetch(() => fetchOptions(ticker), [ticker])
  return (
    <Panel title="Options signals">
      <StateView loading={loading} error={error}>
        {data && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Stat label="ATM IV" value={data.atm_iv != null ? fmtPctU(data.atm_iv, 1) : '—'} />
            <Stat label="IV rank" value={data.iv_rank != null ? fmtPctU(data.iv_rank, 0) : `building (${data.iv_history_days}d)`} />
            <Stat label="IV percentile" value={data.iv_percentile != null ? fmtPctU(data.iv_percentile, 0) : '—'} />
            <Stat label="P/C volume" value={fmtNum(data.put_call_volume)} tone={data.put_call_volume > 1 ? 'bear' : 'bull'} />
            <Stat label="P/C OI" value={fmtNum(data.put_call_oi)} />
            <Stat label="25Δ skew" value={data.skew_25d != null ? fmtPct(data.skew_25d, 1) : '—'} />
            <Stat label="25Δ risk rev." value={data.risk_reversal_25d != null ? fmtPct(data.risk_reversal_25d, 1) : '—'} />
            <Stat label="GEX (approx)" value={data.gex_notional != null ? `${(data.gex_notional / 1e9).toFixed(2)}B` : '—'} tone={data.gex_notional >= 0 ? 'bull' : 'bear'} />
            <div className="lbl-dim" style={{ marginTop: 4, lineHeight: 1.4 }}>
              {data.front_expiry} · {data.dte}d · spot {fmtNum(data.spot)}
            </div>
          </div>
        )}
      </StateView>
    </Panel>
  )
}

// ── analyst & fundamentals panel ─────────────────────────────
// Renders nothing unless Yahoo has coverage (single US equities); each
// sub-block appears only if its data is present.
const REC_SEGS = [
  ['strongBuy', 'Strong Buy', '#4cc38a'],
  ['buy', 'Buy', '#12a45f'],
  ['hold', 'Hold', '#7a8699'],
  ['sell', 'Sell', '#d97b6c'],
  ['strongSell', 'Strong Sell', '#f23645'],
]

const fmtCap = (n) => {
  if (n == null) return ''
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`
  return `${n}`
}

function consensusColor(label) {
  if (!label) return 'var(--text)'
  if (label.includes('Buy')) return 'var(--bull)'
  if (label.includes('Sell')) return 'var(--bear)'
  return 'var(--side)'
}

function AnalystPanel({ data }) {
  if (!data) return null
  const { recommendations: rec, price_target: pt, earnings: er, short: sh, profile: pf } = data
  // Only worth a panel if there's real analyst/positioning content. A bare
  // company name (which even ETFs like SPY have) is not enough — otherwise the
  // header renders over an empty body.
  if (!(rec || pt || er || sh)) return null
  const blocks = []
  if (rec) blocks.push(<ConsensusBlock rec={rec} />)
  if (pt) blocks.push(<TargetBlock pt={pt} />)
  if (er) blocks.push(<EarningsBlock er={er} />)
  if (sh) blocks.push(<ShortBlock sh={sh} />)
  return (
    <Panel title="Analyst & fundamentals">
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {blocks.map((b, i) => (
          <div key={i} style={i ? { borderTop: '1px solid var(--hairline)', paddingTop: 11, marginTop: 11 } : undefined}>
            {b}
          </div>
        ))}
        {pf && (pf.sector || pf.industry || pf.market_cap) && (
          <div style={{ borderTop: '1px solid var(--hairline)', paddingTop: 10, marginTop: 11,
                        fontSize: 10.5, lineHeight: 1.45, color: 'var(--text-dim)', textTransform: 'none', letterSpacing: 0 }}>
            {[pf.sector, pf.industry].filter(Boolean).join(' · ')}
            {pf.market_cap ? `${pf.sector || pf.industry ? ' · ' : ''}${fmtCap(pf.market_cap)} mkt cap` : ''}
          </div>
        )}
      </div>
    </Panel>
  )
}

function ConsensusBlock({ rec }) {
  const total = rec.total || 1
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="lbl">Consensus</span>
        <span className="lbl-dim">{rec.total} analysts</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 3 }}>
        <span className="num" style={{ fontSize: 17, fontWeight: 600, color: consensusColor(rec.consensus) }}>
          {(rec.consensus || '').toUpperCase()}
        </span>
        {rec.trend != null && rec.trend !== 0 && (
          <span className="num" title="consensus mean vs last month"
            style={{ fontSize: 10.5, color: rec.trend > 0 ? 'var(--bull)' : 'var(--bear)' }}>
            {rec.trend > 0 ? '▲ improving' : '▼ softening'}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', height: 18, borderRadius: 3, overflow: 'hidden', marginTop: 6, gap: 1 }}>
        {REC_SEGS.map(([k, lbl, c]) => {
          const v = rec.distribution?.[k] || 0
          if (!v) return null
          const w = (v / total) * 100
          return (
            <div key={k} title={`${lbl}: ${v}`}
              style={{ width: `${w}%`, background: c, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {w > 9 && <span className="num" style={{ fontSize: 10, color: '#0b0e14', fontWeight: 700 }}>{v}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TargetBlock({ pt }) {
  const { low, mean, high, current, upside: up } = pt
  const span = (low != null && high != null && high > low) ? high - low : null
  const pos = (v) => (span == null || v == null) ? null : Math.max(2, Math.min(98, ((v - low) / span) * 100))
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="lbl">Price target</span>
        {up != null && (
          <span className="num" style={{ fontSize: 11.5, color: up >= 0 ? 'var(--bull)' : 'var(--bear)' }}>
            {fmtPct(up)} to mean
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 5 }}>
        <span className="num" style={{ fontSize: 16, fontWeight: 600, color: 'var(--accent)' }}>{fmtNum(mean)}</span>
        <span className="lbl-dim" style={{ fontSize: 10 }}>mean{pt.n_analysts ? ` · ${pt.n_analysts} analysts` : ''}</span>
      </div>
      {span != null ? (
        <>
          <div style={{ position: 'relative', height: 4, borderRadius: 2, background: 'var(--elevated)', marginTop: 10 }}>
            {current != null && pos(current) != null && (
              <div title={`current ${fmtNum(current)}`}
                style={{ position: 'absolute', left: `${pos(current)}%`, top: -4, transform: 'translateX(-50%)',
                         width: 2, height: 12, background: 'var(--text-muted)' }} />
            )}
            {pos(mean) != null && (
              <div title={`mean ${fmtNum(mean)}`}
                style={{ position: 'absolute', left: `${pos(mean)}%`, top: -4, transform: 'translateX(-50%)',
                         width: 2, height: 12, background: 'var(--accent)' }} />
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5 }}>
            <span className="num lbl-dim" style={{ fontSize: 10 }}>{fmtNum(low)}</span>
            <span className="num lbl-dim" style={{ fontSize: 10 }}>{fmtNum(high)}</span>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5 }}>
          <span className="num lbl-dim">low {fmtNum(low)}</span>
          <span className="num lbl-dim">high {fmtNum(high)}</span>
        </div>
      )}
    </div>
  )
}

function EarningsBlock({ er }) {
  const sp = er.last?.surprise_pct
  return (
    <div>
      <span className="lbl">Earnings</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
        {er.next_date && <Stat label="Next report" value={er.next_date} />}
        {er.last?.date && <Stat label="Last report" value={er.last.date} />}
        {sp != null && <Stat label="EPS surprise" value={`${sp >= 0 ? '+' : ''}${sp}%`} tone={sp >= 0 ? 'bull' : 'bear'} />}
      </div>
    </div>
  )
}

function ShortBlock({ sh }) {
  return (
    <div>
      <span className="lbl">Short interest</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
        {sh.pct_float != null && <Stat label="% of float" value={fmtPctU(sh.pct_float, 1)} tone={sh.pct_float > 0.1 ? 'bear' : 'flat'} />}
        {sh.days_to_cover != null && <Stat label="Days to cover" value={fmtNum(sh.days_to_cover, 1)} />}
        {sh.chg_pct != null && <Stat label="MoM change" value={fmtPct(sh.chg_pct)} tone={sh.chg_pct > 0 ? 'bear' : 'bull'} />}
      </div>
    </div>
  )
}

// ── fundamentals view (mode = 'fundamentals') ─────────────────────
// Revenue/net-income bars (annual↔quarterly) with the price line overlaid, a
// lean valuation panel (core multiples + percentile vs own 5y range), and a
// trailing-P/E band. Renders an empty note for names Yahoo doesn't cover.
function FundamentalsView({ ticker }) {
  const [freq, setFreq] = React.useState('annual')
  const fun = useFetch(() => fetchFundamentals(ticker), [ticker])
  const pricePeriod = freq === 'annual' ? '10y' : '5y'
  const price = useFetch(() => fetchTicker(ticker, pricePeriod), [ticker, pricePeriod])
  const d = fun.data
  const all = freq === 'annual' ? d?.income?.annual : d?.income?.quarterly
  const rows = (all || []).filter((r) => r.revenue != null).slice(freq === 'annual' ? -8 : -20)

  return (
    <div style={{ flex: 1, minHeight: 0, height: '100%', overflowY: 'auto' }}>
      <StateView loading={fun.loading} error={fun.error}
        empty={!fun.loading && !fun.error && d && !d.available}
        emptyHint="No fundamentals for this symbol — Yahoo/SEC only cover single US-listed companies (not ETFs, indices, futures, or most non-US listings).">
        {d && d.available && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Panel title="Revenue · with stock-price overlay"
              right={<FreqToggle freq={freq} setFreq={setFreq} />}
              bodyStyle={{ padding: '10px 12px 6px' }}>
              <RevStats rows={rows} />
              <FundOverlayChart rows={rows} priceHist={price.data?.history} freq={freq} />
            </Panel>
            <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 10 }}>
              <Panel title="Valuation"><ValuationList items={d.valuation?.items} /></Panel>
              <Panel title="P/E vs its own history" bodyStyle={{ padding: 6 }}>
                <PeBandChart band={d.pe_band} />
              </Panel>
            </div>
          </div>
        )}
      </StateView>
    </div>
  )
}

const capB = (n) => {
  if (n == null) return '—'
  const a = Math.abs(n)
  if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `$${(n / 1e6).toFixed(0)}M`
  return `$${n}`
}

function RevStats({ rows }) {
  if (!rows?.length) return null
  const revs = rows.map((r) => r.revenue).filter((v) => v != null)
  if (!revs.length) return null
  const first = revs[0], last = revs[revs.length - 1]
  const min = Math.min(...revs), max = Math.max(...revs)
  const total = first ? last / first - 1 : null
  const yrs = Math.max(0.5, (new Date(rows[rows.length - 1].date) - new Date(rows[0].date)) / (365.25 * 864e5))
  const cagr = (first > 0 && last > 0) ? Math.pow(last / first, 1 / yrs) - 1 : null
  const Item = ({ label, value, color }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span className="lbl" style={{ fontSize: 9 }}>{label}</span>
      <span className="num" style={{ fontSize: 12.5, color: color || 'var(--text)' }}>{value}</span>
    </div>
  )
  return (
    <div style={{ display: 'flex', gap: 22, alignItems: 'baseline', marginBottom: 6, flexWrap: 'wrap' }}>
      <span className="lbl" style={{ color: 'var(--bull)', letterSpacing: '0.04em' }}>Revenue</span>
      <Item label="Latest" value={capB(last)} />
      <Item label="Min" value={capB(min)} />
      <Item label="Max" value={capB(max)} />
      {cagr != null && <Item label="CAGR" value={fmtPct(cagr)} color={cagr >= 0 ? 'var(--bull)' : 'var(--bear)'} />}
      {total != null && <Item label="Total chg" value={fmtPct(total)} color={total >= 0 ? 'var(--bull)' : 'var(--bear)'} />}
    </div>
  )
}

function FreqToggle({ freq, setFreq }) {
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {[['annual', 'Annual'], ['quarterly', 'Quarterly']].map(([k, l]) => (
        <button key={k} onClick={() => setFreq(k)} className="num"
          style={{
            padding: '2px 8px', borderRadius: 3, fontSize: 10.5,
            background: freq === k ? 'var(--elevated)' : 'transparent',
            color: freq === k ? 'var(--text)' : 'var(--text-muted)',
            border: `1px solid ${freq === k ? 'var(--border-strong)' : 'transparent'}`,
          }}>{l}</button>
      ))}
    </div>
  )
}

function FundOverlayChart({ rows, priceHist, freq }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current) return
    const bars = rows || []
    const bx = bars.map((r) => r.date)
    const px = priceHist || []
    const widthDays = freq === 'annual' ? 200 : 55
    const widthMs = widthDays * 864e5

    // clip the x-axis so bars and the (possibly longer) price series line up:
    // start where the bars start (bounded by where price data begins).
    let xrange
    if (bars.length) {
      let startMs = new Date(bars[0].date).getTime() - widthMs
      if (px.length) startMs = Math.max(startMs, new Date(px[0].date).getTime())
      const endCandidates = [new Date(bars[bars.length - 1].date).getTime() + widthMs]
      if (px.length) endCandidates.push(new Date(px[px.length - 1].date).getTime())
      const iso = (ms) => new Date(ms).toISOString().slice(0, 10)
      xrange = [iso(startMs), iso(Math.max(...endCandidates))]
    }

    // quarterly: tick each bar as Q1..Q4 (calendar quarter from its end month),
    // with the year shown under Q1. Annual keeps plain year ticks.
    const xaxis = { gridcolor: '#22262f', type: 'date', range: xrange }
    if (freq === 'quarterly' && bars.length) {
      xaxis.tickmode = 'array'
      xaxis.tickvals = bx
      xaxis.ticktext = bars.map((r) => {
        const d = new Date(r.date)
        const q = Math.floor(d.getMonth() / 3) + 1
        return q === 1 ? `Q1<br>'${String(d.getFullYear()).slice(2)}` : `Q${q}`
      })
      xaxis.tickfont = { size: 8.5 }
    } else {
      xaxis.nticks = 8
    }

    const traces = [
      { type: 'bar', name: 'Revenue', x: bx, y: bars.map((r) => r.revenue / 1e9), yaxis: 'y', width: widthMs,
        marker: { color: 'rgba(38,139,110,0.82)' }, hovertemplate: 'Rev $%{y:.2f}B<extra></extra>' },
      { type: 'scatter', mode: 'lines', name: 'Stock price', x: px.map((p) => p.date), y: px.map((p) => p.close), yaxis: 'y2',
        line: { color: '#e0a23a', width: 1.8 }, hovertemplate: 'Px $%{y:.2f}<extra></extra>' },
    ]
    const layout = {
      margin: { l: 52, r: 54, t: 6, b: 22 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 9, color: '#787b86' },
      showlegend: true, legend: { orientation: 'h', y: -0.18, x: 0.5, xanchor: 'center', font: { size: 9 } },
      hovermode: 'closest',
      hoverlabel: { bgcolor: '#1e222d', bordercolor: '#363b48', font: { family: 'IBM Plex Mono, monospace', size: 10, color: '#d1d4dc' } },
      xaxis,
      yaxis: { gridcolor: '#2a2e39', side: 'left', tickprefix: '$', ticksuffix: 'B', rangemode: 'tozero' },
      yaxis2: { overlaying: 'y', side: 'right', tickprefix: '$', gridcolor: 'transparent' },
    }
    Plotly.react(ref.current, traces, layout, { responsive: true, displayModeBar: false })
  }, [rows, priceHist, freq])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])
  if (!rows?.length) return <div className="lbl-dim" style={{ padding: 12 }}>no statement data</div>
  return <div ref={ref} style={{ width: '100%', height: 340 }} />
}

function ValuationList({ items }) {
  if (!items?.length) return <span className="lbl-dim">—</span>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {items.map((it) => <ValRow key={it.key} it={it} />)}
    </div>
  )
}

function ValRow({ it }) {
  const val = it.is_pct ? fmtPctU(it.value, 2) : (it.value != null ? it.value.toFixed(2) : '—')
  const p = it.pctile   // 0..1, low = historically cheap
  const tag = p == null ? null : p <= 0.33 ? 'cheap' : p >= 0.66 ? 'rich' : 'mid'
  const tagCol = tag === 'cheap' ? 'var(--bull)' : tag === 'rich' ? 'var(--bear)' : 'var(--text-muted)'
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="lbl">{it.label}</span>
        <span className="num" style={{ fontSize: 13 }}>{val}</span>
      </div>
      {p != null && (
        <div style={{ marginTop: 5 }}>
          <div style={{ position: 'relative', height: 4, borderRadius: 2, background: 'var(--elevated)' }}>
            <div style={{ position: 'absolute', left: `${Math.max(2, Math.min(98, p * 100))}%`, top: -3, transform: 'translateX(-50%)', width: 2, height: 10, background: tagCol }} />
          </div>
          <div className="lbl-dim" style={{ marginTop: 3, fontSize: 9.5, textTransform: 'none', letterSpacing: 0 }}>
            {Math.round(p * 100)}th pctile of 5y · <span style={{ color: tagCol }}>{tag}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function PeBandChart({ band }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current || !band?.dates?.length) return
    const { dates, pe, mean, sd } = band
    const flat = (val) => dates.map(() => val)
    const traces = [
      { type: 'scatter', mode: 'lines', x: dates, y: flat(mean + sd), line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
      { type: 'scatter', mode: 'lines', x: dates, y: flat(mean - sd), line: { width: 0 }, fill: 'tonexty', fillcolor: 'rgba(120,123,134,0.10)', hoverinfo: 'skip', showlegend: false },
      { type: 'scatter', mode: 'lines', x: dates, y: flat(mean), line: { color: '#787b86', width: 1, dash: 'dash' }, hovertemplate: `mean ${mean}<extra></extra>`, showlegend: false },
      { type: 'scatter', mode: 'lines', x: dates, y: pe, line: { color: '#2962ff', width: 1.8 }, hovertemplate: 'P/E %{y:.1f}<extra></extra>', showlegend: false },
    ]
    const layout = {
      margin: { l: 38, r: 12, t: 8, b: 22 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 9, color: '#787b86' }, showlegend: false,
      hovermode: 'closest',
      hoverlabel: { bgcolor: '#1e222d', bordercolor: '#363b48', font: { family: 'IBM Plex Mono, monospace', size: 10, color: '#d1d4dc' } },
      xaxis: { gridcolor: '#22262f', nticks: 6 },
      yaxis: { gridcolor: '#2a2e39', side: 'right', showspikes: true, spikecolor: '#4a4f5c', spikethickness: 1, spikedash: 'solid', spikemode: 'across', spikesnap: 'cursor' },
    }
    Plotly.react(ref.current, traces, layout, { responsive: true, displayModeBar: false })
  }, [band])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])
  if (!band?.dates?.length) return <div className="lbl-dim" style={{ padding: 12 }}>P/E history unavailable for this name</div>
  return <div ref={ref} style={{ width: '100%', height: 232 }} />
}
