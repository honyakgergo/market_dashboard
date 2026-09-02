// ============================================================
// pages/Overview.jsx
// Market Overview: sector heatmap with a universe switch (US / Europe /
// Commodities), breadth, and movers. Europe = European single names by
// sector; Commodities = futures by metals/energy/agriculture.
// ============================================================

import React, { useState } from 'react'
import { fetchOverview } from '../api/client'
import { useStore } from '../store/useStore'
import { useFetch, StateView, Panel, fmtPct, useSession, useAutoRefresh, SessionBanner } from '../components/ui'

// diverging heat: only extremes saturate, mids stay muted
const BASE = [42, 46, 57]
const POS = [8, 153, 129]
const NEG = [242, 54, 69]
function heatColor(ret, scale = 0.04) {
  if (ret == null) return 'var(--elevated)'
  const a = Math.pow(Math.min(Math.abs(ret) / scale, 1), 1.5)
  const tgt = ret >= 0 ? POS : NEG
  const mix = BASE.map((b, i) => Math.round(b + (tgt[i] - b) * a))
  return `rgb(${mix[0]},${mix[1]},${mix[2]})`
}

const UNIVERSES = [['US', 'US'], ['Europe', 'Europe'], ['Commodities', 'Commodities']]

export default function Overview() {
  const { data, loading, error, reload } = useFetch(fetchOverview, [])
  const session = useSession()
  useAutoRefresh(reload, session?.us_open, 90000)
  const openTicker = useStore((s) => s.openTicker)
  const [metric, setMetric] = useState('ret_1d')
  const [universe, setUniverse] = useState('US')

  const region = universe === 'US' ? null : data?.regions?.[universe]
  const heatmap = universe === 'US' ? data?.heatmap : (region?.heatmap || [])
  const sectors = universe === 'US' ? data?.sectors : (region?.sectors || [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 10 }}>
      <SessionBanner session={session} market="us" />
      <StateView loading={loading} error={error} empty={!loading && !error && !data}>
        {data && (
          <>
            <BreadthBar b={data.breadth} n={data.universe_size} asOf={data.as_of} />

            <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 300px', gap: 10 }}>
              {/* heatmap */}
              <Panel
                title="Heatmap"
                right={
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {UNIVERSES.map(([k, l]) => (
                        <button key={k} onClick={() => setUniverse(k)} className="num"
                          style={{
                            padding: '2px 8px', borderRadius: 3, fontSize: 11,
                            color: universe === k ? 'var(--text)' : 'var(--text-muted)',
                            background: universe === k ? 'var(--elevated)' : 'transparent',
                            border: `1px solid ${universe === k ? 'var(--border-strong)' : 'transparent'}`,
                          }}>{l}</button>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {[['ret_1d', '1D'], ['ret_1m', '1M']].map(([k, l]) => (
                        <button key={k} onClick={() => setMetric(k)} className="num"
                          style={{
                            padding: '2px 8px', borderRadius: 3, fontSize: 11,
                            color: metric === k ? 'var(--text)' : 'var(--text-muted)',
                            background: metric === k ? 'var(--elevated)' : 'transparent',
                          }}>{l}</button>
                      ))}
                    </div>
                  </div>
                }
                bodyStyle={{ overflowY: 'auto' }}
              >
                <Heatmap heatmap={heatmap} sectors={sectors} metric={metric} onPick={openTicker} />
              </Panel>

              {/* movers */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflowY: 'auto' }}>
                {universe === 'US' ? (
                  <>
                    <MoverList title="Top gainers" rows={data.movers.gainers} field="ret_1d" onPick={openTicker} />
                    <MoverList title="Top losers" rows={data.movers.losers} field="ret_1d" onPick={openTicker} />
                    <MoverList title="Unusual volume" rows={data.movers.unusual_volume} field="vol_ratio" suffix="×" onPick={openTicker} />
                    <CrossList rows={data.movers.crosses} onPick={openTicker} />
                  </>
                ) : (
                  <RegionMovers heatmap={heatmap} onPick={openTicker} />
                )}
              </div>
            </div>
          </>
        )}
      </StateView>
    </div>
  )
}

function BreadthBar({ b, n, asOf }) {
  const adv = b.advancers, dec = b.decliners
  const tot = Math.max(adv + dec, 1)
  return (
    <Panel>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <div style={{ minWidth: 150 }}>
          <div className="lbl">Breadth · {n} US names</div>
          <div className="num" style={{ marginTop: 4 }}>
            <span style={{ color: 'var(--bull)' }}>{adv} adv</span>
            <span style={{ color: 'var(--text-dim)' }}> · </span>
            <span style={{ color: 'var(--bear)' }}>{dec} dec</span>
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', height: 8, borderRadius: 2, overflow: 'hidden', background: 'var(--elevated)' }}>
            <div style={{ width: `${(adv / tot) * 100}%`, background: 'var(--bull)' }} />
            <div style={{ width: `${(dec / tot) * 100}%`, background: 'var(--bear)' }} />
          </div>
        </div>
        <Metric label="% > 50d" value={fmtPct(b.pct_above_50, 0)} />
        <Metric label="% > 200d" value={fmtPct(b.pct_above_200, 0)} />
        <Metric label="New highs" value={b.new_highs} tone="bull" />
        <Metric label="New lows" value={b.new_lows} tone="bear" />
        <div className="lbl-dim">{asOf}</div>
      </div>
    </Panel>
  )
}

function Metric({ label, value, tone }) {
  const c = tone === 'bull' ? 'var(--bull)' : tone === 'bear' ? 'var(--bear)' : 'var(--text)'
  return (
    <div style={{ textAlign: 'right', minWidth: 64 }}>
      <div className="lbl">{label}</div>
      <div className="num" style={{ color: c, marginTop: 2 }}>{value}</div>
    </div>
  )
}

function Heatmap({ heatmap, sectors, metric, onPick }) {
  if (!heatmap?.length) return <span className="lbl-dim">No data for this universe</span>
  const bySector = {}
  for (const t of heatmap) (bySector[t.sector] ||= []).push(t)
  const order = (sectors || []).map((s) => s.sector)
  const aggKey = metric === 'ret_1d' ? 'avg_1d' : 'avg_1m'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {order.map((sec) => {
        const tiles = (bySector[sec] || []).slice().sort((a, b) => (b[metric] || -99) - (a[metric] || -99))
        if (!tiles.length) return null
        const agg = (sectors || []).find((s) => s.sector === sec)
        return (
          <div key={sec}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
              <span className="lbl">{sec}</span>
              <span className="num lbl" style={{ color: (agg?.[aggKey] || 0) >= 0 ? 'var(--bull)' : 'var(--bear)' }}>
                {fmtPct(agg?.[aggKey])}
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
              {tiles.map((t) => (
                <div key={t.symbol} onClick={() => onPick(t.symbol)} title={`${t.symbol} ${fmtPct(t[metric])}`}
                  style={{
                    width: 62, height: 38, borderRadius: 3, cursor: 'pointer',
                    background: heatColor(t[metric]),
                    display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
                    border: '1px solid rgba(0,0,0,0.25)',
                  }}>
                  <span className="num" style={{ fontSize: 10.5, fontWeight: 600, color: '#fff' }}>{t.label || t.symbol}</span>
                  <span className="num" style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.85)' }}>{fmtPct(t[metric], 1)}</span>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function RegionMovers({ heatmap, onPick }) {
  const valid = (heatmap || []).filter((t) => t.ret_1d != null)
  const gainers = [...valid].sort((a, b) => b.ret_1d - a.ret_1d).slice(0, 10)
  const losers = [...valid].sort((a, b) => a.ret_1d - b.ret_1d).slice(0, 10)
  return (
    <>
      <SimpleMoverList title="Top gainers" rows={gainers} onPick={onPick} />
      <SimpleMoverList title="Top losers" rows={losers} onPick={onPick} />
    </>
  )
}

function SimpleMoverList({ title, rows, onPick }) {
  return (
    <Panel title={title} style={{ flexShrink: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {rows.map((r) => (
          <div key={r.symbol} onClick={() => onPick(r.symbol)}
            style={{ display: 'flex', justifyContent: 'space-between', cursor: 'pointer', gap: 8 }}>
            <span className="num" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label || r.symbol}</span>
            <span className="num" style={{ color: (r.ret_1d || 0) >= 0 ? 'var(--bull)' : 'var(--bear)', flexShrink: 0, whiteSpace: 'nowrap' }}>{fmtPct(r.ret_1d)}</span>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function MoverList({ title, rows, field, suffix = '', onPick }) {
  return (
    <Panel title={title} style={{ flexShrink: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {rows.slice(0, 8).map((r) => {
          const v = r[field]
          const isPct = field.startsWith('ret')
          const tone = isPct ? (v >= 0 ? 'var(--bull)' : 'var(--bear)') : 'var(--text)'
          return (
            <div key={r.symbol} onClick={() => onPick(r.symbol)}
              style={{ display: 'flex', justifyContent: 'space-between', cursor: 'pointer', gap: 8 }}>
              <span className="num" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.symbol}</span>
              <span className="num" style={{ color: tone, flexShrink: 0, whiteSpace: 'nowrap' }}>{isPct ? fmtPct(v) : `${v}${suffix}`}</span>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

function CrossList({ rows, onPick }) {
  return (
    <Panel title="MA50/200 crosses · 5d" style={{ flexShrink: 0 }}>
      {rows.length === 0 ? <span className="lbl-dim">none</span> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {rows.map((r) => (
            <div key={r.symbol} onClick={() => onPick(r.symbol)}
              style={{ display: 'flex', justifyContent: 'space-between', cursor: 'pointer', gap: 8 }}>
              <span className="num" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.symbol}</span>
              <span className="num" style={{ color: r.cross === 'golden' ? 'var(--bull)' : 'var(--bear)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                {r.cross}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}
