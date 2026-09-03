# ============================================================
# services/commodities.py
# Commodities — built around the questions a commodity actually answers,
# not around another rebased line chart.
#
# What it computes
#   board        one row per commodity: price, returns, where it sits in its
#                52-week range, trend vs MA50/MA200, realized vol + vol
#                percentile, and a distance-from-high read
#   curve        front-vs-deferred futures spread per complex = CONTANGO or
#                BACKWARDATION. This is the single most informative commodity
#                signal there is: backwardation means physical scarcity now,
#                contango means the market is paying you to store it. It also
#                sets the sign of roll yield, which is why a spot rally can
#                still leave a long-only ETF holder flat.
#   ratios       the macro ratios (gold/silver, copper/gold, gold/oil ...) with
#                a 5-YEAR PERCENTILE, so "1.9" becomes "stretched"
#   real_assets  gold against the 10y real yield — gold's actual driver
#   seasonality  average calendar-month return over ~10y per commodity; the one
#                asset class where seasonality is a real supply-side effect
#                (heating demand, harvests, driving season) rather than folklore
#   correlation  cross-commodity correlation, to see whether the complex is
#                trading as one macro/dollar trade or on its own fundamentals
#
# Continuous futures (=F) and crypto aren't in the warm daily cache, so history
# comes through data.daily_close_series, which refuses to serve a stale cache.
# ============================================================

import time
import threading
from datetime import datetime

import numpy as np
import pandas as pd
import yfinance as yf

from services.data import _yf_lock, daily_close_series
from services.session import market_session

# label · yahoo symbol · group   (order = board/legend order)
INSTRUMENTS = [
    ("Gold",          "GC=F", "Metals"),
    ("Silver",        "SI=F", "Metals"),
    ("Copper",        "HG=F", "Metals"),
    ("Platinum",      "PL=F", "Metals"),
    ("WTI crude",     "CL=F", "Energy"),
    ("Brent",         "BZ=F", "Energy"),
    ("Nat gas",       "NG=F", "Energy"),
    ("Gasoline",      "RB=F", "Energy"),
    ("Corn",          "ZC=F", "Agriculture"),
    ("Wheat",         "ZW=F", "Agriculture"),
    ("Soybeans",      "ZS=F", "Agriculture"),
    ("Coffee",        "KC=F", "Agriculture"),
    ("Sugar",         "SB=F", "Agriculture"),
    ("Cattle",        "LE=F", "Agriculture"),
    ("Bitcoin",       "BTC-USD", "Reference"),
    ("Long Treasury", "TLT", "Reference"),
    ("US dollar",     "UUP", "Reference"),
]

GROUP_ORDER = ["Metals", "Energy", "Agriculture", "Reference"]

# label · numerator · denominator · what a RISE in the ratio means
RATIOS = [
    ("Gold / Silver", "GC=F", "SI=F",
     "Silver underperforming gold — monetary stress, weak industrial demand"),
    ("Copper / Gold", "HG=F", "GC=F",
     "Growth being priced over fear — historically tracks real yields"),
    ("Gold / Crude", "GC=F", "CL=F",
     "Store-of-value bid over the growth/energy complex"),
    ("Gold / Bitcoin", "GC=F", "BTC-USD",
     "Old store of value winning over the new one"),
    ("Crude / Nat gas", "CL=F", "NG=F",
     "Oil bid relative to gas — the energy complex is not moving as one"),
]

# Roll yield, measured the only way Yahoo reliably supports.
#
# Yahoo does not serve a usable deferred-contract series (dated symbols like
# CLZ25.NYM come and go, and there is no continuous 2nd-month feed), so instead
# of inventing a curve we MEASURE ITS CONSEQUENCE. A front-month futures ETF
# holds the contract and rolls it; the front-month continuous price does not.
# Their ratio therefore drifts by exactly the realised roll yield:
#
#     ETF / front-month falling  ->  contango,        long-only holders bleed
#     ETF / front-month rising   ->  backwardation,   the roll pays them
#
# That is the number that actually decides whether being long the complex works,
# and both legs are symbols Yahoo serves every day.
# label · futures ETF · front-month continuous
ROLL_PAIRS = [
    ("WTI crude", "USO", "CL=F"),
    ("Nat gas",   "UNG", "NG=F"),
]

# Gold's actual driver: the 10-year TIPS real yield (FRED series DFII10, already
# fetched by services.macro). Nominal rates matter far less.
REAL_YIELD_FRED = "DFII10"

_series_cache: dict = {}
_SERIES_TTL = 3600
_out_cache: dict = {}
_TTL_LIVE, _TTL_CLOSE = 150, 900
_curve_cache: dict = {"ts": 0.0, "data": None}
_CURVE_TTL = 3600
_lock = threading.Lock()


