# ============================================================
# services/europe.py
# Europe page — live from the 09:00 CET open through the 17:30 close:
#   - EU index board (DAX / Euro Stoxx 50 / CAC / FTSE / IBEX / MIB)
#   - EU volatility gauge (Euro Stoxx 50 realized vol — VSTOXX isn't on Yahoo)
#   - EUR crosses + European commodities (Brent, Gold)
#   - intraday % paths so you see who's leading / lagging today
#   - overlap panel (15:30–17:30 CET) — how the US open lands on Europe
#
# EU indices aren't in the warm daily cache, so daily history is fetched
# live and memoized. IMPORTANT: during a live session the last daily bar is
# TODAY'S forming bar, so the intraday % base is the last COMPLETED session
# close (rows strictly before today) — otherwise everything reads ~0%.
# ============================================================

import time
import threading
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import yfinance as yf

from services.data import _yf_lock, _load_from_cache
from services.session import market_session

EU_INDICES = [
    ("DAX", "^GDAXI"),
    ("Euro Stoxx 50", "^STOXX50E"),
    ("CAC 40", "^FCHI"),
    ("FTSE 100", "^FTSE"),
    ("IBEX 35", "^IBEX"),
    ("FTSE MIB", "FTSEMIB.MI"),
]
EU_VOL_PROXY = "^STOXX50E"          # realized vol of this = EU fear gauge
FX = [("EUR / USD", "EURUSD=X"), ("EUR / GBP", "EURGBP=X"), ("EUR / JPY", "EURJPY=X")]
COMMODITIES = [("Brent crude", "BZ=F"), ("Gold", "GC=F")]
US_PROXY = "SPY"

# iShares STOXX Europe 600 sector UCITS ETFs (XETRA). We probe each and serve
# only those that resolve; the sector name is read from Yahoo at runtime so we
# never hardcode a ticker->sector guess.
EU_SECTORS = [f"EXV{i}.DE" for i in range(1, 8)] + [f"EXH{i}.DE" for i in range(1, 10)]
_name_cache: dict = {}

_series_cache: dict = {}
_SERIES_TTL = 3600
_out_cache: dict = {}
_TTL_LIVE, _TTL_CLOSE = 120, 900
_lock = threading.Lock()


def _daily(ticker: str):
    now = time.time()
    c = _series_cache.get(ticker)
    if c and now - c["ts"] < _SERIES_TTL:
        return c["series"]
    s = None
    end = datetime.now().strftime("%Y-%m-%d")
    start = (datetime.now() - timedelta(days=420)).strftime("%Y-%m-%d")
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


def _prior_close(s: pd.Series) -> float:
    """Last completed session close (excludes today's forming bar)."""
    today = pd.Timestamp.now().normalize()
    prior = s[s.index.normalize() < today]
    if len(prior):
        return float(prior.iloc[-1])
    return float(s.iloc[-2]) if len(s) > 1 else float(s.iloc[-1])


def _intraday_path(ticker: str, base: float | None):
    """Today's 5-min closes as % change from `base`. (last_pct, points)."""
    acquired = _yf_lock.acquire(timeout=15)
    if not acquired:
        return None, None
    try:
        raw = yf.download(ticker, period="1d", interval="5m", auto_adjust=True, progress=False, threads=False)
        if raw is None or raw.empty:
            return None, None
        if isinstance(raw.columns, pd.MultiIndex):
            raw.columns = raw.columns.get_level_values(0)
        closes = raw["Close"].astype(float).dropna()
        if not len(closes) or not base:
            return None, None
        pts = [{"t": ts.strftime("%H:%M"), "v": round(float(c) / base - 1, 5)} for ts, c in closes.items()]
        return round(float(closes.iloc[-1]) / base - 1, 5), pts
    except Exception:
        return None, None
    finally:
        _yf_lock.release()


def _index_data(name: str, sym: str, live: bool) -> dict | None:
    s = _daily(sym)
    if s is None or len(s) < 5:
        return None
    base = _prior_close(s)                       # yesterday's close
    prior = s[s.index.normalize() < pd.Timestamp.now().normalize()]
    spark_src = prior if len(prior) > 5 else s
    daily_spark = [round(float(v), 2) for v in spark_src.iloc[-60:].values]

    out = {"name": name, "symbol": sym, "prev_close": round(base, 2),
           "last": round(float(s.iloc[-1]), 2),
           "ret_1d": round(float(s.iloc[-1]) / base - 1, 4) if base else None,
           "intraday": None, "spark": daily_spark}

    if live:
        last_pct, pts = _intraday_path(sym, base)
        if last_pct is not None:
            out["ret_1d"] = last_pct
            out["last"] = round(base * (1 + last_pct), 2)
            out["intraday"] = pts
    else:
        # closed: today's completed bar vs the one before it
        if len(s) > 1:
            out["ret_1d"] = round(float(s.iloc[-1]) / float(s.iloc[-2]) - 1, 4)
            out["last"] = round(float(s.iloc[-1]), 2)
    return out


