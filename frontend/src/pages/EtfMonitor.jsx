// ============================================================
// pages/EtfMonitor.jsx  — Cross-Asset
//   Row 1: rebased performance (base 100) + rolling-correlation, side by side
//   Row 2: return matrix + risk-appetite / trending-reverting sidebar
// Fits one screen; thicker lines + more gridlines for readability.
// ============================================================

import React, { useEffect, useRef, useState } from 'react'
import Plotly from 'plotly.js-dist-min'
import { fetchEtfMonitor } from '../api/client'
import { useStore } from '../store/useStore'
import { useFetch, StateView, Panel, Pill, fmtPct, useSession, useAutoRefresh, SessionBanner } from '../components/ui'

const TF = { '1D': 1, '1W': 5, '1M': 21, '3M': 63, '6M': 126, YTD: null, '1Y': 252 }
const TF_KEYS = ['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y']

const ASSET_COL = {
  SPY: '#d1d4dc', QQQ: '#5b9cf3', IWM: '#7e6bd8',
  EFA: '#57b39a', EEM: '#3f9d6e',
  TLT: '#e0a23a', LQD: '#c98a6b', HYG: '#bf6b6b',
  GLD: '#d4af37', SLV: '#9aa0a6', USO: '#8a6d3b', CPER: '#b87333',
  UUP: '#6fa8dc', 'BTC-USD': '#f2a900',
}
const colorOf = (sym) => ASSET_COL[sym] || '#787b86'

export default function EtfMonitor() {
  const { data, loading, error, reload } = useFetch(fetchEtfMonitor, [])
  const session = useSession()
  useAutoRefresh(reload, session?.us_open, 90000)
  const openTicker = useStore((s) => s.openTicker)
  const [tf, setTf] = useState('3M')
  const [mode, setMode] = useState('pct')

  const ca = data?.cross_asset

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: '100%' }}>
        <SessionBanner session={session} market="us" note="live · cross-asset" />
        <StateView loading={loading} error={error} empty={!loading && !error && !data}>
          {data && (
            <>
              {/* row 1: performance + correlation */}
              <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 10 }}>
                <Panel
                  title={mode === 'z' ? 'Cross-asset performance · z-score (σ from mean)' : 'Cross-asset performance · rebased to 100'}
                  right={<div style={{ display: 'flex', gap: 12, alignItems: 'center' }}><NormToggle mode={mode} setMode={setMode} /><TfToggle tf={tf} setTf={setTf} /></div>}
                  bodyStyle={{ padding: 6 }}
                >
                  {ca ? <PerfChart bundle={ca} tf={tf} mode={mode} onPick={openTicker} />
                      : <Note msg="cross-asset bundle unavailable — restart backend" />}
                </Panel>

                <Panel title={`Rolling correlation · ${ca?.corr_matrix?.window ?? ''}d`} bodyStyle={{ padding: 8 }}>
                  {ca ? <CorrMatrix cm={ca.corr_matrix} /> : <Note msg="unavailable" />}
                </Panel>
              </div>

              {/* row 2: return matrix + sidebar */}
              <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 10 }}>
                <Panel title="Return matrix" right={<span className="lbl-dim">click a row to open</span>}>
                  {ca ? <ReturnMatrix rm={ca.return_matrix} onPick={openTicker} /> : <Note msg="unavailable" />}
                </Panel>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <RiskAppetite ra={data.risk_appetite} />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <StateCol title="Trending" rows={data.states.trending} onPick={openTicker} dir />
                    <StateCol title="Reverting" rows={data.states.reverting} onPick={openTicker} />
                  </div>
                </div>
              </div>
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
          title={k === 'z' ? 'z-score — standardized by each asset\u2019s own volatility (spreads low-vol assets out)' : 'percent change from window start'}
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
        line: { color: colorOf(a.symbol), width: a.symbol === 'SPY' ? 2.6 : 2 }, connectgaps: true,
        hovertemplate: `${a.label}  %{y:+.2f}%<extra></extra>`,
      }))
    } else {
      arr = bundle.perf
      traces = arr.map((a) => {
        const { x, y } = sliceNorm(bundle.dates, a.close, tf, mode)
        return {
          type: 'scatter', mode: 'lines', name: a.label, x, y,
          line: { color: colorOf(a.symbol), width: a.symbol === 'SPY' ? 2.6 : 2 }, connectgaps: true,
          hovertemplate: mode === 'z' ? `${a.label}  %{y:.2f}σ<extra></extra>` : `${a.label}  %{y:+.2f}%<extra></extra>`,
        }
      })
    }
    const suffix = (mode === 'z' && !intraday) ? 'σ' : '%'
    const layout = {
      margin: { l: 46, r: 12, t: 6, b: 24 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 9.5, color: '#787b86' },
      showlegend: true, legend: { orientation: 'h', y: 1.1, x: 0, font: { size: 9.5 } },
      // 'closest' => hovering a line shows ONLY that asset's tooltip (not every
      // series stacked). Clean solid crosshair on both axes so you can still
      // read the exact x/y at the cursor.
      hovermode: 'closest',
      hoverlabel: { bgcolor: '#1e222d', bordercolor: '#363b48', font: { family: 'IBM Plex Mono, monospace', size: 10, color: '#d1d4dc' } },
      xaxis: { gridcolor: '#22262f', showspikes: true, spikecolor: '#4a4f5c', spikethickness: 1, spikedash: 'solid', spikemode: 'across', spikesnap: 'cursor', nticks: 8 },
      yaxis: { gridcolor: '#2a2e39', side: 'right', ticksuffix: suffix, zeroline: true, zerolinecolor: '#4a4f5c', zerolinewidth: 1.2, nticks: 10, showspikes: true, spikecolor: '#4a4f5c', spikethickness: 1, spikedash: 'solid', spikemode: 'across', spikesnap: 'cursor' },
    }
    Plotly.react(ref.current, traces, layout, { responsive: true, displayModeBar: false })
    const el = ref.current
    const onClick = (e) => { const p = e.points?.[0]; if (p && onPick) onPick(arr[p.curveNumber]?.symbol) }
    el.removeAllListeners?.('plotly_click'); el.on('plotly_click', onClick)
  }, [bundle, tf, mode, onPick, intraday, noIntraday])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])
  if (noIntraday) return <div className="lbl-dim" style={{ padding: 16, height: 420 }}>1D intraday lights up when the US market is open — use 1W or longer for now.</div>
  return <div ref={ref} style={{ width: '100%', height: 420 }} />
}

