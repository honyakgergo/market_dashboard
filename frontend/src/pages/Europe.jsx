// ============================================================
// pages/Europe.jsx
// Europe cockpit — live from the 09:00 CET open:
//   - EU index board with intraday % lines
//   - who's leading today (normalized intraday overlay)
//   - EU sector ETFs (iShares STOXX 600 sectors): rebased curves + ranking
//   - EU realized-vol gauge + EUR crosses + European commodities
//   - overlap panel (15:30–17:30 CET): how the US open lands on Europe
// ============================================================

import React, { useEffect, useRef } from 'react'
import Plotly from 'plotly.js-dist-min'
import { fetchEurope } from '../api/client'
import { useFetch, StateView, Panel, Pill, fmtNum, fmtPct, useSession, useAutoRefresh, SessionBanner } from '../components/ui'

const LINE_COLORS = ['#2962ff', '#089981', '#e0a23a', '#9a8aaa', '#5b9cf3', '#f23645']
const SECTOR_COLORS = ['#5b9cf3', '#089981', '#e0a23a', '#9a8aaa', '#57b39a', '#c98a6b',
  '#7e6bd8', '#bf6b6b', '#6fa8dc', '#d4af37', '#8a6d3b', '#b87333', '#3f9d6e', '#c46b9a', '#8aa0b5', '#d18a5b', '#6bbf9a']
// Stable per-sector colour keyed by SYMBOL (not by rank), so a sector keeps its
// colour across timeframes instead of swapping when the ranking reorders.
const SECTOR_ORDER = ['EXV1.DE', 'EXV2.DE', 'EXV3.DE', 'EXV4.DE', 'EXV5.DE', 'EXV6.DE', 'EXV7.DE',
  'EXH1.DE', 'EXH2.DE', 'EXH3.DE', 'EXH4.DE', 'EXH5.DE', 'EXH6.DE', 'EXH7.DE', 'EXH8.DE', 'EXH9.DE']
const sectorColor = (sym) => { const i = SECTOR_ORDER.indexOf(sym); return SECTOR_COLORS[(i < 0 ? 0 : i) % SECTOR_COLORS.length] }
const lvl = (x) => fmtNum(x, Math.abs(x) < 10 ? 4 : 2)

// period tabs for the sector chart + ranking. Lookback in *trading* days.
const SEC_PERIODS = ['1d', '1w', '1m', '3m', '6m', '1y']
const SEC_LOOKBACK = { '1d': 2, '1w': 6, '1m': 22, '3m': 66, '6m': 132, '1y': 252 }

// Rebase each sector's full series to the start of the selected window (=0%),
// compute the window return, and sort best-to-worst.
function sliceSectors(sectors, period) {
  const k = SEC_LOOKBACK[period] || 132
  return (sectors || []).map((s) => {
    const closes = s.closes || []
    const dates = s.dates || []
    const n = Math.min(k, closes.length)
    if (n < 2) return { ...s, dates: [], perf: [], ret_window: null }
    const cl = closes.slice(-n)
    const dt = dates.slice(-n)
    const base = cl[0]
    const perf = base ? cl.map((v) => +(v / base * 100 - 100).toFixed(2)) : cl.map(() => 0)
    const ret_window = base ? cl[cl.length - 1] / base - 1 : null
    return { ...s, dates: dt, perf, ret_window }
  })
}

function PeriodTabs({ value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {SEC_PERIODS.map((p) => (
        <button key={p} onClick={() => onChange(p)} className="num"
          style={{
            padding: '2px 7px', borderRadius: 3, fontSize: 10.5, textTransform: 'uppercase',
            background: value === p ? 'var(--elevated)' : 'transparent',
            color: value === p ? 'var(--text)' : 'var(--text-muted)',
            border: `1px solid ${value === p ? 'var(--border-strong)' : 'transparent'}`,
          }}>{p}</button>
      ))}
    </div>
  )
}

