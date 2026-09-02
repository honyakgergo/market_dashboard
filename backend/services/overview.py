# ============================================================
# services/overview.py
# Market Overview: sector heatmap, breadth (+ TRIN), and movers.
#
# Two modes, chosen by the market clock:
#   - CLOSE (US shut): everything from the warmed daily cache. Fast.
#   - LIVE  (US open): structural metrics (MAs, longer returns, crosses)
#     still come from the daily cache, but ONE bulk intraday snapshot of the
#     universe overlays today's price so ret_1d / breadth / TRIN / movers are
#     live. One batched yfinance call, not 500 — kept behind the shared lock.
# ============================================================

import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

from services.data import _load_from_cache, _yf_lock
from services.session import market_session

SEARCH_DB = Path(__file__).parent.parent / "search.db"
EQUITY_CATEGORIES = ("mega_equity", "large_equity", "volatile_equity")

# in-memory TTL cache, keyed by mode ('live' | 'close')
_cache: dict = {}
_TTL_CLOSE = 180
_TTL_LIVE = 150

# ── Extra heatmap universes (rendered like the S&P sector heatmap) ─────
# European single names grouped by sector, and commodities grouped by
# subgroup. Not in the warm cache, so pulled via bulk downloads and cached
# separately (longer TTL) so we don't refetch on every overview cycle.
EUROPE_STOCKS = {
    "Technology": ["SAP.DE", "ASML.AS", "ADYEN.AS", "STM.PA", "IFX.DE", "CAP.PA", "DSY.PA", "NOKIA.HE", "ERIC-B.ST"],
    "Health Care": ["NOVN.SW", "ROG.SW", "AZN.L", "NOVO-B.CO", "SAN.PA", "GSK.L", "BAYN.DE", "FRE.DE"],
    "Financials": ["HSBA.L", "BNP.PA", "ALV.DE", "UBSG.SW", "SAN.MC", "INGA.AS", "BBVA.MC", "AXA.PA", "DBK.DE"],
    "Consumer Disc.": ["MC.PA", "RMS.PA", "OR.PA", "ITX.MC", "VOW3.DE", "BMW.DE", "MBG.DE"],
    "Consumer Staples": ["NESN.SW", "ULVR.L", "DGE.L", "BATS.L", "HEIA.AS", "AD.AS"],
    "Industrials": ["SIE.DE", "AIR.PA", "SU.PA", "ABBN.SW", "DHL.DE", "RHM.DE", "SAF.PA"],
    "Energy": ["SHEL.L", "TTE.PA", "BP.L", "ENI.MI", "EQNR.OL"],
    "Materials": ["BAS.DE", "RIO.L", "GLEN.L", "AI.PA", "ANTO.L"],
    "Utilities": ["IBE.MC", "ENEL.MI", "EOAN.DE", "RWE.DE", "NG.L"],
    "Comm. Services": ["DTE.DE", "ORA.PA", "VOD.L", "TEF.MC"],
}
COMMOD_GROUPS = {
    "Metals": [("Gold", "GC=F"), ("Silver", "SI=F"), ("Copper", "HG=F"), ("Platinum", "PL=F"), ("Palladium", "PA=F")],
    "Energy": [("WTI crude", "CL=F"), ("Brent", "BZ=F"), ("Nat gas", "NG=F"), ("Gasoline", "RB=F"), ("Heating oil", "HO=F")],
    "Agriculture": [("Corn", "ZC=F"), ("Wheat", "ZW=F"), ("Soybeans", "ZS=F"), ("Coffee", "KC=F"), ("Sugar", "SB=F"), ("Cocoa", "CC=F"), ("Cotton", "CT=F")],
}

_regions_cache: dict = {"ts": 0.0, "data": None}
_REGIONS_TTL = 600


def _bulk_close(symbols: list[str], period: str = "3mo") -> dict:
    out = {}
    acquired = _yf_lock.acquire(timeout=90)
    if not acquired:
        return out
    try:
        raw = yf.download(symbols, period=period, interval="1d", auto_adjust=True,
                          progress=False, threads=True, group_by="ticker")
    except Exception:
        raw = None
    finally:
        _yf_lock.release()
    if raw is None or raw.empty:
        return out
    multi = isinstance(raw.columns, pd.MultiIndex)
    for s in symbols:
        try:
            sub = raw[s] if (multi and s in raw.columns.get_level_values(0)) else (raw if not multi else None)
            if sub is None:
                continue
            c = sub["Close"].dropna()
            if len(c):
                out[s] = c
        except Exception:
            continue
    return out


def _heat_row(symbol, label, sector, c):
    last = float(c.iloc[-1])
    return {
        "symbol": symbol, "label": label, "sector": sector,
        "ret_1d": round(last / float(c.iloc[-2]) - 1, 4) if len(c) > 1 else None,
        "ret_1m": round(last / float(c.iloc[-22]) - 1, 4) if len(c) > 22 else None,
    }


