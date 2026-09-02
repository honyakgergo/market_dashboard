// ============================================================
// pages/Commodities.jsx
// Commodities & cross-asset ratios:
//   - rebased performance curves with a timeframe toggle          ← hero
//   - ratio charts (gold/silver, copper/gold, gold/oil, gold/BTC)
//   - return matrix (1D…1Y), colour-scaled
// ============================================================

import React, { useEffect, useRef, useState } from 'react'
import Plotly from 'plotly.js-dist-min'
import { fetchCommodities } from '../api/client'
import { useFetch, StateView, Panel, fmtPct, useSession, useAutoRefresh, SessionBanner } from '../components/ui'

const TF = { '1D': 1, '1W': 5, '1M': 21, '3M': 63, '6M': 126, YTD: null, '1Y': 252 }
const TF_KEYS = ['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y']

// index into a full daily series where the selected window starts
function windowStart(dates, tf) {
  if (tf === 'YTD') {
    const y0 = new Date().getFullYear()
    const i = (dates || []).findIndex((d) => new Date(d).getFullYear() === y0)
    return i < 0 ? 0 : i
  }
  return Math.max(0, (dates || []).length - (TF[tf] || 63))
}

const COL = {
  'CL=F': '#8a6d3b', 'BZ=F': '#a87f45', 'NG=F': '#5b9cf3',
  'GC=F': '#d4af37', 'SI=F': '#9aa0a6', 'HG=F': '#b87333', 'PL=F': '#7e93a8',
  IEF: '#57b39a', TLT: '#e0a23a', 'BTC-USD': '#f2a900',
}
const colorOf = (s) => COL[s] || '#787b86'

export default function Commodities() {
  const { data, loading, error, reload } = useFetch(fetchCommodities, [])
  const session = useSession()
  useAutoRefresh(reload, session?.us_open, 90000)
  const [tf, setTf] = useState('3M')
  const [mode, setMode] = useState('pct')
  const b = data?.bundle

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: '100%' }}>
        <SessionBanner session={session} market="us" note="live · commodities" />
        <StateView loading={loading} error={error} empty={!loading && !error && !data}>
          {data && (
            <>
              <Panel title={mode === 'z' ? 'Performance · z-score (σ from mean)' : 'Performance · rebased to 100'} right={<div style={{ display: 'flex', gap: 12, alignItems: 'center' }}><NormToggle mode={mode} setMode={setMode} /><TfToggle tf={tf} setTf={setTf} /></div>} bodyStyle={{ padding: 6 }}>
                {b ? <PerfChart bundle={b} tf={tf} mode={mode} /> : <Note msg="bundle unavailable — restart backend" />}
              </Panel>

              <Panel title={`Cross-asset ratios · ${tf}`}>
                {b?.ratios?.length ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
                    {b.ratios.map((r) => <RatioCard key={r.label} r={r} tf={tf} />)}
                  </div>
                ) : <Note msg="no ratios resolved" />}
              </Panel>

              <Panel title="Return matrix">
                {b ? <ReturnMatrix rm={b.return_matrix} /> : <Note msg="unavailable" />}
              </Panel>
            </>
          )}
        </StateView>
      </div>
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
          title={k === 'z' ? 'z-score — standardized by each asset\u2019s own volatility' : 'percent change from window start'}
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

// re-rebase (pct) or standardize (z) the window
function sliceNorm(dates, perf, tf, mode) {
  let startIdx
  if (tf === 'YTD') {
    const y0 = new Date().getFullYear()
    startIdx = dates.findIndex((d) => new Date(d).getFullYear() === y0)
    if (startIdx < 0) startIdx = 0
  } else {
    startIdx = Math.max(0, dates.length - (TF[tf] || 63))
  }
  const xs = dates.slice(startIdx)
  const cut = perf.slice(startIdx)
  if (mode === 'z') {
    const vals = cut.filter((v) => v != null)
    if (vals.length < 3) return { x: xs, y: cut.map(() => null) }
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1
    return { x: xs, y: cut.map((v) => (v == null ? null : Math.round(((v - mean) / sd) * 100) / 100)) }
  }
  const base = cut.find((v) => v != null)
  const baseMul = base == null ? null : 1 + base / 100
  return { x: xs, y: cut.map((v) => (v == null || baseMul == null ? null : Math.round(((1 + v / 100) / baseMul - 1) * 10000) / 100)) }
}

