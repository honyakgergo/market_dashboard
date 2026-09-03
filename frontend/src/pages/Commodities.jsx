// ============================================================
// pages/Commodities.jsx
// Commodities, organised around what a commodity can actually tell you
// rather than around another rebased line chart.
//
//   1  board       every contract: price, returns, 52-week range position,
//                  trend, realized vol + its percentile. One glance = the
//                  state of the whole complex.
//   2  roll yield  contango vs backwardation, measured. The single most
//                  important commodity fact and the one a price chart hides:
//                  spot can rally all year while a long-only holder loses money
//                  to the roll.
//   3  ratios      the macro ratios with a 5-YEAR PERCENTILE, so a level
//                  becomes "stretched" or "nowhere near an extreme"
//   4  gold vs real yields — gold's actual driver, and the times it decouples
//   5  seasonality — real supply-side effects (heating, harvest, driving)
//   6  correlation — is the complex one dollar trade or many stories
//   7  performance — the rebased chart, kept, demoted
// ============================================================

import React, { useEffect, useRef, useState } from 'react'
import Plotly from 'plotly.js-dist-min'
import { fetchCommodities } from '../api/client'
import { useStore } from '../store/useStore'
import { useFetch, StateView, Panel, Pill, fmtPct, fmtNum, useSession, useAutoRefresh, SessionBanner } from '../components/ui'

const TF = { '1D': 1, '1W': 5, '1M': 21, '3M': 63, '6M': 126, YTD: null, '1Y': 252 }
const TF_KEYS = ['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y']

const COL = {
  'GC=F': '#d4af37', 'SI=F': '#9aa0a6', 'HG=F': '#b87333', 'PL=F': '#7e93a8',
  'CL=F': '#8a6d3b', 'BZ=F': '#a87f45', 'NG=F': '#2962ff', 'RB=F': '#6b8ec4',
  'ZC=F': '#c9a227', 'ZW=F': '#c98a6b', 'ZS=F': '#7a9a4e', 'KC=F': '#8b5a2b',
  'SB=F': '#d4b483', 'LE=F': '#b06a5c',
  'BTC-USD': '#f2a900', TLT: '#26a69a', UUP: '#6fa8dc',
}
const colorOf = (s) => COL[s] || '#787b86'
const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']

export default function Commodities() {
  const { data, loading, error, reload } = useFetch(fetchCommodities, [])
  const session = useSession()
  useAutoRefresh(reload, session?.us_open, 90000)
  const openTicker = useStore((s) => s.openTicker)
  const [tf, setTf] = useState('3M')
  const [mode, setMode] = useState('pct')

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: '100%' }}>
        <SessionBanner session={session} market="us" note="live · commodities" />
        <StateView loading={loading} error={error} empty={!loading && !error && !data}>
          {data && (
            <>
              <Headline data={data} onPick={openTicker} />

              <Panel title="Board" right={<span className="lbl-dim">click a row to open · bar = position in the 52-week range</span>}>
                <Board board={data.board} groups={data.groups} onPick={openTicker} />
              </Panel>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.15fr', gap: 10 }}>
                <Panel title="Roll yield · contango vs backwardation"
                       right={<span className="lbl-dim">futures ETF ÷ front month</span>}>
                  <RollYield rows={data.curve} />
                </Panel>
                <Panel title="Gold vs the 10-year real yield">
                  <RealAssets ra={data.real_assets} />
                </Panel>
              </div>

              <Panel title="Cross-asset ratios · with 5-year percentile">
                {data.ratios?.length ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
                    {data.ratios.map((r) => <RatioCard key={r.label} r={r} tf={tf} />)}
                  </div>
                ) : <Note msg="no ratios resolved" />}
              </Panel>

              <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 10 }}>
                <Panel title="Seasonality · average return by calendar month"
                       right={<span className="lbl-dim">10 years · green = up months</span>}>
                  <Seasonality rows={data.seasonality} />
                </Panel>
                <Panel title={`Correlation · ${data.correlation?.window ?? ''}d`} bodyStyle={{ padding: 8 }}>
                  <CorrMatrix cm={data.correlation} />
                </Panel>
              </div>

              <Panel
                title={mode === 'z' ? 'Performance · z-score (σ from mean)' : 'Performance · rebased to 100'}
                right={<div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <NormToggle mode={mode} setMode={setMode} /><TfToggle tf={tf} setTf={setTf} />
                </div>}
                bodyStyle={{ padding: 6 }}
              >
                {data.bundle ? <PerfChart bundle={data.bundle} tf={tf} mode={mode} onPick={openTicker} />
                             : <Note msg="performance bundle unavailable" />}
              </Panel>
            </>
          )}
        </StateView>
      </div>
    </div>
  )
}