def _agg_sectors(heat, order):
    agg = {}
    for t in heat:
        a = agg.setdefault(t["sector"], {"count": 0, "s1d": 0.0, "n1d": 0, "s1m": 0.0, "n1m": 0})
        a["count"] += 1
        if t["ret_1d"] is not None:
            a["s1d"] += t["ret_1d"]; a["n1d"] += 1
        if t["ret_1m"] is not None:
            a["s1m"] += t["ret_1m"]; a["n1m"] += 1
    out = []
    for sec in order:
        if sec in agg:
            a = agg[sec]
            out.append({"sector": sec, "count": a["count"],
                        "avg_1d": round(a["s1d"] / a["n1d"], 4) if a["n1d"] else None,
                        "avg_1m": round(a["s1m"] / a["n1m"], 4) if a["n1m"] else None})
    return out


def _build_regions() -> dict:
    now = time.time()
    if _regions_cache["data"] and now - _regions_cache["ts"] < _REGIONS_TTL:
        return _regions_cache["data"]

    # Europe
    eu_syms = [s for lst in EUROPE_STOCKS.values() for s in lst]
    eu_close = _bulk_close(eu_syms)
    eu_heat = []
    for sector, syms in EUROPE_STOCKS.items():
        for s in syms:
            c = eu_close.get(s)
            if c is not None and len(c) >= 3:
                eu_heat.append(_heat_row(s, s.split(".")[0], sector, c))

    # Commodities
    com_syms = [t for lst in COMMOD_GROUPS.values() for _, t in lst]
    com_close = _bulk_close(com_syms)
    com_heat = []
    for group, lst in COMMOD_GROUPS.items():
        for name, t in lst:
            c = com_close.get(t)
            if c is not None and len(c) >= 3:
                com_heat.append(_heat_row(t, name, group, c))

    data = {
        "Europe": {"heatmap": eu_heat, "sectors": _agg_sectors(eu_heat, EUROPE_STOCKS.keys())},
        "Commodities": {"heatmap": com_heat, "sectors": _agg_sectors(com_heat, COMMOD_GROUPS.keys())},
    }
    _regions_cache.update({"ts": now, "data": data})
    return data


def _equity_meta() -> list[dict]:
    if not SEARCH_DB.exists():
        return []
    with sqlite3.connect(f"file:{SEARCH_DB}?mode=ro", uri=True) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT symbol, sector, category FROM tickers WHERE category IN (?,?,?)",
            EQUITY_CATEGORIES,
        ).fetchall()
    return [dict(r) for r in rows]


def _bulk_snapshot(tickers: list[str], batch: int = 250) -> dict:
    """One (batched, threaded) intraday download → {symbol: (last_price, day_volume)}.

    Uses period=1d so each ticker's latest bar is today's forming session.
    threads=True lets yfinance parallelize — ~500 names in ~10-15s instead of
    100s+. Behind the shared yfinance lock; partial results are fine.
    """
    out: dict = {}
    acquired = _yf_lock.acquire(timeout=90)
    if not acquired:
        return out
    try:
        for i in range(0, len(tickers), batch):
            chunk = tickers[i:i + batch]
            try:
                raw = yf.download(chunk, period="1d", interval="1d", auto_adjust=True,
                                  progress=False, threads=True, group_by="ticker")
            except Exception:
                continue
            if raw is None or raw.empty:
                continue
            multi = isinstance(raw.columns, pd.MultiIndex)
            for sym in chunk:
                try:
                    sub = raw[sym] if (multi and sym in raw.columns.get_level_values(0)) else (raw if not multi else None)
                    if sub is None or sub.empty:
                        continue
                    row = sub.dropna().iloc[-1]
                    out[sym] = (float(row["Close"]), float(row["Volume"]))
                except Exception:
                    continue
    finally:
        _yf_lock.release()
    return out


def _metrics(sym: str, sector: str, start: str, end: str, live=None) -> dict | None:
    df = _load_from_cache(sym, start, end)
    if df is None or len(df) < 60:
        return None
    close = df["Close"].astype(float)
    vol = df["Volume"].astype(float)

    ma50_s = close.rolling(50).mean()
    ma200_s = close.rolling(200).mean()
    ma50 = float(ma50_s.iloc[-1]) if pd.notna(ma50_s.iloc[-1]) else None
    ma200 = float(ma200_s.iloc[-1]) if pd.notna(ma200_s.iloc[-1]) else None

    win = close.iloc[-252:] if len(close) >= 252 else close
    hi, lo = float(win.max()), float(win.min())
    avg_vol20 = float(vol.iloc[-20:].mean()) if len(vol) >= 20 else float(vol.mean())

    if live is not None:
        # live price overlays today; returns measured from it back N sessions
        last, today_vol = float(live[0]), float(live[1])
        if last <= 0:
            return None
        def ret(n):
            return (last / float(close.iloc[-n]) - 1) if len(close) >= n else None
        ret_1d, ret_1w, ret_1m, ret_3m = ret(1), ret(5), ret(21), ret(63)
        hi, lo = max(hi, last), min(lo, last)
    else:
        last = float(close.iloc[-1])
        if last <= 0:
            return None
        today_vol = float(vol.iloc[-1])
        def ret(n):
            return (last / float(close.iloc[-n]) - 1) if len(close) > n else None
        ret_1d, ret_1w, ret_1m, ret_3m = ret(2), ret(6), ret(22), ret(66)

    # MA50/200 cross within the last 5 sessions (structural — from cache)
    cross = None
    if len(ma50_s.dropna()) > 5 and len(ma200_s.dropna()) > 5:
        d = (ma50_s - ma200_s).dropna()
        if len(d) > 6:
            recent = np.sign(d.iloc[-6:].values)
            if recent[0] < 0 and recent[-1] > 0:
                cross = "golden"
            elif recent[0] > 0 and recent[-1] < 0:
                cross = "death"

    return {
        "symbol": sym, "sector": sector, "close": round(last, 2),
        "ret_1d": ret_1d, "ret_1w": ret_1w, "ret_1m": ret_1m, "ret_3m": ret_3m,
        "above_50": (ma50 is not None and last > ma50),
        "above_200": (ma200 is not None and last > ma200),
        "pct_from_high": round(last / hi - 1, 4) if hi else None,
        "new_high": last >= hi * 0.999,
        "new_low": last <= lo * 1.001,
        "dollar_vol": round(last * avg_vol20, 0),
        "vol_ratio": round(today_vol / avg_vol20, 2) if avg_vol20 else None,
        "today_dvol": round(last * today_vol, 0) if today_vol else None,
        "cross": cross,
    }


