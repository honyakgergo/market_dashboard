# ============================================================
# services/macro.py
# Responsible for: macro indicator fetching + composite score
#
# NOTE: This is the SwingLab 7/8-signal score, copied verbatim as the
# foundation. It will be extended in the dashboard build with FRED series
# (real yields, breakevens, net liquidity) and the VIX complex.
# ============================================================

import pandas as pd
from services.data import fetch_ohlcv
from services.indicators import compute_ma


# ------------------------------------------------------------
# Macro ticker definitions
# ------------------------------------------------------------

MACRO_TICKERS = {
    "VIX"    : "^VIX",
    "TNX"    : "^TNX",
    "IRX"    : "^IRX",
    "DXY"    : "UUP",
    "HYG"    : "HYG",
    "TLT"    : "TLT",
    "SPY"    : "SPY",
    "EURUSD" : "EURUSD=X",
}


# ------------------------------------------------------------
# Fetch all macro data
# ------------------------------------------------------------

def fetch_macro(period: str = "1y") -> dict:
    macro = {}
    for name, ticker in MACRO_TICKERS.items():
        try:
            df = fetch_ohlcv(ticker, period=period)
            last = float(df["Close"].iloc[-1])
            print(f"  MACRO {name} ({ticker}): last close = {last:.4f}")
            macro[name] = df
        except ValueError as e:
            print(f"Warning: could not fetch {name} ({ticker}): {e}")
    return macro


# ------------------------------------------------------------
# Compute macro signals
# ------------------------------------------------------------

def compute_macro_signals(macro: dict) -> pd.DataFrame:
    base_idx = macro["SPY"].index
    signals  = pd.DataFrame(index=base_idx)

    def safe_close(name):
        if name in macro:
            s = macro[name]["Close"]
            if isinstance(s, pd.DataFrame):
                s = s.iloc[:, 0]
            return s.reindex(base_idx, method="ffill")
        return None

    vix    = safe_close("VIX")
    tnx    = safe_close("TNX")
    irx    = safe_close("IRX")
    dxy    = safe_close("DXY")
    hyg    = safe_close("HYG")
    tlt    = safe_close("TLT")
    spy    = safe_close("SPY")
    eurusd = safe_close("EURUSD")

    signals["sig_vix"]         = (vix < 20).astype(int)                  if vix is not None else 0
    signals["sig_yield_curve"] = (tnx > irx).astype(int)                 if tnx is not None and irx is not None else 0
    signals["sig_dxy"]         = (dxy < compute_ma(dxy, 50)).astype(int) if dxy is not None else 0
    signals["sig_hyg"]         = (hyg > compute_ma(hyg, 50)).astype(int) if hyg is not None else 0
    signals["sig_tlt"]         = (tlt > compute_ma(tlt, 50)).astype(int) if tlt is not None else 0
    signals["sig_spy"]         = (spy > compute_ma(spy, 200)).astype(int) if spy is not None else 0
    signals["sig_eurusd"]      = (eurusd < compute_ma(eurusd, 50)).astype(int) if eurusd is not None else 0

    # Store actual values for the UI
    signals["val_vix"]         = vix if vix is not None else float('nan')
    signals["val_tnx"]         = tnx if tnx is not None else float('nan')
    signals["val_irx"]         = irx if irx is not None else float('nan')
    signals["val_dxy"]         = dxy if dxy is not None else float('nan')
    signals["val_dxy_ma50"]    = compute_ma(dxy, 50) if dxy is not None else float('nan')
    signals["val_hyg"]         = hyg if hyg is not None else float('nan')
    signals["val_hyg_ma50"]    = compute_ma(hyg, 50) if hyg is not None else float('nan')
    signals["val_tlt"]         = tlt if tlt is not None else float('nan')
    signals["val_tlt_ma50"]    = compute_ma(tlt, 50) if tlt is not None else float('nan')
    signals["val_spy"]         = spy if spy is not None else float('nan')
    signals["val_spy_ma200"]   = compute_ma(spy, 200) if spy is not None else float('nan')
    signals["val_eurusd"]      = eurusd if eurusd is not None else float('nan')
    signals["val_eurusd_ma50"] = compute_ma(eurusd, 50) if eurusd is not None else float('nan')

    signals["score"]  = signals.filter(like="sig_").sum(axis=1)
    signals["regime"] = signals["score"].apply(lambda s: "risk_on" if s >= 4 else "risk_off")

    return signals