# ------------------------------------------------------------
# series
# ------------------------------------------------------------

def _daily(ticker: str, days: int = 3800):
    """Long daily history (~10y for seasonality), memoized for an hour."""
    now = time.time()
    c = _series_cache.get(ticker)
    if c and now - c["ts"] < _SERIES_TTL:
        return c["series"]
    s = daily_close_series(ticker, days=days, min_rows=40)
    _series_cache[ticker] = {"ts": now, "series": s}
    return s


def _pctile(series: pd.Series, value: float, lookback: int) -> float | None:
    if series is None or value is None:
        return None
    tail = series.dropna().iloc[-lookback:]
    if len(tail) < 40:
        return None
    return round(float((tail < value).sum()) / len(tail), 3)


# ------------------------------------------------------------
# board — the "what is actually going on" table
# ------------------------------------------------------------

def _board_row(label: str, sym: str, group: str) -> dict | None:
    s = _daily(sym)
    if s is None or len(s) < 60:
        return None
    s = s.dropna()
    last = float(s.iloc[-1])

    def ret(n):
        return round(last / float(s.iloc[-1 - n]) - 1, 4) if len(s) > n else None

    year0 = f"{datetime.now().year}-01-01"
    yr = s[s.index >= year0]
    ytd = round(last / float(yr.iloc[0]) - 1, 4) if len(yr) > 1 else None

    win52 = s.iloc[-252:] if len(s) >= 252 else s
    hi, lo = float(win52.max()), float(win52.min())
    # Position in the 52-week range: 0 = at the low, 1 = at the high. The single
    # fastest way to read a whole complex at a glance.
    rng_pos = round((last - lo) / (hi - lo), 3) if hi > lo else None

    ma50 = float(s.rolling(50).mean().iloc[-1]) if len(s) >= 50 else None
    ma200 = float(s.rolling(200).mean().iloc[-1]) if len(s) >= 200 else None

    rv = (s.pct_change().rolling(21).std() * np.sqrt(252) * 100).dropna()
    rv_level = round(float(rv.iloc[-1]), 1) if len(rv) else None
    rv_pct = _pctile(rv, rv_level, 756) if rv_level is not None else None

    # Trend label from the MA stack — the same read a trader takes off a chart.
    trend = None
    if ma50 is not None and ma200 is not None:
        if last > ma50 > ma200:
            trend = "uptrend"
        elif last < ma50 < ma200:
            trend = "downtrend"
        else:
            trend = "mixed"

    return {
        "label": label, "symbol": sym, "group": group,
        "last": round(last, 4),
        "ret_1d": ret(1), "ret_1w": ret(5), "ret_1m": ret(21),
        "ret_3m": ret(63), "ret_6m": ret(126), "ytd": ytd, "ret_1y": ret(252),
        "high_52w": round(hi, 4), "low_52w": round(lo, 4),
        "range_pos": rng_pos,
        "from_high": round(last / hi - 1, 4) if hi else None,
        "above_ma50": (ma50 is not None and last > ma50),
        "above_ma200": (ma200 is not None and last > ma200),
        "trend": trend,
        "rv_21d": rv_level, "rv_pctile": rv_pct,
        "as_of": str(s.index[-1].date()),
    }


# ------------------------------------------------------------
# curve structure — contango vs backwardation
# ------------------------------------------------------------

def _curve_structure() -> list[dict]:
    """Realised roll yield per complex — see the ROLL_PAIRS note above.

    We track ETF / front-month as an index. Its slope IS the roll yield:
    persistently negative slope = contango bleed, positive = backwardation gain.
    Reported over 3m / 6m / 12m and annualized, because a single day's ratio is
    meaningless — the whole point is the drift.
    """
    now = time.time()
    if _curve_cache["data"] is not None and now - _curve_cache["ts"] < _CURVE_TTL:
        return _curve_cache["data"]

    out = []
    for label, etf_sym, front_sym in ROLL_PAIRS:
        etf = _daily(etf_sym, days=800)
        front = _daily(front_sym, days=800)
        if etf is None or front is None:
            continue
        joined = pd.concat({"etf": etf, "front": front}, axis=1).dropna()
        if len(joined) < 130:
            continue
        ratio = (joined["etf"] / joined["front"])
        ratio = ratio / float(ratio.iloc[0]) * 100      # index to 100 at window start

        def drift(n):
            """Annualized % drift of the ratio over the last n sessions."""
            if len(ratio) <= n:
                return None
            chg = float(ratio.iloc[-1]) / float(ratio.iloc[-1 - n]) - 1
            return round(chg * (252 / n), 4)

        roll_3m, roll_6m, roll_12m = drift(63), drift(126), drift(252)
        headline = roll_3m if roll_3m is not None else roll_6m
        out.append({
            "label": label, "etf": etf_sym, "front": front_sym,
            "roll_3m": roll_3m, "roll_6m": roll_6m, "roll_12m": roll_12m,
            "state": (None if headline is None else
                      "backwardation" if headline > 0.01 else
                      "contango" if headline < -0.01 else "flat"),
            "front_px": round(float(joined["front"].iloc[-1]), 3),
            "etf_px": round(float(joined["etf"].iloc[-1]), 3),
            "dates": [str(d.date()) for d in ratio.index[-252:]],
            "values": [round(float(v), 3) for v in ratio.iloc[-252:].values],
        })
    _curve_cache.update({"ts": now, "data": out})
    return out


