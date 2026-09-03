# money_dashboard

A live market-analytics terminal: sector breadth and rotation, the volatility complex, macro & regime, commodities, positioning and per-ticker research in one place. FastAPI backend + React/Vite frontend on a ~15-minute-delayed (and always labelled) feed driven by an EU/US market-session clock.

Not a backtester — the strategy work lives in the separate `swinglab` project.

---

## Quick start

```bash
# backend  (http://localhost:8000, docs at /docs)
cd backend
pip install -r requirements.txt
cp .env.example .env          # then paste your free FRED key into it
uvicorn main:app --reload --port 8000

# frontend (http://localhost:5173)
cd frontend
npm install
npm run dev
```

First boot seeds the ticker search index from `backend/data/*.csv` and warms the price cache in a background thread — the app is usable immediately, and pages fill in as the warm progresses. Watch the console for the `[FRED]` line: it now actually calls the API, so it tells you whether FRED works, not just whether a key is present.

**This machine:** the backend deps live in the `swinglab` conda env —
`C:\Users\honya\.conda\envs\swinglab\python.exe`. The bare `python` on PATH is the Windows Store stub and won't work.

---

## Repository map

```
backend/
  main.py                 every HTTP route; thin — all logic is in services/
  seed_tickers.py         one-time seed of search.db from data/*.csv
  data/                   sp500_seed.csv, etf_seed.csv (the base universe)
  services/
    data.py               ★ OHLCV fetching + the SQLite cache. Read this first.
    universe.py           which symbols the cache warmer keeps fresh
    cache_warmer.py       boot warm + 6-hourly background refresh
    session.py            EU/US market clock — decides live vs last-close mode
    indicators.py         MA / Bollinger / z-score / RSI / ATR / autocorrelation
    regime.py             per-ticker Bull / Bear / Sideways label
    validate.py           flag-and-keep data-quality layer
    overview.py           sector heatmap, breadth + TRIN, movers, region boards
    etf_monitor.py        cross-asset board, rotation ratios, RRG, risk appetite
    volatility.py         the vol cockpit (+ single-name IV, own endpoint)
    commodities.py        board, roll yield, ratios, seasonality, real assets
    europe.py             EU indices, EU sector ETFs, FX, session overlap
    macro.py              macro score + FRED series (real yields, breakevens…)
    options.py            options-as-indicator: IV, skew, put/call, approx GEX
    intraday.py           on-demand intraday bars + session VWAP (never cached)
    analysis.py           analyst consensus, targets, earnings, short interest
    fundamentals.py       income statement, valuation multiples, P/E band
    edgar.py              SEC XBRL for deep fundamental history
    screener.py           Yahoo predefined screens → the Ideas page
    cot.py                CFTC Commitments of Traders
    sentiment.py          NAAIM / AAII positioning
    news.py               watchlist + per-ticker headlines
    watchlist.py          watchlist CRUD + quotes
    ticker_search.py      search over search.db
    extra_universe.py     adds commodities/FX/crypto/EU names to the index

frontend/src/
  App.jsx                 shell: top bar, nav, search
  store/useStore.js       zustand: current page, ticker, chart period
  api/client.js           every backend call, in one file
  components/
    TVChart.jsx           ★ the price chart (TradingView lightweight-charts)
    RRG.jsx               ★ Relative Rotation Graph (4-quadrant rotation)
    ui.jsx                Panel / Pill / StateView / useFetch / session hooks
    TickerSearch.jsx      symbol search box
  pages/                  one file per nav item
  styles/globals.css      design tokens (TradingView dark palette)
```

---

## The data layer (`services/data.py`)

Everything on every page ultimately comes from here, so it is worth 60 seconds.

Prices come from yfinance through a **process-wide lock** (`_yf_lock` — yfinance is not thread-safe and concurrent downloads corrupt data) into a SQLite OHLCV cache at `backend/cache.db`.

### Two accessors, two different contracts

| | `fetch_ohlcv(ticker, period)` | `daily_close_series(ticker, days)` |
|---|---|---|
| Used by | Overview, Cross-Asset, Ticker page, macro | Volatility, Commodities, Europe |
| For | symbols in the **warm universe** | symbols **not** warmed (futures, EU ETFs, crypto) |
| Returns | full OHLCV DataFrame | a close-price Series |
| Last bar | the most recent **completed** session | the freshest bar the feed has |
| Freshness rule | `_cache_is_fresh` (range coverage) | `cache_is_current` (refresh recency) |