function retColor(v, scale) {
  if (v == null) return 'transparent'
  const t = Math.max(-1, Math.min(1, v / (scale || 0.05)))
  const a = Math.min(0.8, Math.abs(t) * 0.8 + 0.05)
  return t >= 0 ? `rgba(8,153,129,${a})` : `rgba(242,54,69,${a})`
}

function ReturnMatrix({ rm, onPick }) {
  if (!rm?.rows?.length) return <Note msg="no data" />
  const scales = {}
  rm.cols.forEach((c) => { scales[c] = Math.max(0.02, ...rm.rows.map((r) => Math.abs(r.vals[c] ?? 0))) })
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: 'var(--mono)', fontSize: 12 }}>
        <thead>
          <tr>
            <th className="lbl" style={{ textAlign: 'left', padding: '5px 8px', color: 'var(--text-dim)', fontWeight: 500 }}>Asset</th>
            {rm.cols.map((c) => <th key={c} className="lbl" style={{ textAlign: 'right', padding: '5px 8px', color: 'var(--text-dim)', fontWeight: 500 }}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rm.rows.map((r) => (
            <tr key={r.symbol} onClick={() => onPick(r.symbol)} style={{ cursor: 'pointer', borderTop: '1px solid var(--hairline)' }}>
              <td style={{ padding: '6px 8px', color: 'var(--text)', whiteSpace: 'nowrap' }}>
                <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 2, background: colorOf(r.symbol), marginRight: 7 }} />
                {r.label}
              </td>
              {rm.cols.map((c) => {
                const v = r.vals[c]
                return (
                  <td key={c} style={{ textAlign: 'right', padding: '6px 8px', background: retColor(v, scales[c]), color: v == null ? 'var(--text-dim)' : 'var(--text)' }}>
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

function corrColor(v) {
  if (v == null) return 'transparent'
  const a = Math.min(0.82, Math.abs(v) * 0.8 + 0.04)
  return v >= 0 ? `rgba(41,98,255,${a})` : `rgba(242,54,69,${a})`
}

function CorrMatrix({ cm }) {
  if (!cm?.matrix?.length) return <Note msg="no data" />
  const short = (s) => s.replace('-USD', '')
  // Fill the panel: equal-width data columns (table-layout: fixed) across the
  // full width, cells tall enough that the grid fills the panel height, and
  // the legend pinned to the bottom.
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 11, width: '100%', height: '100%', tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 42 }} />
            {cm.symbols.map((s) => <col key={s} />)}
          </colgroup>
          <thead>
            <tr>
              <th style={{ padding: '3px 4px' }} />
              {cm.symbols.map((s) => (
                <th key={s} className="lbl" style={{ padding: '4px 2px', color: 'var(--text-dim)', fontWeight: 500, whiteSpace: 'nowrap', fontSize: 10, textAlign: 'center' }}>{short(s)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cm.matrix.map((row, i) => (
              <tr key={i}>
                <td className="num" style={{ padding: '3px 6px 3px 2px', color: 'var(--text-muted)', textAlign: 'right', whiteSpace: 'nowrap', fontSize: 10.5 }} title={cm.labels[i]}>{short(cm.symbols[i])}</td>
                {row.map((v, j) => (
                  <td key={j} title={`${cm.labels[i]} · ${cm.labels[j]} = ${v}`}
                    style={{ textAlign: 'center', padding: '3px 2px',
                      background: i === j ? 'var(--elevated)' : corrColor(v),
                      color: i === j ? 'var(--text-dim)' : Math.abs(v) > 0.4 ? 'var(--text)' : 'var(--text-muted)' }}>
                    {i === j ? '·' : v.toFixed(2)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="lbl-dim" style={{ marginTop: 8, lineHeight: 1.4, flexShrink: 0 }}>
        Blue = moving together · red = diversifying. A wall of blue means one macro factor is driving everything.
      </div>
    </div>
  )
}

function RiskAppetite({ ra }) {
  if (!ra) return null
  const pct = ra.max ? ra.score / ra.max : 0
  const tone = pct >= 0.6 ? 'bull' : pct <= 0.4 ? 'bear' : 'side'
  return (
    <Panel title="Cross-asset risk appetite">
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div className="num" style={{ fontSize: 24, fontWeight: 600 }}>{ra.score}<span style={{ color: 'var(--text-dim)', fontSize: 15 }}>/{ra.max}</span></div>
        <div style={{ flex: 1, display: 'flex', gap: 3 }}>
          {ra.votes.map((v, i) => (
            <div key={i} title={v.label} style={{ flex: 1, height: 8, borderRadius: 2, background: v.on ? 'var(--bull)' : 'var(--bear)' }} />
          ))}
        </div>
        <Pill tone={tone}>{pct >= 0.6 ? 'RISK-ON' : pct <= 0.4 ? 'RISK-OFF' : 'MIXED'}</Pill>
      </div>
    </Panel>
  )
}

function StateCol({ title, rows, onPick, dir }) {
  return (
    <Panel title={title} right={<span className="num lbl-dim">{rows.length}</span>} bodyStyle={{ overflowY: 'auto', maxHeight: 200 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {rows.length === 0 ? <span className="lbl-dim">none</span> : rows.slice(0, 8).map((r) => (
          <div key={r.symbol} onClick={() => onPick(r.symbol)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', cursor: 'pointer' }}>
            <span className="num" style={{ fontWeight: 600 }}>
              {dir && <span style={{ color: r.direction > 0 ? 'var(--bull)' : 'var(--bear)', marginRight: 4 }}>{r.direction > 0 ? '↑' : '↓'}</span>}
              {r.symbol}
            </span>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
              <span className="num lbl-dim" title="efficiency ratio">{r.er}</span>
              <span className="num" style={{ width: 54, textAlign: 'right', fontSize: 12, color: (r.ret_1m || 0) >= 0 ? 'var(--bull)' : 'var(--bear)' }}>{fmtPct(r.ret_1m)}</span>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function Note({ msg }) { return <div className="lbl-dim" style={{ padding: 12 }}>{msg}</div> }