// ── headline: what the complex is doing, in one strip ────────
function Headline({ data, onPick }) {
  const b = data.breadth
  return (
    <Panel bodyStyle={{ padding: '11px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 26, flexWrap: 'wrap' }}>
        <div>
          <div className="lbl">Trend breadth</div>
          <div className="num" style={{ fontSize: 20, fontWeight: 600, marginTop: 2 }}>
            {b?.above_ma200 ?? '—'}<span style={{ color: 'var(--text-dim)', fontSize: 14 }}>/{b?.total ?? '—'}</span>
          </div>
          <div className="lbl-dim" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 10 }}>above the 200-day</div>
        </div>
        <div style={{ minWidth: 120 }}>
          <div style={{ display: 'flex', height: 8, borderRadius: 2, overflow: 'hidden', background: 'var(--elevated)' }}>
            <div style={{ width: `${(b?.pct ?? 0) * 100}%`, background: 'var(--bull)' }} />
          </div>
        </div>
        <MoverStrip title="Leading · 1M" rows={data.leaders} onPick={onPick} tone="bull" />
        <MoverStrip title="Lagging · 1M" rows={data.laggards} onPick={onPick} tone="bear" />
        <span className="num lbl-dim" style={{ marginLeft: 'auto' }}>{data.as_of}</span>
      </div>
    </Panel>
  )
}