# ------------------------------------------------------------
# Get current macro state
# ------------------------------------------------------------

def get_current_macro_state(signals: pd.DataFrame) -> dict:
    latest   = signals.iloc[-1]
    sig_cols = [c for c in signals.columns if c.startswith("sig_")]
    val_cols = [c for c in signals.columns if c.startswith("val_")]

    return {
        "date"   : str(signals.index[-1].date()),
        "score"  : int(latest["score"]),
        "regime" : latest["regime"],
        "signals": {col: int(latest[col]) for col in sig_cols},
        "values" : {col: round(float(latest[col]), 4) if pd.notna(latest[col]) else None for col in val_cols},
    }


# ============================================================
# FRED + VIX-complex extension
# Adds real yields, breakevens, net liquidity, and the VIX term structure.
# FRED key is read from the environment (.env via python-dotenv). If it's
# missing, the FRED fields return None and the rest still works.
# ============================================================

import os
import time
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except Exception:
    pass

from services.data import _load_from_cache
from datetime import datetime, timedelta

# FRED series IDs
_FRED = {
    "real_yield_10y": "DFII10",     # 10y TIPS yield (%)
    "breakeven_10y":  "T10YIE",     # 10y breakeven inflation (%)
    "fed_assets":     "WALCL",      # Fed balance sheet ($ millions)
    "tga":            "WTREGEN",    # Treasury General Account ($ billions)
    "rrp":            "RRPONTSYD",  # Overnight reverse repo ($ billions)
}

_ext_cache = {"ts": 0.0, "data": None}
_EXT_TTL = 1800  # 30 min


def _fred():
    key = os.getenv("FRED_API_KEY")
    if not key or key == "your_fred_api_key_here":
        return None
    try:
        from fredapi import Fred
        return Fred(api_key=key)
    except Exception:
        return None


def fred_status() -> str:
    """Human-readable diagnostic for the startup log.

    Actually exercises the API rather than just checking that a key exists — a
    key can be present and every call still fail (see _fred_http on the Windows
    certificate-store problem), and a startup line saying "key loaded" while
    every FRED panel is silently blank is worse than no line at all.
    """
    key = os.getenv("FRED_API_KEY")
    if not key or key == "your_fred_api_key_here":
        return "key NOT found in environment (.env not loaded or var unset)"
    probe = fetch_fred_series("DFII10", years=1)
    if probe is None or not len(probe):
        return f"key loaded (…{key[-4:]}) but the API call FAILED — {fred_last_error()}"
    return f"key loaded and working ✓ (…{key[-4:]}, DFII10 last {probe.index[-1].date()})"


_fred_series_cache: dict = {}
_FRED_SERIES_TTL = 6 * 3600
_fred_last_error: str | None = None

FRED_API = "https://api.stlouisfed.org/fred/series/observations"


def fred_last_error() -> str | None:
    """Why the most recent FRED fetch failed, if it did. Surfaced to the UI so a
    dead FRED panel says what is actually wrong instead of guessing."""
    return _fred_last_error


