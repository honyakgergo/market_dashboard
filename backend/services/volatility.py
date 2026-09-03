# ============================================================
# services/volatility.py
# The volatility cockpit.
#
# The organising idea: every vol number is meaningless as a level and only
# means something as a POSITION IN ITS OWN HISTORY. VIX 18 is calm in 2022 and
# alarming in 2017. So almost everything here ships as (level, 1y percentile,
# z-score) rather than a bare number, and the page ranks them.
#
# What it computes
#   headline    VIX + change + percentile + 52w range + a regime verdict
#   term        VIX9D / VIX / VIX3M / VIX6M curve, VIX/VIX3M and VIX9D/VIX
#               ratios, slope percentile, days-in-backwardation count
#   rv          SPY realized vol at 5/10/21/63d = a realized TERM STRUCTURE,
#               plus a 3y realized-vol CONE (10/25/50/75/90th pctile per window)
#   vrp         VIX - 21d realized, series + percentile (is vol selling paid?)
#   tails       VVIX (+ VVIX/VIX), SKEW, both percentile-ranked
#   cross       VIX / VXN / RVX levels, spreads and history
#   dispersion  realized pairwise correlation + cross-sectional dispersion
#
# Single-name implied vol (the dispersion / "is SPY vol cheap vs its members"
# question) is expensive — it needs one option chain per name — so it lives
# behind its own endpoint, `/vol/single-name`, with a long TTL. See
# build_single_name_vol().
#
# Data reality: the well-known Cboe indices are usually on Yahoo; the newer
# niche ones (DSPX, ^COR1M) may not be, and ^RVX is effectively delisted. We
# PROBE every ticker and serve only what resolves, substituting a clearly
# flagged realized-vol proxy where a Cboe index is missing.
# ============================================================

import math
import time
import threading
from datetime import datetime

import numpy as np
import pandas as pd
import yfinance as yf

from services.data import _yf_lock, daily_close_series
from services.session import market_session
from services.options import bs_greeks

# tenor label · yahoo symbol · days-to-maturity (for the curve x-axis)
TENORS = [("VIX9D", "^VIX9D", 9), ("VIX", "^VIX", 30), ("VIX3M", "^VIX3M", 90), ("VIX6M", "^VIX6M", 180)]
EXTRA_VOL = {"vvix": "^VVIX", "skew": "^SKEW", "vxn": "^VXN", "rvx": "^RVX"}
DISPERSION_TICKERS = {"dspx": "^DSPX"}

# realized-correlation basket — liquid mega/large caps that are in the cache.
_BASKET = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "AVGO", "TSLA",
           "JPM", "XOM", "UNH", "V", "MA", "COST", "HD", "PG", "JNJ", "WMT"]

# single-name IV board: the index, then the names that actually drive it.
# Approximate S&P 500 weights, renormalised inside the basket — used for the
# implied-correlation proxy. Deliberately short: one option chain each.
SN_INDEX = "SPY"
SN_NAMES = [
    ("NVDA", 0.075), ("AAPL", 0.070), ("MSFT", 0.065), ("AMZN", 0.040),
    ("META", 0.028), ("GOOGL", 0.025), ("AVGO", 0.024), ("TSLA", 0.020),
]

RV_WINDOWS = [5, 10, 21, 63]

_series_cache: dict = {}          # ticker -> {"ts", "series"}
_SERIES_TTL = 3600
_probe_cache: dict = {"ts": 0.0, "resolved": None}
_PROBE_TTL = 6 * 3600
_out_cache: dict = {}             # mode -> {"ts","data"}
_TTL_LIVE, _TTL_CLOSE = 120, 900
_sn_cache: dict = {"ts": 0.0, "data": None}
_SN_TTL = 1800                    # option chains are slow — half an hour is plenty
_lock = threading.Lock()
_sn_lock = threading.Lock()


# ------------------------------------------------------------
# series helpers
# ------------------------------------------------------------

def _daily_series(ticker: str):
    """Daily close series (~2y), memoized for an hour.

    Goes through `daily_close_series`, which refuses to serve a cache whose last
    bar is stale and writes any live refetch back — so a vol index that fell out
    of the warm universe can't quietly freeze the whole page on old numbers.
    """
    now = time.time()
    c = _series_cache.get(ticker)
    if c and now - c["ts"] < _SERIES_TTL:
        return c["series"]
    s = daily_close_series(ticker, days=760, min_rows=20)
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


# ------------------------------------------------------------
# statistics — every level is reported with its own context
# ------------------------------------------------------------

