# money_dashboard — progress & architecture notes

> Working memory for this project. Read this first before making changes — it
> captures how the pieces fit together, the non-obvious gotchas, and what's
> been done recently. Keep it updated at the end of each working session.

Last updated: **2026-08-04**

---

## 1. What this is

A **live market-analytics terminal** (not a backtester — that's the separate
`swinglab` project). TradingView-style dark terminal aesthetic, IBM Plex Mono,
~15-minute-delayed data that is always labelled, driven by an EU/US
market-session clock. It's a deliberate CV/portfolio deliverable.

- Backend: **FastAPI** (`backend/`), Python.
- Frontend: **React + Vite** (`frontend/`), Zustand for state, Plotly.js for charts.
- Data: **yfinance** (sole price source) + **FRED** (macro series yfinance can't
  supply). **SQLite** for caching.

Run locally:
```bash
# backend
cd backend && uvicorn main:app --reload --port 8000
# frontend
cd frontend && npm run dev        # Vite dev server on :5173 (CORS-allowed in main.py)
```

---

## 2. Backend architecture

`main.py` is a thin FastAPI layer: each dashboard surface is **one endpoint**
that calls a `build_*()` function in `services/`. Pattern is consistent —
routes stay dumb, logic + caching live in the service module.

### Services (`backend/services/`)
| module | builds | notes |
|---|---|---|
| `data.py` | OHLCV fetch + `cache.db` | **All `yf.download` calls go through `_yf_lock`** (yfinance is not thread-safe). Has a flag-and-keep data-quality layer (`_validate_fetched_data`) with per-ticker price floors/ceilings. Silences yfinance's own `logging.getLogger("yfinance")` to CRITICAL so "possibly delisted" noise doesn't spam the console. |
| `indicators.py` | MA50/200, Bollinger, RSI, ATR, z-score, autocorr | |
| `regime.py` | Bull/Bear/Sideways regime | |
| `macro.py` | composite macro score + FRED extended series | `MACRO_TICKERS`, `fred_status()`. Aware of April 2026 BAML credit-series licensing truncation. |
| `overview.py` | sector heatmap / breadth / movers | `_bulk_snapshot()` batched intraday, reused by etf_monitor. US/Europe/Commodities heatmap universe switch. |
| `etf_monitor.py` | **Cross-Asset** page | rebased perf, rolling-corr matrix, return matrix, RRG, efficiency-ratio trending/reverting, risk-appetite gauge. `CROSS_ASSET` = 14 representative tickers. |
| `volatility.py` | VIX term structure, VVIX/SKEW/VRP, dispersion/correlation | `^RVX` delisted on Yahoo → proxied via IWM realized vol. |
| `europe.py` | EU indices, EU realized-vol gauge, FX, EU sector ETFs | `^V2TX` (VSTOXX) 404s on Yahoo → EU realized-vol used instead. `SECTOR_NAMES` static map for iShares STOXX 600 sector ETFs (EXV1-7.DE, EXH1-9.DE), pinned after feed verification. EU indices/sectors fetched live + memoized (not in warm cache). |
| `commodities.py` | commodities perf, cross-asset ratios, return matrix | `INSTRUMENTS` uses continuous futures (`CL=F`, `BZ=F`, `NG=F`, `GC=F`, `SI=F`, `HG=F`) + `IEF`/`TLT`/`BTC-USD`. `RATIOS`: gold/silver, copper/gold, gold/oil, gold/BTC. Live-fetched + memoized. |
| `positioning` → `cot.py` + `sentiment.py` | CFTC COT (financial + commodities), NAAIM, AAII | AAII/NAAIM parse: **labels live in cells, not headers** → content-based detection. `sentiment.db` accumulates NAAIM. |
| `options.py` | options-as-indicator panel | ATM IV, IV rank/percentile, P/C, 25Δ skew/RR, approx GEX. `options_iv.db` builds IV history over time. |
| `analysis.py` | **(new, 2026-08-04)** analyst & fundamentals for Ticker Detail | `build_analysis(t)` → consensus (`recommendations`), price targets (`analyst_price_targets`), earnings surprise (`earnings_dates`, computed from est vs actual), short interest + profile (`info`). Every block optional (None when Yahoo lacks coverage). 30-min memo, all under `_yf_lock`. |
| `screener.py` | **(new, 2026-08-04)** Ideas & Movers page | `build_screener()` runs Yahoo predefined screens via `yf.screen(key, count=)` — `day_gainers`, `day_losers`, `most_actives`, `undervalued_large_caps`, `growth_technology_stocks`, `aggressive_small_caps`. 5-min memo; degrades gracefully if `yf.screen` is missing (old yfinance). |
| `fundamentals.py` | **(new, 2026-08-04)** Ticker → Fundamentals mode | `build_fundamentals(t)` → income statement (annual+quarterly: revenue/net income/EPS), core valuation multiples (P/E, fwd P/E, P/S, EV/EBITDA, PEG, div yield) each with a **percentile vs its own 5y history**, and a trailing-P/E band (mean/σ). Deep history from **EDGAR** (revenue/EPS quarterly+annual) with yfinance as fallback; P/E band from `get_valuation_measures(freq='monthly')` or reconstructed from EDGAR TTM-EPS ÷ price. 12h memo. |
| `edgar.py` | **(new, 2026-08-04)** SEC EDGAR XBRL client | `cik_for()` (ticker→CIK via company_tickers.json) + companyconcept fetch. **Duration-based** extraction (~90d=quarter, ~365d=year), deduped by latest filing; the missing Q4 of each fiscal year is reconstructed as annual − (3 reported quarters in that window). Gives deep revenue/EPS/net-income history Yahoo can't (US filers only). Requires a descriptive `SEC_UA`. Independent of `_yf_lock`. |
| `watchlist.py` | **(new, 2026-08-04)** persisted watchlist for News page | SQLite `watchlist.db` (symbol/label/group/sort). Self-seeds Holdings (AAPL/MSFT/NVDA) + Macro ETF proxies (GLD/SLV/USO/TLT). CRUD + `get_quotes()` bulk last-price/%chg (60s cache) for the price strip. |
| `news.py` | **(new, 2026-08-04)** headline aggregation | Per-symbol `Ticker.news` (STORY only), schema-normalized (nested `content` + legacy flat), deduped across the watchlist by URL (ticker tags merged), newest-first. 15-min per-symbol cache. |
| `intraday.py` | on-demand intraday bars + session VWAP | ephemeral, not cached to disk. |
| `session.py` | `market_session()` — EU/US clock | drives every live page's auto-refresh + freshness banner. |
| `ticker_search.py` | search over `search.db` | ranked symbol/name search, recent list, `lookup_and_add` for unknown symbols. |
| `universe.py` | ticker universe for the cache warmer | `get_warm_universe()` = seeded equities ∪ macro ∪ FX ∪ EXTRA_TICKERS. `get_equity_universe()` excludes `is_seed=2` (search-only extras) so the warmer doesn't hammer them. |
| `extra_universe.py` | **(new, 2026-08-04)** augments `search.db` | curated non-equity symbols, marked `is_seed=2` = searchable but NOT warmed. See §5. |
| `cache_warmer.py` | 2y warm on startup + 6h background refresh | |
| `validate.py` | `classify()` symbol→category | |

