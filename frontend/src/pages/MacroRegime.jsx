// ============================================================
// pages/MacroRegime.jsx
// Macro board — "what's happening today":
//   - SPY line vs composite score, time-aligned with regime shading (hero)
//   - 7 risk-signal drivers with live values
//   - net liquidity (large) + real-yield / breakeven
//   - VIX term structure + market pressure (breadth / TRIN)
// ============================================================

import React, { useEffect, useRef } from 'react'
import Plotly from 'plotly.js-dist-min'
import { fetchMacro, fetchMacroExtended, fetchOverview } from '../api/client'
import { useFetch, StateView, Panel, Pill, fmtNum, fmtPctU } from '../components/ui'

const SIGNALS = {
  sig_vix:         { label: 'Volatility',  desc: 'VIX < 20',         val: (d) => `VIX ${fmtNum(d.val_vix, 1)}` },
  sig_yield_curve: { label: 'Yield curve', desc: '10Y > 3M',         val: (d) => `${fmtNum(d.val_tnx, 2)} / ${fmtNum(d.val_irx, 2)}` },
  sig_dxy:         { label: 'US dollar',    desc: 'UUP below 50d',    val: (d) => `${fmtNum(d.val_dxy)} · ma ${fmtNum(d.val_dxy_ma50)}` },
  sig_hyg:         { label: 'Credit',       desc: 'HYG above 50d',    val: (d) => `${fmtNum(d.val_hyg)} · ma ${fmtNum(d.val_hyg_ma50)}` },
  sig_tlt:         { label: 'Treasuries',   desc: 'TLT above 50d',    val: (d) => `${fmtNum(d.val_tlt)} · ma ${fmtNum(d.val_tlt_ma50)}` },
  sig_spy:         { label: 'Equity trend', desc: 'SPY above 200d',   val: (d) => `${fmtNum(d.val_spy)} · ma ${fmtNum(d.val_spy_ma200)}` },
  sig_eurusd:      { label: 'EUR/USD',      desc: 'EURUSD below 50d', val: (d) => `${fmtNum(d.val_eurusd, 4)} · ma ${fmtNum(d.val_eurusd_ma50, 4)}` },
}

