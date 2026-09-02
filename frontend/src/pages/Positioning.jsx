// ============================================================
// pages/Positioning.jsx
// Who's positioned how:
//   - NAAIM active-manager equity exposure (weekly) — gauge + history
//   - CFTC COT financial futures: Leveraged Funds vs Asset Managers net,
//     with 3y net-positioning history + percentile (extremes flagged)
//   - CFTC COT commodities: Managed Money net + history
//   - AAII retail sentiment (best-effort; shows a note if the feed blocks)
// ============================================================

import React, { useEffect, useRef } from 'react'
import Plotly from 'plotly.js-dist-min'
import { fetchCot, fetchSentiment } from '../api/client'
import { useFetch, StateView, Panel, Pill, fmtNum } from '../components/ui'

const C = { lev: '#5b9cf3', am: '#e0a23a', mm: '#57b39a', grid: '#2a2e39', sep: '#4a4f5c', zero: '#4a4f5c' }
const fmtK = (v) => {
  if (v == null) return '—'
  const a = Math.abs(v)
  const s = a >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : `${v}`
  return v > 0 ? `+${s}` : s
}
const netTone = (v) => (v == null ? 'var(--text)' : v > 0 ? 'var(--bull)' : v < 0 ? 'var(--bear)' : 'var(--text)')

export default function Positioning() {
  const cot = useFetch(fetchCot, [])
  const sent = useFetch(fetchSentiment, [])

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: '100%' }}>

        {/* NAAIM + AAII */}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
          <Panel title="NAAIM exposure · active-manager equity exposure (weekly)"
            right={sent.data?.naaim && <span className="num lbl-dim">{sent.data.naaim.n} weeks tracked</span>}
            bodyStyle={{ padding: 6 }}>
            <StateView loading={sent.loading} error={sent.error} empty={!sent.loading && !sent.error && !sent.data?.naaim}>
              {sent.data?.naaim && <Naaim n={sent.data.naaim} />}
            </StateView>
          </Panel>

          <Panel title="Retail sentiment">
            <StateView loading={sent.loading} error={sent.error}>
              <Aaii aaii={sent.data?.aaii} />
            </StateView>
          </Panel>
        </div>

        {/* COT financial */}
        <Panel title="Speculative positioning · CFTC COT · financial futures"
          right={cot.data?.as_of && <span className="num lbl-dim">as of {cot.data.as_of}</span>}>
          <StateView loading={cot.loading} error={cot.error} empty={!cot.loading && !cot.error && !cot.data?.financial?.length}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
              {cot.data?.financial?.map((it) => <FinCard key={it.key} it={it} />)}
            </div>
            <Legend kind="fin" />
          </StateView>
        </Panel>

        {/* COT commodities */}
        <Panel title="Speculative positioning · CFTC COT · commodities">
          <StateView loading={cot.loading} error={cot.error} empty={!cot.loading && !cot.error && !cot.data?.commodity?.length}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
              {cot.data?.commodity?.map((it) => <ComCard key={it.key} it={it} />)}
            </div>
            <Legend kind="com" />
          </StateView>
        </Panel>
      </div>
    </div>
  )
}

// ── NAAIM ────────────────────────────────────────────────────
function Naaim({ n }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current || !n?.values?.length) return
    const trace = { type: 'scatter', mode: 'lines', x: n.dates, y: n.values,
      line: { color: '#57b39a', width: 2 }, hovertemplate: '%{y:.1f}<extra></extra>' }
    const shapes = [100, 0, 200].map((lvl) => ({ type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: lvl, y1: lvl,
      line: { color: '#2a2e39', width: 0.8, dash: 'dot' } }))
    const layout = {
      margin: { l: 40, r: 12, t: 6, b: 22 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 9, color: '#787b86' }, showlegend: false, hovermode: 'x',
      xaxis: { type: 'date', gridcolor: '#22262f', nticks: 8, tickformat: '%b %Y', hoverformat: '%d %b %Y' }, yaxis: { gridcolor: '#2a2e39', side: 'right', nticks: 6 }, shapes,
    }
    Plotly.react(ref.current, [trace], layout, { responsive: true, displayModeBar: false })
  }, [n])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])

  const zone = n.last >= 90 ? ['AGGRESSIVE', 'bull'] : n.last <= 20 ? ['DEFENSIVE', 'bear'] : ['NEUTRAL', 'side']
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, padding: '0 6px 6px' }}>
        <span className="num" style={{ fontSize: 30, fontWeight: 600 }}>{fmtNum(n.last, 1)}</span>
        {n.change != null && <span className="num" style={{ fontSize: 13, color: n.change >= 0 ? 'var(--bull)' : 'var(--bear)' }}>{n.change >= 0 ? '+' : ''}{n.change} w/w</span>}
        <Pill tone={zone[1]}>{zone[0]}</Pill>
        {n.pctile != null && <span className="lbl-dim">{Math.round(n.pctile * 100)}th pctile</span>}
        <span className="lbl-dim" style={{ marginLeft: 'auto' }}>0 = fully hedged · 100 = fully long · 200 = leveraged long</span>
      </div>
      <div ref={ref} style={{ width: '100%', height: 220 }} />
    </div>
  )
}

