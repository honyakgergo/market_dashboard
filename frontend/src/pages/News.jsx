// ============================================================
// pages/News.jsx
// Watchlist-driven news. Left rail = editable watchlist (Holdings / Macro)
// with a live price strip; click a name to filter. Right = a unified,
// newest-first headline feed (deduped across the watchlist), each card
// linking out to the source. Time-window tabs filter client-side.
// ============================================================

import React from 'react'
import { fetchWatchlist, addWatchlist, removeWatchlist, fetchWatchlistQuotes, fetchNews } from '../api/client'
import { useStore } from '../store/useStore'
import { useFetch, StateView, Panel, fmtPct, fmtNum } from '../components/ui'

const HOURS = [['24h', 24], ['48h', 48], ['7d', 168], ['All', null]]

function ago(ts) {
  if (!ts) return ''
  const s = Math.max(0, Date.now() / 1000 - ts)
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export default function News() {
  const wl = useFetch(fetchWatchlist, [])
  const quotes = useFetch(fetchWatchlistQuotes, [])
  const news = useFetch(fetchNews, [])
  const [selected, setSelected] = React.useState(null)   // symbol filter
  const [win, setWin] = React.useState(48)               // hours window

  const items = news.data?.items || []
  const cutoff = win ? Date.now() / 1000 - win * 3600 : 0
  const shown = items.filter((i) =>
    (!selected || (i.tickers || []).some((t) => t.symbol === selected)) &&
    (!win || (i.published || 0) >= cutoff)
  )

  const refreshAll = () => { wl.reload(); quotes.reload(); news.reload() }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 10 }}>
      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '260px 1fr', gap: 10 }}>
        <WatchlistRail
          data={wl.data} loading={wl.loading} quotes={quotes.data?.quotes || {}}
          selected={selected} onSelect={(s) => setSelected((cur) => (cur === s ? null : s))}
          onChanged={refreshAll}
        />

        <Panel
          title={selected ? `News · ${selected}` : 'News · watchlist'}
          right={
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {selected && (
                <button onClick={() => setSelected(null)} className="news-tab">clear ×</button>
              )}
              {HOURS.map(([lbl, h]) => (
                <button key={lbl} onClick={() => setWin(h)} className={`news-tab${win === h ? ' on' : ''}`}>{lbl}</button>
              ))}
            </div>
          }
          bodyStyle={{ overflowY: 'auto', padding: '6px 8px 10px' }}
        >
          <StateView loading={news.loading} error={news.error}
            empty={!news.loading && !news.error && shown.length === 0}
            emptyHint={selected ? `No recent headlines for ${selected} in this window.` : 'No headlines in this window — widen it or add symbols.'}>
            <NewsFeed items={shown} onTag={setSelected} />
          </StateView>
        </Panel>
      </div>
    </div>
  )
}

function Chips({ item, onTag, style }) {
  if (!item.tickers?.length) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, ...style }}>
      {item.tickers.map((t) => (
        <button key={t.symbol} className="chip"
          onClick={(e) => { e.stopPropagation(); onTag(t.symbol) }}>{t.symbol}</button>
      ))}
    </div>
  )
}

const hideImg = (e) => { e.currentTarget.style.visibility = 'hidden' }