# ------------------------------------------------------------
# ratios with percentile context
# ------------------------------------------------------------

def _ratio_block() -> list[dict]:
    out = []
    for label, a, b, meaning in RATIOS:
        sa, sb = _daily(a), _daily(b)
        if sa is None or sb is None:
            continue
        r = (sa / sb.reindex(sa.index).ffill()).dropna()
        if len(r) < 120:
            continue
        last = float(r.iloc[-1])
        p5y = _pctile(r, last, 1260)
        p1y = _pctile(r, last, 252)

        def rr(n):
            return round(last / float(r.iloc[-1 - n]) - 1, 4) if len(r) > n else None

        # "Stretched" is a percentile statement, not a price statement — this is
        # what turns a ratio chart into something you can act on.
        tag = None
        if p5y is not None:
            tag = "extreme high" if p5y >= 0.95 else "high" if p5y >= 0.80 else \
                  "extreme low" if p5y <= 0.05 else "low" if p5y <= 0.20 else "mid"

        out.append({
            "label": label, "num": a, "den": b, "meaning": meaning,
            "level": round(last, 4),
            "pctile_5y": p5y, "pctile_1y": p1y, "tag": tag,
            "ret_1m": rr(21), "ret_3m": rr(63), "ret_1y": rr(252),
            "min_5y": round(float(r.iloc[-1260:].min()), 4),
            "max_5y": round(float(r.iloc[-1260:].max()), 4),
            "dates": [str(d.date()) for d in r.index[-1260:]],
            "values": [round(float(v), 4) for v in r.iloc[-1260:].values],
        })
    return out


# ------------------------------------------------------------
# real assets: gold vs the 10y real yield
# ------------------------------------------------------------

def _real_assets() -> dict | None:
    """Gold against the 10-year TIPS real yield.

    Gold has no cash flow, so its opportunity cost IS the real yield: when real
    yields fall, holding a zero-carry asset costs less and gold re-rates. The
    relationship is normally strongly negative, and it BREAKING is itself the
    signal — that is what central-bank buying and debasement fear look like in
    the data.
    """
    gold = _daily("GC=F", days=1900)
    if gold is None:
        return None
    reason = None
    try:
        from services.macro import fetch_fred_series, fred_last_error
        ry = fetch_fred_series(REAL_YIELD_FRED, years=5)
        reason = fred_last_error()
    except Exception as e:
        ry = None
        reason = f"{type(e).__name__}: {e}"
    if ry is None or not len(ry):
        # Report the ACTUAL failure. Guessing "no API key?" when the key is fine
        # sends you looking in the wrong place.
        return {"available": False,
                "reason": f"10y real yield unavailable — {reason or 'FRED returned nothing'}"}

    joined = pd.concat({"gold": gold, "real": ry}, axis=1).dropna()
    if len(joined) < 120:
        return {"available": False, "reason": "not enough overlapping history"}
    joined = joined.iloc[-1260:]

    # Correlation of CHANGES, not levels — levels give spurious trend correlation.
    ch = joined.diff().dropna()
    corr_full = float(ch["gold"].corr(ch["real"]))
    corr_90 = float(ch.iloc[-90:]["gold"].corr(ch.iloc[-90:]["real"])) if len(ch) > 90 else None

    return {
        "available": True,
        "dates": [str(d.date()) for d in joined.index],
        "gold": [round(float(v), 2) for v in joined["gold"].values],
        "real_yield": [round(float(v), 3) for v in joined["real"].values],
        "corr_5y": round(corr_full, 3),
        "corr_90d": round(corr_90, 3) if corr_90 is not None else None,
        "real_yield_last": round(float(joined["real"].iloc[-1]), 3),
        "gold_last": round(float(joined["gold"].iloc[-1]), 2),
        "regime": ("decoupled — gold rising despite real yields (debasement / official buying)"
                   if corr_90 is not None and corr_90 > -0.1 else
                   "normal — gold trading inversely to real yields"),
    }


