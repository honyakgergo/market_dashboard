# ============================================================
# services/fundamentals.py
# Per-ticker fundamentals for the Ticker "Fundamentals" view. Deliberately
# lean — the metrics that actually drive a research call, not a ratio dump:
#   - income      : revenue / net income / EPS per period (annual + quarterly)
#   - valuation   : the core multiples (P/E, fwd P/E, P/S, EV/EBITDA, PEG,
#                   div yield), each with a percentile vs its OWN 5y history
#   - pe_band     : trailing-P/E time series + mean/σ ("cheap vs itself")
#
# Yahoo serves only ~4 annual / ~5 quarterly statement periods, but
# get_valuation_measures(freq='monthly') gives a longer multiple history —
# that's what powers the percentiles and the P/E band. US-large-cap-rich;
# absent for ETFs / futures / most EU names (frontend renders nothing then).
# Cached 12h (fundamentals barely move); all yfinance under _yf_lock.
# ============================================================

import time
import threading
import bisect

import numpy as np
import pandas as pd
import yfinance as yf

from services.data import _yf_lock, fetch_ohlcv
from services import edgar

_cache: dict = {}
_TTL = 43200  # 12h
_lock = threading.Lock()


def _num(x):
    try:
        if x is None:
            return None
        v = float(x)
        return None if pd.isna(v) else v
    except Exception:
        return None


def _row(df, *names):
    """Fetch a statement row by exact name, else loose contains-match."""
    if df is None or getattr(df, "empty", True):
        return None
    for n in names:
        if n in df.index:
            return df.loc[n]
    low = {str(i).lower(): i for i in df.index}
    for n in names:
        for k, orig in low.items():
            if n.lower() in k:
                return df.loc[orig]
    return None


def _statement(df):
    """Income statement DataFrame -> [{date, revenue, net_income, eps}] oldest→newest."""
    if df is None or getattr(df, "empty", True):
        return []
    rev = _row(df, "Total Revenue")
    ni = _row(df, "Net Income", "Net Income Common Stockholders")
    eps = _row(df, "Diluted EPS", "Basic EPS")
    out = []
    for c in reversed(list(df.columns)):
        try:
            d = str(pd.to_datetime(c).date())
        except Exception:
            continue
        out.append({
            "date": d,
            "revenue": _num(rev.get(c)) if rev is not None else None,
            "net_income": _num(ni.get(c)) if ni is not None else None,
            "eps": _num(eps.get(c)) if eps is not None else None,
        })
    return out


# core multiples: key · display label · valuation-measures row match · info fallback
_SPECS = [
    ("pe",        "Trailing P/E", ["trailing p/e"],              "trailingPE"),
    ("fpe",       "Forward P/E",  ["forward p/e"],               "forwardPE"),
    ("ps",        "Price / Sales", ["price/sales"],              "priceToSalesTrailing12Months"),
    ("ev_ebitda", "EV / EBITDA",  ["enterprise value/ebitda"],   "enterpriseToEbitda"),
    ("peg",       "PEG",          ["peg"],                       "pegRatio"),
]


def _valuation(t, info):
    info = info or {}
    vm = None
    try:
        vm = t.get_valuation_measures(freq="monthly", periods=60)
    except Exception:
        vm = None

    def measure_row(matches):
        if vm is None or getattr(vm, "empty", True):
            return None
        idx = {str(i).lower(): i for i in vm.index}
        for m in matches:
            for k, orig in idx.items():
                if m in k:
                    return vm.loc[orig]
        return None

    def current_and_pctile(row):
        if row is None:
            return (None, None)
        cur = _num(row.get("Current"))
        hist = [_num(row[c]) for c in row.index if c != "Current"]
        hist = [h for h in hist if h is not None and h > 0]
        if cur is None and hist:
            cur = hist[-1]
        pctile = None
        if cur is not None and len(hist) >= 8:
            pctile = round(sum(1 for h in hist if h <= cur) / len(hist), 2)
        return (cur, pctile)

    items = []
    for key, label, match, infofield in _SPECS:
        cur, pctile = current_and_pctile(measure_row(match))
        if cur is None:
            cur = _num(info.get(infofield))
            pctile = None
        if cur is not None and cur > 0:
            items.append({"key": key, "label": label, "value": round(cur, 2), "pctile": pctile})

    # dividend yield — prefer the clean fractional field
    dy = _num(info.get("trailingAnnualDividendYield"))
    if dy is None:
        raw = _num(info.get("dividendYield"))
        if raw is not None:
            dy = raw / 100.0 if raw > 1 else raw
    if dy:
        items.append({"key": "div", "label": "Div yield", "value": round(dy, 4), "pctile": None, "is_pct": True})

    # trailing-P/E band (monthly history) + mean/σ
    pe_band = None
    pe_row = measure_row(["trailing p/e"])
    if pe_row is not None:
        pts = []
        for c in pe_row.index:
            if c == "Current":
                continue
            v = _num(pe_row[c])
            if v is not None and v > 0:
                try:
                    pts.append((pd.to_datetime(c), v))
                except Exception:
                    pass
        pts.sort(key=lambda x: x[0])
        if len(pts) >= 8:
            vals = [v for _, v in pts]
            pe_band = {
                "dates": [str(d.date()) for d, _ in pts],
                "pe": [round(v, 2) for _, v in pts],
                "mean": round(float(np.mean(vals)), 2),
                "sd": round(float(np.std(vals)), 2),
                "last": round(vals[-1], 2),
            }
    return items, pe_band