def _fred_http(series_id: str, start: str):
    """Fetch a FRED series over HTTPS with `requests`.

    Deliberately NOT via fredapi. fredapi calls urllib's `urlopen`, which on
    Windows builds verifies against the system certificate store — and a single
    malformed certificate in that store makes every call die with
    `SSLError [ASN1: NOT_ENOUGH_DATA]`, no matter how valid the API key is.
    `requests` verifies against certifi's bundled CA file instead, which is why
    yfinance keeps working in exactly the environments where fredapi does not.

    Returns a pandas Series, or None (with the reason recorded in
    _fred_last_error).
    """
    global _fred_last_error
    import pandas as pd

    key = os.getenv("FRED_API_KEY")
    if not key or key == "your_fred_api_key_here":
        _fred_last_error = "no FRED_API_KEY in backend/.env"
        return None
    try:
        import requests
    except Exception:
        _fred_last_error = "the `requests` package is not installed"
        return None

    try:
        r = requests.get(FRED_API, timeout=20, params={
            "series_id": series_id, "api_key": key, "file_type": "json",
            "observation_start": start,
        })
        if r.status_code != 200:
            _fred_last_error = f"FRED returned HTTP {r.status_code} for {series_id}"
            return None
        obs = r.json().get("observations") or []
    except Exception as e:
        _fred_last_error = f"{type(e).__name__}: {e}"
        return None

    rows = [(o["date"], float(o["value"])) for o in obs if o.get("value") not in (None, ".", "")]
    if not rows:
        _fred_last_error = f"FRED returned no usable observations for {series_id}"
        return None

    s = pd.Series([v for _, v in rows], index=pd.to_datetime([d for d, _ in rows]))
    _fred_last_error = None
    return s


def fetch_fred_series(series_id: str, years: int = 5):
    """Full FRED series as a pandas Series, memoized for six hours.

    FRED daily series update once a day at most and several dashboard surfaces
    want the same real-yield / breakeven history. Returns None when FRED is
    unavailable, so every FRED-backed panel must treat its data as optional —
    call fred_last_error() to tell the user why.
    """
    key = f"{series_id}:{years}"
    hit = _fred_series_cache.get(key)
    if hit and time.time() - hit["ts"] < _FRED_SERIES_TTL:
        return hit["series"]

    start = (datetime.now() - timedelta(days=int(years * 366))).strftime("%Y-%m-%d")
    s = _fred_http(series_id, start)

    # Last resort: if the HTTP path failed for some non-SSL reason, fredapi may
    # still work (e.g. behind a proxy that only it is configured for).
    if s is None:
        fred = _fred()
        if fred is not None:
            try:
                import pandas as pd
                raw = fred.get_series(series_id, observation_start=start)
                if raw is not None and len(raw):
                    s = pd.Series(raw).dropna().astype(float)
                    s.index = pd.to_datetime(s.index)
            except Exception:
                s = None

    _fred_series_cache[key] = {"ts": time.time(), "series": s}
    return s


def _series(fred, sid):
    """Return (latest, value ~21 obs ago) for a FRED series, or (None, None).

    `fred` is accepted for call-compatibility but no longer used: everything
    routes through fetch_fred_series so the whole app shares one cache and one
    working transport.
    """
    s = fetch_fred_series(sid, years=3)
    if s is None or not len(s):
        return None, None
    s = s.dropna()
    if s.empty:
        return None, None
    latest = float(s.iloc[-1])
    prev = float(s.iloc[-22]) if len(s) > 22 else None
    return latest, prev


def _vix_complex():
    end = datetime.now().strftime("%Y-%m-%d")
    v = _load_from_cache("^VIX", "2000-01-01", end)
    v3 = _load_from_cache("^VIX3M", "2000-01-01", end)
    vix = float(v["Close"].iloc[-1]) if v is not None and len(v) else None
    vix3m = float(v3["Close"].iloc[-1]) if v3 is not None and len(v3) else None
    out = {"vix": round(vix, 2) if vix else None, "vix3m": round(vix3m, 2) if vix3m else None,
           "term_spread": None, "contango": None, "ratio": None}
    if vix and vix3m:
        out["term_spread"] = round(vix3m - vix, 2)
        out["contango"] = bool(vix3m > vix)        # normal/calm when in contango
        out["ratio"] = round(vix / vix3m, 3)

    def _ser(df, n=126):
        if df is None or not len(df):
            return None
        s = df["Close"].iloc[-n:]
        return {"dates": [str(d.date()) for d in s.index], "values": [round(float(x), 2) for x in s.values]}
    out["vix_series"] = _ser(v)
    out["vix3m_series"] = _ser(v3)
    return out