def _pctile(series: pd.Series, value: float, lookback: int = 252) -> float | None:
    """Where `value` sits inside the last `lookback` observations, 0..1."""
    if series is None or value is None:
        return None
    tail = series.dropna().iloc[-lookback:]
    if len(tail) < 30:
        return None
    return round(float((tail < value).sum()) / len(tail), 3)


def _zscore(series: pd.Series, value: float, lookback: int = 252) -> float | None:
    if series is None or value is None:
        return None
    tail = series.dropna().iloc[-lookback:]
    if len(tail) < 30:
        return None
    sd = float(tail.std())
    if not sd:
        return None
    return round((value - float(tail.mean())) / sd, 2)


def _ctx(series: pd.Series, level: float | None = None, lookback: int = 252,
         hist_n: int = 252, digits: int = 2) -> dict | None:
    """The standard shape for every gauge on this page: a level, what it means
    relative to its own last year, and enough history to draw it."""
    if series is None or not len(series.dropna()):
        return None
    s = series.dropna()
    if level is None:
        level = float(s.iloc[-1])
    tail = s.iloc[-lookback:]
    prev = float(s.iloc[-2]) if len(s) > 1 else None
    hist = s.iloc[-hist_n:]
    return {
        "level": round(float(level), digits),
        "chg": round(float(level) - prev, digits) if prev is not None else None,
        "chg_pct": round(float(level) / prev - 1, 4) if prev else None,
        "pctile": _pctile(s, level, lookback),
        "z": _zscore(s, level, lookback),
        "min_52w": round(float(tail.min()), digits),
        "max_52w": round(float(tail.max()), digits),
        "median_52w": round(float(tail.median()), digits),
        "history": {
            "dates": [str(d.date()) for d in hist.index],
            "values": [round(float(v), digits) for v in hist.values],
        },
    }


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
# realized volatility
# ------------------------------------------------------------

def _rv_series(ticker: str, window: int) -> pd.Series | None:
    """Annualized rolling realized (close-to-close) vol, in vol points."""
    s = _daily_series(ticker)
    if s is None or len(s) < window + 5:
        return None
    rv = (s.pct_change().rolling(window).std() * np.sqrt(252) * 100).dropna()
    return rv if len(rv) else None


def _realized_term(ticker: str = "SPY") -> dict | None:
    """Realized vol measured over several windows = a realized term structure.

    Read against the implied curve this answers the only question that matters
    for a vol seller: is the market paying me more than the stock is moving, and
    at which horizon?
    """
    out = []
    for w in RV_WINDOWS:
        rv = _rv_series(ticker, w)
        if rv is None:
            continue
        level = float(rv.iloc[-1])
        out.append({
            "window": w,
            "level": round(level, 2),
            "pctile": _pctile(rv, level, 252),
            "z": _zscore(rv, level, 252),
        })
    return {"ticker": ticker, "points": out} if out else None


def _rv_cone(ticker: str = "SPY", lookback: int = 756) -> dict | None:
    """Realized-volatility cone: the 10/25/50/75/90th percentile of realized vol
    at each horizon over ~3 years, with today's reading laid on top.

    This is the standard way to see whether current realized vol is genuinely
    unusual for that horizon, rather than just unusual versus last week.
    """
    bands, spot = [], []
    for w in RV_WINDOWS:
        rv = _rv_series(ticker, w)
        if rv is None:
            continue
        tail = rv.iloc[-lookback:]
        if len(tail) < 60:
            continue
        q = tail.quantile([0.1, 0.25, 0.5, 0.75, 0.9])
        bands.append({
            "window": w,
            "p10": round(float(q.loc[0.1]), 2), "p25": round(float(q.loc[0.25]), 2),
            "p50": round(float(q.loc[0.5]), 2), "p75": round(float(q.loc[0.75]), 2),
            "p90": round(float(q.loc[0.9]), 2),
        })
        spot.append({"window": w, "level": round(float(rv.iloc[-1]), 2)})
    if not bands:
        return None
    return {"ticker": ticker, "bands": bands, "current": spot, "lookback_days": lookback}


# ------------------------------------------------------------
# dispersion / correlation (realized — always available, from cache)
# ------------------------------------------------------------