def _merge(rev, ni, eps):
    """Merge EDGAR revenue/net-income/EPS series (each [{date,val}]) into
    [{date, revenue, net_income, eps}], keeping only periods that have revenue."""
    by = {}
    for r in rev or []:
        by.setdefault(r["date"], {})["revenue"] = r["val"]
    for r in ni or []:
        by.setdefault(r["date"], {})["net_income"] = r["val"]
    for r in eps or []:
        by.setdefault(r["date"], {})["eps"] = r["val"]
    out = []
    for d, v in sorted(by.items()):
        if v.get("revenue") is None:
            continue
        out.append({"date": d, "revenue": v.get("revenue"),
                    "net_income": v.get("net_income"), "eps": v.get("eps")})
    return out


def _ttm(eps_q):
    """Rolling 4-quarter EPS -> [{date, val=ttm}] (needs 4 clean quarters)."""
    s = sorted(eps_q or [], key=lambda x: x["date"])
    vals = [x["val"] for x in s]
    out = []
    for i in range(3, len(s)):
        w = vals[i - 3:i + 1]
        if all(x is not None for x in w):
            out.append({"date": s[i]["date"], "val": round(sum(w), 4)})
    return out


def _reconstruct_pe_band(sym, eps_ttm):
    """Fallback P/E history when get_valuation_measures is empty: monthly price
    / trailing-TTM-EPS (as-of that month), with mean/σ."""
    if not eps_ttm or len(eps_ttm) < 4:
        return None
    try:
        df = fetch_ohlcv(sym, period="5y", use_cache=True, warmup=False)
    except Exception:
        return None
    if df is None or df.empty:
        return None
    close = df["Close"]
    if hasattr(close, "columns"):
        close = close.iloc[:, 0]
    monthly = close.groupby(close.index.to_period("M")).last()
    dates = [pd.Timestamp(x["date"]) for x in eps_ttm]
    vals = [x["val"] for x in eps_ttm]
    pts = []
    for period, px in monthly.items():
        dt = period.to_timestamp(how="end").normalize()
        i = bisect.bisect_right(dates, dt) - 1
        if i >= 0 and vals[i] and vals[i] > 0:
            pe = float(px) / vals[i]
            if 0 < pe < 500:
                pts.append((dt, pe))
    if len(pts) < 8:
        return None
    vv = [p for _, p in pts]
    return {
        "dates": [str(d.date()) for d, _ in pts],
        "pe": [round(x, 2) for x in vv],
        "mean": round(float(np.mean(vv)), 2),
        "sd": round(float(np.std(vv)), 2),
        "last": round(vv[-1], 2),
    }


def build_fundamentals(ticker: str, force: bool = False) -> dict:
    sym = (ticker or "").strip().upper()
    if not sym:
        return {"symbol": sym, "available": False}

    now = time.time()
    with _lock:
        c = _cache.get(sym)
        if not force and c and now - c["ts"] < _TTL:
            return c["data"]

    # --- yfinance: info, valuation multiples, statement fallback (under lock) ---
    info, items, pe_band = None, [], None
    yf_annual, yf_quarterly = [], []
    acquired = _yf_lock.acquire(timeout=40)
    try:
        t = yf.Ticker(sym)
        try:
            info = t.info
        except Exception:
            info = None
        try:
            yf_annual = _statement(t.income_stmt)
        except Exception:
            yf_annual = []
        try:
            yf_quarterly = _statement(t.quarterly_income_stmt)
        except Exception:
            yf_quarterly = []
        try:
            items, pe_band = _valuation(t, info)
        except Exception:
            items, pe_band = [], None
    except Exception:
        pass
    finally:
        if acquired:
            _yf_lock.release()

    # --- EDGAR: deep quarterly/annual history (no lock; independent of yfinance) ---
    annual, quarterly, eps_ttm = yf_annual, yf_quarterly, []
    cik = None
    try:
        cik = edgar.cik_for(sym)
    except Exception:
        cik = None
    if cik:
        try:
            rq = edgar.revenue_quarterly(cik)
            if rq:
                niq = []
                try:
                    niq = edgar.net_income_quarterly(cik)
                except Exception:
                    niq = []
                epq = []
                try:
                    epq = edgar.eps_quarterly(cik)
                except Exception:
                    epq = []
                merged = _merge(rq, niq, epq)
                if merged:
                    quarterly = merged
                eps_ttm = _ttm(epq)
        except Exception:
            pass
        try:
            ra = edgar.revenue_annual(cik)
            if ra:
                nia = []
                try:
                    nia = edgar.net_income_annual(cik)
                except Exception:
                    nia = []
                merged = _merge(ra, nia, [])
                if merged:
                    annual = merged
        except Exception:
            pass

    # --- P/E band: prefer Yahoo valuation-measures, else reconstruct from EDGAR ---
    if not pe_band and eps_ttm:
        try:
            pe_band = _reconstruct_pe_band(sym, eps_ttm)
        except Exception:
            pe_band = None

    has_income = any(r.get("revenue") is not None for r in (annual + quarterly))
    data = {
        "symbol": sym,
        "income": {"annual": annual, "quarterly": quarterly},
        "valuation": {"items": items},
        "pe_band": pe_band,
        "eps_ttm": eps_ttm,
        "available": bool(has_income or items),
    }
    with _lock:
        _cache[sym] = {"ts": now, "data": data}
    return data