### Databases (all gitignored, created locally)
- `cache.db` — OHLCV price cache (the warm store).
- `search.db` — **search index only** (metadata for the ticker search box; NOT prices).
  Built by `seed_tickers.py` from `data/sp500_seed.csv` + `data/etf_seed.csv`,
  then augmented on every boot by `extra_universe.ensure_extra_seeded()`.
- `sentiment.db` — accumulated NAAIM/AAII.
- `options_iv.db` — accumulated ATM IV history for IV rank/percentile.

### Endpoints
`/session` `/overview` `/etf-monitor` `/macro` `/macro/extended` `/vol`
`/europe` `/commodities` `/cot` `/sentiment` `/options/{t}` `/intraday/{t}`
`/ticker/{t}` `/analysis/{t}` `/screener` `/fundamentals/{t}` `/watchlist` `/watchlist/quotes` `/news` `/news/{t}` `/tickers/search` `/tickers/recent` `/tickers/lookup`
`/tickers/select` `/tickers/stats` `/cache*`. Most take `?force=true`.

---

## 3. Frontend architecture

`src/App.jsx` — shell: top bar (brand · nav · `TickerSearch`) + active page.
Pages switch via the Zustand store (`src/store/useStore.js`, `PAGES` enum).

### Pages (`src/pages/`) → nav label
- `Overview.jsx` → Overview
- `Ideas.jsx` → **Ideas** (new 2026-08-04 — Yahoo-screener discovery surface)
- `News.jsx` → **News** (new 2026-08-04 — watchlist + aggregated headline feed)
- `EtfMonitor.jsx` → **Cross-Asset** (⚠️ file name ≠ nav label)
- `MacroRegime.jsx` → Macro & Regime
- `Volatility.jsx` → Volatility
- `Europe.jsx` → Europe
- `Commodities.jsx` → Commodities
- `Positioning.jsx` → Positioning
- `TickerDetail.jsx` → Ticker (three modes: **Daily / Intraday / Fundamentals**;
  Fundamentals = revenue+net-income bars w/ price overlay, lean valuation panel
  with percentile-vs-own-history, trailing-P/E band)