def build_macro_extended(force: bool = False) -> dict:
    now = time.time()
    if not force and _ext_cache["data"] and (now - _ext_cache["ts"] < _EXT_TTL):
        return _ext_cache["data"]

    # Availability is decided by whether a real fetch SUCCEEDS, not by whether a
    # fredapi client could be constructed. Those are different questions: a key
    # can be present and every call still fail (see _fred_http), which used to
    # leave this block reporting available=True over a wall of nulls.
    probe = fetch_fred_series(_FRED["real_yield_10y"], years=3)
    ok = probe is not None and len(probe) > 0
    fred_block = {"available": ok}
    if not ok:
        fred_block["reason"] = fred_last_error() or "FRED returned no data"
    net_liq = None
    if ok:
        fred = None                                              # kept for _series' signature
        ry, ry_p = _series(fred, _FRED["real_yield_10y"])
        be, be_p = _series(fred, _FRED["breakeven_10y"])
        assets, assets_p = _series(fred, _FRED["fed_assets"])   # $ millions
        tga, tga_p = _series(fred, _FRED["tga"])                 # $ billions
        rrp, rrp_p = _series(fred, _FRED["rrp"])                 # $ billions

        def net(a, t, rp):
            if a is None or t is None or rp is None:
                return None
            # All three FRED series come back in $ millions in practice;
            # convert the combination to $ billions.
            return (a - t - rp) / 1000

        net_liq = net(assets, tga, rrp)
        net_liq_prev = net(assets_p, tga_p, rrp_p)
        fred_block.update({
            "real_yield_10y": ry, "real_yield_10y_chg": (round(ry - ry_p, 2) if ry and ry_p else None),
            "breakeven_10y": be, "breakeven_10y_chg": (round(be - be_p, 2) if be and be_p else None),
            "net_liquidity_bn": round(net_liq, 1) if net_liq else None,
            "net_liquidity_chg_bn": round(net_liq - net_liq_prev, 1) if (net_liq and net_liq_prev) else None,
        })

        # Short histories for the trend sparklines. These go through
        # fetch_fred_series like everything else — calling fred.get_series here
        # was why the sparklines stayed null even once the numbers appeared.
        def _hist(sid, n=180):
            s = fetch_fred_series(sid, years=3)
            if s is None or not len(s):
                return None
            s = s.dropna().iloc[-n:]
            return {"dates": [str(d.date()) for d in s.index],
                    "values": [round(float(v), 3) for v in s.values]}
        fred_block["real_yield_series"] = _hist(_FRED["real_yield_10y"])
        fred_block["breakeven_series"] = _hist(_FRED["breakeven_10y"])
        try:
            import pandas as _pd
            legs = {k: fetch_fred_series(_FRED[k], years=3)
                    for k in ("fed_assets", "tga", "rrp")}
            if all(v is not None and len(v) for v in legs.values()):
                nl = _pd.concat([
                    legs["fed_assets"].rename("a"),
                    legs["tga"].rename("t"),
                    legs["rrp"].rename("r"),
                ], axis=1).ffill().dropna()
                nls = ((nl["a"] - nl["t"] - nl["r"]) / 1000).iloc[-180:]
                fred_block["net_liquidity_series"] = {
                    "dates": [str(d.date()) for d in nls.index],
                    "values": [round(float(v), 1) for v in nls.values]}
            else:
                fred_block["net_liquidity_series"] = None
        except Exception:
            fred_block["net_liquidity_series"] = None

    data = {"as_of": datetime.now().strftime("%Y-%m-%d"), "fred": fred_block, "vix_complex": _vix_complex()}
    _ext_cache["ts"] = now
    _ext_cache["data"] = data
    return data


def get_macro_history(signals: pd.DataFrame, days: int = 252) -> dict:
    """Composite-score, regime, and SPY time series for the macro overlay."""
    sig_cols = [c for c in signals.columns if c.startswith("sig_")]
    s = signals.iloc[-days:]
    spy = s["val_spy"] if "val_spy" in s.columns else None
    return {
        "dates": [str(d.date()) for d in s.index],
        "score": [int(v) for v in s["score"]],
        "regime": [str(v) for v in s["regime"]],
        "spy": ([None if pd.isna(v) else round(float(v), 2) for v in spy] if spy is not None else None),
        "max_score": len(sig_cols),
    }