Both read and write the **same** `ohlcv` table. The difference in their last bar is applied **on read**, by `_trim_forming_bar`, never on write — because two callers need opposite things:

- Overview and Cross-Asset in **live** mode overlay an intraday snapshot and measure today's return against the last cached bar, so that bar must still be the *previous* close while the session runs.
- The same pages in **close** mode read the last bar *as* today's close.

So a bar dated today is dropped only while the US cash session is open. Filtering at write time instead would force one contract on both and silently corrupt whichever lost.

### Freshness is measured in "when did we last ask", not "how old is the last bar"

`ohlcv_reach` stores, per ticker, `earliest_asked` and `refreshed_at`.

- **`refreshed_at`** drives `cache_is_current(ticker, max_age_minutes=45)`. Judging freshness by bar *date* means guessing which session should exist by now — and that guess is wrong on weekends, on holidays, before a market's open, and on every non-US calendar. "We asked the feed 20 minutes ago and this is what it gave us" needs no calendar at all.
- **`earliest_asked`** makes full history cacheable. Without it, a `period=max` request could never be served from cache — the cache would need bars from before the instrument was listed to look complete — so every load of the full-history chart would re-download decades of data.

### Gotchas worth remembering

- **yfinance `end=` is exclusive.** `end=today` returns data through *yesterday*. `_fetch_from_yfinance` compensates by asking through tomorrow.
- **`_validate_fetched_data` measures against the last ~500 bars, not the whole series.** Its "last close is under 10% of the max → reject" rule catches a corrupt splice inside a normal window, but over a full multi-decade history it would reject any real company trading 90% below a peak it set in 2000 or 2021 — and there are many. Bounding the window is what makes `period=max` safe.
- **fredapi is broken on this machine.** It calls stdlib `urlopen`, which verifies against the Windows certificate store; one malformed cert there kills every call with `SSLError [ASN1: NOT_ENOUGH_DATA]`. `services/macro.py` therefore fetches FRED over `requests` (certifi-bundled CAs) and only falls back to fredapi. yfinance was never affected, which is why prices worked while every FRED panel sat silently blank.
- **`^RVX` is effectively delisted** on Yahoo. The vol page substitutes an IWM realized-vol proxy and labels it as one.
- Options data is fetched **per chain** and is slow. Anything needing many chains gets its own endpoint and a long TTL.

### Caching layers, outermost first

1. **Per-page TTL cache** in each service (`_out_cache`), keyed on `live`/`close` mode — ~2 min live, ~15 min closed.
2. **Per-symbol series memo** (`_series_cache`), 1 hour, in `europe` / `commodities` / `volatility`.
3. **SQLite OHLCV cache**, warmed on boot (2y) and refreshed every 6 hours.

Every builder takes `force=True`, which bypasses layers 1 and 2. Add `?force=true` to any endpoint.

---

## Endpoints

| Route | What |
|---|---|
| `GET /health` · `GET /session` | status; EU/US market clock |
| `GET /overview` | sector heatmap, breadth + TRIN, movers, Europe/commodity boards |
| `GET /etf-monitor` | cross-asset board, rotation ratios, **RRG**, risk appetite, correlation |
| `GET /macro` · `GET /macro/extended` | composite macro score; FRED real yields / breakevens / net liquidity |
| `GET /vol` | the volatility cockpit |
| `GET /vol/single-name` | single-name IV vs index IV (slow — own endpoint, 30-min TTL) |
| `GET /vol/probe` | which vol tickers Yahoo actually serves right now |
| `GET /europe` | EU indices, sector ETFs, FX, VSTOXX proxy, session overlap |
| `GET /commodities` | board, roll yield, ratios, seasonality, gold vs real yields |
| `GET /cot` · `GET /sentiment` | CFTC positioning; NAAIM / AAII |
| `GET /screener` | Yahoo predefined screens (the Ideas page) |
| `GET /ticker/{t}?period=` | daily OHLCV + indicators + regime. `period` ∈ `1mo 3mo 6mo 1y 2y 5y 10y max`. The Ticker page always asks for `max`; shorter periods exist for other callers |
| `GET /intraday/{t}` | intraday bars + session VWAP (never cached) |
| `GET /options/{t}` | IV, IV rank, skew, risk reversal, put/call, approximate GEX |
| `GET /analysis/{t}` · `GET /fundamentals/{t}` | analyst & positioning; statements & multiples |
| `GET /news` · `GET /news/{t}` | watchlist and per-ticker headlines |
| `GET /watchlist` (+ POST/DELETE) · `GET /watchlist/quotes` | watchlist |
| `GET /tickers/search` · `/recent` · `/stats` · POST `/lookup` · `/select` | symbol search |
| `GET /cache/status` · POST `/cache/warm` · DELETE `/cache` · `/cache/{t}` | cache admin |

