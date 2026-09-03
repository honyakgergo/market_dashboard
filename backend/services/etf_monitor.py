# ============================================================
# services/etf_monitor.py
# Cross-Asset / ETF Monitor — hybrid freshness:
#   LIVE (US open): asset-class map, rotation ratios, and the risk-appetite
#     gauge overlay today's move via one bulk intraday snapshot.
#   DAILY (always): the RRG (rotation is a multi-week concept — intraday
#     tails are noise) and the Efficiency-Ratio trending/reverting board.
# Structural history (spark lines, MA50, RRG tails) comes from the cache.
# ============================================================

import math
import time
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import yfinance as yf

from services.data import _load_from_cache, _yf_lock
from services.session import market_session
from services.overview import _bulk_snapshot   # reused batched intraday snapshot

_cache: dict = {}
_TTL_CLOSE = 180
_TTL_LIVE = 150

ASSET_MAP = {
    "US Equity":     ["SPY", "QQQ", "IWM", "DIA", "RSP"],
    "US Sectors":    ["XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU", "XLB", "XLRE", "XLC"],
    "International":  ["EFA", "EEM", "EWJ", "FXI", "VXUS"],
    "Bonds":         ["TLT", "IEF", "SHY", "LQD", "HYG", "TIP"],
    "Commodities":   ["GLD", "SLV", "USO", "UNG", "DBC", "CPER"],
    "Crypto":        ["BTC-USD", "ETH-USD"],
    "Dollar / FX":   ["UUP", "EURUSD=X", "JPY=X"],
}

RATIOS = [
    ("XLY/XLP (risk appetite)", "XLY", "XLP"),
    ("SOXX/SPY (semis lead)",   "SOXX", "SPY"),
    ("RSP/SPY (breadth)",       "RSP", "SPY"),
    ("IWM/SPY (small caps)",    "IWM", "SPY"),
    ("IWF/IWD (growth/value)",  "IWF", "IWD"),
    ("HYG/LQD (credit risk)",   "HYG", "LQD"),
    ("CPER/GLD (copper/gold)",  "CPER", "GLD"),
    ("XLU/SPY (defensives)",    "XLU", "SPY"),
]

# ── Relative Rotation Graph ───────────────────────────────────
# Two universes, both measured against SPY. Sectors answers "where inside US
# equity is money going"; cross-asset answers "is money in equity at all".
RRG_UNIVERSES = {
    "sectors": [
        ("XLK", "Technology"), ("XLC", "Comm. Services"), ("XLY", "Cons. Disc."),
        ("XLP", "Cons. Staples"), ("XLE", "Energy"), ("XLF", "Financials"),
        ("XLV", "Health Care"), ("XLI", "Industrials"), ("XLB", "Materials"),
        ("XLRE", "Real Estate"), ("XLU", "Utilities"), ("SMH", "Semis"),
    ],
    "cross_asset": [
        ("QQQ", "Nasdaq 100"), ("IWM", "Russell 2000"), ("RSP", "S&P equal wt"),
        ("EFA", "Dev ex-US"), ("EEM", "EM equity"),
        ("TLT", "Long Treasuries"), ("IEF", "10y Treasuries"),
        ("LQD", "IG credit"), ("HYG", "HY credit"),
        ("GLD", "Gold"), ("SLV", "Silver"), ("USO", "Crude oil"), ("CPER", "Copper"),
        ("UUP", "US dollar"), ("BTC-USD", "Bitcoin"),
    ],
}
RRG_BENCH = "SPY"
RRG_TAIL = 12          # weeks of tail retained per member

# one representative per asset class — drives the rebased perf chart + matrices
CROSS_ASSET = [
    ("S&P 500", "SPY"), ("Nasdaq 100", "QQQ"), ("Russell 2000", "IWM"),
    ("Dev ex-US", "EFA"), ("EM equity", "EEM"),
    ("Long Treasuries", "TLT"), ("IG credit", "LQD"), ("HY credit", "HYG"),
    ("Gold", "GLD"), ("Silver", "SLV"), ("Crude oil", "USO"), ("Copper", "CPER"),
    ("US dollar", "UUP"), ("Bitcoin", "BTC-USD"),
]


