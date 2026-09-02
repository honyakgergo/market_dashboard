# ============================================================
# services/volatility.py
# The volatility cockpit that powers the live Vol page:
#   - term structure  (VIX9D · VIX · VIX3M · VIX6M)
#   - VVIX (vol-of-vol), SKEW
#   - cross-index vol  (VIX vs VXN vs RVX)
#   - VRP  (implied VIX − realized SPY vol)
#   - dispersion / correlation  → broadening vs tightening
#
# Data reality: the well-known Cboe vol indices are usually on Yahoo; the
# newer niche ones (DSPX, implied-correlation) may not be. We PROBE each
# ticker and only serve what resolves. For dispersion we always compute a
# realized cross-sectional measure from the cache (cheap, robust) and, if
# Yahoo serves DSPX/COR, surface those too.
#
# Vol index history comes from the daily cache when present, else a live
# daily fetch (memoized). Current level upgrades to the intraday last when
# the US session is open.
# ============================================================

import time
import threading
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import yfinance as yf

from services.data import _yf_lock, _load_from_cache
from services.session import market_session

# tenor label · yahoo symbol · days-to-maturity (for the curve x-axis)
TENORS = [("VIX9D", "^VIX9D", 9), ("VIX", "^VIX", 30), ("VIX3M", "^VIX3M", 90), ("VIX6M", "^VIX6M", 180)]
EXTRA_VOL = {"vvix": "^VVIX", "skew": "^SKEW", "vxn": "^VXN", "rvx": "^RVX"}
DISPERSION_TICKERS = {"dspx": "^DSPX", "cor1m": "^COR1M"}

# realized-correlation basket — liquid mega/large caps that are in the cache.
_BASKET = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "AVGO", "TSLA",
           "JPM", "XOM", "UNH", "V", "MA", "COST", "HD", "PG", "JNJ", "WMT"]

_series_cache: dict = {}          # ticker -> {"ts", "series"}
_SERIES_TTL = 3600
_probe_cache: dict = {"ts": 0.0, "resolved": None}
_PROBE_TTL = 6 * 3600
_out_cache: dict = {}             # mode -> {"ts","data"}
_TTL_LIVE, _TTL_CLOSE = 120, 900
_lock = threading.Lock()


# ------------------------------------------------------------
# series helpers
# ------------------------------------------------------------

def _daily_series(ticker: str):
    """Daily close series (~1y). Cache first, else a memoized live fetch."""
    now = time.time()
    c = _series_cache.get(ticker)
    if c and now - c["ts"] < _SERIES_TTL:
        return c["series"]

    end = datetime.now().strftime("%Y-%m-%d")
    start = (datetime.now() - timedelta(days=400)).strftime("%Y-%m-%d")
    s = None
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


def _intraday_last(ticker: str):
    acquired = _yf_lock.acquire(timeout=15)
    if not acquired:
        return None
    try:
        raw = yf.download(ticker, period="1d", interval="5m", auto_adjust=True, progress=False, threads=False)
        if raw is None or raw.empty:
            return None
        if isinstance(raw.columns, pd.MultiIndex):
            raw.columns = raw.columns.get_level_values(0)
        return float(raw["Close"].dropna().iloc[-1])
    except Exception:
        return None
    finally:
        _yf_lock.release()


def _level_and_hist(ticker: str, live: bool, n: int = 126):
    s = _daily_series(ticker)
    if s is None or not len(s):
        return None, None
    level = float(s.iloc[-1])
    if live:
        lv = _intraday_last(ticker)
        if lv is not None:
            level = lv
    tail = s.iloc[-n:]
    hist = {"dates": [str(d.date()) for d in tail.index], "values": [round(float(v), 2) for v in tail.values]}
    return round(level, 2), hist


# ------------------------------------------------------------
# probe — which vol tickers does Yahoo actually serve?
# ------------------------------------------------------------

