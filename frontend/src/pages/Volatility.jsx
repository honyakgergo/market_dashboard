// ============================================================
// pages/Volatility.jsx
// Vol cockpit — live during US hours, last close otherwise.
// Everything is a CHART, not a number:
//   - stat strip (VIX / VIX3M / slope / VVIX / SKEW / VRP)
//   - term-structure curve (VIX9D · VIX · VIX3M · VIX6M)
//   - cross-index vol over time (VIX / VXN / RVX)         ← headline
//   - equity-vol spreads over time (VXN−VIX, RVX−VIX)     ← "eq vs market"
//   - VVIX / SKEW / VRP as line charts
//   - dispersion / correlation (single-name vs index → DSPX)
// ============================================================

import React, { useEffect, useRef } from 'react'
import Plotly from 'plotly.js-dist-min'
import { fetchVol } from '../api/client'
import { useFetch, StateView, Panel, Pill, fmtNum, useSession, useAutoRefresh, SessionBanner } from '../components/ui'

const C = {
  vix: '#d1d4dc', vxn: '#5b9cf3', rvx: '#e0a23a',
  vvix: '#9a8aaa', skew: '#c98a6b', vrp: '#57b39a',
  grid: '#2a2e39', sep: '#363b48', text: '#787b86', dim: '#5a5d68',
  bull: '#089981', bear: '#f23645',
}