export default function Europe() {
  const { data, loading, error, reload } = useFetch(fetchEurope, [])
  const session = useSession()
  useAutoRefresh(reload, session?.eu_open, 90000)
  const live = data?.mode === 'live'
  const [secPeriod, setSecPeriod] = React.useState('6m')
  const sectors = React.useMemo(() => sliceSectors(data?.sectors, secPeriod), [data, secPeriod])

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: '100%' }}>
        <SessionBanner session={session} market="eu" note="live · European session" />
        <StateView loading={loading} error={error} empty={!loading && !error && !data}>
          {data && (
            <>
              {/* index board */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10 }}>
                {data.indices.map((ix) => <IndexTile key={ix.symbol} ix={ix} live={live} />)}
              </div>

              {/* leaders + side rail */}
              <div style={{ height: 320, display: 'grid', gridTemplateColumns: '1.8fr 1fr', gap: 10 }}>
                <Panel title={live ? 'Who\u2019s leading today · intraday %' : 'Today · % change'} bodyStyle={{ padding: 6, display: 'flex' }}>
                  <LeaderChart indices={data.indices} live={live} />
                </Panel>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
                  <Panel title="EU volatility">
                    {data.vol_gauge ? (
                      <div>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                          <span className="num" style={{ fontSize: 24, fontWeight: 600 }}>{fmtNum(data.vol_gauge.level, 2)}</span>
                          <span className="lbl-dim">annualized %</span>
                        </div>
                        <Spark values={data.vol_gauge.history} invert />
                        <div className="lbl-dim" style={{ marginTop: 4 }}>{data.vol_gauge.label}</div>
                      </div>
                    ) : <span className="lbl-dim">unavailable</span>}
                  </Panel>
                  <Panel title="EUR crosses" style={{ flex: 1 }} bodyStyle={{ overflowY: 'auto' }}>
                    <QuoteList rows={data.fx} />
                  </Panel>
                </div>
              </div>

              {/* EU sector ETFs */}
              <div style={{ display: 'grid', gridTemplateColumns: '1.7fr 1fr', gap: 10 }}>
                <Panel title="EU sectors · rebased to window start"
                  right={<div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <PeriodTabs value={secPeriod} onChange={setSecPeriod} />
                    <SectorFreshness sectors={data.sectors} />
                  </div>}
                  bodyStyle={{ padding: 6 }}>
                  <SectorChart sectors={sectors} />
                </Panel>
                <Panel title={`Sector ranking · ${secPeriod.toUpperCase()} return`} bodyStyle={{ overflowY: 'auto', maxHeight: 380 }}>
                  <SectorRank sectors={sectors} />
                </Panel>
              </div>

              {/* overlap */}
              <Overlap overlap={data.overlap} />
            </>
          )}
        </StateView>
      </div>
    </div>
  )
}

// Shows the sector board's data date, and calls out any sector whose last bar
// trails the rest. Sector ETFs are fetched per symbol, so one lagging behind
// the others is a real failure mode — worth surfacing rather than letting it
// look like a flat market.
function SectorFreshness({ sectors }) {
  if (!sectors?.length) return <span className="lbl-dim">iShares STOXX 600</span>
  const dates = sectors.map((s) => s.as_of).filter(Boolean)
  const newest = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null
  const stale = sectors.filter((s) => s.stale)
  return (
    <span className="lbl-dim" title={stale.length ? `Behind: ${stale.map((s) => s.name).join(', ')}` : 'All sectors on the same bar'}>
      iShares STOXX 600 · {newest || '—'}
      {stale.length > 0 && (
        <span style={{ color: 'var(--side)', marginLeft: 6 }}>{stale.length} behind</span>
      )}
    </span>
  )
}

// ── EU sector rebased curves ─────────────────────────────────
function SectorChart({ sectors }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current || !sectors?.length) return
    const traces = sectors.map((s) => ({
      type: 'scatter', mode: 'lines', name: s.name, x: s.dates, y: s.perf,
      line: { color: sectorColor(s.symbol), width: 1.9 },
      hovertemplate: `${s.name}  %{y:+.2f}%<extra></extra>`,
    }))
    const layout = {
      margin: { l: 42, r: 12, t: 6, b: 22 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 9, color: '#787b86' },
      showlegend: true, legend: { orientation: 'h', y: 1.14, x: 0, font: { size: 8.5 } },
      hovermode: 'closest',
      hoverlabel: { bgcolor: '#1e222d', bordercolor: '#363b48', font: { family: 'IBM Plex Mono, monospace', size: 10, color: '#d1d4dc' } },
      xaxis: { gridcolor: '#22262f', nticks: 8, showspikes: true, spikecolor: '#4a4f5c', spikethickness: 1, spikedash: 'solid', spikemode: 'across', spikesnap: 'cursor' },
      yaxis: { gridcolor: '#2a2e39', side: 'right', ticksuffix: '%', zeroline: true, zerolinecolor: '#4a4f5c', zerolinewidth: 1.2, nticks: 9, showspikes: true, spikecolor: '#4a4f5c', spikethickness: 1, spikedash: 'solid', spikemode: 'across', spikesnap: 'cursor' },
    }
    Plotly.react(ref.current, traces, layout, { responsive: true, displayModeBar: false })
  }, [sectors])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])
  if (!sectors?.length) return <div className="lbl-dim" style={{ padding: 12 }}>no EU sector ETFs resolved via feed</div>
  return <div ref={ref} style={{ width: '100%', height: 340 }} />
}

