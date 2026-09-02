# ============================================================
# services/screener.py
# "Ideas & Movers" — a discovery surface built on Yahoo's predefined
# screeners via yfinance (`yf.screen`). US-region-strong; each predefined
# body returns up to ~25 quotes. This is the "where to put fresh money"
# page: today's gainers/losers/most-active plus a few value/growth screens.
#
# Cached in-memory (5 min). Degrades gracefully if the installed yfinance
# is too old to have `yf.screen` — the page then shows a short notice
# instead of erroring.
# ============================================================

import time
import threading
from datetime import datetime

import yfinance as yf

from services.data import _yf_lock

_cache = {"ts": 0.0, "data": None}
_TTL = 300
_lock = threading.Lock()

# (predefined screener key, display label, one-line blurb)
SCREENS = [
    ("day_gainers",              "Top gainers",            "Largest gains today"),
    ("day_losers",               "Top losers",             "Largest losses today"),
    ("most_actives",             "Most active",            "Highest volume today"),
    ("undervalued_large_caps",   "Undervalued large caps", "Low P/E, large cap"),
    ("growth_technology_stocks", "Growth tech",            "High-growth technology"),
    ("aggressive_small_caps",    "Aggressive small caps",  "High-beta small caps"),
]

PER_SCREEN = 22


def _num(x):
    try:
        if x is None:
            return None
        return float(x)
    except Exception:
        return None


def _rows_from(res, limit):
    quotes = res.get("quotes") if isinstance(res, dict) else None
    out = []
    for q in (quotes or [])[:limit]:
        sym = q.get("symbol")
        if not sym:
            continue
        cp = _num(q.get("regularMarketChangePercent"))
        out.append({
            "symbol": sym,
            "name": q.get("shortName") or q.get("longName") or "",
            "price": _num(q.get("regularMarketPrice")),
            # Yahoo returns change as a percent number (e.g. 5.2) → fraction
            # so the frontend's fmtPct works like everywhere else.
            "change_pct": (cp / 100.0) if cp is not None else None,
            "volume": _num(q.get("regularMarketVolume")),
            "market_cap": _num(q.get("marketCap")),
        })
    return out


def _run_one(key, limit=PER_SCREEN):
    res = None
    acquired = _yf_lock.acquire(timeout=30)
    try:
        # `count` (not `size`) is the reliable arg for predefined queries.
        res = yf.screen(key, count=max(limit, 25))
    except Exception:
        res = None
    finally:
        if acquired:
            _yf_lock.release()
    return _rows_from(res, limit)


def build_screener(force: bool = False) -> dict:
    now = time.time()
    with _lock:
        if not force and _cache["data"] and now - _cache["ts"] < _TTL:
            return _cache["data"]

    if not hasattr(yf, "screen"):
        data = {
            "sections": [],
            "as_of": datetime.utcnow().isoformat(),
            "error": "This yfinance build has no screener (yf.screen missing). "
                     "Upgrade with: pip install -U yfinance",
        }
        with _lock:
            _cache.update(ts=now, data=data)
        return data

    sections = []
    for key, label, blurb in SCREENS:
        sections.append({"key": key, "label": label, "blurb": blurb, "rows": _run_one(key)})

    got_any = any(s["rows"] for s in sections)
    data = {
        "sections": sections,
        "as_of": datetime.utcnow().isoformat(),
    }
    if not got_any:
        data["error"] = ("Screener returned nothing — Yahoo may be rate-limiting "
                         "or temporarily blocking the screener endpoint. Try again shortly.")
    with _lock:
        _cache.update(ts=now, data=data)
    return data