def probe(force: bool = False) -> dict:
    now = time.time()
    if not force and _probe_cache["resolved"] is not None and now - _probe_cache["ts"] < _PROBE_TTL:
        return _probe_cache["resolved"]
    resolved = {}
    all_t = {lbl: sym for lbl, sym, _ in TENORS} | EXTRA_VOL | DISPERSION_TICKERS
    for lbl, sym in all_t.items():
        s = _daily_series(sym)
        resolved[lbl] = {"symbol": sym, "ok": bool(s is not None and len(s) > 5),
                         "last": (round(float(s.iloc[-1]), 2) if s is not None and len(s) else None)}
    _probe_cache.update({"ts": now, "resolved": resolved})
    return resolved


# ------------------------------------------------------------
# realized dispersion / correlation (always available, from cache)
# ------------------------------------------------------------

def _realized_dispersion(window: int = 21) -> dict | None:
    end = datetime.now().strftime("%Y-%m-%d")
    start = (datetime.now() - timedelta(days=120)).strftime("%Y-%m-%d")
    rets = {}
    for sym in _BASKET:
        df = _load_from_cache(sym, start, end)
        if df is not None and len(df) > window + 2:
            rets[sym] = df["Close"].astype(float).pct_change().iloc[-window:]
    if len(rets) < 5:
        return None
    R = pd.DataFrame(rets).dropna()
    if len(R) < 5:
        return None
    corr = R.corr().values
    iu = np.triu_indices_from(corr, k=1)
    avg_corr = float(np.nanmean(corr[iu]))
    # cross-sectional dispersion: stdev across names of their window returns
    period_ret = (R + 1).prod() - 1
    dispersion = float(period_ret.std())
    return {"avg_corr": round(avg_corr, 3), "dispersion": round(dispersion, 4), "n": R.shape[1], "window": window}


def _realized_vol(ticker: str, window: int = 21) -> float | None:
    s = _daily_series(ticker)
    if s is None or len(s) < window + 2:
        return None
    rv = s.pct_change().iloc[-window:].std() * np.sqrt(252) * 100
    return round(float(rv), 2) if pd.notna(rv) else None


def _realized_vol_series(ticker: str, window: int = 21):
    """Annualized rolling realized vol as a % series (RVX proxy + VRP series)."""
    s = _daily_series(ticker)
    if s is None or len(s) < window + 5:
        return None
    rv = (s.pct_change().rolling(window).std() * np.sqrt(252) * 100).dropna()
    return rv if len(rv) else None


def _vol_panel(live: bool, n: int = 180) -> dict | None:
    """Aligned VIX / VXN / RVX(proxy) history on one date axis, plus the
    equity-vol spreads (VXN-VIX, RVX-VIX) and VRP (VIX - SPY realized).
    RVX is delisted on Yahoo -> IWM realized-vol proxy, flagged as such."""
    vix = _daily_series("^VIX")
    if vix is None or len(vix) < 20:
        return None
    vxn = _daily_series("^VXN")
    rvx = _daily_series("^RVX")
    rvx_is_proxy = False
    if rvx is None or len(rvx) < 20:
        rvx = _realized_vol_series("IWM", 21)
        rvx_is_proxy = rvx is not None

    frames = {"vix": vix}
    if vxn is not None and len(vxn) > 20:
        frames["vxn"] = vxn
    if rvx is not None and len(rvx) > 20:
        frames["rvx"] = rvx
    df = pd.concat(frames, axis=1).dropna(subset=["vix"]).iloc[-n:]
    if df.empty:
        return None

    def col(name):
        if name not in df.columns:
            return None
        return [None if pd.isna(v) else round(float(v), 2) for v in df[name].values]

    def spread(a, b):
        if a not in df.columns or b not in df.columns:
            return None
        s = (df[a] - df[b]).dropna()
        if not len(s):
            return None
        return {"dates": [str(d.date()) for d in s.index],
                "values": [round(float(v), 2) for v in s.values],
                "last": round(float(s.iloc[-1]), 2)}

    vrp_series = None
    spy_rv = _realized_vol_series("SPY", 21)
    if spy_rv is not None:
        vr = pd.concat({"vix": vix, "rv": spy_rv}, axis=1).dropna().iloc[-n:]
        if len(vr):
            diff = vr["vix"] - vr["rv"]
            vrp_series = {"dates": [str(d.date()) for d in vr.index],
                          "values": [round(float(v), 2) for v in diff.values],
                          "last": round(float(diff.iloc[-1]), 2)}

    return {
        "dates": [str(d.date()) for d in df.index],
        "vix": col("vix"), "vxn": col("vxn"), "rvx": col("rvx"),
        "rvx_is_proxy": rvx_is_proxy,
        "spread_vxn_vix": spread("vxn", "vix"),
        "spread_rvx_vix": spread("rvx", "vix"),
        "vrp_series": vrp_series,
    }