export default function MacroRegime() {
  const { data, loading, error } = useFetch(fetchMacro, [])
  const ext = useFetch(fetchMacroExtended, [])
  const ov = useFetch(fetchOverview, [])

  const sigKeys = data ? Object.keys(data).filter((k) => k.startsWith('sig_')) : []
  const max = sigKeys.length
  const on = sigKeys.filter((k) => data[k] === 1).length
  const riskOn = data?.regime === 'risk_on'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 10, overflowY: 'auto' }}>
      <StateView loading={loading} error={error}>
        {data && (
          <>
            {/* hero: SPY vs score, time-aligned */}
            <Panel
              title="SPY vs composite score · 12 months"
              right={
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <span className="num" style={{ fontSize: 18, fontWeight: 600 }}>{on}<span style={{ color: 'var(--text-dim)', fontSize: 13 }}> / {max}</span></span>
                  <Pill tone={riskOn ? 'bull' : 'bear'}>{riskOn ? 'RISK-ON' : 'RISK-OFF'}</Pill>
                  <span className="lbl-dim">{data.date}</span>
                </div>
              }
              bodyStyle={{ padding: 6 }}
            >
              <RegimeOverlay hist={data.history} />
              <div className="lbl-dim" style={{ padding: '4px 6px 0' }}>
                Shading = risk-on (green) / risk-off (red). Watch the score sag into SPY drawdowns.
              </div>
            </Panel>

            {/* signal drivers */}
            <Panel title={`Risk signals · ${on}/${max} on`}>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${max}, 1fr)`, gap: 8 }}>
                {sigKeys.map((k) => {
                  const meta = SIGNALS[k] || { label: k.replace('sig_', ''), desc: '', val: () => '' }
                  const active = data[k] === 1
                  return (
                    <div key={k} style={{ background: 'var(--elevated)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <div style={{ fontSize: 12.5, fontWeight: 500 }}>{meta.label}</div>
                          <div className="lbl-dim" style={{ marginTop: 2 }}>{meta.desc}</div>
                        </div>
                        <span style={{ width: 9, height: 9, borderRadius: '50%', marginTop: 2, background: active ? 'var(--bull)' : 'var(--bear)', boxShadow: active ? '0 0 8px var(--bull)' : 'none' }} />
                      </div>
                      <div className="num" style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 11.5 }}>{meta.val(data)}</div>
                    </div>
                  )
                })}
              </div>
            </Panel>

            {/* liquidity (large) + yields */}
            <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 10 }}>
              <Panel title="Net liquidity · Fed assets − TGA − RRP" bodyStyle={{ padding: 6 }}>
                <StateView loading={ext.loading} error={ext.error}>
                  {ext.data && (ext.data.fred?.available && ext.data.fred.net_liquidity_series ? (
                    <>
                      <div style={{ padding: '2px 8px 6px', display: 'flex', alignItems: 'baseline', gap: 12 }}>
                        <span className="num" style={{ fontSize: 22, fontWeight: 600 }}>{netLiq(ext.data.fred.net_liquidity_bn)}</span>
                        {ext.data.fred.net_liquidity_chg_bn != null && (
                          <span className="num" style={{ fontSize: 12, color: ext.data.fred.net_liquidity_chg_bn >= 0 ? 'var(--bull)' : 'var(--bear)' }}>
                            {ext.data.fred.net_liquidity_chg_bn >= 0 ? '+' : ''}{fmtNum(ext.data.fred.net_liquidity_chg_bn, 0)}B / mo
                          </span>
                        )}
                      </div>
                      <LineChart series={ext.data.fred.net_liquidity_series} height={180} />
                    </>
                  ) : (
                    <div className="lbl-dim" style={{ padding: 8, lineHeight: 1.5 }}>FRED key not set — add <span className="num">FRED_API_KEY</span> to <span className="num">backend/.env</span>.</div>
                  ))}
                </StateView>
              </Panel>

              <Panel title="Rates · FRED">
                <StateView loading={ext.loading} error={ext.error}>
                  {ext.data && (ext.data.fred?.available ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                      <TrendRow label="Real yield 10y" value={`${fmtNum(ext.data.fred.real_yield_10y, 2)}%`} chg={ext.data.fred.real_yield_10y_chg} unit="pp" series={ext.data.fred.real_yield_series} />
                      <TrendRow label="Breakeven 10y" value={`${fmtNum(ext.data.fred.breakeven_10y, 2)}%`} chg={ext.data.fred.breakeven_10y_chg} unit="pp" series={ext.data.fred.breakeven_series} />
                    </div>
                  ) : <div className="lbl-dim">FRED key not set.</div>)}
                </StateView>
              </Panel>
            </div>

            {/* VIX + pressure */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Panel title="VIX term structure">
                <StateView loading={ext.loading} error={ext.error}>
                  {ext.data && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <div style={{ display: 'flex', gap: 20, alignItems: 'baseline' }}>
                        <Big label="VIX" value={fmtNum(ext.data.vix_complex.vix, 2)} />
                        <Big label="VIX3M" value={fmtNum(ext.data.vix_complex.vix3m, 2)} />
                        <Big label="spread" value={fmtNum(ext.data.vix_complex.term_spread, 2)} />
                        {ext.data.vix_complex.contango != null && (
                          <Pill tone={ext.data.vix_complex.contango ? 'bull' : 'bear'}>{ext.data.vix_complex.contango ? 'CONTANGO' : 'BACKWARDATION'}</Pill>
                        )}
                      </div>
                      <DualSpark a={ext.data.vix_complex.vix_series} b={ext.data.vix_complex.vix3m_series} />
                      <div style={{ display: 'flex', gap: 16 }}>
                        <Legend color="var(--accent)" label="VIX (1m)" />
                        <Legend color="var(--text-dim)" label="VIX3M (3m)" />
                      </div>
                    </div>
                  )}
                </StateView>
              </Panel>

              <MarketPressure ov={ov} />
            </div>
          </>
        )}
      </StateView>
    </div>
  )
}

// ── SPY + score, shared time axis, regime shading spanning both ──
function RegimeOverlay({ hist }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current || !hist?.dates?.length) return
    const { dates, score, regime, spy, max_score } = hist

    const shapes = []
    let start = 0
    for (let i = 1; i <= dates.length; i++) {
      if (i === dates.length || regime[i] !== regime[start]) {
        shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0: dates[start], x1: dates[i - 1], y0: 0, y1: 1,
          fillcolor: regime[start] === 'risk_on' ? 'rgba(8,153,129,0.10)' : 'rgba(242,54,69,0.10)', line: { width: 0 }, layer: 'below' })
        start = i
      }
    }
    shapes.push({ type: 'line', xref: 'paper', yref: 'y2', x0: 0, x1: 1, y0: 4, y1: 4, line: { color: '#363b48', width: 1, dash: 'dot' } })

    const spyTrace = { type: 'scatter', mode: 'lines', x: dates, y: spy, yaxis: 'y',
      line: { color: '#d1d4dc', width: 1.6 }, name: 'SPY', hovertemplate: 'SPY %{y}<extra></extra>' }
    const scoreTrace = { type: 'scatter', mode: 'lines', x: dates, y: score, yaxis: 'y2',
      line: { color: '#2962ff', width: 1.4, shape: 'hv' }, fill: 'tozeroy', fillcolor: 'rgba(41,98,255,0.14)',
      name: 'Score', hovertemplate: 'score %{y}<extra></extra>' }

    const layout = {
      margin: { l: 8, r: 48, t: 8, b: 22 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 9, color: '#787b86' }, showlegend: false, hovermode: 'x unified',
      xaxis: { gridcolor: '#2a2e39', domain: [0, 1], anchor: 'y2', rangeslider: { visible: false } },
      yaxis: { gridcolor: '#2a2e39', domain: [0.40, 1.0], side: 'right', tickformat: '.0f' },
      yaxis2: { gridcolor: '#2a2e39', domain: [0.0, 0.34], side: 'right', range: [0, max_score], dtick: 2 },
      shapes,
    }
    Plotly.react(ref.current, [spyTrace, scoreTrace], layout, { responsive: true, displayModeBar: false })
  }, [hist])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])
  return <div ref={ref} style={{ width: '100%', height: 300 }} />
}

function MarketPressure({ ov }) {
  const b = ov.data?.breadth
  const adv = b?.advancers || 0, dec = b?.decliners || 0
  const tot = Math.max(adv + dec, 1)
  const trin = b?.trin
  const trinTone = trin == null ? 'flat' : trin < 0.9 ? 'bull' : trin > 1.1 ? 'bear' : 'flat'
  return (
    <Panel title="Market pressure · today">
      <StateView loading={ov.loading} error={ov.error}>
        {b && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="num" style={{ color: 'var(--bull)' }}>{adv} adv</span>
                <span className="num" style={{ color: 'var(--bear)' }}>{dec} dec</span>
              </div>
              <div style={{ display: 'flex', height: 8, borderRadius: 2, overflow: 'hidden', background: 'var(--elevated)', marginTop: 5 }}>
                <div style={{ width: `${(adv / tot) * 100}%`, background: 'var(--bull)' }} />
                <div style={{ width: `${(dec / tot) * 100}%`, background: 'var(--bear)' }} />
              </div>
            </div>
            <Line label="Up / down $vol" value={fmtNum(b.vol_ratio)} tone={b.vol_ratio > 1 ? 'bull' : 'bear'} />
            <Line label="TRIN (Arms)" value={fmtNum(trin)} tone={trinTone} hint={trin == null ? '' : trin < 1 ? 'buying' : 'selling'} />
            <Line label="% above 50d" value={fmtPctU(b.pct_above_50, 0)} />
            <Line label="% above 200d" value={fmtPctU(b.pct_above_200, 0)} />
            <Line label="New highs / lows" value={`${b.new_highs} / ${b.new_lows}`} tone={b.new_highs >= b.new_lows ? 'bull' : 'bear'} />
          </div>
        )}
      </StateView>
    </Panel>
  )
}

function LineChart({ series, height = 160 }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current || !series?.values?.length) return
    const vals = series.values
    const min = Math.min(...vals), max = Math.max(...vals)
    const pad = (max - min) * 0.2 || Math.abs(max) * 0.02 || 1
    // Scale the axis to the data range so the variation fills the chart; the
    // tozeroy fill is clipped at the floor, leaving a clean area.
    const range = [min - pad, max + pad]
    const trace = { type: 'scatter', mode: 'lines', x: series.dates, y: vals,
      line: { color: '#2962ff', width: 1.6 }, fill: 'tozeroy', fillcolor: 'rgba(41,98,255,0.10)', hovertemplate: '%{y}<extra></extra>' }
    const layout = {
      margin: { l: 8, r: 52, t: 4, b: 22 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 9, color: '#787b86' }, showlegend: false,
      xaxis: { gridcolor: '#2a2e39' }, yaxis: { gridcolor: '#2a2e39', side: 'right', range },
    }
    Plotly.react(ref.current, [trace], layout, { responsive: true, displayModeBar: false })
  }, [series])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])
  return <div ref={ref} style={{ width: '100%', height }} />
}

function Line({ label, value, tone = 'flat', hint }) {
  const c = tone === 'bull' ? 'var(--bull)' : tone === 'bear' ? 'var(--bear)' : 'var(--text)'
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span className="lbl">{label}</span>
      <span className="num" style={{ color: c, fontSize: 13 }}>{value}{hint && <span className="lbl-dim" style={{ marginLeft: 6 }}>{hint}</span>}</span>
    </div>
  )
}
function Legend({ color, label }) {
  return <span className="lbl" style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 14, height: 2, background: color }} />{label}</span>
}
function netLiq(bn) {
  if (bn == null) return '—'
  return bn >= 1000 ? `$${(bn / 1000).toFixed(2)}T` : `$${fmtNum(bn, 0)}B`
}
function Big({ label, value }) {
  return <div><div className="lbl">{label}</div><div className="num" style={{ fontSize: 16 }}>{value}</div></div>
}
function TrendRow({ label, value, chg, unit, series }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ flex: 1 }}>
        <div className="lbl">{label}</div>
        <div className="num" style={{ fontSize: 14, marginTop: 2 }}>
          {value}
          {chg != null && <span style={{ marginLeft: 8, fontSize: 11, color: chg >= 0 ? 'var(--bull)' : 'var(--bear)' }}>{chg >= 0 ? '+' : ''}{fmtNum(chg, 1)}{unit}</span>}
        </div>
      </div>
      <Spark series={series} />
    </div>
  )
}
function Spark({ series }) {
  const vals = series?.values
  if (!vals?.length) return <div style={{ width: 130 }} />
  const w = 130, h = 30, min = Math.min(...vals), max = Math.max(...vals), rng = (max - min) || 1
  const up = vals[vals.length - 1] >= vals[0]
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * w},${h - ((v - min) / rng) * h}`).join(' ')
  return <svg width={w} height={h} style={{ flexShrink: 0 }}><polyline points={pts} fill="none" stroke={up ? 'var(--bull)' : 'var(--bear)'} strokeWidth="1.2" /></svg>
}
function DualSpark({ a, b }) {
  if (!a?.values?.length) return null
  const w = 460, h = 90
  const all = [...a.values, ...(b?.values || [])]
  const min = Math.min(...all), max = Math.max(...all), rng = (max - min) || 1
  const line = (vals) => vals.map((v, i) => `${(i / (vals.length - 1)) * w},${h - ((v - min) / rng) * h}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none">
      {b?.values?.length && <polyline points={line(b.values)} fill="none" stroke="var(--text-dim)" strokeWidth="1" />}
      <polyline points={line(a.values)} fill="none" stroke="var(--accent)" strokeWidth="1.4" />
    </svg>
  )
}
