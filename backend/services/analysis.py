# ============================================================
# services/analysis.py
# Per-ticker analyst & fundamentals bundle for the Ticker Detail page.
# Everything here is single-equity and US-coverage-dependent, so each block
# returns None when Yahoo has no data — the frontend renders only what exists
# (ETFs / futures / crypto / most EU names simply won't populate).
#
#   - recommendations : analyst consensus (strongBuy…strongSell) + drift
#   - price_target    : low / mean / high / median targets + implied upside
#   - earnings        : next date + last surprise (computed from est vs actual)
#   - short           : short % of float, days-to-cover, MoM change
#   - profile         : name / sector / industry / market cap
#
# All yfinance access is serialised under the shared _yf_lock (not thread
# safe) and memoised per-ticker (analyst data moves slowly).
# ============================================================

import time
import threading
from datetime import datetime

import pandas as pd
import yfinance as yf

from services.data import _yf_lock

_cache: dict = {}
_TTL = 1800  # 30 min — analyst/estimate data barely moves intraday
_lock = threading.Lock()

REC_ORDER = ["strongBuy", "buy", "hold", "sell", "strongSell"]
REC_WEIGHT = {"strongBuy": 1, "buy": 2, "hold": 3, "sell": 4, "strongSell": 5}


def _num(x):
    """Coerce to float or None (handles NaN / numpy / bad types)."""
    try:
        if x is None:
            return None
        if isinstance(x, float) and pd.isna(x):
            return None
        return float(x)
    except Exception:
        return None


def _consensus_label(mean):
    if mean is None:
        return None
    if mean <= 1.5:
        return "Strong Buy"
    if mean <= 2.5:
        return "Buy"
    if mean <= 3.5:
        return "Hold"
    if mean <= 4.5:
        return "Sell"
    return "Strong Sell"


def _recommendations(t):
    try:
        df = t.recommendations
    except Exception:
        return None
    if df is None or len(df) == 0:
        return None
    df = df.copy()
    if "period" in df.columns:
        df = df.set_index("period")

    periods = []
    for idx, row in df.iterrows():
        dist = {}
        for k in REC_ORDER:
            if k in row and not pd.isna(row[k]):
                try:
                    dist[k] = int(row[k])
                except Exception:
                    pass
        total = sum(dist.values())
        if total == 0:
            continue
        wsum = sum(REC_WEIGHT[k] * v for k, v in dist.items())
        periods.append({"period": str(idx), "distribution": dist,
                        "total": total, "mean": round(wsum / total, 2)})
    if not periods:
        return None

    cur = periods[0]
    trend = None
    if len(periods) > 1:
        # positive => consensus improving (mean falling toward "buy")
        trend = round(periods[1]["mean"] - cur["mean"], 2)
    return {
        "consensus": _consensus_label(cur["mean"]),
        "mean": cur["mean"],
        "total": cur["total"],
        "distribution": cur["distribution"],
        "trend": trend,
        "history": periods[:4],
    }


def _price_target(t, info):
    pt = None
    try:
        pt = t.analyst_price_targets
    except Exception:
        pt = None
    cur = low = high = mean = median = None
    if isinstance(pt, dict) and pt:
        cur = _num(pt.get("current"))
        low = _num(pt.get("low"))
        high = _num(pt.get("high"))
        mean = _num(pt.get("mean"))
        median = _num(pt.get("median"))

    info = info or {}
    if cur is None:
        cur = _num(info.get("currentPrice"))
    if mean is None:
        mean = _num(info.get("targetMeanPrice"))
    if low is None:
        low = _num(info.get("targetLowPrice"))
    if high is None:
        high = _num(info.get("targetHighPrice"))
    if median is None:
        median = _num(info.get("targetMedianPrice"))

    if mean is None:
        return None
    n = info.get("numberOfAnalystOpinions")
    upside = round(mean / cur - 1, 4) if (mean and cur) else None
    return {
        "current": cur, "low": low, "mean": mean, "high": high, "median": median,
        "n_analysts": int(n) if n else None, "upside": upside,
    }