### Shared components (`src/components/`)
- `ui.jsx` — `Panel`, `Pill`, `StateView`, `useFetch`, `useSession`,
  `useAutoRefresh`, `SessionBanner`, formatters (`fmtPct`, `fmtNum`, `toneOf`, …).
- `CandleChart.jsx` — TradingView-style price/volume/RSI 3-pane chart with
  MA/BB/regime overlays, pinned OHLC legend, **click-to-set-entry / right-click-to-clear**,
  and an optional **analyst price-target rail** (`priceTargets={low,mean,high}` → faint
  band + dashed mean line + edge label; drawn only when supplied).
- `TickerSearch.jsx` — ⌘K command palette. Debounced search against
  `/tickers/search`; on no match, Enter triggers `/tickers/lookup` (live yfinance add).

### Charts
All charts are **Plotly.js** (`plotly.js-dist-min`), created imperatively in a
`useEffect` with `Plotly.react(...)` and torn down with `Plotly.purge` on unmount.
`paper_bgcolor`/`plot_bgcolor` are transparent so the panel surface shows through.

### Design tokens (`src/styles/globals.css`)
Locked TradingView palette. Variable **names** are inherited from SwingLab so
copied components keep working; **values** are the dashboard's own.
- bg `#131722` · surface `#1e222d` · elevated `#252a37`
- border `#2a2e39` · border-strong `#363b48` · hairline `#1c212c`
- text `#d1d4dc` · muted `#787b86` · dim `#5a5d68`
- accent `#2962ff` (TV blue) · bull `#089981` · bear `#f23645` · side `#e0a23a`
- **crosshair / zeroline grey: `#4a4f5c`** (see §4)

---

## 4. Chart conventions & gotchas

- **Crosshair spikes** are standardised to a single **thin SOLID `#4a4f5c`** line
  per axis (`spikethickness:1, spikedash:'solid', spikemode:'across', spikesnap:'cursor'`).
  Dashed spikes read as a broken/haloed "margin", so we don't use them.
- **Multi-line perf charts hover with `hovermode:'closest'`**, NOT `'x unified'` —
  hovering a line shows only that series' tooltip. Each trace carries its own
  `hovertemplate` (`"<label>  +x.xx%"` / `"…σ"`). Applies to Cross-Asset and
  Commodities perf charts.
- **Plotly flex-layout collapse**: panels with `minHeight:0` as *direct* flex
  children shrink to zero. Fix = outer scroll wrapper + natural-height inner
  column (used across the vol/cross-asset cockpits).
- `1D` intraday only lights up when the US market is open; otherwise the perf
  charts show a "use 1W or longer" note.

### Known Yahoo quirks
- `^RVX` delisted → IWM realized-vol proxy.
- `^V2TX` (VSTOXX) 404 → EU realized-vol gauge (`europe.py`).
- FRED BAML credit series truncated (April 2026 licensing change) — handled in `macro.py`.
- `EURUSD=X`, `^IRX` are low-absolute-price → whitelisted in `data._validate_fetched_data`.

---

## 5. Ticker search universe — how it's seeded

Two layers, both idempotent-friendly:

1. **CSV seed** (`data/sp500_seed.csv` + `data/etf_seed.csv`) → built into
   `search.db` by `seed_tickers.py`. `ensure_seeded()` runs on startup but
   **only if the table is empty** — so editing the CSVs after first run has NO
   effect without a manual `python seed_tickers.py` (which does a destructive
   `reseed()` and wipes `last_accessed`).