function Aaii({ aaii }) {
  if (!aaii) return <span className="lbl-dim">—</span>
  if (!aaii.available) {
    return (
      <div className="lbl-dim" style={{ lineHeight: 1.5 }}>
        AAII feed unavailable{aaii.note ? ` — ${aaii.note}` : ''}. NAAIM above covers manager positioning.
      </div>
    )
  }
  const L = aaii.last
  const spreadTone = L.spread >= 0 ? 'var(--bull)' : 'var(--bear)'
  const zone = L.spread >= 0.20 ? ['CROWDED BULLISH', 'bear']
             : L.spread <= -0.20 ? ['CAPITULATION', 'bull']
             : ['NEUTRAL', 'side']
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <div style={{ display: 'flex', height: 14, borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${L.bullish * 100}%`, background: 'var(--bull)' }} />
          <div style={{ width: `${L.neutral * 100}%`, background: 'var(--text-dim)' }} />
          <div style={{ width: `${L.bearish * 100}%`, background: 'var(--bear)' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
          <span className="num" style={{ color: 'var(--bull)', fontSize: 11 }}>Bull {(L.bullish * 100).toFixed(1)}%</span>
          <span className="num lbl-dim" style={{ fontSize: 11 }}>Neu {(L.neutral * 100).toFixed(1)}%</span>
          <span className="num" style={{ color: 'var(--bear)', fontSize: 11 }}>Bear {(L.bearish * 100).toFixed(1)}%</span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <div>
          <div className="lbl">Bull − Bear spread</div>
          <div className="num" style={{ fontSize: 22, fontWeight: 600, color: spreadTone }}>{L.spread >= 0 ? '+' : ''}{(L.spread * 100).toFixed(1)}</div>
        </div>
        <Pill tone={zone[1]}>{zone[0]}</Pill>
      </div>

      <SpreadSpark spread={aaii.spread} />
      <div className="lbl-dim">
        {aaii.n} weeks{aaii.spread_pctile != null ? ` · ${Math.round(aaii.spread_pctile * 100)}th pctile spread` : ''}
        {aaii.hist_avg_bull != null ? ` · avg bull ${Math.round(aaii.hist_avg_bull * 100)}%` : ''}
      </div>
    </div>
  )
}

function SpreadSpark({ spread }) {
  if (!spread?.length) return null
  const w = 260, h = 40
  const min = Math.min(...spread, 0), max = Math.max(...spread, 0), rng = (max - min) || 1
  const y = (v) => h - ((v - min) / rng) * h
  const pts = spread.map((v, i) => `${(i / (spread.length - 1)) * w},${y(v)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: h }}>
      <line x1="0" y1={y(0)} x2={w} y2={y(0)} stroke="#4a4f5c" strokeWidth="0.6" strokeDasharray="3 3" />
      <polyline points={pts} fill="none" stroke="#9a8aaa" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

// ── COT cards ────────────────────────────────────────────────
function pctBadge(p) {
  if (p == null) return null
  if (p >= 0.9) return <Pill tone="bull">STRETCHED LONG</Pill>
  if (p <= 0.1) return <Pill tone="bear">STRETCHED SHORT</Pill>
  return <span className="lbl-dim">{Math.round(p * 100)}th pctile</span>
}

function FinCard({ it }) {
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 6, padding: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{it.label}</span>
        {pctBadge(it.lev_pctile)}
      </div>
      <div className="num lbl-dim" style={{ fontSize: 9.5, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.contract}</div>

      <div style={{ display: 'flex', gap: 20, marginTop: 8 }}>
        <div>
          <div className="lbl" style={{ color: C.lev }}>Leveraged funds</div>
          <div className="num" style={{ fontSize: 20, fontWeight: 600, color: netTone(it.lev_net) }}>{fmtK(it.lev_net)}</div>
          <div className="num lbl-dim">{it.lev_chg != null ? `${fmtK(it.lev_chg)} w/w` : ''}</div>
        </div>
        <div>
          <div className="lbl" style={{ color: C.am }}>Asset managers</div>
          <div className="num" style={{ fontSize: 20, fontWeight: 600, color: netTone(it.am_net) }}>{fmtK(it.am_net)}</div>
          <div className="num lbl-dim">{it.am_chg != null ? `${fmtK(it.am_chg)} w/w` : ''}</div>
        </div>
      </div>

      <NetChart dates={it.dates} series={[
        { name: 'Leveraged funds', y: it.lev_hist, color: C.lev },
        { name: 'Asset managers', y: it.am_hist, color: C.am },
      ]} />
    </div>
  )
}

function ComCard({ it }) {
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 6, padding: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{it.label}</span>
        {pctBadge(it.mm_pctile)}
      </div>
      <div className="num lbl-dim" style={{ fontSize: 9.5, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.contract}</div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 8 }}>
        <div>
          <div className="lbl" style={{ color: C.mm }}>Managed money net</div>
          <div className="num" style={{ fontSize: 20, fontWeight: 600, color: netTone(it.mm_net) }}>{fmtK(it.mm_net)}</div>
        </div>
        <span className="num lbl-dim">{it.mm_chg != null ? `${fmtK(it.mm_chg)} w/w` : ''}</span>
      </div>

      <NetChart dates={it.dates} series={[{ name: 'Managed money', y: it.mm_hist, color: C.mm }]} />
    </div>
  )
}