function MoverStrip({ title, rows, onPick, tone }) {
  if (!rows?.length) return null
  return (
    <div>
      <div className="lbl">{title}</div>
      <div style={{ display: 'flex', gap: 12, marginTop: 3, flexWrap: 'wrap' }}>
        {rows.slice(0, 4).map((r) => (
          <span key={r.symbol} onClick={() => onPick(r.symbol)} className="num"
            style={{ fontSize: 11.5, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            {r.label} <span style={{ color: `var(--${tone})` }}>{fmtPct(r.ret_1m, 1)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

// ── the board ────────────────────────────────────────────────
const TREND_TONE = { uptrend: 'var(--bull)', downtrend: 'var(--bear)', mixed: 'var(--side)' }

function Board({ board, groups, onPick }) {
  if (!board?.length) return <Note msg="no data" />
  const cols = [['ret_1d', '1D'], ['ret_1w', '1W'], ['ret_1m', '1M'], ['ret_3m', '3M'], ['ytd', 'YTD'], ['ret_1y', '1Y']]
  // Colour each column against its OWN spread. A single fixed scale across every
  // timeframe saturates the long columns solid — a +60% year and a +8% year both
  // render as the same green — which throws away the comparison the heat exists
  // to make.
  const scales = {}
  for (const [k] of cols) {
    scales[k] = Math.max(0.02, ...board.map((r) => Math.abs(r[k] ?? 0)))
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: 'var(--mono)', fontSize: 11.5 }}>
        <thead>
          <tr>
            <Th align="left">Instrument</Th>
            <Th>Last</Th>
            {cols.map(([, l]) => <Th key={l}>{l}</Th>)}
            <Th align="left" width={110}>52w range</Th>
            <Th>Trend</Th>
            <Th>RV 21d</Th>
          </tr>
        </thead>
        <tbody>
          {(groups || []).map((g) => {
            const rows = board.filter((r) => r.group === g)
            if (!rows.length) return null
            return (
              <React.Fragment key={g}>
                <tr>
                  <td colSpan={cols.length + 5} className="lbl"
                      style={{ padding: '9px 6px 3px', color: 'var(--text-dim)' }}>{g}</td>
                </tr>
                {rows.map((r) => (
                  <tr key={r.symbol} onClick={() => onPick(r.symbol)}
                      style={{ cursor: 'pointer', borderTop: '1px solid var(--hairline)' }}>
                    <td style={{ padding: '5px 6px', whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 2, background: colorOf(r.symbol), marginRight: 7 }} />
                      {r.label}
                    </td>
                    <td style={{ padding: '5px 6px', textAlign: 'right' }}>{fmtNum(r.last, r.last < 10 ? 3 : 2)}</td>
                    {cols.map(([k]) => <RetCell key={k} v={r[k]} scale={scales[k]} />)}
                    <td style={{ padding: '5px 6px' }}><RangeBar r={r} /></td>
                    <td style={{ padding: '5px 6px', textAlign: 'right', color: TREND_TONE[r.trend] || 'var(--text-dim)', fontSize: 10.5 }}>
                      {r.trend || '—'}
                    </td>
                    <td style={{ padding: '5px 6px', textAlign: 'right' }}
                        title={r.rv_pctile != null ? `${Math.round(r.rv_pctile * 100)}th percentile of 3y` : ''}>
                      {fmtNum(r.rv_21d, 1)}
                      {r.rv_pctile != null && (
                        <span style={{ marginLeft: 5, fontSize: 9.5, color: r.rv_pctile >= 0.8 ? 'var(--bear)' : r.rv_pctile <= 0.2 ? 'var(--bull)' : 'var(--text-dim)' }}>
                          {Math.round(r.rv_pctile * 100)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </React.Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Th({ children, align = 'right', width }) {
  return <th className="lbl" style={{ textAlign: align, padding: '4px 6px', color: 'var(--text-dim)', fontWeight: 500, width }}>{children}</th>
}

function RetCell({ v, scale }) {
  return (
    <td style={{ padding: '5px 6px', textAlign: 'right', background: retColor(v, scale),
      color: v == null ? 'var(--text-dim)' : 'var(--text)' }}>
      {v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}`}
    </td>
  )
}

// Where the price sits between its 52-week low and high — the fastest way to
// read a whole complex without looking at a single chart.
function RangeBar({ r }) {
  const p = r.range_pos
  if (p == null) return <span className="lbl-dim">—</span>
  const pos = Math.max(2, Math.min(98, p * 100))
  const tone = p >= 0.85 ? 'var(--bull)' : p <= 0.15 ? 'var(--bear)' : 'var(--text-muted)'
  return (
    <div title={`${(p * 100).toFixed(0)}% of the 52w range · low ${r.low_52w} · high ${r.high_52w}`}
         style={{ position: 'relative', height: 5, borderRadius: 3, background: 'var(--elevated)', width: 100 }}>
      <div style={{ position: 'absolute', left: `${pos}%`, top: -2.5, transform: 'translateX(-50%)',
        width: 3, height: 10, background: tone, borderRadius: 1 }} />
    </div>
  )
}

// ── roll yield ───────────────────────────────────────────────
function RollYield({ rows }) {
  if (!rows?.length) {
    return <Note msg="roll-yield legs unavailable — needs both the futures ETF and the front-month contract" />
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {rows.map((r) => <RollCard key={r.label} r={r} />)}
      <div className="lbl-dim" style={{ lineHeight: 1.45, textTransform: 'none', letterSpacing: 0, fontSize: 10.5 }}>
        The line is a front-month futures <strong>ETF divided by the front-month contract</strong>. An ETF holds and
        rolls the contract; the continuous price does not — so the drift between them <em>is</em> the roll yield.
        Falling = contango, and a long-only holder bleeds that much a year even if spot goes nowhere. Rising =
        backwardation, physical tightness, and the roll pays you.
      </div>
    </div>
  )
}

function RollCard({ r }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current || !r.values?.length) return
    const back = r.state === 'backwardation'
    const trace = {
      type: 'scatter', mode: 'lines', x: r.dates, y: r.values,
      line: { color: back ? '#26a69a' : '#ef5350', width: 1.6 },
      hovertemplate: '%{y:.1f}<extra></extra>',
    }
    const layout = {
      margin: { l: 34, r: 8, t: 6, b: 18 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 8.5, color: '#5a5d68' }, showlegend: false,
      hovermode: 'x',
      hoverlabel: { bgcolor: '#1e222d', bordercolor: '#2a2e39', font: { family: 'IBM Plex Mono, monospace', size: 10, color: '#d1d4dc' } },
      xaxis: { gridcolor: '#1f2430', nticks: 4 },
      yaxis: { gridcolor: '#1f2430', side: 'right', nticks: 4 },
    }
    Plotly.react(ref.current, [trace], layout, { responsive: true, displayModeBar: false })
  }, [r])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])

  const tone = r.state === 'backwardation' ? 'bull' : r.state === 'contango' ? 'bear' : 'side'
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 5, padding: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span className="lbl">{r.label}</span>
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
          <span className="num lbl-dim">{r.etf} / {r.front}</span>
          {r.state && <Pill tone={tone}>{r.state.toUpperCase()}</Pill>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 18, marginTop: 5 }}>
        <RollStat label="3m ann." v={r.roll_3m} />
        <RollStat label="6m ann." v={r.roll_6m} />
        <RollStat label="12m ann." v={r.roll_12m} />
      </div>
      <div ref={ref} style={{ width: '100%', height: 96, marginTop: 4 }} />
    </div>
  )
}

function RollStat({ label, v }) {
  return (
    <div>
      <div className="lbl" style={{ fontSize: 9 }}>{label}</div>
      <div className="num" style={{ fontSize: 12.5, marginTop: 1, color: v == null ? 'var(--text-dim)' : v >= 0 ? 'var(--bull)' : 'var(--bear)' }}>
        {v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`}
      </div>
    </div>
  )
}

// ── gold vs real yields ──────────────────────────────────────
function RealAssets({ ra }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current || !ra?.available) return
    const traces = [
      { type: 'scatter', mode: 'lines', name: 'Gold', x: ra.dates, y: ra.gold, yaxis: 'y',
        line: { color: '#d4af37', width: 1.8 }, hovertemplate: 'Gold %{y:.0f}<extra></extra>' },
      { type: 'scatter', mode: 'lines', name: '10y real yield', x: ra.dates, y: ra.real_yield, yaxis: 'y2',
        line: { color: '#2962ff', width: 1.5 }, hovertemplate: 'Real %{y:.2f}%<extra></extra>' },
    ]
    const layout = {
      margin: { l: 46, r: 44, t: 20, b: 24 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 9, color: '#787b86' },
      showlegend: true, legend: { orientation: 'h', y: 1.16, x: 0, font: { size: 9 } },
      hovermode: 'x unified',
      hoverlabel: { bgcolor: '#1e222d', bordercolor: '#2a2e39', font: { family: 'IBM Plex Mono, monospace', size: 10, color: '#d1d4dc' } },
      xaxis: { gridcolor: '#1f2430', nticks: 7 },
      yaxis: { gridcolor: '#1f2430', side: 'left', title: { text: 'gold $', font: { size: 8.5 } } },
      // Inverted so the two lines OVERLAY when the normal inverse relationship
      // holds — the moments they diverge are then impossible to miss.
      yaxis2: { overlaying: 'y', side: 'right', autorange: 'reversed', gridcolor: 'transparent',
                title: { text: 'real yield % (inverted)', font: { size: 8.5 } } },
    }
    Plotly.react(ref.current, traces, layout, { responsive: true, displayModeBar: false })
  }, [ra])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])

  if (!ra?.available) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Note msg={ra?.reason || 'unavailable'} />
        <div className="lbl-dim" style={{ lineHeight: 1.45, textTransform: 'none', letterSpacing: 0, fontSize: 10.5 }}>
          This panel needs a FRED API key — put <code>FRED_API_KEY=…</code> in <code>backend/.env</code> and restart.
          A free key comes from fred.stlouisfed.org/docs/api/api_key.html.
        </div>
      </div>
    )
  }
  const decoupled = ra.corr_90d != null && ra.corr_90d > -0.1
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 22, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Stat label="Gold" value={fmtNum(ra.gold_last, 0)} />
        <Stat label="10y real" value={`${fmtNum(ra.real_yield_last, 2)}%`} />
        <Stat label="corr 90d" value={fmtNum(ra.corr_90d, 2)} tone={decoupled ? 'side' : 'flat'} />
        <Stat label="corr 5y" value={fmtNum(ra.corr_5y, 2)} />
        {decoupled && <Pill tone="side">DECOUPLED</Pill>}
      </div>
      <div ref={ref} style={{ width: '100%', height: 210 }} />
      <div className="lbl-dim" style={{ lineHeight: 1.45, textTransform: 'none', letterSpacing: 0, fontSize: 10.5 }}>
        Gold pays no coupon, so its opportunity cost <em>is</em> the real yield — normally they move inversely
        (the right axis is inverted here so that shows up as the lines tracking each other). {ra.regime}.
        Correlations are of daily <em>changes</em>, not levels.
      </div>
    </div>
  )
}

// ── ratios with percentile ───────────────────────────────────
const TAG_TONE = {
  'extreme high': 'bear', high: 'bear', mid: 'flat', low: 'bull', 'extreme low': 'bull',
}

function RatioCard({ r }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current || !r.values?.length) return
    const trace = {
      type: 'scatter', mode: 'lines', x: r.dates, y: r.values,
      line: { color: '#26a69a', width: 1.5 }, hovertemplate: '%{y:.3f}<extra></extra>',
    }
    const shapes = [
      { type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: r.min_5y, y1: r.min_5y, line: { color: '#2a2e39', width: 1, dash: 'dot' } },
      { type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: r.max_5y, y1: r.max_5y, line: { color: '#2a2e39', width: 1, dash: 'dot' } },
    ]
    const layout = {
      margin: { l: 46, r: 8, t: 6, b: 20 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 9, color: '#787b86' }, showlegend: false,
      hovermode: 'x',
      hoverlabel: { bgcolor: '#1e222d', bordercolor: '#2a2e39', font: { family: 'IBM Plex Mono, monospace', size: 10, color: '#d1d4dc' } },
      xaxis: { gridcolor: '#1f2430', nticks: 5 },
      yaxis: { gridcolor: '#1f2430', side: 'right', nticks: 5 },
      shapes,
    }
    Plotly.react(ref.current, [trace], layout, { responsive: true, displayModeBar: false })
  }, [r])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])

  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 5, padding: 9 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span className="lbl">{r.label}</span>
        <div style={{ display: 'flex', gap: 9, alignItems: 'baseline' }}>
          <span className="num" style={{ fontSize: 14 }}>{fmtNum(r.level, 3)}</span>
          {r.tag && <Pill tone={TAG_TONE[r.tag] || 'flat'}>{r.tag.toUpperCase()}</Pill>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 5, flexWrap: 'wrap' }}>
        <Stat label="1M" value={fmtPct(r.ret_1m, 1)} tone={toneOfRet(r.ret_1m)} small />
        <Stat label="3M" value={fmtPct(r.ret_3m, 1)} tone={toneOfRet(r.ret_3m)} small />
        <Stat label="1Y" value={fmtPct(r.ret_1y, 1)} tone={toneOfRet(r.ret_1y)} small />
        <Stat label="5y pctile" value={r.pctile_5y != null ? `${Math.round(r.pctile_5y * 100)}th` : '—'} small />
      </div>
      {r.pctile_5y != null && (
        <div style={{ position: 'relative', height: 4, borderRadius: 2, marginTop: 8, background: 'var(--elevated)' }}>
          <div style={{ position: 'absolute', left: `${Math.max(1.5, Math.min(98.5, r.pctile_5y * 100))}%`,
            top: -3, transform: 'translateX(-50%)', width: 2, height: 10, background: 'var(--text)', borderRadius: 1 }} />
        </div>
      )}
      <div ref={ref} style={{ width: '100%', height: 150, marginTop: 4 }} />
      <div className="lbl-dim" style={{ marginTop: 2, lineHeight: 1.4, textTransform: 'none', letterSpacing: 0, fontSize: 10 }}>
        Rising: {r.meaning}.
      </div>
    </div>
  )
}

// ── seasonality ──────────────────────────────────────────────
function Seasonality({ rows }) {
  if (!rows?.length) return <Note msg="not enough history for seasonality" />
  const scale = Math.max(0.02, ...rows.flatMap((r) => r.months.map((m) => Math.abs(m.avg ?? 0))))
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: 'var(--mono)', fontSize: 11 }}>
        <thead>
          <tr>
            <Th align="left">Instrument</Th>
            {MONTHS.map((m, i) => <Th key={i}>{m}</Th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol} style={{ borderTop: '1px solid var(--hairline)' }}>
              <td style={{ padding: '4px 6px', whiteSpace: 'nowrap', color: 'var(--text)' }}>{r.label}</td>
              {r.months.map((m) => (
                <td key={m.month}
                    title={m.avg == null ? 'no data'
                      : `${r.label} · month ${m.month}: avg ${(m.avg * 100).toFixed(1)}%, up ${Math.round((m.hit_rate || 0) * 100)}% of ${m.n} years`}
                    style={{ textAlign: 'center', padding: '4px 3px', background: retColor(m.avg, scale),
                      color: m.avg == null ? 'var(--text-dim)' : 'var(--text)' }}>
                  {m.avg == null ? '·' : (m.avg * 100).toFixed(1)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="lbl-dim" style={{ marginTop: 8, lineHeight: 1.45, textTransform: 'none', letterSpacing: 0, fontSize: 10.5 }}>
        Average monthly return over the last 10 years, in percent. Hover for the hit rate — a big average built on
        two outlier years is not a seasonal effect, and the hit rate is what separates the two. Commodities are the
        one asset class where this reflects something physical: heating demand, harvest cycles, driving season.
      </div>
    </div>
  )
}

// ── correlation matrix ───────────────────────────────────────
function corrColor(v) {
  if (v == null) return 'transparent'
  const a = Math.min(0.82, Math.abs(v) * 0.8 + 0.04)
  return v >= 0 ? `rgba(41,98,255,${a})` : `rgba(239,83,80,${a})`
}

function CorrMatrix({ cm }) {
  if (!cm?.matrix?.length) return <Note msg="no data" />
  const short = (s) => s.replace('-USD', '').replace('=F', '')
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 10, width: '100%', tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 40 }} />
            {cm.symbols.map((s) => <col key={s} />)}
          </colgroup>
          <thead>
            <tr>
              <th style={{ padding: '3px 4px' }} />
              {cm.symbols.map((s) => (
                <th key={s} className="lbl" style={{ padding: '4px 1px', color: 'var(--text-dim)', fontWeight: 500, fontSize: 9, textAlign: 'center' }}>{short(s)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cm.matrix.map((row, i) => (
              <tr key={i}>
                <td className="num" style={{ padding: '3px 5px 3px 2px', color: 'var(--text-muted)', textAlign: 'right', whiteSpace: 'nowrap', fontSize: 9.5 }} title={cm.labels[i]}>{short(cm.symbols[i])}</td>
                {row.map((v, j) => (
                  <td key={j} title={`${cm.labels[i]} · ${cm.labels[j]} = ${v}`}
                    style={{ textAlign: 'center', padding: '3px 1px',
                      background: i === j ? 'var(--elevated)' : corrColor(v),
                      color: i === j ? 'var(--text-dim)' : Math.abs(v) > 0.4 ? 'var(--text)' : 'var(--text-muted)' }}>
                    {i === j ? '·' : v.toFixed(1)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="lbl-dim" style={{ marginTop: 8, lineHeight: 1.45, textTransform: 'none', letterSpacing: 0, fontSize: 10.5, flexShrink: 0 }}>
        Blue = moving together. A wall of blue across metals, energy and ags means you are not trading commodities,
        you are trading the dollar or global growth — and diversifying between them buys you nothing.
      </div>
    </div>
  )
}

// ── performance chart (demoted, still useful) ────────────────
function sliceNorm(dates, close, tf, mode) {
  let startIdx
  if (tf === 'YTD') {
    const y0 = new Date().getFullYear()
    startIdx = dates.findIndex((d) => new Date(d).getFullYear() === y0)
    if (startIdx < 0) startIdx = 0
  } else {
    startIdx = Math.max(0, dates.length - (TF[tf] || 63))
  }
  const xs = dates.slice(startIdx)
  const cut = close.slice(startIdx)
  if (mode === 'z') {
    const vals = cut.filter((v) => v != null)
    if (vals.length < 3) return { x: xs, y: cut.map(() => null) }
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1
    return { x: xs, y: cut.map((v) => (v == null ? null : Math.round(((v - mean) / sd) * 100) / 100)) }
  }
  const base = cut.find((v) => v != null)
  return { x: xs, y: cut.map((v) => (v == null || !base ? null : Math.round((v / base * 100 - 100) * 100) / 100)) }
}

function PerfChart({ bundle, tf, mode, onPick }) {
  const ref = useRef(null)
  const intraday = tf === '1D' ? bundle?.intraday : null
  const noIntraday = tf === '1D' && !intraday
  useEffect(() => {
    if (noIntraday || !ref.current || !bundle?.perf?.length) return
    let traces, arr
    if (intraday) {
      arr = bundle.perf.filter((a) => intraday[a.symbol])
      traces = arr.map((a) => ({
        type: 'scatter', mode: 'lines', name: a.label, x: intraday[a.symbol].t, y: intraday[a.symbol].y,
        line: { color: colorOf(a.symbol), width: 2 }, connectgaps: true,
        hovertemplate: `${a.label}  %{y:+.2f}%<extra></extra>`,
      }))
    } else {
      arr = bundle.perf
      traces = arr.map((a) => {
        const { x, y } = sliceNorm(bundle.dates, a.close, tf, mode)
        return {
          type: 'scatter', mode: 'lines', name: a.label, x, y,
          line: { color: colorOf(a.symbol), width: 2 }, connectgaps: true,
          hovertemplate: mode === 'z' ? `${a.label}  %{y:.2f}σ<extra></extra>` : `${a.label}  %{y:+.2f}%<extra></extra>`,
        }
      })
    }
    const suffix = (mode === 'z' && !intraday) ? 'σ' : '%'
    const layout = {
      margin: { l: 44, r: 12, t: 6, b: 24 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 9, color: '#787b86' },
      showlegend: true, legend: { orientation: 'h', y: 1.1, x: 0, font: { size: 9 } },
      hovermode: 'closest',
      hoverlabel: { bgcolor: '#1e222d', bordercolor: '#2a2e39', font: { family: 'IBM Plex Mono, monospace', size: 10, color: '#d1d4dc' } },
      xaxis: { gridcolor: '#1f2430', nticks: 8, showspikes: true, spikecolor: '#4a4f5c', spikethickness: 1, spikedash: 'solid', spikemode: 'across', spikesnap: 'cursor' },
      yaxis: { gridcolor: '#1f2430', side: 'right', ticksuffix: suffix, zeroline: true, zerolinecolor: '#4a4f5c', zerolinewidth: 1.2, nticks: 9, showspikes: true, spikecolor: '#4a4f5c', spikethickness: 1, spikedash: 'solid', spikemode: 'across', spikesnap: 'cursor' },
    }
    Plotly.react(ref.current, traces, layout, { responsive: true, displayModeBar: false })
    const el = ref.current
    const onClick = (e) => { const p = e.points?.[0]; if (p && onPick) onPick(arr[p.curveNumber]?.symbol) }
    el.removeAllListeners?.('plotly_click'); el.on('plotly_click', onClick)
  }, [bundle, tf, mode, intraday, noIntraday, onPick])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])
  if (noIntraday) return <div className="lbl-dim" style={{ padding: 16, height: 380 }}>1D intraday lights up when the US market is open — use 1W or longer for now.</div>
  return <div ref={ref} style={{ width: '100%', height: 380 }} />
}

// ── shared bits ──────────────────────────────────────────────
function retColor(v, scale) {
  if (v == null) return 'transparent'
  const t = Math.max(-1, Math.min(1, v / (scale || 0.05)))
  const a = Math.min(0.72, Math.abs(t) * 0.72 + 0.04)
  return t >= 0 ? `rgba(38,166,154,${a})` : `rgba(239,83,80,${a})`
}

const toneOfRet = (v) => (v == null ? 'flat' : v > 0 ? 'bull' : v < 0 ? 'bear' : 'flat')

function Stat({ label, value, tone = 'flat', small }) {
  const c = tone === 'bull' ? 'var(--bull)' : tone === 'bear' ? 'var(--bear)' : tone === 'side' ? 'var(--side)' : 'var(--text)'
  return (
    <div>
      <div className="lbl" style={{ fontSize: small ? 9 : 10 }}>{label}</div>
      <div className="num" style={{ fontSize: small ? 11.5 : 13.5, marginTop: 1, color: c }}>{value}</div>
    </div>
  )
}

function TfToggle({ tf, setTf }) {
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {TF_KEYS.map((k) => (
        <button key={k} onClick={() => setTf(k)} className="num"
          style={{
            padding: '3px 9px', borderRadius: 4, fontSize: 11,
            background: k === tf ? 'var(--elevated)' : 'transparent',
            color: k === tf ? 'var(--text)' : 'var(--text-muted)',
            border: `1px solid ${k === tf ? 'var(--border-strong)' : 'transparent'}`,
          }}>{k}</button>
      ))}
    </div>
  )
}

function NormToggle({ mode, setMode }) {
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {[['pct', '%'], ['z', 'σ']].map(([k, l]) => (
        <button key={k} onClick={() => setMode(k)} className="num"
          title={k === 'z' ? 'z-score — standardized by each asset’s own volatility' : 'percent change from window start'}
          style={{
            padding: '3px 9px', borderRadius: 4, fontSize: 11,
            background: k === mode ? 'var(--elevated)' : 'transparent',
            color: k === mode ? 'var(--text)' : 'var(--text-muted)',
            border: `1px solid ${k === mode ? 'var(--border-strong)' : 'transparent'}`,
          }}>{l}</button>
      ))}
    </div>
  )
}

function Note({ msg }) { return <div className="lbl-dim" style={{ padding: 12 }}>{msg}</div> }