def _realized_dispersion(window: int = 21) -> dict | None:
    rets = {}
    for sym in _BASKET:
        s = _daily_series(sym)
        if s is not None and len(s) > window + 2:
            rets[sym] = s.pct_change().iloc[-window:]
    if len(rets) < 5:
        return None
    R = pd.DataFrame(rets).dropna()
    if len(R) < 5:
        return None
    corr = R.corr().values
    iu = np.triu_indices_from(corr, k=1)
    avg_corr = float(np.nanmean(corr[iu]))
    period_ret = (R + 1).prod() - 1
    dispersion = float(period_ret.std())
    best = period_ret.idxmax()
    worst = period_ret.idxmin()
    return {
        "avg_corr": round(avg_corr, 3),
        "dispersion": round(dispersion, 4),
        "n": R.shape[1], "window": window,
        "best": {"symbol": str(best), "ret": round(float(period_ret[best]), 4)},
        "worst": {"symbol": str(worst), "ret": round(float(period_ret[worst]), 4)},
    }


def _corr_history(window: int = 21, n: int = 180) -> dict | None:
    """Rolling average pairwise correlation of the basket — the risk-on/risk-off
    dial. Toward 1 the whole tape is one trade; toward 0 stock picking works."""
    closes = {}
    for sym in _BASKET:
        s = _daily_series(sym)
        if s is not None and len(s) > window + n:
            closes[sym] = s
    if len(closes) < 5:
        return None
    R = pd.DataFrame(closes).pct_change().dropna()
    if len(R) < window + 20:
        return None
    R = R.iloc[-(n + window):]
    vals, dates = [], []
    for i in range(window, len(R) + 1):
        c = R.iloc[i - window:i].corr().values
        iu = np.triu_indices_from(c, k=1)
        m = float(np.nanmean(c[iu]))
        if not math.isnan(m):
            vals.append(round(m, 3))
            dates.append(str(R.index[i - 1].date()))
    return {"dates": dates, "values": vals, "window": window} if vals else None


# ------------------------------------------------------------
# term structure
# ------------------------------------------------------------

def _term_block(live: bool, res: dict) -> dict:
    curve = []
    for lbl, sym, dtm in TENORS:
        if res.get(lbl, {}).get("ok"):
            level, hist = _level_and_hist(sym, live)
            if level is not None:
                curve.append({"label": lbl, "symbol": sym, "dtm": dtm, "level": level, "history": hist})

    lv = {p["label"]: p["level"] for p in curve}
    vix, vix3m, vix9d, vix6m = lv.get("VIX"), lv.get("VIX3M"), lv.get("VIX9D"), lv.get("VIX6M")

    vix_s = _daily_series("^VIX")
    v3_s = _daily_series("^VIX3M")
    v9_s = _daily_series("^VIX9D")

    # VIX / VIX3M — the canonical term-structure signal. Below 1 = contango
    # (calm, carry works); above 1 = backwardation (stress, hedges bid).
    ratio_ctx = days_backwardated = None
    if vix_s is not None and v3_s is not None:
        r = (vix_s / v3_s).dropna()
        if len(r) > 30:
            live_ratio = (vix / vix3m) if (vix and vix3m) else float(r.iloc[-1])
            ratio_ctx = _ctx(r, live_ratio, digits=3)
            days_backwardated = int((r.iloc[-60:] > 1).sum())

    # VIX9D / VIX — near-dated stress. Spikes into CPI/FOMC/earnings even when
    # the 30-day curve is still asleep.
    near_ctx = None
    if v9_s is not None and vix_s is not None:
        r9 = (v9_s / vix_s).dropna()
        if len(r9) > 30:
            live9 = (vix9d / vix) if (vix9d and vix) else float(r9.iloc[-1])
            near_ctx = _ctx(r9, live9, digits=3)

    slope_ctx = None
    if vix_s is not None and v3_s is not None:
        sl = (v3_s - vix_s).dropna()
        if len(sl) > 30:
            live_slope = (vix3m - vix) if (vix and vix3m) else float(sl.iloc[-1])
            slope_ctx = _ctx(sl, live_slope, digits=2)

    contango = bool(vix3m > vix) if (vix and vix3m) else None
    return {
        "curve": curve,
        "vix": vix, "vix9d": vix9d, "vix3m": vix3m, "vix6m": vix6m,
        "contango": contango,
        "slope": slope_ctx,
        "vix_vix3m": ratio_ctx,
        "vix9d_vix": near_ctx,
        "days_backwardated_60": days_backwardated,
    }


# ------------------------------------------------------------
# cross-index
# ------------------------------------------------------------