def _earnings(t):
    out = {"next_date": None, "last": None, "history": []}
    df = None
    try:
        df = t.earnings_dates
    except Exception:
        df = None

    today = pd.Timestamp.now().normalize()
    if df is not None and len(df):
        d = df.copy()
        try:
            d.index = pd.to_datetime(d.index)
            if getattr(d.index, "tz", None) is not None:
                d.index = d.index.tz_localize(None)
        except Exception:
            pass

        def _col(row, *names):
            for c in names:
                if c in row and not pd.isna(row[c]):
                    return _num(row[c])
            return None

        def _surprise(est, act):
            if est is None or act is None or est == 0:
                return None
            return round((act - est) / abs(est) * 100, 1)

        try:
            future = d[d.index > today].sort_index()
            if len(future):
                out["next_date"] = str(future.index[0].date())
        except Exception:
            pass

        try:
            past = d[d.index <= today].sort_index(ascending=False)
            if len(past):
                r0 = past.iloc[0]
                est = _col(r0, "EPS Estimate")
                act = _col(r0, "Reported EPS")
                out["last"] = {
                    "date": str(past.index[0].date()),
                    "eps_est": est, "eps_act": act,
                    "surprise_pct": _surprise(est, act),
                }
                hist = []
                for dt, row in past.head(6).iterrows():
                    sp = _surprise(_col(row, "EPS Estimate"), _col(row, "Reported EPS"))
                    if sp is not None:
                        hist.append({"date": str(dt.date()), "surprise_pct": sp})
                out["history"] = hist[:4]
        except Exception:
            pass

    if out["next_date"] is None:
        try:
            cal = t.calendar
            if isinstance(cal, dict):
                ed = cal.get("Earnings Date")
                if ed:
                    d0 = ed[0] if isinstance(ed, (list, tuple)) else ed
                    out["next_date"] = str(pd.to_datetime(d0).date())
        except Exception:
            pass

    if out["next_date"] is None and out["last"] is None:
        return None
    return out


def _short(info):
    info = info or {}
    pct = _num(info.get("shortPercentOfFloat"))
    days = _num(info.get("shortRatio"))
    shares = info.get("sharesShort")
    prev = info.get("sharesShortPriorMonth")
    if pct is None and days is None and not shares:
        return None
    out = {
        "pct_float": round(pct, 4) if pct is not None else None,
        "days_to_cover": round(days, 2) if days is not None else None,
        "shares_short": int(shares) if shares else None,
        "prior_month": int(prev) if prev else None,
        "chg_pct": round(shares / prev - 1, 4) if (shares and prev) else None,
    }
    asof = info.get("dateShortInterest")
    if asof:
        try:
            out["as_of"] = str(pd.to_datetime(asof, unit="s").date()) if isinstance(asof, (int, float)) else str(asof)
        except Exception:
            pass
    return out


def _profile(info):
    info = info or {}
    name = info.get("longName") or info.get("shortName")
    sector = info.get("sector")
    industry = info.get("industry")
    mcap = _num(info.get("marketCap"))
    emp = info.get("fullTimeEmployees")
    if not any([name, sector, industry, mcap]):
        return None
    return {
        "name": name, "sector": sector, "industry": industry,
        "market_cap": mcap, "employees": int(emp) if emp else None,
        "currency": info.get("currency"),
    }


def build_analysis(ticker: str, force: bool = False) -> dict:
    sym = (ticker or "").strip().upper()
    if not sym:
        return {"symbol": sym, "available": False}

    now = time.time()
    with _lock:
        c = _cache.get(sym)
        if not force and c and now - c["ts"] < _TTL:
            return c["data"]

    info = recs = pt = earn = None
    acquired = _yf_lock.acquire(timeout=30)
    try:
        t = yf.Ticker(sym)
        try:
            info = t.info
        except Exception:
            info = None
        recs = _recommendations(t)
        pt = _price_target(t, info)
        earn = _earnings(t)
    except Exception:
        pass
    finally:
        if acquired:
            _yf_lock.release()

    short = _short(info)
    prof = _profile(info)

    data = {
        "symbol": sym,
        "recommendations": recs,
        "price_target": pt,
        "earnings": earn,
        "short": short,
        "profile": prof,
        # "available" = has real analyst/positioning content. Profile alone
        # (name/sector) doesn't count — ETFs & indices carry a name but no
        # coverage, and we don't want an empty panel to render for them.
        "available": any([recs, pt, earn, short]),
        "as_of": datetime.utcnow().isoformat(),
    }
    with _lock:
        _cache[sym] = {"ts": now, "data": data}
    return data