2. **`extra_universe.py`** (added 2026-08-04) → `ensure_extra_seeded()` runs on
   **every** startup and upserts the non-equity names the CSVs never covered
   (**commodity futures, EU indices, EU sector ETFs, major EU single stocks, FX
   pairs, the dollar index, extra crypto, and the vol/rates complex**). These
   rows are marked **`is_seed=2` = "searchable but NOT warmed"**: they appear in
   search and open on demand in Ticker Detail (live `fetch_ohlcv`), but
   `universe.get_equity_universe()` filters them out of the cache-warmer set so
   the warm job doesn't hammer ~90 extra names (slow + "possibly delisted"
   noise). Existing rows / recency are never disturbed.

**To add more searchable names**: append to `_ROWS` (or `_EU_SECTORS`) in
`extra_universe.py` and restart the backend. No reseed, no CSV edit needed.
Keep `_EU_SECTORS` in sync with `europe.py::SECTOR_NAMES`.

---

## 6. Conventions / working preferences

- **Complete, pasteable files** over fragments/diffs where practical.
- Backend: thin routes, `build_*()` in services, cache in the service module.
- **Decision-first**: commit to a design; only flag genuine blockers.
- Skepticism on intermediate results is valid — engage with it.

---

## 7. Changelog

### 2026-08-04 (pass 7) — News page + watchlist
1. **Watchlist** (`services/watchlist.py` → `watchlist.db`, self-seeding). CRUD
   endpoints `/watchlist` (GET/POST/DELETE) + `/watchlist/quotes` (bulk
   last-price/%chg strip). Groups: Holdings + Macro (gold/silver/oil/treasuries
   via ETF proxies GLD/SLV/USO/TLT — futures carry no news).
2. **News aggregation** (`services/news.py` → `/news`, `/news/{t}`). Pulls
   `Ticker.news` per watchlist symbol (STORY only), normalizes the nested
   `content` schema (+ legacy flat), dedupes across symbols by URL with merged
   ticker tags, newest-first. 15-min per-symbol cache.
3. **News page** (`pages/News.jsx`, `PAGES.NEWS`, nav before Ticker). Left rail
   = editable watchlist with live price strip, click-to-filter, add/remove, ↗
   to open the chart. Right = unified feed; cards show publisher · relative
   time · headline (links to source) · 2-line summary · ticker chips (click to
   filter). Time-window tabs (24h/48h/7d/All) filter client-side.
   - *Caveat:* `.news` can drift to generic market news for thin/foreign
     tickers; macro uses ETF proxies for relevance. Inline = headline+summary;
     full article is a link-out (publisher copyright).

### 2026-08-04 (pass 6) — EDGAR deep history + Fundamentals restyle
1. **SEC EDGAR integration** (`services/edgar.py`). Fundamentals now pull deep
   quarterly+annual **revenue / EPS / net income** from EDGAR's XBRL
   companyconcept API. Duration-based extraction (not calendar frames) + the
   missing Q4-per-year reconstructed as annual − (Q1+Q2+Q3), so quarterly bars
   are continuous. yfinance remains the fallback when EDGAR has no CIK / no data
   (non-US names). Needs a descriptive `SEC_UA` (SEC requires it; edit the
   contact string if throttled).
2. **P/E band reconstruction.** When `get_valuation_measures` is empty (older
   yfinance / uncovered), the band is rebuilt from EDGAR TTM-EPS ÷ monthly
   price — fixes the "P/E history unavailable" case for US names.
3. **Overlay restyled to reference.** Green revenue bars (left $B axis) + orange
   price line (right $ axis) + a Latest/Min/Max/CAGR/Total-chg stat strip.
   Dropped the net-income bars from this chart to keep it clean; quarterly view
   now shows ~20 bars (EDGAR) instead of ~5.
4. **Target-price rail now defaults OFF** on the Ticker chart (`showTargets`
   initial state false); still toggled by the "Tgt" chip.

### 2026-08-04 (pass 5) — Fundamentals view on the Ticker page
1. **New `services/fundamentals.py` → `/fundamentals/{t}`** + `fetchFundamentals`.
   Income statement (annual+quarterly), core valuation multiples each with a
   **percentile vs their own 5y range**, and a trailing-P/E band. Powered by
   `get_valuation_measures(freq='monthly')` (the multiple *history*, since plain
   `.info` only gives current) + `income_stmt`/`quarterly_income_stmt`.
