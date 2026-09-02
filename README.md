# money_dashboard

A live market-analytics terminal — sector breadth and rotation, the volatility complex, macro & regime, and options positioning in one place. Not a backtester; the strategy work lives in the separate `swinglab` project. FastAPI backend + React/Vite frontend, on a ~15-minute-delayed (and always labelled) data feed driven by an EU/US market-session clock.

## Structure

```
backend/    FastAPI app — data, indicators, macro (+FRED), overview, etf_monitor,
            volatility, options, europe, intraday, session, cache
frontend/   React/Vite dashboard — 6 pages on a TradingView-style palette
```

## The six pages

- **Overview** — sector heatmap, breadth, day's movers
- **ETF Monitor** — cross-asset board with rotation and a Relative Rotation Graph (RRG)
- **Macro & Regime** — composite macro score (yfinance + FRED real yields / breakevens / net liquidity) and a Bull/Bear/Sideways regime
- **Volatility** — VIX term structure, VVIX, SKEW, cross-index, variance risk premium, dispersion
- **Europe** — EU indices, VSTOXX, EURUSD, US/EU session overlap
- **Ticker Detail** — daily + intraday history, indicators (MA/Bollinger/z-score/RSI/ATR), regime, and an options-as-indicator panel (put/call, IV rank, skew/risk-reversal, approximate GEX)

## How it works

Prices come from yfinance through a thread-locked wrapper into a SQLite OHLCV cache (2-year warm on startup, 6-hour background refresh), with a flag-and-keep data-quality layer that marks suspect bars rather than dropping them. FRED supplies the macro series yfinance can't. Each dashboard surface is one FastAPI endpoint (`/overview`, `/etf-monitor`, `/macro/extended`, `/vol`, `/europe`, `/options/{t}`, `/intraday/{t}`, `/session`) with optional `force` refresh.

## Run (backend)

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env        # add your FRED key
uvicorn main:app --reload --port 8000
```

First start seeds the search index from the CSVs and warms the cache in the background. `cache.db` and `search.db` are created locally and gitignored.

## Stack

`Python` · `FastAPI` · `pandas` / `NumPy` · `yfinance` · `FRED API` · `SQLite` · `React` · `Vite`

---

A fuller write-up is in my portfolio.