def _cross_block(live: bool, n: int = 252) -> dict | None:
    vix = _daily_series("^VIX")
    if vix is None or len(vix) < 20:
        return None
    vxn = _daily_series("^VXN")
    rvx = _daily_series("^RVX")
    rvx_is_proxy = False
    if rvx is None or len(rvx) < 20:
        rvx = _rv_series("IWM", 21)
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
        full = (frames[a] - frames[b]).dropna()
        return {
            "dates": [str(d.date()) for d in s.index],
            "values": [round(float(v), 2) for v in s.values],
            "last": round(float(s.iloc[-1]), 2),
            "pctile": _pctile(full, float(s.iloc[-1]), 252),
        }

    return {
        "dates": [str(d.date()) for d in df.index],
        "vix": col("vix"), "vxn": col("vxn"), "rvx": col("rvx"),
        "rvx_is_proxy": rvx_is_proxy,
        "levels": {
            "vix": round(float(df["vix"].iloc[-1]), 2),
            "vxn": round(float(df["vxn"].iloc[-1]), 2) if "vxn" in df.columns else None,
            "rvx": round(float(df["rvx"].iloc[-1]), 2) if "rvx" in df.columns else None,
        },
        "spread_vxn_vix": spread("vxn", "vix"),
        "spread_rvx_vix": spread("rvx", "vix"),
    }


# ------------------------------------------------------------
# variance risk premium
# ------------------------------------------------------------

def _vrp_block(vix_level: float | None, n: int = 252) -> dict | None:
    """VRP = implied (VIX) - subsequent-window realized (SPY 21d).

    Positive means options are pricing more movement than the index delivered:
    the premium that makes systematic vol selling profitable, and the thing that
    goes violently negative in a shock.
    """
    vix = _daily_series("^VIX")
    rv = _rv_series("SPY", 21)
    if vix is None or rv is None:
        return None
    joined = pd.concat({"vix": vix, "rv": rv}, axis=1).dropna()
    if len(joined) < 40:
        return None
    diff = (joined["vix"] - joined["rv"]).dropna()
    live_vrp = (vix_level - float(joined["rv"].iloc[-1])) if vix_level is not None else float(diff.iloc[-1])
    ctx = _ctx(diff, live_vrp, hist_n=n, digits=2)
    if ctx:
        ctx["realized_21d"] = round(float(joined["rv"].iloc[-1]), 2)
        ctx["implied"] = round(float(vix_level if vix_level is not None else joined["vix"].iloc[-1]), 2)
        ctx["ratio"] = round(ctx["implied"] / ctx["realized_21d"], 2) if ctx["realized_21d"] else None
    return ctx


# ------------------------------------------------------------
# regime verdict
# ------------------------------------------------------------

def _regime(vix_ctx, term, vvix_ctx, vrp) -> dict:
    """One sentence for the top of the page, derived from the pieces below it
    rather than from a level alone."""
    p = vix_ctx.get("pctile") if vix_ctx else None
    backwardated = term.get("contango") is False
    signals = []

    if p is None:
        label, tone = "unknown", "flat"
    elif p >= 0.90:
        label, tone = "crisis", "bear"
    elif p >= 0.75 or backwardated:
        label, tone = "stressed", "bear"
    elif p <= 0.20:
        label, tone = "complacent", "bull"
    else:
        label, tone = "normal", "side"

    if p is not None:
        signals.append(f"VIX at the {round(p * 100)}th percentile of its last year")
    if term.get("contango") is not None:
        signals.append("term structure in contango" if term["contango"] else "term structure BACKWARDATED")
    if term.get("days_backwardated_60"):
        signals.append(f"{term['days_backwardated_60']} of the last 60 sessions backwardated")
    if vvix_ctx and vvix_ctx.get("pctile") is not None:
        signals.append(f"VVIX at the {round(vvix_ctx['pctile'] * 100)}th percentile")
    if vrp and vrp.get("level") is not None:
        signals.append(
            f"variance premium {'positive' if vrp['level'] >= 0 else 'NEGATIVE'} "
            f"({vrp['level']:+.1f} pts)"
        )
    return {"label": label, "tone": tone, "signals": signals}


# ------------------------------------------------------------
# single-name implied vol (own endpoint — one option chain per name)
# ------------------------------------------------------------