2. **Ticker page gained a third mode: Fundamentals** (`TickerDetail.jsx`
   `FundamentalsView`). Revenue + net-income bars (annual↔quarterly toggle,
   default annual) with the **5y price line overlaid** (dual axis); a lean
   **Valuation** panel (P/E, fwd P/E, P/S, EV/EBITDA, PEG, div yield — each with
   a cheap/mid/rich percentile marker); and a **P/E-vs-own-5y-history** band
   chart (P/E line + mean ±σ). Deliberately kept sparse — no ratio dump.
   Renders an empty note for ETFs/indices/futures/most EU names.
   - *Data caveat:* Yahoo serves only ~4 annual / ~5 quarterly statement
     periods, so the bars are few over a 5y window; the monthly valuation-
     measures history is the longer series.

### 2026-08-04 (pass 4) — timeframe tabs on Europe sectors + Commodities ratios
1. **Europe sector tabs (1D…1Y).** `/europe` now returns each sector ETF's full
   ~1y daily series (`dates` + `closes`) instead of a fixed 180-day rebased
   curve; `_daily()` fetch extended 220→420 days / `6mo`→`1y`. `Europe.jsx`
   gained a `PeriodTabs` control + `sliceSectors()` that rebases and ranks
   client-side, so clicking a period instantly re-windows **both** the rebased
   chart and the sector-ranking panel (no refetch). Default 6M.
2. **Europe sector-chart hover** switched `x unified`→`closest` (+ clean spikes)
   so only the hovered line shows — matching Cross-Asset & Commodities.
3. **Commodities ratio cards now follow the timeframe toggle.** The hero perf
   chart already had the 1D…1Y toggle; the four ratio charts ignored it. They
   now re-window to the selected `tf` (client-side slice of their full series)
   and report that window's return in the header (was always "1m"). Panel title
   shows the active window. Ratio hover also moved to `closest` + spikes.

### 2026-08-04 (pass 3) — Ideas page + Ticker-panel polish
1. **Ideas & Movers page** (new). `services/screener.py` → `/screener`,
   `fetchScreener`, `pages/Ideas.jsx`, wired into `PAGES.IDEAS` + `App` nav
   (second slot, after Overview). Six Yahoo predefined screens rendered as a
   responsive grid of compact, clickable lists (row → `openTicker`): gainers,
   losers, most-active, undervalued large caps, growth tech, aggressive small
   caps. `change_pct` normalised to a fraction server-side so `fmtPct` works.
   Graceful notice if `yf.screen` is unavailable or Yahoo returns nothing.
2. **Price-target rail is now toggleable** — new "Tgt" chip in the Ticker
   toolbar (next to BB); when off, `priceTargets` isn't passed to `CandleChart`.
3. **Removed the empty "Entry analysis" placeholder.** The panel (and its
   "click any candle…" prompt) no longer renders until a real entry→exit/latest
   window exists — the chart panel's own title still advertises the interaction.
   The analyzer itself is unchanged.
4. **Analyst panel readability pass.** Blocks now separated by hairline
   dividers; **price target** redesigned as a low–high **range bar** with
   current + mean markers and a big mean number (was a cramped 3-across row);
   **earnings** switched to clean `Stat` rows (no more mid-date line-wrap);
   profile footer de-uppercased. Empty-panel-for-ETFs bug (SPY showed a bare
   header) fixed — `available` / render guard now require real analyst content,
   not just a company name.

### 2026-08-04 (pass 2) — analyst feature + error-spam & overflow fixes
1. **Analyst & fundamentals panel** on Ticker Detail (new `services/analysis.py`
   → `/analysis/{t}`, `api/client.fetchAnalysis`, `AnalystPanel` in
   `TickerDetail.jsx`). Shows: analyst **consensus** (colored label + 5-segment
   strong-buy…strong-sell bar + improving/softening drift), **price targets**
   (low/mean/high + implied upside), **earnings** (next date + last EPS surprise,
   computed from est vs actual), **short interest** (% float, days-to-cover, MoM),
   and a sector/industry/market-cap footer. Each block renders only if Yahoo has
   the data, so the whole panel is absent for ETFs/futures/crypto/most EU names.