function SectorRank({ sectors }) {
  if (!sectors?.length) return <span className="lbl-dim">—</span>
  const rows = [...sectors].sort((a, b) => (b.ret_window ?? -99) - (a.ret_window ?? -99))
  const maxAbs = Math.max(0.02, ...rows.map((s) => Math.abs(s.ret_window || 0)))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((s) => {
        const up = (s.ret_window || 0) >= 0
        const w = Math.abs(s.ret_window || 0) / maxAbs * 100
        return (
          <div key={s.symbol} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 6, height: 6, borderRadius: 2, background: sectorColor(s.symbol), flexShrink: 0 }} />
            <span style={{ width: 118, fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={`${s.name} · ${s.symbol}`}>{s.name}</span>
            <div style={{ flex: 1, height: 8, background: 'var(--hairline)', borderRadius: 2, position: 'relative' }}>
              <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${w}%`, background: up ? 'var(--bull)' : 'var(--bear)', borderRadius: 2, opacity: 0.8 }} />
            </div>
            <span className="num" style={{ width: 52, textAlign: 'right', fontSize: 11.5, color: up ? 'var(--bull)' : 'var(--bear)' }}>{fmtPct(s.ret_window)}</span>
          </div>
        )
      })}
    </div>
  )
}

function IndexTile({ ix, live }) {
  const tone = (ix.ret_1d || 0) >= 0 ? 'var(--bull)' : 'var(--bear)'
  return (
    <Panel bodyStyle={{ padding: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ix.name}</div>
          <div className="num lbl-dim" style={{ marginTop: 2, fontSize: 10 }}>{ix.symbol}</div>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 }}>
        <span className="num" style={{ fontSize: 15 }}>{fmtNum(ix.last, 0)}</span>
        <span className="num" style={{ color: tone, fontSize: 12.5 }}>{fmtPct(ix.ret_1d)}</span>
      </div>
      <MiniLine ix={ix} live={live} tone={tone} />
    </Panel>
  )
}

function MiniLine({ ix, live, tone }) {
  const intraday = live && ix.intraday?.length
  const vals = intraday ? ix.intraday.map((p) => p.v) : ix.spark
  if (!vals?.length) return <div style={{ height: 34 }} />
  const w = 260, h = 34, min = Math.min(...vals), max = Math.max(...vals), rng = (max - min) || 1
  const y = (v) => h - ((v - min) / rng) * h
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * w},${y(v)}`).join(' ')
  const area = `0,${h} ${pts} ${w},${h}`
  const fill = tone === 'var(--bull)' ? 'rgba(8,153,129,0.10)' : 'rgba(242,54,69,0.10)'
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: h, marginTop: 8, display: 'block' }}>
      <polygon points={area} fill={fill} />
      {intraday && <line x1="0" y1={y(0)} x2={w} y2={y(0)} stroke="var(--border-strong)" strokeWidth="0.5" strokeDasharray="3 3" />}
      <polyline points={pts} fill="none" stroke={tone} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function QuoteList({ rows }) {
  if (!rows?.length) return <span className="lbl-dim">—</span>
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {rows.map((q) => (
        <div key={q.symbol} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--hairline)' }}>
          <div style={{ width: 92, flexShrink: 0 }}>
            <div style={{ fontSize: 12.5 }}>{q.name}</div>
          </div>
          <MiniSpark values={q.spark} up={(q.ret_1d || 0) >= 0} />
          <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 96 }}>
            <div className="num" style={{ fontSize: 13 }}>{lvl(q.level)}</div>
            <div className="num" style={{ fontSize: 11, color: (q.ret_1d || 0) >= 0 ? 'var(--bull)' : 'var(--bear)' }}>{fmtPct(q.ret_1d)}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

function LeaderChart({ indices, live }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current || !indices?.length) return
    let traces
    if (live && indices.some((i) => i.intraday?.length)) {
      traces = indices.filter((i) => i.intraday?.length).map((ix, k) => ({
        type: 'scatter', mode: 'lines', name: ix.name,
        x: ix.intraday.map((p) => p.t), y: ix.intraday.map((p) => p.v * 100),
        line: { color: LINE_COLORS[k % LINE_COLORS.length], width: 1.6 },
        hovertemplate: `${ix.name} %{y:.2f}%<extra></extra>`,
      }))
    } else {
      const sorted = [...indices].sort((a, b) => (b.ret_1d || 0) - (a.ret_1d || 0))
      traces = [{
        type: 'bar', orientation: 'h',
        x: sorted.map((i) => (i.ret_1d || 0) * 100), y: sorted.map((i) => i.name),
        marker: { color: sorted.map((i) => ((i.ret_1d || 0) >= 0 ? '#089981' : '#f23645')) },
        hovertemplate: '%{y} %{x:.2f}%<extra></extra>',
      }]
    }
    const layout = {
      margin: { l: live ? 36 : 100, r: 14, t: 8, b: live ? 40 : 24 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 9, color: '#787b86' },
      showlegend: live, legend: { orientation: 'h', y: -0.14, font: { size: 9 } },
      xaxis: { gridcolor: '#2a2e39', ticksuffix: '%', zeroline: true, zerolinecolor: '#363b48' },
      yaxis: { gridcolor: '#2a2e39', automargin: true, zeroline: true, zerolinecolor: '#363b48' },
    }
    Plotly.react(ref.current, traces, layout, { responsive: true, displayModeBar: false })
  }, [indices, live])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])
  return <div ref={ref} style={{ width: '100%', height: '100%', minHeight: 240 }} />
}