# ------------------------------------------------------------
# public build
# ------------------------------------------------------------

def build_volatility(force: bool = False) -> dict:
    sess = market_session()
    live = sess["us_open"]
    key = "live" if live else "close"
    ttl = _TTL_LIVE if live else _TTL_CLOSE

    now = time.time()
    with _lock:
        cached = _out_cache.get(key)
        if not force and cached and now - cached["ts"] < ttl:
            return cached["data"]

        res = probe()

        # term structure
        curve = []
        for lbl, sym, dtm in TENORS:
            if res.get(lbl, {}).get("ok"):
                level, hist = _level_and_hist(sym, live)
                if level is not None:
                    curve.append({"label": lbl, "dtm": dtm, "level": level, "history": hist})
        vix = next((p["level"] for p in curve if p["label"] == "VIX"), None)
        vix3m = next((p["level"] for p in curve if p["label"] == "VIX3M"), None)
        contango = bool(vix3m > vix) if (vix and vix3m) else None
        term_slope = round(vix3m - vix, 2) if (vix and vix3m) else None

        # single vol gauges
        def gauge(lbl):
            if not res.get(lbl, {}).get("ok"):
                return None
            level, hist = _level_and_hist(EXTRA_VOL[lbl], live)
            return {"level": level, "history": hist}
        vvix, skew, vxn, rvx = gauge("vvix"), gauge("skew"), gauge("vxn"), gauge("rvx")

        # cross-index; RVX is delisted on Yahoo → IWM realized-vol proxy
        rvx_level = rvx["level"] if rvx else None
        rvx_proxy = _realized_vol("IWM", 21) if rvx_level is None else None
        cross = {"vix": vix, "vxn": vxn["level"] if vxn else None,
                 "rvx": rvx_level, "rvx_proxy": rvx_proxy}

        # VRP = implied (VIX) − realized (SPY 21d)
        spy_rv = _realized_vol("SPY", 21)
        vrp = round(vix - spy_rv, 2) if (vix and spy_rv) else None

        # dispersion / correlation
        realized = _realized_dispersion(21)
        dspx_ok = res.get("dspx", {}).get("ok")
        dspx_level, dspx_hist = (_level_and_hist("^DSPX", live) if dspx_ok else (None, None))
        dispersion = {
            "realized": realized,                       # always (from cache basket)
            "dspx": dspx_level,                         # Cboe S&P 500 Dispersion Index
            "dspx_history": dspx_hist,
            "implied_corr": None,                       # ^COR1M too sparse on Yahoo to trust
        }
        # broadening ↔ tightening from realized correlation (0..1)
        corr_val = realized["avg_corr"] if realized else None
        dispersion["corr_used"] = round(corr_val, 3) if corr_val is not None else None
        dispersion["state"] = (None if corr_val is None else
                               "tightening" if corr_val >= 0.55 else
                               "broadening" if corr_val <= 0.35 else "neutral")

        panel = _vol_panel(live)

        data = {
            "mode": key, "phase": sess["phase"],
            "as_of": sess["now_cet"] + " CET" if live else datetime.now().strftime("%Y-%m-%d"),
            "term_structure": curve, "vix": vix, "vix3m": vix3m,
            "contango": contango, "term_slope": term_slope,
            "vvix": vvix, "skew": skew, "vxn": vxn, "rvx": rvx,
            "cross_index": cross, "spy_realized_vol": spy_rv, "vrp": vrp,
            "dispersion": dispersion,
            "vol_panel": panel,
            "resolved": {k: v["ok"] for k, v in res.items()},
        }
        _out_cache[key] = {"ts": now, "data": data}
        return data