2. **Price-target rail on the candle chart** — `CandleChart` gained an optional
   `priceTargets` prop drawing a faint low–high band + dashed mean line + edge
   label. Purely additive.
3. **Killed the "possibly delisted" console spam.** (a) `data.py` sets the
   yfinance logger to CRITICAL (those warnings are already handled by our
   try/except); (b) `extra_universe` rows are now `is_seed=2` and excluded from
   the warm cache via `universe.get_equity_universe()`, so the warmer no longer
   retries ~90 futures/FX/EU names 3× each. The `$STM.PA / $ROG.SW / $AXA.PA`
   lines came from `overview.py`'s Europe heatmap list (mostly valid, transient
   rate-limit misses); `SATS` is a delisted name in the warm/snapshot set —
   both are now silenced.
4. **Overview mover boxes "text leans out" fixed.** The gainers/losers/unusual/
   crosses panels were flex children with `flex-shrink:1` + `minHeight:0`, so
   they compressed and rows spilled out. Pinned each to natural height
   (`flexShrink:0`; the column already scrolls) and added row overflow safety
   (`minWidth:0` + ellipsis on the symbol, `flexShrink:0` on the value).

### 2026-08-04 (pass 1) — crosshair / hover / search / corr-matrix pass
1. **Crosshair "white margin" removed.** All Plotly crosshair spikes changed
   from dashed/mixed styles to a single thin **solid `#4a4f5c`** line per axis
   (explicitly non-white). Files: `CandleChart.jsx`, `TickerDetail.jsx`
   (intraday), `EtfMonitor.jsx`, `Commodities.jsx`.
   - *Note:* if a stale build still shows a bright-white cross, rebuild the
     frontend — the source now pins the colour, so a fresh build clears it.
2. **Hover shows only the line under the cursor** on the Cross-Asset and
   Commodities perf charts: `hovermode` `'x unified'` → `'closest'`, with clean
   spikes retained on both axes.
3. **Searchable universe expanded.** New `services/extra_universe.py` +
   startup hook in `main.py`. Commodities futures, crypto (12 coins), FX +
   DXY, EU indices, iShares STOXX 600 sector ETFs, ~40 major EU single stocks
   (Amsterdam/Paris/Frankfurt/London/Zurich/Copenhagen/Milan/Madrid), plus the
   missing ETFs the dashboard already referenced (`UUP`, `SOXX`, `RSP`, `IWF`,
   `IWD`) and the vol/rates complex. **Requires one backend restart** to seed.
4. **Rolling-correlation matrix now fills its panel** (Cross-Asset): equal-width
   columns via `table-layout: fixed`, `width/height: 100%`, taller cells, larger
   font, legend pinned to the bottom. File: `EtfMonitor.jsx::CorrMatrix`.

---

## 8. Open / on the horizon
- **Fundamentals follow-up slices** (kept out of slice 1 to avoid crowding):
  margins over time (gross/op/net), growth + forward estimates/revisions,
  balance-sheet health (net debt / debt-equity / current ratio), cash-flow
  (OCF & FCF) bars, dividend history + buyback/dilution (`get_shares_full`).
- **`history(repair=True)`** — let yfinance auto-fix 100× spikes / currency
  glitches before our validator sees them (quiet quality upgrade to `data.py`;
  deliberately not done yet to avoid touching the hot path mid-session).
- **ETF x-ray** via `ticker.funds_data` (top holdings / sector weights) — fits
  the EU-sector-ETF + cross-asset angle.
- **Options depth** (OI walls / max-pain / IV term structure) building on the
  existing options panel.
- **Ideas page follow-ups**: add a custom `EquityQuery` builder (region/sector/
  metric filters) beyond the predefined screens; optional EU-region screens;
  let a row show a mini spark / more columns.
- Trading 212 portfolio analysis page (summary strip, holdings table, P&L bar
  chart, sector/region donuts).
- Verify Ticker Detail renders cleanly for volume-less symbols (indices `^…`,
  some futures) — chart works, volume pane may be empty; worth a polish pass
  (e.g. hide the volume pane when all-null).
- Consider surfacing `category` from the search index in the search row (crypto
  / future / index badges).
- `/analysis/{t}` fires for every ticker incl. ETFs/futures (returns
  `available:false` after a wasted `.info` call) — could short-circuit by
  category to save a network round-trip.
