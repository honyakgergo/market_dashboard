// ============================================================
// App.jsx — shell: top bar (brand · nav · search) + active surface
// ============================================================

import React from 'react'
import { useStore, PAGES } from './store/useStore'
import TickerSearch from './components/TickerSearch'
import Overview from './pages/Overview'
import Ideas from './pages/Ideas'
import News from './pages/News'
import EtfMonitor from './pages/EtfMonitor'
import MacroRegime from './pages/MacroRegime'
import Volatility from './pages/Volatility'
import Europe from './pages/Europe'
import Commodities from './pages/Commodities'
import Positioning from './pages/Positioning'
import TickerDetail from './pages/TickerDetail'

const NAV = [
  { key: PAGES.OVERVIEW, label: 'Overview' },
  { key: PAGES.IDEAS,    label: 'Ideas' },
  { key: PAGES.ETF,      label: 'Cross-Asset' },
  { key: PAGES.MACRO,    label: 'Macro & Regime' },
  { key: PAGES.VOL,      label: 'Volatility' },
  { key: PAGES.EUROPE,   label: 'Europe' },
  { key: PAGES.COMMOD,   label: 'Commodities' },
  { key: PAGES.POS,      label: 'Positioning' },
  { key: PAGES.NEWS,     label: 'News' },
  { key: PAGES.TICKER,   label: 'Ticker' },
]

export default function App() {
  const page = useStore((s) => s.page)
  const setPage = useStore((s) => s.setPage)

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* top bar */}
      <header style={{
        height: 48, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 18,
        padding: '0 14px', borderBottom: '1px solid var(--border)', background: 'var(--surface)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)' }} />
          <span className="num" style={{ fontWeight: 600, letterSpacing: '0.02em' }}>money_dashboard</span>
        </div>

        <nav style={{ display: 'flex', gap: 2 }}>
          {NAV.map((n) => (
            <button key={n.key} onClick={() => setPage(n.key)}
              style={{
                padding: '6px 12px', borderRadius: 4, fontSize: 12.5,
                color: page === n.key ? 'var(--text)' : 'var(--text-muted)',
                background: page === n.key ? 'var(--elevated)' : 'transparent',
              }}>{n.label}</button>
          ))}
        </nav>

        <div style={{ marginLeft: 'auto' }}><TickerSearch /></div>
      </header>

      {/* surface */}
      <main style={{ flex: 1, minHeight: 0, padding: 12, overflow: 'hidden' }}>
        {page === PAGES.OVERVIEW && <Overview />}
        {page === PAGES.IDEAS && <Ideas />}
        {page === PAGES.ETF && <EtfMonitor />}
        {page === PAGES.MACRO && <MacroRegime />}
        {page === PAGES.VOL && <Volatility />}
        {page === PAGES.EUROPE && <Europe />}
        {page === PAGES.COMMOD && <Commodities />}
        {page === PAGES.POS && <Positioning />}
        {page === PAGES.NEWS && <News />}
        {page === PAGES.TICKER && <TickerDetail />}
      </main>
    </div>
  )
}