export default function Volatility() {
  const { data, loading, error, reload } = useFetch(fetchVol, [])
  const session = useSession()
  useAutoRefresh(reload, session?.us_open, 90000)

  const p = data?.vol_panel

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: '100%' }}>
      <SessionBanner session={session} market="us" note="live · vol complex" />
      <StateView loading={loading} error={error} empty={!loading && !error && !data}>
        {data && (
          <>
            {/* stat strip */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10 }}>
              <Stat label="VIX" value={fmtNum(data.vix, 2)} />
              <Stat label="VIX3M" value={fmtNum(data.vix3m, 2)} />
              <Stat label="Term slope" value={fmtNum(data.term_slope, 2)}
                    tone={data.contango == null ? 'flat' : data.contango ? 'bull' : 'bear'}
                    sub={data.contango == null ? '' : data.contango ? 'contango' : 'backwardation'} />
              <Stat label="VVIX" value={fmtNum(data.vvix?.level, 1)} />
              <Stat label="SKEW" value={fmtNum(data.skew?.level, 1)} />
              <Stat label="VRP" value={data.vrp != null ? `${data.vrp > 0 ? '+' : ''}${fmtNum(data.vrp, 2)}` : '—'}
                    tone={data.vrp == null ? 'flat' : data.vrp >= 0 ? 'bull' : 'bear'}
                    sub={data.vrp == null ? '' : data.vrp >= 0 ? 'implied rich' : 'realized > implied'} />
            </div>

            {/* cross-index over time — the headline */}
            <Panel
              title="Cross-index implied vol · over time"
              right={<span className="num lbl-dim">
                VIX {fmtNum(data.cross_index?.vix, 1)} · VXN {fmtNum(data.cross_index?.vxn, 1)}
                {p?.rvx_is_proxy ? ' · RVX (IWM proxy)' : ` · RVX ${fmtNum(data.cross_index?.rvx, 1)}`}
              </span>}
              bodyStyle={{ padding: 6 }}
            >
              {p ? (
                <LineChart height={300} yTitle="vol pts" series={[
                  { name: 'VIX · S&P 500', x: p.dates, y: p.vix, color: C.vix, width: 1.8 },
                  { name: 'VXN · Nasdaq 100', x: p.dates, y: p.vxn, color: C.vxn, width: 1.4 },
                  { name: p.rvx_is_proxy ? 'RVX · IWM RV proxy' : 'RVX · Russell 2000', x: p.dates, y: p.rvx, color: C.rvx, width: 1.4, dash: p.rvx_is_proxy ? 'dot' : 'solid' },
                ]} />
              ) : <Unavailable msg="cross-index history unavailable — restart backend to pick up vol_panel" />}
            </Panel>

            {/* term structure + equity-vol spreads */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 10 }}>
              <Panel
                title="Term structure"
                right={data.contango != null && <Pill tone={data.contango ? 'bull' : 'bear'}>{data.contango ? 'CONTANGO' : 'BACKWARDATION'}</Pill>}
                bodyStyle={{ padding: 6 }}
              >
                <TermCurve curve={data.term_structure} contango={data.contango} />
              </Panel>

              <Panel
                title="Equity-vol spreads · who's leading the stress"
                right={<span className="num lbl-dim">
                  {p?.spread_vxn_vix && `VXN−VIX ${p.spread_vxn_vix.last > 0 ? '+' : ''}${p.spread_vxn_vix.last}`}
                  {p?.spread_rvx_vix && ` · RVX−VIX ${p.spread_rvx_vix.last > 0 ? '+' : ''}${p.spread_rvx_vix.last}`}
                </span>}
                bodyStyle={{ padding: 6 }}
              >
                {p && (p.spread_vxn_vix || p.spread_rvx_vix) ? (
                  <LineChart height={240} zeroLine yTitle="Δ vol pts" series={[
                    p.spread_vxn_vix && { name: 'VXN − VIX (tech premium)', x: p.spread_vxn_vix.dates, y: p.spread_vxn_vix.values, color: C.vxn, width: 1.5 },
                    p.spread_rvx_vix && { name: p.rvx_is_proxy ? 'RVX(proxy) − VIX' : 'RVX − VIX (small-cap premium)', x: p.spread_rvx_vix.dates, y: p.spread_rvx_vix.values, color: C.rvx, width: 1.5, dash: p.rvx_is_proxy ? 'dot' : 'solid' },
                  ].filter(Boolean)} />
                ) : <Unavailable msg="spread history unavailable" />}
                <div className="lbl-dim" style={{ padding: '4px 6px 0', lineHeight: 1.4 }}>
                  Above zero = that index is more feared than the S&P. VXN&gt;0 tech-led · RVX&gt;0 breadth/small-cap-led.
                </div>
              </Panel>
            </div>

            {/* VVIX / SKEW / VRP as line charts */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
              <MiniChart title="VVIX" hint="vol-of-vol · tail-hedge demand" g={data.vvix} color={C.vvix} />
              <MiniChart title="SKEW" hint="cost of downside vs upside" g={data.skew} color={C.skew} />
              <MiniSeries title="Variance risk premium" hint="VIX − SPY realized (21d)"
                          s={p?.vrp_series} color={C.vrp} zeroLine
                          headline={data.vrp != null ? `${data.vrp > 0 ? '+' : ''}${fmtNum(data.vrp, 2)}` : '—'}
                          headTone={data.vrp == null ? 'flat' : data.vrp >= 0 ? 'bull' : 'bear'} />
            </div>

            {/* cross-index snapshot + dispersion */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: 10 }}>
              <Panel title="Cross-index vol · current">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <CrossRow label="VIX · S&P 500" value={data.cross_index.vix} />
                  <CrossRow label="VXN · Nasdaq 100" value={data.cross_index.vxn} />
                  <CrossRow label="RVX · Russell 2000" value={data.cross_index.rvx} proxy={data.cross_index.rvx_proxy} />
                  <div className="lbl-dim" style={{ lineHeight: 1.4, marginTop: 2 }}>
                    VXN above VIX = tech-led stress · RVX above VIX = small-cap/breadth stress.
                  </div>
                </div>
              </Panel>
              <Dispersion d={data.dispersion} />
            </div>
          </>
        )}
      </StateView>
      </div>
    </div>
  )
}