# ------------------------------------------------------------
# seasonality
# ------------------------------------------------------------

def _seasonality(years: int = 10) -> list[dict]:
    """Average calendar-month return per commodity over ~`years`.

    Commodities are the one asset class where this is a supply-side fact rather
    than a curiosity: heating demand, harvest windows, driving season. Reported
    with the hit rate so a big average built on two outliers is visible as such.
    """
    out = []
    cutoff = pd.Timestamp.now() - pd.DateOffset(years=years)
    for label, sym, group in INSTRUMENTS:
        if group == "Reference":
            continue
        s = _daily(sym)
        if s is None or len(s) < 500:
            continue
        s = s[s.index >= cutoff]
        if len(s) < 400:
            continue
        monthly = s.resample("ME").last().pct_change().dropna()
        if len(monthly) < 24:
            continue
        months = []
        for m in range(1, 13):
            vals = monthly[monthly.index.month == m]
            if not len(vals):
                months.append({"month": m, "avg": None, "hit_rate": None, "n": 0})
                continue
            months.append({
                "month": m,
                "avg": round(float(vals.mean()), 4),
                "median": round(float(vals.median()), 4),
                "hit_rate": round(float((vals > 0).sum()) / len(vals), 3),
                "n": int(len(vals)),
            })
        out.append({"label": label, "symbol": sym, "group": group, "months": months,
                    "years": years})
    return out


# ------------------------------------------------------------
# cross-commodity correlation
# ------------------------------------------------------------

def _correlation(window: int = 63) -> dict | None:
    closes = {}
    for label, sym, group in INSTRUMENTS:
        s = _daily(sym)
        if s is not None and len(s) > window + 20:
            closes[sym] = s
    if len(closes) < 4:
        return None
    R = pd.DataFrame(closes).sort_index().ffill().pct_change().dropna()
    if len(R) < window:
        return None
    corr = R.iloc[-window:].corr()
    syms = [s for _, s, _ in INSTRUMENTS if s in corr.columns]
    label_of = {s: l for l, s, _ in INSTRUMENTS}
    return {
        "window": window,
        "symbols": syms,
        "labels": [label_of[s] for s in syms],
        "matrix": [[round(float(corr.loc[a, b]), 2) for b in syms] for a in syms],
    }


# ------------------------------------------------------------
# performance series (kept — but as a supporting panel, not the hero)
# ------------------------------------------------------------

def _perf_bundle(n: int = 1260) -> dict | None:
    frames = {}
    for _, sym, _g in INSTRUMENTS:
        s = _daily(sym)
        if s is not None and len(s) > 40:
            frames[sym] = s
    if not frames:
        return None
    df = pd.DataFrame(frames).sort_index().ffill().iloc[-n:]
    perf = []
    for label, sym, group in INSTRUMENTS:
        if sym not in df.columns:
            continue
        c = df[sym]
        perf.append({"label": label, "symbol": sym, "group": group,
                     "close": [None if pd.isna(v) else round(float(v), 4) for v in c.values]})
    return {"dates": [str(d.date()) for d in df.index], "perf": perf}


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


# ------------------------------------------------------------
# public build
# ------------------------------------------------------------

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
        if force:
            _series_cache.clear()
            _curve_cache.update({"ts": 0.0, "data": None})

        board = [r for r in (_board_row(l, s, g) for l, s, g in INSTRUMENTS) if r]

        # Headline reads, derived from the board so they can't disagree with it.
        real = [r for r in board if r["group"] != "Reference"]
        leaders = sorted([r for r in real if r["ret_1m"] is not None],
                         key=lambda r: r["ret_1m"], reverse=True)[:5]
        laggards = sorted([r for r in real if r["ret_1m"] is not None],
                          key=lambda r: r["ret_1m"])[:5]
        n_up = sum(1 for r in real if r["above_ma200"])
        breadth = {"above_ma200": n_up, "total": len(real),
                   "pct": round(n_up / len(real), 3) if real else None}

        bundle = _perf_bundle()
        if live and bundle:
            bundle["intraday"] = _intraday_basket([s for _, s, _g in INSTRUMENTS])

        data = {
            "mode": key, "phase": sess["phase"],
            "as_of": sess["now_cet"] + " CET" if live else datetime.now().strftime("%Y-%m-%d"),
            "groups": GROUP_ORDER,
            "board": board,
            "breadth": breadth,
            "leaders": leaders, "laggards": laggards,
            "curve": _curve_structure(),
            "ratios": _ratio_block(),
            "real_assets": _real_assets(),
            "seasonality": _seasonality(10),
            "correlation": _correlation(63),
            "bundle": bundle,
        }
        _out_cache[key] = {"ts": now, "data": data}
        return data
