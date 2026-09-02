# ============================================================
# backend/main.py
# FastAPI app for the money_dashboard analytics terminal.
# Run with: uvicorn main:app --reload --port 8000
#
# Foundation routes only (search / ticker / macro / cache). The dashboard
# surfaces — /overview, /etf-monitor, intraday, /options, extended /macro —
# are added on top of this in the next build steps.
# ============================================================

import sqlite3
import threading
import pandas as pd
from datetime import datetime, timedelta
from fastapi import FastAPI, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from services.data import fetch_ohlcv, _purge_ticker_cache, DB_PATH, _period_to_days
from services.indicators import compute_all, autocorr_label
from services.regime import compute_regime
from services.macro import fetch_macro, compute_macro_signals, get_current_macro_state, get_macro_history
from services.cache_warmer import warm_cache, start_background_refresh, MAX_DAYS
from services.universe import get_warm_universe
from services import ticker_search
from services.overview import build_overview
from services.etf_monitor import build_etf_monitor
from services.intraday import fetch_intraday
from services.options import build_options
from services.session import market_session
from services.volatility import build_volatility, probe as vol_probe
from services.europe import build_europe
from services.commodities import build_commodities
from services.cot import build_cot
from services.sentiment import build_sentiment
from services.macro import build_macro_extended, fred_status
from services.extra_universe import ensure_extra_seeded
from services.analysis import build_analysis
from services.screener import build_screener
from services.fundamentals import build_fundamentals
from services import watchlist as wl
from services.news import build_watchlist_news, build_ticker_news
import seed_tickers