def _atm_iv(ticker: str) -> dict | None:
    """ATM implied vol from the ~30-day expiry, plus the 25-delta put/call skew.

    Kept deliberately light versus services.options.build_options: one chain,
    no open-interest aggregation, no GEX — this runs across a whole basket.
    """
    acquired = _yf_lock.acquire(timeout=25)
    if not acquired:
        return None
    try:
        yt = yf.Ticker(ticker)
        expirations = list(yt.options or [])
        if not expirations:
            return None
        try:
            spot = float(yt.fast_info["last_price"])
        except Exception:
            s = _daily_series(ticker)
            spot = float(s.iloc[-1]) if s is not None and len(s) else None
        if not spot:
            return None

        today = datetime.now().date()
        dted = [(e, (datetime.strptime(e, "%Y-%m-%d").date() - today).days) for e in expirations]
        usable = [(e, d) for e, d in dted if d >= 14]
        if not usable:
            return None
        expiry, dte = min(usable, key=lambda x: abs(x[1] - 30))
        chain = yt.option_chain(expiry)
        calls = chain.calls[chain.calls["impliedVolatility"] > 0].reset_index(drop=True)
        puts = chain.puts[chain.puts["impliedVolatility"] > 0].reset_index(drop=True)
    except Exception:
        return None
    finally:
        _yf_lock.release()

    if not len(calls) or not len(puts):
        return None

    T = max(dte, 1) / 365.0
    ci = min(range(len(calls)), key=lambda i: abs(float(calls["strike"].iloc[i]) - spot))
    pi = min(range(len(puts)), key=lambda i: abs(float(puts["strike"].iloc[i]) - spot))
    atm = float((calls["impliedVolatility"].iloc[ci] + puts["impliedVolatility"].iloc[pi]) / 2)
    if not (0 < atm < 5):
        return None

    # 25-delta skew: how much more the market pays for downside than upside.
    skew = None
    try:
        cd = [(bs_greeks(spot, float(k), T, 0.04, float(iv), True)["delta"], float(iv))
              for k, iv in zip(calls["strike"], calls["impliedVolatility"])]
        pdd = [(bs_greeks(spot, float(k), T, 0.04, float(iv), False)["delta"], float(iv))
               for k, iv in zip(puts["strike"], puts["impliedVolatility"])]
        cd = [x for x in cd if x[0] is not None]
        pdd = [x for x in pdd if x[0] is not None]
        if cd and pdd:
            iv25c = min(cd, key=lambda x: abs(x[0] - 0.25))[1]
            iv25p = min(pdd, key=lambda x: abs(x[0] + 0.25))[1]
            skew = round((iv25p - iv25c) * 100, 2)
    except Exception:
        skew = None

    return {"symbol": ticker, "expiry": expiry, "dte": dte,
            "iv": round(atm * 100, 2), "skew_25d": skew, "spot": round(spot, 2)}