function Overlap({ overlap }) {
  const ref = useRef(null)
  const active = overlap?.active && overlap?.spy?.intraday?.length
  useEffect(() => {
    if (!ref.current || !active) return
    const spy = overlap.spy.intraday
    const trace = {
      type: 'scatter', mode: 'lines', x: spy.map((p) => p.t), y: spy.map((p) => p.v * 100),
      line: { color: '#d1d4dc', width: 1.6 }, fill: 'tozeroy', fillcolor: 'rgba(41,98,255,0.08)',
      hovertemplate: 'SPY %{y:.2f}%<extra></extra>',
    }
    const layout = {
      margin: { l: 34, r: 12, t: 8, b: 22 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 9, color: '#787b86' }, showlegend: false,
      xaxis: { gridcolor: '#2a2e39' }, yaxis: { gridcolor: '#2a2e39', ticksuffix: '%', side: 'right', zeroline: true, zerolinecolor: '#363b48' },
    }
    Plotly.react(ref.current, [trace], layout, { responsive: true, displayModeBar: false })
  }, [active, overlap])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])

  return (
    <Panel
      title="US → Europe overlap"
      right={<Pill tone={active ? 'accent' : 'flat'}>{active ? `US OPEN · SPY ${fmtPct(overlap.spy.ret_1d)}` : '15:30–17:30 CET'}</Pill>}
      bodyStyle={{ padding: active ? 6 : 12 }}
    >
      {active ? (
        <div ref={ref} style={{ width: '100%', height: 150 }} />
      ) : (
        <span className="lbl-dim">Lights up during the 15:30–17:30 CET overlap, when the US opens while Europe is still trading — SPY's intraday path shows how the open is landing on European names.</span>
      )}
    </Panel>
  )
}

function Spark({ values, invert = false }) {
  if (!values?.length) return <div style={{ height: 32 }} />
  const w = 260, h = 32, min = Math.min(...values), max = Math.max(...values), rng = (max - min) || 1
  const up = values[values.length - 1] >= values[0]
  const col = (up !== invert) ? 'var(--bear)' : 'var(--bull)'
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / rng) * h}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: h, marginTop: 6 }}>
      <polyline points={pts} fill="none" stroke={col} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function MiniSpark({ values, up }) {
  if (!values?.length) return <div style={{ flex: 1 }} />
  const w = 200, h = 26, min = Math.min(...values), max = Math.max(...values), rng = (max - min) || 1
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / rng) * h}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ flex: 1, height: h }}>
      <polyline points={pts} fill="none" stroke={up ? 'var(--bull)' : 'var(--bear)'} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