def _quote(name: str, sym: str) -> dict | None:
    s = _daily(sym)
    if s is None or len(s) < 3:
        return None
    last = float(s.iloc[-1])
    prev = float(s.iloc[-2])
    return {"name": name, "symbol": sym, "level": round(last, 4),
            "ret_1d": round(last / prev - 1, 4) if prev else None,
            "spark": [round(float(v), 4) for v in s.iloc[-60:].values]}


def _eu_vol_gauge() -> dict | None:
    s = _daily(EU_VOL_PROXY)
    if s is None or len(s) < 30:
        return None
    rv = (s.pct_change().rolling(21).std() * np.sqrt(252) * 100).dropna()
    if not len(rv):
        return None
    return {"label": "Euro Stoxx 50 · realized vol (21d)", "level": round(float(rv.iloc[-1]), 2),
            "history": [round(float(v), 2) for v in rv.iloc[-60:].values]}


def _sector_name(sym: str) -> str:
    """Static map of the iShares STOXX Europe 600 sector ETFs (confirmed via the
    feed-verification run). No runtime lookup -> no first-load latency."""
    return SECTOR_NAMES.get(sym, sym)


SECTOR_NAMES = {
    "EXV1.DE": "Banks", "EXV2.DE": "Telecommunications", "EXV3.DE": "Technology",
    "EXV4.DE": "Health Care", "EXV5.DE": "Automobiles & Parts", "EXV6.DE": "Basic Resources",
    "EXV7.DE": "Chemicals", "EXV8.DE": "Construction & Materials", "EXV9.DE": "Travel & Leisure",
    "EXH1.DE": "Oil & Gas", "EXH2.DE": "Financial Services", "EXH3.DE": "Food & Beverage",
    "EXH4.DE": "Industrial Goods & Services", "EXH5.DE": "Insurance", "EXH6.DE": "Media",
    "EXH7.DE": "Personal & Household Goods", "EXH8.DE": "Retail", "EXH9.DE": "Utilities",
}


def _eu_sectors() -> list[dict]:
    """Full daily series per resolving sector ETF (dates + closes). Rebasing and
    window returns are computed client-side so the period tabs (1D…1Y) switch
    instantly without a refetch. Only tickers that actually return data are
    included."""
    out = []
    for sym in EU_SECTORS:
        s = _daily(sym)
        if s is None or len(s) < 10:
            continue
        out.append({
            "symbol": sym, "name": _sector_name(sym),
            "dates": [str(d.date()) for d in s.index],
            "closes": [round(float(v), 4) for v in s.values],
            "last": round(float(s.iloc[-1]), 2),
        })
    return out


def build_europe(force: bool = False) -> dict:
    sess = market_session()
    live = sess["eu_open"]
    key = "live" if live else "close"
    ttl = _TTL_LIVE if live else _TTL_CLOSE

    now = time.time()
    with _lock:
        cached = _out_cache.get(key)
        if not force and cached and now - cached["ts"] < ttl:
            return cached["data"]

        indices = [d for d in (_index_data(n, s, live) for n, s in EU_INDICES) if d]
        vol_gauge = _eu_vol_gauge()
        fx = [q for q in (_quote(n, s) for n, s in FX) if q]
        commodities = [q for q in (_quote(n, s) for n, s in COMMODITIES) if q]

        overlap = {"active": bool(sess["us_open"] and sess["eu_open"]), "spy": None}
        if overlap["active"]:
            sp = _daily(US_PROXY)
            if sp is not None and len(sp):
                lp, pts = _intraday_path(US_PROXY, _prior_close(sp))
                overlap["spy"] = {"ret_1d": lp, "intraday": pts}

        sectors = _eu_sectors()

        data = {
            "mode": key, "phase": sess["phase"], "as_of": sess["now_cet"] + " CET",
            "eu_open": sess["eu_open"], "us_open": sess["us_open"],
            "indices": indices, "vol_gauge": vol_gauge, "fx": fx,
            "commodities": commodities, "overlap": overlap,
            "sectors": sectors,
        }
        _out_cache[key] = {"ts": now, "data": data}
        return data