// ── generic multi-line time chart ────────────────────────────
function LineChart({ series, height = 240, zeroLine = false, yTitle }) {
  const ref = useRef(null)
  useEffect(() => {
    const clean = (series || []).filter((s) => s && s.x?.length && s.y?.some((v) => v != null))
    if (!ref.current || !clean.length) return
    const traces = clean.map((s) => ({
      type: 'scatter', mode: 'lines', x: s.x, y: s.y, name: s.name,
      line: { color: s.color, width: s.width || 1.5, dash: s.dash || 'solid' },
      connectgaps: true, hovertemplate: `${s.name}  %{y:.2f}<extra></extra>`,
    }))
    const shapes = zeroLine
      ? [{ type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 0, y1: 0, line: { color: C.sep, width: 1, dash: 'dot' } }]
      : []
    const layout = {
      margin: { l: 42, r: 14, t: 6, b: 24 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 9, color: C.text },
      showlegend: true, legend: { orientation: 'h', y: 1.14, x: 0, font: { size: 10 }, bgcolor: 'transparent' },
      hovermode: 'x unified',
      hoverlabel: { bgcolor: '#1e222d', bordercolor: C.sep, font: { family: 'IBM Plex Mono, monospace', size: 10, color: '#d1d4dc' } },
      xaxis: { gridcolor: C.grid, showspikes: true, spikecolor: '#6b7080', spikethickness: 1, spikedash: 'dot', spikemode: 'across', spikesnap: 'cursor' },
      yaxis: { gridcolor: C.grid, side: 'right', title: yTitle ? { text: yTitle, font: { size: 9 } } : undefined },
      shapes,
    }
    Plotly.react(ref.current, traces, layout, { responsive: true, displayModeBar: false })
  }, [series, zeroLine, yTitle])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])
  return <div ref={ref} style={{ width: '100%', height }} />
}

// ── term-structure curve ─────────────────────────────────────
function TermCurve({ curve, contango }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current || !curve?.length) return
    const trace = {
      type: 'scatter', mode: 'lines+markers+text',
      x: curve.map((p) => p.dtm), y: curve.map((p) => p.level),
      text: curve.map((p) => `${p.label} ${p.level}`), textposition: 'top center',
      textfont: { size: 10, color: '#d1d4dc' },
      line: { color: contango ? C.bull : C.bear, width: 2 },
      marker: { size: 8, color: contango ? C.bull : C.bear },
      hovertemplate: '%{text}<extra></extra>',
    }
    const layout = {
      margin: { l: 34, r: 16, t: 22, b: 30 }, paper_bgcolor: 'transparent',
      plot_bgcolor: contango ? 'rgba(8,153,129,0.04)' : 'rgba(242,54,69,0.04)',
      font: { family: 'IBM Plex Mono, monospace', size: 9, color: C.text }, showlegend: false,
      xaxis: { title: { text: 'days to maturity', font: { size: 9 } }, gridcolor: C.grid, tickvals: curve.map((p) => p.dtm), ticktext: curve.map((p) => p.label) },
      yaxis: { gridcolor: C.grid, side: 'right' },
    }
    Plotly.react(ref.current, [trace], layout, { responsive: true, displayModeBar: false })
  }, [curve, contango])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])
  if (!curve?.length) return <Unavailable msg="term-structure tickers unavailable via feed" />
  return <div ref={ref} style={{ width: '100%', height: 234 }} />
}

// ── mini line panel for a {level, history:{dates,values}} gauge ─
function MiniChart({ title, hint, g, color }) {
  return (
    <Panel title={title}>
      {g ? (
        <div>
          <div className="num" style={{ fontSize: 24, fontWeight: 600 }}>{fmtNum(g.level, 2)}</div>
          <HistLine hist={g.history} color={color} />
          <div className="lbl-dim" style={{ marginTop: 4 }}>{hint}</div>
        </div>
      ) : <Unavailable msg="unavailable via feed" />}
    </Panel>
  )
}

// ── mini line panel for a {dates,values,last} series (VRP) ────
function MiniSeries({ title, hint, s, color, zeroLine, headline, headTone }) {
  const tcol = headTone === 'bull' ? 'var(--bull)' : headTone === 'bear' ? 'var(--bear)' : 'var(--text)'
  return (
    <Panel title={title}>
      <div>
        <div className="num" style={{ fontSize: 24, fontWeight: 600, color: tol(headline) ? tcol : 'var(--text)' }}>{headline}</div>
        {s ? <HistLine hist={{ dates: s.dates, values: s.values }} color={color} zeroLine={zeroLine} />
           : <div style={{ height: 60 }} />}
        <div className="lbl-dim" style={{ marginTop: 4 }}>{hint}</div>
      </div>
    </Panel>
  )
}
const tol = (x) => x != null && x !== '—'