app = FastAPI(title="money_dashboard API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── In-memory caches ──────────────────────────────────────────

_macro_cache: dict = {}
_signals_cache: pd.DataFrame | None = None


def _get_macro_signals() -> tuple[dict, pd.DataFrame]:
    global _macro_cache, _signals_cache
    if not _macro_cache or _signals_cache is None:
        _macro_cache   = fetch_macro(period="1y")
        _signals_cache = compute_macro_signals(_macro_cache)
    return _macro_cache, _signals_cache


# ── Startup ───────────────────────────────────────────────────

@app.on_event("startup")
def startup():
    """Seed the search index if empty, then warm the price cache and schedule refresh."""
    seed_tickers.ensure_seeded()
    # Idempotently add commodities / crypto / FX / EU indices + stocks that the
    # CSV seed never covered, so every browseable name is searchable. Safe on
    # every boot (INSERT OR IGNORE — never disturbs existing rows).
    ensure_extra_seeded()
    print(f"  [FRED] {fred_status()}")

    def do_warm():
        warm_cache(force=False)
        start_background_refresh(interval_hours=6)
    threading.Thread(target=do_warm, daemon=True).start()


# ── Health ────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "version": "0.1.0"}


# ── Market session (EU/US clock — drives every live page) ─────

@app.get("/session")
def session():
    return market_session()


# ── Macro ─────────────────────────────────────────────────────

@app.get("/macro")
def get_macro():
    _, signals = _get_macro_signals()
    state = get_current_macro_state(signals)
    return {
        "date":   state["date"],
        "score":  state["score"],
        "regime": state["regime"],
        **state["signals"],
        **state["values"],
        "history": get_macro_history(signals),
    }


# ── Single ticker ─────────────────────────────────────────────

@app.get("/ticker/{ticker}")
def get_ticker(ticker: str, period: str = "1y"):
    try:
        df = fetch_ohlcv(ticker, period=period)
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Ticker '{ticker}' not found.")

    df = compute_all(df)
    df["Regime"] = compute_regime(df)

    # Trim the MA warm-up window: indicators were computed on the warm-up
    # data, so trimming to the requested period leaves MA50/MA200/Bollinger
    # valid from the very first visible bar (no "starts mid-screen").
    cutoff = pd.Timestamp(datetime.now() - timedelta(days=_period_to_days(period)))
    trimmed = df[df.index >= cutoff]
    if not trimmed.empty:
        df = trimmed

    def _row(date, row) -> dict:
        def v(x):
            if pd.isna(x): return None
            if isinstance(x, float): return round(x, 4)
            return x
        return {
            "date": str(date.date()), "close": v(row["Close"]),
            "open": v(row["Open"]), "high": v(row["High"]),
            "low": v(row["Low"]),
            "volume": int(row["Volume"]) if not pd.isna(row["Volume"]) else None,
            "ma50": v(row["MA50"]), "ma200": v(row["MA200"]),
            "bb_upper": v(row["BB_upper"]), "bb_mid": v(row["BB_mid"]),
            "bb_lower": v(row["BB_lower"]),
            "zscore": v(row["Zscore"]), "rsi": v(row["RSI"]),
            "atr": v(row["ATR"]), "autocorr": v(row["AutoCorr"]),
            "strategy": autocorr_label(row["AutoCorr"]),
            "regime": row["Regime"],
        }

    history = [_row(date, row) for date, row in df.iterrows()]

    return {
        "ticker":  ticker.upper(),
        "period":  period,
        "regime":  df["Regime"].iloc[-1],
        "latest":  history[-1],
        "history": history,
    }


# ── Ticker search (over search.db — seeded universe) ──────────

@app.get("/tickers/search")
def tickers_search(q: str = "", limit: int = 10):
    """Search the seeded ticker universe by symbol prefix or name substring."""
    limit = max(1, min(limit, 50))
    return {"results": ticker_search.search(q, limit=limit)}


@app.get("/tickers/recent")
def tickers_recent(limit: int = 5):
    """Most recently accessed tickers (for the empty-query state of search)."""
    limit = max(1, min(limit, 20))
    return {"results": ticker_search.get_recent(limit=limit)}


@app.post("/tickers/lookup")
def tickers_lookup(payload: dict = Body(...)):
    """Validate and add a ticker not present in the seeded universe.

    Body: { "symbol": "RKLB" }
    """
    sym = (payload.get("symbol") or "").strip().upper()
    if not sym or not sym.replace("-", "").isalnum() or len(sym) > 10:
        raise HTTPException(status_code=400, detail="Invalid symbol format")

    def _validate(symbol: str) -> dict | None:
        try:
            df = fetch_ohlcv(symbol, period="1mo", use_cache=False, warmup=False)
        except Exception:
            return None
        if df is None or df.empty:
            return None
        return {
            "name":     symbol,
            "sector":   "Unknown",
            "exchange": "",
            "category": "large_equity",
        }

    row = ticker_search.lookup_and_add(sym, _validate)
    if row is None:
        raise HTTPException(status_code=404, detail=f'"{sym}" not found on yfinance.')
    return {"result": row}


@app.post("/tickers/select")
def tickers_select(payload: dict = Body(...)):
    """Fire-and-forget: bump last_accessed for the picked ticker."""
    sym = (payload.get("symbol") or "").strip().upper()
    if not sym:
        return {"updated": False}
    updated = ticker_search.mark_accessed(sym)
    return {"updated": updated, "symbol": sym}


@app.get("/tickers/stats")
def tickers_stats():
    """Diagnostic: counts and DB path for search.db."""
    return ticker_search.stats()


# ── Cache management ──────────────────────────────────────────

@app.delete("/cache/{ticker}")
def purge_cache(ticker: str):
    _purge_ticker_cache(ticker)
    return {"status": "purged", "ticker": ticker}


@app.delete("/cache")
def purge_all_cache():
    global _macro_cache, _signals_cache
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM ohlcv")
        conn.commit()
    _macro_cache = {}
    _signals_cache = None
    return {"status": "purged_all"}


@app.post("/cache/warm")
def trigger_warm_cache(force: bool = False):
    def do_warm():
        warm_cache(force=force)
    threading.Thread(target=do_warm, daemon=True).start()
    return {"status": "warming started", "force": force}


@app.get("/cache/status")
def cache_status():
    from services.data import _cache_is_fresh
    tickers = get_warm_universe()
    status = {t: _cache_is_fresh(t, MAX_DAYS) for t in tickers}
    fresh = sum(1 for v in status.values() if v)
    return {"total": len(status), "fresh": fresh, "stale": len(status) - fresh, "tickers": status}


# ── Market overview (heatmap / breadth / movers) ──────────────

@app.get("/overview")
def overview(force: bool = False):
    return build_overview(force=force)


# ── Cross-asset / ETF monitor ─────────────────────────────────

@app.get("/etf-monitor")
def etf_monitor(force: bool = False):
    return build_etf_monitor(force=force)


# ── Intraday (current-day hourly, on demand, ephemeral) ───────

@app.get("/intraday/{ticker}")
def intraday(ticker: str, interval: str = "5m", days: int = 1):
    try:
        return fetch_intraday(ticker, interval=interval, days=days)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── Options-as-indicator panel ────────────────────────────────

@app.get("/options/{ticker}")
def options(ticker: str):
    try:
        return build_options(ticker)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── Analyst & fundamentals (consensus / targets / earnings / short interest) ──

@app.get("/analysis/{ticker}")
def analysis(ticker: str, force: bool = False):
    """Analyst consensus, price targets, earnings surprises, short interest and a
    small company profile. Every block is optional — absent for names Yahoo
    doesn't cover (ETFs / futures / crypto / most EU listings)."""
    return build_analysis(ticker, force=force)


# ── Ideas & Movers (Yahoo predefined screeners — discovery surface) ──

@app.get("/screener")
def screener(force: bool = False):
    """Predefined Yahoo screens (gainers / losers / most-active / value / growth /
    small caps) as a 'where to put fresh money' discovery page."""
    return build_screener(force=force)


# ── Fundamentals (revenue/EPS statements + valuation multiples + P/E band) ──

@app.get("/fundamentals/{ticker}")
def fundamentals(ticker: str, force: bool = False):
    """Income statement (annual + quarterly), core valuation multiples with
    percentile-vs-own-history, and a trailing-P/E band. Absent for names Yahoo
    doesn't cover (ETFs / futures / most EU listings)."""
    return build_fundamentals(ticker, force=force)


# ── Extended macro (FRED real yields / breakevens / net liquidity + VIX complex) ──

@app.get("/macro/extended")
def macro_extended(force: bool = False):
    return build_macro_extended(force=force)


# ── Volatility cockpit (term structure / VVIX / SKEW / cross-index / VRP / dispersion) ──

@app.get("/vol")
def vol(force: bool = False):
    return build_volatility(force=force)


@app.get("/vol/probe")
def vol_probe_endpoint(force: bool = False):
    return vol_probe(force=force)


# ── Europe (EU indices / VSTOXX / EURUSD / overlap) ─────────────

@app.get("/europe")
def europe(force: bool = False):
    return build_europe(force=force)


# ── Commodities & cross-asset ratios ─────────────────────────

@app.get("/commodities")
def commodities(force: bool = False):
    return build_commodities(force=force)


# ── Positioning (CFTC COT + NAAIM / AAII sentiment) ───────────

@app.get("/cot")
def cot(force: bool = False):
    return build_cot(force=force)


@app.get("/sentiment")
def sentiment(force: bool = False):
    return build_sentiment(force=force)


# ── Watchlist + News ───────────────────────────────────

class WatchAdd(BaseModel):
    symbol: str
    label: str | None = None
    group: str | None = "Holdings"


@app.get("/watchlist")
def watchlist_get():
    return {"items": wl.get_watchlist()}


@app.post("/watchlist")
def watchlist_add(body: WatchAdd):
    return {"items": wl.add_item(body.symbol, body.label, body.group)}


@app.delete("/watchlist/{symbol}")
def watchlist_remove(symbol: str):
    return {"items": wl.remove_item(symbol)}


@app.get("/watchlist/quotes")
def watchlist_quotes():
    syms = [w["symbol"] for w in wl.get_watchlist()]
    return {"quotes": wl.get_quotes(syms)}


@app.get("/news")
def news(hours: int | None = None):
    """Aggregated, deduped, newest-first headlines across the whole watchlist."""
    return build_watchlist_news(hours=hours)


@app.get("/news/{ticker}")
def news_ticker(ticker: str):
    """Headlines for a single symbol (used by the Ticker page)."""
    return build_ticker_news(ticker)