def build_single_name_vol(force: bool = False) -> dict:
    """Single-name implied vol versus the index — the dispersion question.

    For each basket name we take ATM IV (~30d) and its own 21-day realized vol,
    so you can see three things at once:
      · IV - RV per name  — whose options are expensive relative to how the
        stock actually moves (single-name variance premium)
      · avg single-name IV vs index IV — the dispersion ratio. High means the
        members are expected to move far more than the index does, i.e. they
        are expected to move in DIFFERENT directions.
      · an implied-correlation proxy from the classic dispersion identity
            rho = (s_idx^2 - SUM w_i^2 s_i^2) / (SUM_{i != j} w_i w_j s_i s_j)
        computed over a truncated basket, so it is a proxy, not the Cboe COR
        index — labelled as such everywhere it surfaces.

    Slow (one option chain per symbol) so it has its own endpoint and a 30-minute
    TTL rather than blocking the main /vol payload.
    """
    now = time.time()
    with _sn_lock:
        if not force and _sn_cache["data"] and now - _sn_cache["ts"] < _SN_TTL:
            return _sn_cache["data"]

        index = _atm_iv(SN_INDEX)
        rows = []
        for sym, weight in SN_NAMES:
            iv = _atm_iv(sym)
            if not iv:
                continue
            rv = _rv_series(sym, 21)
            rv_level = round(float(rv.iloc[-1]), 2) if rv is not None else None
            rows.append({
                **iv, "weight": weight, "rv_21d": rv_level,
                "iv_minus_rv": round(iv["iv"] - rv_level, 2) if rv_level is not None else None,
            })

        idx_rv = _rv_series(SN_INDEX, 21)
        idx_rv_level = round(float(idx_rv.iloc[-1]), 2) if idx_rv is not None else None

        avg_iv = round(sum(r["iv"] for r in rows) / len(rows), 2) if rows else None
        ratio = round(avg_iv / index["iv"], 3) if (rows and index and index["iv"]) else None

        # Implied correlation, via the ratio approximation
        #     rho ~= (sigma_index / SUM w_i sigma_i)^2
        # rather than the exact dispersion identity
        #     rho = (s_idx^2 - SUM w_i^2 s_i^2) / (SUM_{i!=j} w_i w_j s_i s_j).
        #
        # The exact form assumes the basket IS the index. Ours is eight
        # mega-caps standing in for five hundred names, and renormalising their
        # weights to 100% makes the basket look far more volatile than the index
        # it is meant to represent — which drives the exact formula to nonsense
        # near zero. The ratio form degrades gracefully under that truncation and
        # is the approximation desks actually quote. Still a proxy, and labelled
        # as one everywhere it surfaces.
        implied_corr = None
        if rows and index and index["iv"]:
            tw = sum(r["weight"] for r in rows)
            wavg = sum((r["weight"] / tw) * r["iv"] for r in rows)
            if wavg > 0:
                implied_corr = round(max(0.0, min(1.0, (index["iv"] / wavg) ** 2)), 3)

        data = {
            "as_of": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "index": (index | {"rv_21d": idx_rv_level,
                               "iv_minus_rv": round(index["iv"] - idx_rv_level, 2)
                               if idx_rv_level is not None else None}) if index else None,
            "names": sorted(rows, key=lambda r: (r["iv_minus_rv"] is None, -(r["iv_minus_rv"] or 0))),
            "avg_name_iv": avg_iv,
            "dispersion_ratio": ratio,
            "implied_corr_proxy": implied_corr,
            "basket_size": len(rows),
            "note": ("Implied correlation is a proxy: the ratio approximation over an "
                     "8-name mega-cap basket, not the Cboe COR index. Read the trend, "
                     "not the decimal."),
        }
        _sn_cache.update({"ts": now, "data": data})
        return data


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
        if force:
            _series_cache.clear()

        res = probe(force=force)
        term = _term_block(live, res)
        vix_level = term.get("vix")

        vix_ctx = _ctx(_daily_series("^VIX"), vix_level)

        def gauge(lbl, digits=2):
            if not res.get(lbl, {}).get("ok"):
                return None
            level, _ = _level_and_hist(EXTRA_VOL[lbl], live)
            return _ctx(_daily_series(EXTRA_VOL[lbl]), level, digits=digits)

        vvix = gauge("vvix", 1)
        skew = gauge("skew", 1)

        # VVIX / VIX — the price of convexity. Elevated means the market is
        # paying up for protection ON volatility itself, which historically
        # leads spot-VIX spikes rather than following them.
        vvix_vix = None
        vv_s, vx_s = _daily_series("^VVIX"), _daily_series("^VIX")
        if vv_s is not None and vx_s is not None:
            r = (vv_s / vx_s).dropna()
            if len(r) > 30:
                live_r = (vvix["level"] / vix_level) if (vvix and vix_level) else float(r.iloc[-1])
                vvix_vix = _ctx(r, live_r, digits=2)

        vrp = _vrp_block(vix_level)
        realized_term = _realized_term("SPY")
        cone = _rv_cone("SPY")
        cross = _cross_block(live)

        realized = _realized_dispersion(21)
        dspx_ok = res.get("dspx", {}).get("ok")
        dspx = _ctx(_daily_series("^DSPX")) if dspx_ok else None
        corr_val = realized["avg_corr"] if realized else None
        dispersion = {
            "realized": realized,
            "dspx": dspx,
            "corr_history": _corr_history(21, 180),
            "corr_used": round(corr_val, 3) if corr_val is not None else None,
            "state": (None if corr_val is None else
                      "tightening" if corr_val >= 0.55 else
                      "broadening" if corr_val <= 0.35 else "neutral"),
        }

        data = {
            "mode": key, "phase": sess["phase"],
            "as_of": sess["now_cet"] + " CET" if live else datetime.now().strftime("%Y-%m-%d"),
            "regime": _regime(vix_ctx, term, vvix, vrp),
            "vix": vix_ctx,
            "term": term,
            "vvix": vvix, "vvix_vix": vvix_vix, "skew": skew,
            "vrp": vrp,
            "realized_term": realized_term,
            "rv_cone": cone,
            "cross": cross,
            "dispersion": dispersion,
            "resolved": {k: v["ok"] for k, v in res.items()},
        }
        _out_cache[key] = {"ts": now, "data": data}
        return data
