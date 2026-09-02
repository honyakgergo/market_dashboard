// ============================================================
// pages/Ideas.jsx
// "Ideas & Movers" — a discovery surface over Yahoo's predefined screeners
// (gainers / losers / most-active / undervalued large caps / growth tech /
// aggressive small caps). Each screen is a compact, clickable list; click a
// row to jump to that name's Ticker Detail. US-region data, ~5-min refresh.
// ============================================================

import React from 'react'
import { fetchScreener } from '../api/client'
import { useStore } from '../store/useStore'
import { useFetch, StateView, Panel, fmtPct, fmtNum, useSession, useAutoRefresh, SessionBanner } from '../components/ui'

const fmtCap = (n) => {
  if (n == null) return ''
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`
  return `${n}`
}

export default function Ideas() {
  const { data, loading, error, reload } = useFetch(fetchScreener, [])
  const session = useSession()
  useAutoRefresh(reload, session?.us_open, 120000)
  const openTicker = useStore((s) => s.openTicker)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 10 }}>
      <SessionBanner session={session} market="us" />
      <StateView loading={loading} error={error} empty={!loading && !error && !data}>
        {data && (
          <>
            {data.error && (
              <Panel style={{ flexShrink: 0 }}>
                <span className="lbl-dim" style={{ textTransform: 'none', lineHeight: 1.5 }}>{data.error}</span>
              </Panel>
            )}

            <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 10 }}>
              {(data.sections || []).map((s) => (
                <ScreenPanel key={s.key} section={s} onPick={openTicker} />
              ))}
            </div>
          </>
        )}
      </StateView>
    </div>
  )
}

function ScreenPanel({ section, onPick }) {
  const rows = section.rows || []
  return (
    <Panel
      title={section.label}
      right={<span className="lbl-dim" style={{ fontSize: 10, textTransform: 'none' }}>{section.blurb}</span>}
      style={{ flex: 1, minWidth: 0, height: '100%' }}
      bodyStyle={{ overflowY: 'auto', padding: '2px 12px 10px' }}
    >
      {rows.length === 0 ? (
        <span className="lbl-dim">no results</span>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {rows.map((r, i) => (
            <div key={r.symbol} onClick={() => onPick(r.symbol)} title={r.name || r.symbol}
              style={{
                display: 'flex', justifyContent: 'space-between', gap: 10, cursor: 'pointer',
                padding: '6px 0', borderTop: i ? '1px solid var(--hairline)' : 'none',
              }}>
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span className="num">{r.symbol}</span>
                {r.name && (
                  <span className="lbl-dim" style={{
                    fontSize: 10, textTransform: 'none', letterSpacing: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{r.name}</span>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 }}>
                <span className="num" style={{ color: (r.change_pct || 0) >= 0 ? 'var(--bull)' : 'var(--bear)' }}>
                  {fmtPct(r.change_pct)}
                </span>
                <span className="lbl-dim" style={{ fontSize: 10 }}>
                  {fmtNum(r.price)}{r.market_cap ? ` · ${fmtCap(r.market_cap)}` : ''}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}