function NetChart({ dates, series }) {
  const ref = useRef(null)
  useEffect(() => {
    const clean = (series || []).filter((s) => s.y?.some((v) => v != null))
    if (!ref.current || !clean.length || !dates?.length) return
    const dual = clean.length === 2
    const traces = clean.map((s, i) => ({
      type: 'scatter', mode: 'lines', name: s.name, x: dates, y: s.y,
      line: { color: s.color, width: 1.6 }, connectgaps: true,
      yaxis: (dual && i === 1) ? 'y2' : 'y',
      hovertemplate: `${s.name} %{y:,.0f}<extra></extra>`,
    }))
    const ax = (color, grid) => ({
      nticks: 5, zeroline: true, zerolinecolor: C.zero, zerolinewidth: 1, tickformat: '.2s',
      gridcolor: grid ? '#22262f' : 'rgba(0,0,0,0)', color, tickfont: { color, size: 8 },
    })
    const layout = {
      margin: { l: dual ? 42 : 46, r: dual ? 42 : 10, t: 6, b: 20 },
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 8.5, color: '#787b86' },
      showlegend: false, hovermode: 'x unified',
      hoverlabel: { bgcolor: '#1e222d', bordercolor: '#363b48', font: { family: 'IBM Plex Mono, monospace', size: 9.5, color: '#d1d4dc' } },
      xaxis: { type: 'date', gridcolor: '#22262f', nticks: 7, tickformat: '%b %Y', hoverformat: '%d %b %Y' },
      yaxis: { ...ax(dual ? clean[0].color : '#787b86', true), side: 'left' },
    }
    if (dual) {
      layout.yaxis2 = { ...ax(clean[1].color, false), side: 'right', overlaying: 'y' }
    } else {
      layout.yaxis.side = 'right'
    }
    Plotly.react(ref.current, traces, layout, { responsive: true, displayModeBar: false })
  }, [dates, series])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])
  return <div ref={ref} style={{ width: '100%', height: 150, marginTop: 6 }} />
}

function Legend({ kind }) {
  const items = kind === 'fin'
    ? [['Leveraged funds', C.lev, 'hedge funds — the fast money'], ['Asset managers', C.am, 'institutions / real money']]
    : [['Managed money', C.mm, 'CTAs / hedge funds — the speculative leg']]
  return (
    <div style={{ display: 'flex', gap: 20, marginTop: 10, flexWrap: 'wrap' }}>
      {items.map(([label, col, note]) => (
        <span key={label} className="lbl" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 3, background: col, borderRadius: 2 }} />{label}
          <span className="lbl-dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· {note}</span>
        </span>
      ))}
      <span className="lbl-dim" style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0 }}>
        net = long − short contracts · percentile vs last ~3y
      </span>
    </div>
  )
}