Most GETs accept `?force=true`.

---

## The pages

**Overview** — sector heatmap with a US / Europe / Commodities switch, breadth (advancers, % above 50d/200d, new highs/lows, TRIN), and movers. Heatmap tiles sort strictly by return: a move of exactly `0.00%` sits between the last gainer and the first loser, and reads neutral grey rather than green.

**Ideas** — Yahoo's predefined screens (gainers, losers, most active, value, growth, small caps) as a discovery surface.

**Cross-Asset** — the hero panel is the **Relative Rotation Graph**. Both axes are measured against SPY and centred on 100, so the crosshair *is* the benchmark:

- x — **RS-Ratio**: relative strength. Right of centre = outperforming.
- y — **RS-Momentum**: whether that strength is still building.

|  | left of centre | right of centre |
|---|---|---|
| **above** | IMPROVING — weak but turning up | LEADING — strong and accelerating |
| **below** | LAGGING — weak and still falling | WEAKENING — strong but losing steam |

Rotation normally runs clockwise: improving → leading → weakening → lagging. Distance from the centre is conviction; a name sitting on the crosshair is behaving like the benchmark whatever quadrant it technically occupies. Toggle between the **cross-asset** and **US sector** universes, set the tail length, click a point to open the ticker. Both axes are z-scored against each member's own two-year history before being re-centred — without that normalisation every series clusters within a hair of 100 and the chart collapses into a dot. The old rebased-to-100 chart is still there under the **Rebased** toggle.

**Macro & Regime** — composite macro score (yfinance + FRED real yields, breakevens, net liquidity) and a Bull/Bear/Sideways regime.

**Volatility** — built on the principle that a vol level means nothing on its own (VIX 18 is calm in 2022, a warning in 2017), so every gauge carries its **1-year percentile** on a rail beneath the number, and the page opens with a regime verdict assembled from those percentiles:

- gauges: VIX · term slope · VVIX · VVIX/VIX · SKEW · VRP
- **term structure** curve plus **VIX/VIX3M** over time — above 1 is backwardation, the most reliable single tell that a drawdown is under way rather than over — with a backwardated-days count and VIX9D/VIX for near-dated event stress
- **realized-vol cone**: SPY realized vol at 5/10/21/63 days against its 3-year 10–90th percentile bands, with VIX overlaid. Above the band = the index really is moving unusually for that horizon; inside it = ordinary, whatever the headlines say
- **VRP** (VIX − 21d realized) as a series with percentile: the premium vol sellers harvest, and it goes sharply negative exactly when that trade stops working
- **cross-index**: VIX / VXN / RVX and the spreads — tech-led and breadth-led stress are different problems
- **dispersion**: rolling average pairwise correlation of a mega-cap basket, plus **single-name IV vs index IV** — per-name IV−RV, the dispersion ratio, and an implied-correlation proxy. That panel loads separately because it needs one option chain per name

**Europe** — EU indices with intraday paths, EU sector ETFs (iShares STOXX 600) with a rebased chart and ranking, EUR crosses, EU realized-vol gauge, and the 15:30–17:30 CET US/EU overlap. The sector panel header shows the board's data date and flags any sector whose last bar trails the rest.

**Commodities** — organised around what a commodity can actually tell you:

- **board** — price, returns, position in the 52-week range as a bar, trend vs the MA stack, realized vol with its 3-year percentile
- **roll yield** — contango vs backwardation, measured as a front-month futures **ETF ÷ front-month contract**. An ETF holds and rolls the contract; the continuous price does not, so their drift *is* the roll yield. This is the fact a price chart hides: spot can rally all year while a long-only holder loses money to the roll
- **ratios** — gold/silver, copper/gold, gold/oil, gold/BTC, crude/gas, each with a **5-year percentile**, which is what turns a level into "stretched"
- **gold vs the 10-year real yield** — gold pays no coupon, so its opportunity cost *is* the real yield; the right axis is inverted so the normal inverse relationship shows as the lines tracking, and decoupling becomes obvious
- **seasonality** — average return by calendar month over 10 years, with the hit rate on hover. The one asset class where this is physical: heating demand, harvests, driving season
- **correlation** — a wall of blue means you are trading the dollar, not commodities

**Positioning** — CFTC Commitments of Traders plus NAAIM / AAII sentiment.

**News** — deduped, newest-first headlines across the watchlist.

**Ticker** — three modes:

- **Daily** — the price chart, built on **TradingView's own `lightweight-charts`** rather than an imitation, so the interactions are the real ones: wheel zooms about the cursor, drag pans, ctrl+wheel scales the price axis, double-clicking an axis resets it. Price scale on the right carries the live last-price tag plus each MA's value in its own colour, over a solid dark ground and a visible square grid. Volume and RSI are separate panes, sized so price keeps the bulk.

  **The chart always loads the instrument's entire history, once per ticker** (SPY: 8,456 bars back to 1993). The period buttons — 1M · 3M · 6M · 1Y · 2Y · 5Y · 10Y · ALL — only move the **visible window**; they never refetch. That is the difference between a chart you can explore and one you can only look at: picking "3M" frames the last ~63 sessions across the full canvas width while a decade of bars sits off-screen to the left, one drag away. `reset` returns to the selected window, `fit all` zooms out to every bar. Windows are applied as *logical* ranges (bar indices, not dates) so weekends and holidays don't leave ragged gaps.

  Regime shading defaults **off** — a plain dark chart with a clean grid is the readable baseline. Click a candle to set an entry, click a later one for an exit, right-click to clear; the entry analyser reports return, days held, annualised, max drawdown and max run-up. Toggles: Regime, MA50, MA200, BB, Vol, RSI, Tgt (analyst targets).
- **Intraday** — 1m…60m bars with session VWAP and the same entry/exit analyser.
- **Fundamentals** — revenue/net income with the price overlaid, valuation multiples with percentile-vs-own-history, and a trailing P/E band.

Side panels: options signals (ATM IV, IV rank, put/call, 25Δ skew and risk reversal, approximate GEX), analyst consensus and price targets, earnings, short interest.

---

## Conventions

- **Every service builder** is `build_x(force: bool = False) -> dict`, wraps its work in a module-level TTL cache keyed on live/close mode, and returns `mode`, `phase` and `as_of` alongside its payload.
- **Missing data is absent, never faked.** Services probe what the feed serves and omit what it doesn't; the frontend renders an explicit "unavailable" note. Proxies (IWM realized vol for RVX, the implied-correlation approximation, ETF-based roll yield) are labelled as proxies wherever they surface.
- **Levels ship with context.** Prefer `(level, percentile, z-score)` over a bare number — see `_ctx()` in `volatility.py`.
- **Sorting must be zero-safe.** `b[metric] || -99` coerces a legitimate `0` to `-99`; use `??` or an explicit `is not None` guard. This was a real bug on the Overview heatmap.
- **Colour semantics**: `> 0` bull, `< 0` bear, exactly `0` neutral. Tokens live in `globals.css`; use `var(--bull)` / `var(--bear)` / `var(--side)`, never literal hex, in page code.
- **Charts**: price uses `lightweight-charts`; everything else uses Plotly. Every Plotly component must `Plotly.purge` on unmount.

## Known constraints

- The feed is delayed ~15 minutes and every live surface says so.
- `session.py` is weekend-aware but only partially holiday-aware (US holidays are a hardcoded list through 2026).
- **IV rank matures over time.** `options_iv.db` snapshots ATM IV daily and cannot be backfilled — the rank is meaningless for the first few weeks and says so.
- The frontend bundle is ~5 MB because Plotly is not code-split. Fine locally.
- `.gitignore` excludes all `*.db`. `options_iv.db` and `sentiment.db` accumulate history no feed can replay — back them up separately if that history matters.

## Stack

`Python` · `FastAPI` · `pandas` / `NumPy` · `yfinance` · `FRED` · `SQLite` · `React` · `Vite` · `Plotly` · `lightweight-charts` · `zustand`