def build_overview(force: bool = False) -> dict:
    sess = market_session()
    live = sess["us_open"]
    key = "live" if live else "close"
    ttl = _TTL_LIVE if live else _TTL_CLOSE

    now = time.time()
    cached = _cache.get(key)
    if not force and cached and (now - cached["ts"] < ttl):
        return cached["data"]

    end = datetime.now().strftime("%Y-%m-%d")
    start = (datetime.now() - timedelta(days=430)).strftime("%Y-%m-%d")

    meta = _equity_meta()
    snapshot = _bulk_snapshot([m["symbol"] for m in meta]) if live else {}

    rows = []
    for m in meta:
        r = _metrics(m["symbol"], m["sector"], start, end, live=snapshot.get(m["symbol"]))
        if r:
            rows.append(r)

    n = len(rows)
    adv = sum(1 for r in rows if (r["ret_1d"] or 0) > 0)
    dec = sum(1 for r in rows if (r["ret_1d"] or 0) < 0)
    above50 = sum(1 for r in rows if r["above_50"])
    above200 = sum(1 for r in rows if r["above_200"])
    new_hi = sum(1 for r in rows if r["new_high"])
    new_lo = sum(1 for r in rows if r["new_low"])

    up_vol = sum(r["today_dvol"] for r in rows if (r["ret_1d"] or 0) > 0 and r["today_dvol"])
    dn_vol = sum(r["today_dvol"] for r in rows if (r["ret_1d"] or 0) < 0 and r["today_dvol"])
    trin = round((adv / dec) / (up_vol / dn_vol), 2) if (dec and dn_vol and up_vol) else None

    sectors = {}
    for r in rows:
        s = sectors.setdefault(r["sector"], {"sector": r["sector"], "count": 0, "sum_1d": 0.0, "sum_1m": 0.0})
        s["count"] += 1
        s["sum_1d"] += r["ret_1d"] or 0
        s["sum_1m"] += r["ret_1m"] or 0
    sector_list = [
        {"sector": s["sector"], "count": s["count"],
         "avg_1d": round(s["sum_1d"] / s["count"], 4),
         "avg_1m": round(s["sum_1m"] / s["count"], 4)}
        for s in sectors.values()
    ]
    sector_list.sort(key=lambda x: x["avg_1d"], reverse=True)

    by_1d = sorted([r for r in rows if r["ret_1d"] is not None], key=lambda r: r["ret_1d"])
    movers = {
        "gainers": list(reversed(by_1d[-12:])),
        "losers": by_1d[:12],
        "unusual_volume": sorted([r for r in rows if r["vol_ratio"]], key=lambda r: r["vol_ratio"], reverse=True)[:12],
        "crosses": [r for r in rows if r["cross"]],
    }

    data = {
        "mode": key,
        "phase": sess["phase"],
        "as_of": sess["now_cet"] + " CET" if live else end,
        "universe_size": n,
        "breadth": {
            "advancers": adv, "decliners": dec, "unchanged": n - adv - dec,
            "pct_above_50": round(above50 / n, 4) if n else None,
            "pct_above_200": round(above200 / n, 4) if n else None,
            "new_highs": new_hi, "new_lows": new_lo,
            "up_volume": up_vol, "down_volume": dn_vol,
            "vol_ratio": round(up_vol / dn_vol, 2) if dn_vol else None,
            "trin": trin,
        },
        "sectors": sector_list,
        "heatmap": [
            {"symbol": r["symbol"], "sector": r["sector"], "ret_1d": r["ret_1d"],
             "ret_1m": r["ret_1m"], "dollar_vol": r["dollar_vol"], "above_200": r["above_200"]}
            for r in rows
        ],
        "movers": movers,
        "regions": _build_regions(),
    }
    _cache[key] = {"ts": now, "data": data}
    return data