def _closes(sym: str, start: str, end: str) -> pd.Series | None:
    df = _load_from_cache(sym, start, end)
    if df is None or len(df) < 30:
        return None
    return df["Close"].astype(float)


def _returns(close: pd.Series, live_price: float | None = None) -> dict:
    if live_price is not None:
        last = float(live_price)
        def ret(n):
            return round(last / float(close.iloc[-n]) - 1, 4) if len(close) >= n else None
        return {"close": round(last, 4), "ret_1d": ret(1), "ret_1w": ret(5), "ret_1m": ret(21), "ret_3m": ret(63)}
    last = float(close.iloc[-1])
    def ret(n):
        return round(last / float(close.iloc[-n]) - 1, 4) if len(close) > n else None
    return {"close": round(last, 4), "ret_1d": ret(2), "ret_1w": ret(6), "ret_1m": ret(22), "ret_3m": ret(66)}


def _quadrant(ratio: float, mom: float) -> str:
    """The four RRG quadrants, read clockwise as the normal rotation cycle:
    improving -> leading -> weakening -> lagging -> improving."""
    if ratio >= 100 and mom >= 100: return "leading"
    if ratio < 100 and mom >= 100:  return "improving"
    if ratio < 100 and mom < 100:   return "lagging"
    return "weakening"


def _build_rrg(members: list[tuple[str, str]], bench: pd.Series,
               start: str, end: str, tail_len: int = RRG_TAIL) -> list[dict]:
    """Relative Rotation Graph coordinates for one universe.

    RS-Ratio  = relative strength versus the benchmark, normalised so 100 is
                "in line with the benchmark".
    RS-Momentum = the rate of change of RS-Ratio, normalised the same way.

    Both axes are z-scored against the member's OWN two-year history before
    being re-centred on 100. That normalisation is what makes the quadrants
    mean something: without it every series clusters within a hair of 100 and
    the whole chart collapses into a dot. Weekly bars, because rotation is a
    multi-week phenomenon and daily sampling just adds noise to the tails.
    """
    bench_w = bench.resample("W-FRI").last().dropna()
    if len(bench_w) < 30:
        return []

    out = []
    for sym, name in members:
        c = _closes(sym, start, end)
        if c is None:
            continue
        cw = c.resample("W-FRI").last().reindex(bench_w.index).ffill()
        rs = (cw / bench_w).dropna()
        if len(rs) < 30:
            continue

        raw_ratio = 100 * rs / rs.rolling(10).mean()
        raw_mom = 100 * raw_ratio / raw_ratio.rolling(10).mean()

        def norm(s: pd.Series) -> pd.Series:
            s = s.dropna()
            if len(s) < 20:
                return pd.Series(dtype=float)
            sd = s.std()
            if not sd or pd.isna(sd):
                return pd.Series(dtype=float)
            return 100 + (s - s.mean()) / sd

        ratio_n, mom_n = norm(raw_ratio), norm(raw_mom)
        if ratio_n.empty or mom_n.empty:
            continue

        tail = pd.DataFrame({"ratio": ratio_n, "mom": mom_n}).dropna().iloc[-tail_len:]
        if len(tail) < 2:
            continue

        pts = [{"date": str(d.date()), "ratio": round(float(a), 2), "mom": round(float(b), 2)}
               for d, a, b in zip(tail.index, tail["ratio"], tail["mom"])]
        head = pts[-1]

        # Distance from the centre = conviction. A name at (101, 101) is barely
        # distinguishable from the benchmark; one at (105, 104) genuinely leads.
        strength = round(math.hypot(head["ratio"] - 100, head["mom"] - 100), 2)
        prev = pts[max(0, len(pts) - 5)]
        heading = round(math.degrees(math.atan2(head["mom"] - prev["mom"],
                                                head["ratio"] - prev["ratio"])), 1)

        out.append({
            "symbol": sym, "name": name, "tail": pts,
            "ratio": head["ratio"], "mom": head["mom"],
            "quadrant": _quadrant(head["ratio"], head["mom"]),
            "strength": strength, "heading": heading,
            "ret_1m": round(float(c.iloc[-1] / c.iloc[-22] - 1), 4) if len(c) > 22 else None,
            "ret_3m": round(float(c.iloc[-1] / c.iloc[-64] - 1), 4) if len(c) > 64 else None,
            "rel_1m": None,   # filled in below, once the benchmark's own move is known
        })

    # Relative return versus the benchmark — the plain-English version of the
    # x-axis, so the chart can be sanity-checked against a number.
    bench_1m = float(bench.iloc[-1] / bench.iloc[-22] - 1) if len(bench) > 22 else None
    if bench_1m is not None:
        for r in out:
            if r["ret_1m"] is not None:
                r["rel_1m"] = round(r["ret_1m"] - bench_1m, 4)

    out.sort(key=lambda r: -r["strength"])
    return out