function NewsFeed({ items, onTag }) {
  // lead story gets the big hero treatment (only if it has an image)
  const hero = items[0]?.thumbnail ? items[0] : null
  const rest = hero ? items.slice(1) : items
  return (
    <div className="news-grid">
      {hero && (
        <div className="nhero" onClick={() => window.open(hero.url, '_blank', 'noopener')}>
          <div className="nhero-imgwrap">
            <img className="nhero-img" src={hero.thumbnail} alt="" loading="lazy" onError={hideImg} />
          </div>
          <div className="nhero-body">
            <div className="ncard-cap">{hero.publisher || 'source'}<span className="t"> · {ago(hero.published)}</span></div>
            <div className="nhero-title">{hero.title}</div>
            {hero.summary && <div className="nhero-sum">{hero.summary}</div>}
            <Chips item={hero} onTag={onTag} style={{ marginTop: 12 }} />
          </div>
        </div>
      )}
      {rest.map((it) => (
        <div key={it.id} className="ncard" onClick={() => window.open(it.url, '_blank', 'noopener')}>
          {it.thumbnail && (
            <div className="ncard-imgwrap">
              <img className="ncard-img" src={it.thumbnail} alt="" loading="lazy" onError={hideImg} />
            </div>
          )}
          <div className="ncard-body">
            <div className="ncard-cap">{it.publisher || 'source'}<span className="t"> · {ago(it.published)}</span></div>
            <div className="ncard-title">{it.title}</div>
            {it.summary && <div className="ncard-sum">{it.summary}</div>}
            <Chips item={it} onTag={onTag} style={{ marginTop: 'auto', paddingTop: 10 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function WatchlistRail({ data, loading, quotes, selected, onSelect, onChanged }) {
  const [sym, setSym] = React.useState('')
  const [grp, setGrp] = React.useState('Holdings')
  const [busy, setBusy] = React.useState(false)
  const openTicker = useStore((s) => s.openTicker)

  const items = data?.items || []
  const groups = ['Holdings', 'Macro']
  const byGroup = groups.map((g) => [g, items.filter((i) => i.group === g)]).filter(([, v]) => v.length)
  // any custom groups the user may have added
  const others = items.filter((i) => !groups.includes(i.group))
  if (others.length) byGroup.push(['Other', others])

  const add = async () => {
    const s = sym.trim().toUpperCase()
    if (!s || busy) return
    setBusy(true)
    try { await addWatchlist(s, null, grp); setSym(''); onChanged() }
    finally { setBusy(false) }
  }
  const remove = async (s) => { await removeWatchlist(s); if (selected === s) onSelect(s); onChanged() }

  return (
    <Panel title="Watchlist" bodyStyle={{ overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      <StateView loading={loading} error={null} empty={!loading && items.length === 0} emptyHint="Add a symbol below.">
        <div style={{ flex: 1 }}>
          {byGroup.map(([g, rows]) => (
            <div key={g} style={{ marginBottom: 14 }}>
              <div className="lbl" style={{ marginBottom: 6, marginTop: 2 }}>{g}</div>
              {rows.map((r) => {
                const q = quotes[r.symbol]
                const on = selected === r.symbol
                return (
                  <div key={r.symbol} onClick={() => onSelect(r.symbol)} className={`wl-row${on ? ' sel' : ''}`}>
                    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                      <span className="num" style={{ fontSize: 12 }}>{r.symbol}</span>
                      {r.label !== r.symbol && (
                        <span className="lbl-dim" style={{ fontSize: 9, textTransform: 'none', letterSpacing: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 }}>
                      {q && <span className="num" style={{ fontSize: 11 }}>{fmtNum(q.price)}</span>}
                      {q && q.change_pct != null && (
                        <span className="num" style={{ fontSize: 9.5, color: q.change_pct >= 0 ? 'var(--bull)' : 'var(--bear)' }}>{fmtPct(q.change_pct)}</span>
                      )}
                    </div>
                    <button title="open chart" className="wl-act go" onClick={(e) => { e.stopPropagation(); openTicker(r.symbol) }}>↗</button>
                    <button title="remove" className="wl-act x" onClick={(e) => { e.stopPropagation(); remove(r.symbol) }}>×</button>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </StateView>

      <div style={{ borderTop: '1px solid var(--hairline)', paddingTop: 8, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input value={sym} onChange={(e) => setSym(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="add symbol…"
          className="num"
          style={{ background: 'var(--elevated)', border: '1px solid var(--hairline)', borderRadius: 4, color: 'var(--text)', padding: '5px 7px', fontSize: 11, outline: 'none' }} />
        <div style={{ display: 'flex', gap: 6 }}>
          <select value={grp} onChange={(e) => setGrp(e.target.value)} className="num"
            style={{ flex: 1, background: 'var(--elevated)', border: '1px solid var(--hairline)', borderRadius: 4, color: 'var(--text-muted)', padding: '4px 6px', fontSize: 10.5, outline: 'none' }}>
            <option>Holdings</option>
            <option>Macro</option>
          </select>
          <button onClick={add} disabled={busy} className="num"
            style={{ background: 'var(--elevated)', border: '1px solid var(--border-strong)', borderRadius: 4, color: 'var(--text)', padding: '4px 12px', fontSize: 10.5, cursor: 'pointer' }}>
            {busy ? '…' : 'add'}
          </button>
        </div>
      </div>
    </Panel>
  )
}
