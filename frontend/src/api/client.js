// ============================================================
// api/client.js — all FastAPI calls in one place
// ============================================================

import axios from 'axios'

const api = axios.create({
  baseURL: 'http://localhost:8000',
  timeout: 30000,
})

// ── Macro / regime ───────────────────────────────────────────
export const fetchMacro = () => api.get('/macro').then(r => r.data)
export const fetchMacroExtended = () => api.get('/macro/extended').then(r => r.data)

// ── Market session (EU/US clock) ─────────────────────────────
export const fetchSession = () => api.get('/session').then(r => r.data)

// ── Single ticker (daily OHLCV + indicators + regime) ─────────
// `period` accepts 'max' for the instrument's entire history; that request can
// pull decades of bars on a cold cache, so it gets a longer timeout.
export const fetchTicker = (ticker, period = '1y') =>
  api.get(`/ticker/${ticker}`, {
    params: { period },
    timeout: period === 'max' || period === '10y' ? 180000 : 30000,
  }).then(r => r.data)

// ── Ticker search (over search.db — seeded universe + lookups) ─
export const searchTickers      = (q, limit = 10) => api.get('/tickers/search', { params: { q, limit } }).then(r => r.data.results)
export const fetchRecentTickers = (limit = 8)     => api.get('/tickers/recent', { params: { limit } }).then(r => r.data.results)
export const lookupTicker       = (symbol)        => api.post('/tickers/lookup', { symbol }).then(r => r.data.result)
export const selectTicker       = (symbol)        => api.post('/tickers/select', { symbol }).then(r => r.data).catch(() => null) // fire-and-forget

// ── Cache diagnostics ────────────────────────────────────────
export const fetchCacheStatus = () => api.get('/cache/status').then(r => r.data)

// ── Dashboard surfaces (backend endpoints land in later steps) ─
// These resolve once services/overview.py, etf_monitor.py, intraday.py,
// options.py + the extended /macro are implemented. Until then they 404 and
// the pages render their "endpoint pending" state.
export const fetchOverview   = ()        => api.get('/overview', { timeout: 120000 }).then(r => r.data)
export const fetchEtfMonitor = ()        => api.get('/etf-monitor', { timeout: 120000 }).then(r => r.data)
export const fetchVol        = ()        => api.get('/vol', { timeout: 120000 }).then(r => r.data)
export const fetchVolProbe   = ()        => api.get('/vol/probe').then(r => r.data)
// Single-name implied vol needs one option chain per basket name — slow, so the
// Volatility page loads it separately and fills the panel in when it lands.
export const fetchVolSingleName = ()     => api.get('/vol/single-name', { timeout: 180000 }).then(r => r.data)
export const fetchEurope     = ()        => api.get('/europe', { timeout: 120000 }).then(r => r.data)
export const fetchCommodities = ()       => api.get('/commodities', { timeout: 120000 }).then(r => r.data)
export const fetchCot         = ()       => api.get('/cot', { timeout: 120000 }).then(r => r.data)
export const fetchSentiment   = ()       => api.get('/sentiment', { timeout: 120000 }).then(r => r.data)
export const fetchIntraday   = (ticker, interval = '5m', days = 1) =>
  api.get(`/intraday/${ticker}`, { params: { interval, days } }).then(r => r.data)
export const fetchOptions    = (ticker)  => api.get(`/options/${ticker}`).then(r => r.data)
export const fetchAnalysis   = (ticker)  => api.get(`/analysis/${ticker}`).then(r => r.data)
export const fetchScreener   = ()        => api.get('/screener', { timeout: 120000 }).then(r => r.data)
export const fetchFundamentals = (ticker) => api.get(`/fundamentals/${ticker}`, { timeout: 60000 }).then(r => r.data)
export const fetchWatchlist       = ()        => api.get('/watchlist').then(r => r.data)
export const addWatchlist         = (symbol, label, group) => api.post('/watchlist', { symbol, label, group }).then(r => r.data)
export const removeWatchlist      = (symbol)  => api.delete(`/watchlist/${symbol}`).then(r => r.data)
export const fetchWatchlistQuotes = ()        => api.get('/watchlist/quotes', { timeout: 60000 }).then(r => r.data)
export const fetchNews            = (hours)   => api.get('/news', { params: hours ? { hours } : {}, timeout: 120000 }).then(r => r.data)
export const fetchTickerNews      = (ticker)  => api.get(`/news/${ticker}`, { timeout: 60000 }).then(r => r.data)

export default api