// ── small inline plotly line (used by the mini panels) ───────
function HistLine({ hist, color, zeroLine = false }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current || !hist?.values?.length) return
    const trace = { type: 'scatter', mode: 'lines', x: hist.dates, y: hist.values, line: { color, width: 1.5 }, connectgaps: true, hovertemplate: '%{y:.2f}<extra></extra>' }
    const shapes = zeroLine ? [{ type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 0, y1: 0, line: { color: C.sep, width: 1, dash: 'dot' } }] : []
    const layout = {
      margin: { l: 34, r: 8, t: 6, b: 18 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 8.5, color: C.dim }, showlegend: false, hovermode: 'x',
      xaxis: { gridcolor: C.grid, showticklabels: false }, yaxis: { gridcolor: C.grid, side: 'right', nticks: 4 }, shapes,
    }
    Plotly.react(ref.current, [trace], layout, { responsive: true, displayModeBar: false })
  }, [hist, color, zeroLine])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])
  return <div ref={ref} style={{ width: '100%', height: 68, marginTop: 4 }} />
}

// ── small pieces ─────────────────────────────────────────────
function Stat({ label, value, tone = 'flat', sub }) {
  const col = tone === 'bull' ? 'var(--bull)' : tone === 'bear' ? 'var(--bear)' : 'var(--text)'
  return (
    <Panel bodyStyle={{ padding: '10px 12px' }}>
      <div className="lbl">{label}</div>
      <div className="num" style={{ fontSize: 20, fontWeight: 600, color: col, marginTop: 3 }}>{value}</div>
      {sub ? <div className="lbl-dim" style={{ marginTop: 2 }}>{sub}</div> : null}
    </Panel>
  )
}

function CrossRow({ label, value, proxy }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span className="lbl">{label}</span>
      {value != null ? (
        <span className="num" style={{ fontSize: 15 }}>{fmtNum(value, 2)}</span>
      ) : proxy != null ? (
        <span className="num" style={{ fontSize: 15 }}>{fmtNum(proxy, 1)}<span className="lbl-dim" style={{ marginLeft: 6 }}>IWM RV</span></span>
      ) : <span className="num">—</span>}
    </div>
  )
}

function Unavailable({ msg }) {
  return <div className="lbl-dim" style={{ padding: 12 }}>{msg}</div>
}

// ── dispersion / correlation ─────────────────────────────────
function Dispersion({ d }) {
  const r = d?.realized
  const corr = d?.corr_used
  const state = d?.state
  const pos = corr == null ? 50 : Math.max(0, Math.min(1, corr)) * 100
  const stateTone = state === 'tightening' ? 'bear' : state === 'broadening' ? 'bull' : 'side'
  return (
    <Panel title="Dispersion · correlation · single-name vs index">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16 }}>
          <div>
            <div className="lbl">DSPX · S&amp;P 500 dispersion</div>
            <div className="num" style={{ fontSize: 26, fontWeight: 600 }}>{d?.dspx != null ? fmtNum(d.dspx, 2) : 'n/a'}</div>
          </div>
          <div style={{ flex: 1 }}><HistLine hist={d?.dspx_history} color="#57b39a" /></div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {state && <Pill tone={stateTone}>{state.toUpperCase()}</Pill>}
          <span className="lbl-dim">avg pairwise correlation {corr != null ? corr.toFixed(2) : '—'}</span>
        </div>

        <div>
          <div style={{ position: 'relative', height: 10, borderRadius: 5,
            background: 'linear-gradient(90deg, var(--bull) 0%, var(--side) 50%, var(--bear) 100%)', opacity: 0.85 }}>
            <div style={{ position: 'absolute', left: `${pos}%`, top: -3, transform: 'translateX(-50%)', width: 3, height: 16, background: 'var(--text)', borderRadius: 1 }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
            <span className="lbl-dim">broadening (low corr)</span>
            <span className="lbl-dim">tightening (high corr)</span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 24 }}>
          <Metric label="Realized disp." value={r ? `${(r.dispersion * 100).toFixed(1)}%` : '—'} />
          <Metric label="Basket" value={r ? `${r.n} names` : '—'} />
        </div>
        <div className="lbl-dim" style={{ lineHeight: 1.4 }}>
          High DSPX = single names moving above index vol on their own stories (stock-picker tape).
          Correlation toward 1 = everything moving together (risk-off).
        </div>
      </div>
    </Panel>
  )
}

function Metric({ label, value }) {
  return (
    <div>
      <div className="lbl">{label}</div>
      <div className="num" style={{ fontSize: 14, marginTop: 2 }}>{value}</div>
    </div>
  )
}