function PerfChart({ bundle, tf, mode }) {
  const ref = useRef(null)
  const intraday = tf === '1D' ? bundle?.intraday : null
  const noIntraday = tf === '1D' && !intraday
  useEffect(() => {
    if (noIntraday || !ref.current || !bundle?.perf?.length) return
    let traces
    if (intraday) {
      traces = bundle.perf.filter((a) => intraday[a.symbol]).map((a) => ({
        type: 'scatter', mode: 'lines', name: a.label, x: intraday[a.symbol].t, y: intraday[a.symbol].y,
        line: { color: colorOf(a.symbol), width: 2 }, connectgaps: true,
        hovertemplate: `${a.label}  %{y:+.2f}%<extra></extra>`,
      }))
    } else {
      traces = bundle.perf.map((a) => {
        const { x, y } = sliceNorm(bundle.dates, a.perf, tf, mode)
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
      showlegend: true, legend: { orientation: 'h', y: 1.12, x: 0, font: { size: 9.5 } },
      // 'closest' => hovering a line shows ONLY that instrument's tooltip, not
      // every series at once. Clean solid crosshair on both axes.
      hovermode: 'closest',
      hoverlabel: { bgcolor: '#1e222d', bordercolor: '#363b48', font: { family: 'IBM Plex Mono, monospace', size: 10, color: '#d1d4dc' } },
      xaxis: { gridcolor: '#22262f', nticks: 8, showspikes: true, spikecolor: '#4a4f5c', spikethickness: 1, spikedash: 'solid', spikemode: 'across', spikesnap: 'cursor' },
      yaxis: { gridcolor: '#2a2e39', side: 'right', ticksuffix: suffix, zeroline: true, zerolinecolor: '#4a4f5c', zerolinewidth: 1.2, nticks: 10, showspikes: true, spikecolor: '#4a4f5c', spikethickness: 1, spikedash: 'solid', spikemode: 'across', spikesnap: 'cursor' },
    }
    Plotly.react(ref.current, traces, layout, { responsive: true, displayModeBar: false })
  }, [bundle, tf, mode, intraday, noIntraday])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])
  if (noIntraday) return <div className="lbl-dim" style={{ padding: 16, height: 420 }}>1D intraday lights up when the US market is open — use 1W or longer for now.</div>
  return <div ref={ref} style={{ width: '100%', height: 420 }} />
}

function RatioCard({ r, tf }) {
  const ref = useRef(null)
  // re-window the ratio series to the selected timeframe (min 2 points so 1D
  // still draws a segment), and report that window's return in the header.
  const start = Math.min(windowStart(r.dates, tf), Math.max(0, (r.dates?.length || 0) - 2))
  const xs = (r.dates || []).slice(start)
  const ys = (r.values || []).slice(start)
  const ret = ys.length > 1 && ys[0] ? ys[ys.length - 1] / ys[0] - 1 : null
  useEffect(() => {
    if (!ref.current || ys.length < 2) return
    const up = (ret || 0) >= 0
    const trace = {
      type: 'scatter', mode: 'lines', x: xs, y: ys,
      line: { color: up ? '#089981' : '#e0a23a', width: 1.5 }, hovertemplate: '%{y:.3f}<extra></extra>',
    }
    const layout = {
      margin: { l: 44, r: 8, t: 6, b: 20 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 9, color: '#787b86' }, showlegend: false,
      hovermode: 'closest',
      hoverlabel: { bgcolor: '#1e222d', bordercolor: '#363b48', font: { family: 'IBM Plex Mono, monospace', size: 10, color: '#d1d4dc' } },
      xaxis: { gridcolor: '#2a2e39', nticks: 5, showspikes: true, spikecolor: '#4a4f5c', spikethickness: 1, spikedash: 'solid', spikemode: 'across', spikesnap: 'cursor' },
      yaxis: { gridcolor: '#2a2e39', side: 'right', nticks: 5, showspikes: true, spikecolor: '#4a4f5c', spikethickness: 1, spikedash: 'solid', spikemode: 'across', spikesnap: 'cursor' },
    }
    Plotly.react(ref.current, [trace], layout, { responsive: true, displayModeBar: false })
  }, [r, tf, xs, ys, ret])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 5, padding: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="lbl">{r.label}</span>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
          <span className="num" style={{ fontSize: 14 }}>{r.level}</span>
          <span className="num" style={{ fontSize: 11.5, color: (ret || 0) >= 0 ? 'var(--bull)' : 'var(--bear)' }}>{fmtPct(ret)} {tf}</span>
        </div>
      </div>
      <div ref={ref} style={{ width: '100%', height: 190, marginTop: 4 }} />
    </div>
  )
}

function retColor(v, scale) {
  if (v == null) return 'transparent'
  const t = Math.max(-1, Math.min(1, v / (scale || 0.05)))
  const a = Math.min(0.8, Math.abs(t) * 0.8 + 0.05)
  return t >= 0 ? `rgba(8,153,129,${a})` : `rgba(242,54,69,${a})`
}

function ReturnMatrix({ rm }) {
  if (!rm?.rows?.length) return <Note msg="no data" />
  const scales = {}
  rm.cols.forEach((c) => { scales[c] = Math.max(0.02, ...rm.rows.map((r) => Math.abs(r.vals[c] ?? 0))) })
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: 'var(--mono)', fontSize: 11.5 }}>
        <thead>
          <tr>
            <th className="lbl" style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-dim)', fontWeight: 500 }}>Instrument</th>
            {rm.cols.map((c) => <th key={c} className="lbl" style={{ textAlign: 'right', padding: '4px 8px', color: 'var(--text-dim)', fontWeight: 500 }}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rm.rows.map((r) => (
            <tr key={r.symbol} style={{ borderTop: '1px solid var(--hairline)' }}>
              <td style={{ padding: '5px 8px', color: 'var(--text)', whiteSpace: 'nowrap' }}>
                <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 2, background: colorOf(r.symbol), marginRight: 7 }} />
                {r.label}
              </td>
              {rm.cols.map((c) => {
                const v = r.vals[c]
                return (
                  <td key={c} style={{ textAlign: 'right', padding: '5px 8px', background: retColor(v, scales[c]), color: v == null ? 'var(--text-dim)' : 'var(--text)' }}>
                    {v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}`}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Note({ msg }) { return <div className="lbl-dim" style={{ padding: 12 }}>{msg}</div> }