def _efficiency_ratio(close, window=21):
    if close is None or len(close) <= window:
        return None, None
    seg = close.iloc[-(window + 1):]
    path = float(seg.diff().abs().sum())
    if not path:
        return 0.0, 1
    er = abs(float(seg.iloc[-1]) - float(seg.iloc[0])) / path
    direction = 1 if seg.iloc[-1] >= seg.iloc[0] else -1
    return round(er, 3), direction


def _cross_asset_bundle(start: str, end: str) -> dict | None:
    """Rebasable perf series + return matrix + rolling-correlation matrix,
    all aligned to the SPY business-day index (ffilled for weekend assets)."""
    bench = _closes("SPY", start, end)
    if bench is None:
        return None
    idx = bench.index
    closes = {}
    for _, sym in CROSS_ASSET:
        c = _closes(sym, start, end)
        if c is not None:
            closes[sym] = c.reindex(idx).ffill()
    if "SPY" not in closes:
        return None

    view = idx[-252:]
    perf = []
    for label, sym in CROSS_ASSET:
        c = closes.get(sym)
        if c is None:
            continue
        s = c.reindex(view)
        perf.append({"label": label, "symbol": sym,
                     "close": [None if pd.isna(v) else round(float(v), 4) for v in s.values]})

    year0 = f"{datetime.now().year}-01-01"
    rows = []
    for label, sym in CROSS_ASSET:
        c = closes.get(sym)
        if c is None or len(c) < 2:
            continue
        last = float(c.iloc[-1])

        def rr(n, _c=c, _last=last):
            return round(_last / float(_c.iloc[-1 - n]) - 1, 4) if len(_c) > n else None
        yr = c[c.index >= year0]
        ytd = round(last / float(yr.iloc[0]) - 1, 4) if len(yr) > 1 else None
        rows.append({"label": label, "symbol": sym, "vals": {
            "1D": rr(1), "1W": rr(5), "1M": rr(21), "3M": rr(63),
            "6M": rr(126), "YTD": ytd, "1Y": rr(252)}})
    return_matrix = {"cols": ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y"], "rows": rows}

    syms = [sym for _, sym in CROSS_ASSET if sym in closes]
    rets = pd.DataFrame({sym: closes[sym].pct_change() for sym in syms}).dropna()
    window = 63 if len(rets) >= 65 else max(20, len(rets) // 2)
    corr = rets.iloc[-window:].corr()
    label_of = {sym: label for label, sym in CROSS_ASSET}
    corr_matrix = {
        "labels": [label_of[s] for s in syms], "symbols": syms, "window": window,
        "matrix": [[round(float(corr.loc[a, b]), 2) for b in syms] for a in syms],
    }

    return {"dates": [str(d.date()) for d in view], "perf": perf,
            "return_matrix": return_matrix, "corr_matrix": corr_matrix}


def _intraday_basket(symbols: list[str]) -> dict | None:
    """One bulk 5-minute download -> {symbol: {t:[...], y:[% since today's open]}}.
    Powers the 1D view while the US session is open."""
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


def build_etf_monitor(force: bool = False) -> dict:
    sess = market_session()
    live = sess["us_open"]
    key = "live" if live else "close"
    ttl = _TTL_LIVE if live else _TTL_CLOSE

    now = time.time()
    cached = _cache.get(key)
    if not force and cached and (now - cached["ts"] < ttl):
        return cached["data"]

    end = datetime.now().strftime("%Y-%m-%d")
    start = (datetime.now() - timedelta(days=600)).strftime("%Y-%m-%d")

    # one bulk intraday snapshot for the live overlay (map + ratio legs)
    snapshot = {}
    if live:
        syms = set()
        for v in ASSET_MAP.values():
            syms.update(v)
        for _, n, d in RATIOS:
            syms.update([n, d])
        snapshot = _bulk_snapshot(list(syms))

    def live_px(sym):
        s = snapshot.get(sym)
        return float(s[0]) if s else None

    # asset-class map (live ret_1d when open)
    asset_map = {}
    for bucket, syms in ASSET_MAP.items():
        tiles = []
        for s in syms:
            c = _closes(s, start, end)
            if c is not None:
                tiles.append({"symbol": s, **_returns(c, live_px(s) if live else None)})
        asset_map[bucket] = tiles

    # rotation ratios (live level + ret_1m + trend_up when open; spark stays daily + live tip)
    ratios = []
    for label, num, den in RATIOS:
        cn, cd = _closes(num, start, end), _closes(den, start, end)
        if cn is None or cd is None:
            continue
        r = (cn / cd.reindex(cn.index, method="ffill")).dropna()
        if len(r) < 60:
            continue
        ma50 = r.rolling(50).mean()
        spark = [round(float(v), 4) for v in r.iloc[-252:].values]

        if live:
            ln, ld = live_px(num), live_px(den)
            level = (ln / ld) if (ln and ld) else float(r.iloc[-1])
            ret_1m = round(level / float(r.iloc[-21]) - 1, 4) if len(r) > 21 else None
            spark = spark + [round(level, 4)]
        else:
            level = float(r.iloc[-1])
            ret_1m = round(level / float(r.iloc[-22]) - 1, 4) if len(r) > 22 else None

        ratios.append({
            "label": label, "num": num, "den": den,
            "level": round(level, 4),
            "trend_up": bool(level > ma50.iloc[-1]) if pd.notna(ma50.iloc[-1]) else None,
            "ret_1m": ret_1m,
            "spark": spark,
        })

    # RRG — weekly and always daily-sourced; intraday tails would be noise.
    bench = _closes(RRG_BENCH, start, end)
    rrg = {}
    if bench is not None:
        for uni, members in RRG_UNIVERSES.items():
            rrg[uni] = _build_rrg(members, bench, start, end)

    # trending vs reverting — Efficiency Ratio (multi-week; stays daily)
    states = {"trending": [], "reverting": [], "neutral": []}
    seen = set()
    for syms in ASSET_MAP.values():
        for s in syms:
            if s in seen:
                continue
            seen.add(s)
            c = _closes(s, start, end)
            er, direction = _efficiency_ratio(c)
            if er is None:
                continue
            item = {"symbol": s, "er": er, "direction": direction,
                    "ret_1m": round(float(c.iloc[-1] / c.iloc[-22] - 1), 4) if len(c) > 22 else None}
            bucket = "trending" if er >= 0.35 else "reverting" if er <= 0.18 else "neutral"
            states[bucket].append(item)
    states["trending"].sort(key=lambda x: x["er"], reverse=True)
    states["reverting"].sort(key=lambda x: x["er"])
    states["neutral"].sort(key=lambda x: x["er"], reverse=True)

    # cross-asset risk appetite from the (live-aware) ratios
    risk_votes = []
    for r in ratios:
        defensive = (r["num"], r["den"]) == ("XLU", "SPY")
        on = (not r["trend_up"]) if defensive else bool(r["trend_up"])
        risk_votes.append({"label": r["label"], "on": on})
    risk_appetite = {"score": sum(1 for v in risk_votes if v["on"]), "max": len(risk_votes), "votes": risk_votes}

    bundle = _cross_asset_bundle(start, end)
    if live and bundle:
        bundle["intraday"] = _intraday_basket([s for _, s in CROSS_ASSET])

    data = {
        "mode": key, "phase": sess["phase"],
        "as_of": sess["now_cet"] + " CET" if live else end,
        "states": states, "risk_appetite": risk_appetite,
        "asset_map": asset_map, "ratios": ratios,
        "rrg": rrg, "benchmark": RRG_BENCH, "rrg_tail_weeks": RRG_TAIL,
        "cross_asset": bundle,
    }
    _cache[key] = {"ts": now, "data": data}
    return data
