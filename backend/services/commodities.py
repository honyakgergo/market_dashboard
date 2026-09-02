# ============================================================
# services/commodities.py
# Commodities & cross-asset ratios page:
#   - rebased performance curves (crude / gold / silver / copper / …)
#   - ratio charts: gold/silver, copper/gold (Dr. Copper), gold/oil, gold/BTC
#   - return matrix (1D…1Y)
#   - bonds + BTC included so the page carries the "real asset vs paper" story
#
# Continuous futures (=F) and crypto aren't in the warm daily cache, so daily
# history is fetched live and memoized (same pattern as europe.py).
# ============================================================

import time
import threading
from datetime import datetime, timedelta

import pandas as pd
import yfinance as yf

from services.data import _yf_lock, _load_from_cache
from services.session import market_session

# label · yahoo symbol   (order = draw/legend order)
INSTRUMENTS = [
    ("Crude WTI", "CL=F"), ("Brent", "BZ=F"), ("Nat gas", "NG=F"),
    ("Gold", "GC=F"), ("Silver", "SI=F"), ("Copper", "HG=F"),
    ("10Y Treasury", "IEF"), ("Long Treasury", "TLT"), ("Bitcoin", "BTC-USD"),
]

# label · numerator · denominator
RATIOS = [
    ("Gold / Silver", "GC=F", "SI=F"),        # risk / monetary stress
    ("Copper / Gold", "HG=F", "GC=F"),        # Dr. Copper — growth vs fear
    ("Gold / Crude", "GC=F", "CL=F"),         # real-asset relative value
    ("Gold / Bitcoin", "GC=F", "BTC-USD"),    # old vs new store of value
]

_series_cache: dict = {}
_SERIES_TTL = 3600
_out_cache: dict = {}
_TTL_LIVE, _TTL_CLOSE = 150, 900
_lock = threading.Lock()


def _daily(ticker: str):
    """Daily close series (~1y). Cache first, else memoized live fetch."""
    now = time.time()
    c = _series_cache.get(ticker)
    if c and now - c["ts"] < _SERIES_TTL:
        return c["series"]
    s = None
    end = datetime.now().strftime("%Y-%m-%d")
    start = (datetime.now() - timedelta(days=400)).strftime("%Y-%m-%d")
    df = _load_from_cache(ticker, start, end)
    if df is not None and len(df) > 20:
        s = df["Close"].astype(float)
    else:
        acquired = _yf_lock.acquire(timeout=20)
        if acquired:
            try:
                raw = yf.download(ticker, period="1y", interval="1d", auto_adjust=True, progress=False, threads=False)
                if raw is not None and not raw.empty:
                    if isinstance(raw.columns, pd.MultiIndex):
                        raw.columns = raw.columns.get_level_values(0)
                    s = raw["Close"].astype(float).dropna()
            except Exception:
                s = None
            finally:
                _yf_lock.release()
    _series_cache[ticker] = {"ts": now, "series": s}
    return s


def _bundle(n: int = 252) -> dict | None:
    frames = {}
    for _, sym in INSTRUMENTS:
        s = _daily(sym)
        if s is not None and len(s) > 40:
            frames[sym] = s
    if not frames:
        return None
    df = pd.DataFrame(frames).sort_index().ffill().iloc[-n:]
    view_dates = [str(d.date()) for d in df.index]

    # rebased perf (% from window start)
    perf = []
    for label, sym in INSTRUMENTS:
        if sym not in df.columns:
            continue
        c = df[sym]
        base = c.dropna().iloc[0] if len(c.dropna()) else None
        if not base:
            continue
        perf.append({"label": label, "symbol": sym,
                     "perf": [None if pd.isna(v) else round(float(v) / float(base) * 100 - 100, 2) for v in c.values]})

    # ratio series
    ratios = []
    for label, a, b in RATIOS:
        if a not in df.columns or b not in df.columns:
            continue
        r = (df[a] / df[b]).dropna()
        if len(r) < 30:
            continue
        ratios.append({
            "label": label, "num": a, "den": b,
            "level": round(float(r.iloc[-1]), 4),
            "ret_1m": round(float(r.iloc[-1] / r.iloc[-22] - 1), 4) if len(r) > 22 else None,
            "dates": [str(d.date()) for d in r.index],
            "values": [round(float(v), 4) for v in r.values],
        })

    # return matrix
    year0 = f"{datetime.now().year}-01-01"
    rows = []
    for label, sym in INSTRUMENTS:
        if sym not in df.columns:
            continue
        c = df[sym].dropna()
        if len(c) < 2:
            continue
        last = float(c.iloc[-1])

        def rr(k, _c=c, _last=last):
            return round(_last / float(_c.iloc[-1 - k]) - 1, 4) if len(_c) > k else None
        yr = c[c.index >= year0]
        ytd = round(last / float(yr.iloc[0]) - 1, 4) if len(yr) > 1 else None
        rows.append({"label": label, "symbol": sym, "vals": {
            "1D": rr(1), "1W": rr(5), "1M": rr(21), "3M": rr(63),
            "6M": rr(126), "YTD": ytd, "1Y": rr(252)}})
    return_matrix = {"cols": ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y"], "rows": rows}

    return {"dates": view_dates, "perf": perf, "ratios": ratios, "return_matrix": return_matrix}


def _intraday_basket(symbols: list[str]) -> dict | None:
    """Bulk 5-minute paths (% since today's open) for the 1D view."""
    acquired = _yf_lock.acquire(timeout=60)
    if not acquired:
        return None
    try:
        raw = yf.download(symbols, period="1d", interval="5m", auto_adjust=True,
                          progress=False, threads=True, group_by="ticker")
    except Exception:
        return None
    finally:
        _yf_lock.release()
    if raw is None or raw.empty:
        return None
    multi = isinstance(raw.columns, pd.MultiIndex)
    paths = {}
    for s in symbols:
        try:
            sub = raw[s] if (multi and s in raw.columns.get_level_values(0)) else (raw if not multi else None)
            if sub is None:
                continue
            c = sub["Close"].dropna()
            if len(c) < 2:
                continue
            base = float(c.iloc[0])
            if not base:
                continue
            paths[s] = {"t": [ts.strftime("%H:%M") for ts in c.index],
                        "y": [round(float(v) / base * 100 - 100, 3) for v in c.values]}
        except Exception:
            continue
    return paths or None


def build_commodities(force: bool = False) -> dict:
    sess = market_session()
    live = sess["us_open"]
    key = "live" if live else "close"
    ttl = _TTL_LIVE if live else _TTL_CLOSE

    now = time.time()
    with _lock:
        cached = _out_cache.get(key)
        if not force and cached and now - cached["ts"] < ttl:
            return cached["data"]

        bundle = _bundle()
        if live and bundle:
            bundle["intraday"] = _intraday_basket([s for _, s in INSTRUMENTS])
        data = {
            "mode": key, "phase": sess["phase"],
            "as_of": sess["now_cet"] + " CET" if live else datetime.now().strftime("%Y-%m-%d"),
            "bundle": bundle,
        }
        _out_cache[key] = {"ts": now, "data": data}
        return data
