# ============================================================
# services/cot.py
# CFTC Commitments of Traders — speculative positioning.
#
#   Financial futures  (TFF report, gpe5-46if):
#     Leveraged Funds (hedge funds) net + Asset Managers net + Dealers net
#     for E-mini S&P 500 / E-mini Nasdaq-100 / 10Y T-Note / Euro FX.
#   Commodities        (Disaggregated report, 72hh-3qpy):
#     Managed Money net + Producer net + Swap net
#     for Gold / Silver / Copper / WTI crude.
#
# Contracts are resolved from the latest report by MAX open interest among
# name matches — robust to CFTC's verbose / shifting contract strings. Each
# leg carries ~3y of weekly net history + a percentile so extremes are obvious.
#
# Public, unauthenticated Socrata API. Weekly data → long TTL cache.
# ============================================================

import time
import threading

import pandas as pd
import requests

BASE = "https://publicreporting.cftc.gov/resource/{code}.json"
TFF = "gpe5-46if"          # Traders in Financial Futures (futures only)
DISAGG = "72hh-3qpy"       # Disaggregated (futures only)
HDRS = {"User-Agent": "Mozilla/5.0 (money_dashboard)"}
DATE = "report_date_as_yyyy_mm_dd"
NAME = "market_and_exchange_names"

# spec: all=(every token present) · any=(≥1 present) · not=(none present)
FINANCIAL = [
    {"key": "es", "label": "E-mini S&P 500",   "all": ["E-MINI S&P 500"], "not": ["MICRO", "ADJUSTED", "DIVIDEND"]},
    {"key": "nq", "label": "E-mini Nasdaq-100", "all": ["NASDAQ MINI"],     "not": []},
    {"key": "zn", "label": "10Y T-Note",        "all": ["NOTE"], "any": ["10Y", "10 YEAR", "10-YEAR"], "not": ["MICRO", "ULTRA"]},
    {"key": "6e", "label": "Euro FX",           "all": ["EURO FX"], "not": ["/"]},
]
COMMODITY = [
    {"key": "gc", "label": "Gold",      "all": ["GOLD"],   "not": ["MICRO", "PAX", "PERP", "KILO"]},
    {"key": "si", "label": "Silver",    "all": ["SILVER"], "not": ["MICRO"]},
    {"key": "hg", "label": "Copper",    "all": ["COPPER"], "not": []},
    {"key": "cl", "label": "WTI crude", "all": ["CRUDE OIL", "NEW YORK MERCANTILE"], "not": []},
]

_cache: dict = {"ts": 0.0, "data": None}
_TTL = 6 * 3600
_lock = threading.Lock()


def _num(s):
    return pd.to_numeric(s, errors="coerce")


def _latest(code: str) -> pd.DataFrame:
    r = requests.get(BASE.format(code=code), headers=HDRS, timeout=30,
                     params={"$order": f"{DATE} DESC", "$limit": 1500})
    r.raise_for_status()
    df = pd.DataFrame(r.json())
    if df.empty:
        return df
    return df[df[DATE] == df[DATE].max()]


def _history(code: str, name: str, n: int = 160) -> pd.DataFrame:
    r = requests.get(BASE.format(code=code), headers=HDRS, timeout=40,
                     params={NAME: name, "$order": f"{DATE} DESC", "$limit": n})
    r.raise_for_status()
    df = pd.DataFrame(r.json())
    if df.empty:
        return df
    return df.sort_values(DATE)


def _pick(latest: pd.DataFrame, spec: dict) -> str | None:
    """Choose the contract name matching the spec with the largest open interest."""
    names = latest[NAME].dropna().unique().tolist()

    def ok(n):
        u = n.upper()
        if not all(t in u for t in spec.get("all", [])):
            return False
        if spec.get("any") and not any(t in u for t in spec["any"]):
            return False
        if any(t in u for t in spec.get("not", [])):
            return False
        return True

    matches = [n for n in names if ok(n)]
    if not matches:
        return None
    if len(matches) == 1:
        return matches[0]
    sub = latest[latest[NAME].isin(matches)].copy()
    sub["_oi"] = _num(sub["open_interest_all"])
    return sub.sort_values("_oi", ascending=False)[NAME].iloc[0]


def _pctile(series: pd.Series, last) -> float | None:
    s = series.dropna()
    if len(s) < 10 or pd.isna(last):
        return None
    return round(float((s < last).mean()), 3)


def _series(df, long_col, short_col):
    net = _num(df[long_col]) - _num(df[short_col])
    return net


def _pack_financial(spec, name, df):
    dates = [str(d)[:10] for d in df[DATE]]
    lev = _series(df, "lev_money_positions_long", "lev_money_positions_short")
    am = _series(df, "asset_mgr_positions_long", "asset_mgr_positions_short")
    deal = _series(df, "dealer_positions_long_all", "dealer_positions_short_all")
    oi = _num(df["open_interest_all"])

    def last(s):
        v = s.dropna()
        return int(v.iloc[-1]) if len(v) else None

    def wow(s):
        v = s.dropna()
        return int(v.iloc[-1] - v.iloc[-2]) if len(v) > 1 else None

    return {
        "key": spec["key"], "label": spec["label"], "contract": name,
        "oi": last(oi),
        "lev_net": last(lev), "lev_chg": wow(lev), "lev_pctile": _pctile(lev, lev.dropna().iloc[-1] if len(lev.dropna()) else None),
        "am_net": last(am), "am_chg": wow(am), "am_pctile": _pctile(am, am.dropna().iloc[-1] if len(am.dropna()) else None),
        "dealer_net": last(deal),
        "dates": dates,
        "lev_hist": [None if pd.isna(v) else int(v) for v in lev.values],
        "am_hist": [None if pd.isna(v) else int(v) for v in am.values],
    }


def _pack_commodity(spec, name, df):
    dates = [str(d)[:10] for d in df[DATE]]
    mm = _series(df, "m_money_positions_long_all", "m_money_positions_short_all")
    prod = _series(df, "prod_merc_positions_long", "prod_merc_positions_short")
    swap = _series(df, "swap_positions_long_all", "swap__positions_short_all")
    oi = _num(df["open_interest_all"])

    def last(s):
        v = s.dropna()
        return int(v.iloc[-1]) if len(v) else None

    def wow(s):
        v = s.dropna()
        return int(v.iloc[-1] - v.iloc[-2]) if len(v) > 1 else None

    return {
        "key": spec["key"], "label": spec["label"], "contract": name,
        "oi": last(oi),
        "mm_net": last(mm), "mm_chg": wow(mm), "mm_pctile": _pctile(mm, mm.dropna().iloc[-1] if len(mm.dropna()) else None),
        "prod_net": last(prod), "swap_net": last(swap),
        "dates": dates,
        "mm_hist": [None if pd.isna(v) else int(v) for v in mm.values],
    }


def build_cot(force: bool = False) -> dict:
    with _lock:
        now = time.time()
        if not force and _cache["data"] and now - _cache["ts"] < _TTL:
            return _cache["data"]

        out = {"as_of": None, "financial": [], "commodity": [], "errors": {}}

        try:
            tff = _latest(TFF)
            if not tff.empty:
                out["as_of"] = str(pd.to_datetime(tff[DATE]).max().date())
                for spec in FINANCIAL:
                    name = _pick(tff, spec)
                    if not name:
                        continue
                    h = _history(TFF, name)
                    if not h.empty:
                        out["financial"].append(_pack_financial(spec, name, h))
        except Exception as e:
            out["errors"]["tff"] = str(e)[:160]

        try:
            dis = _latest(DISAGG)
            if not dis.empty and not out["as_of"]:
                out["as_of"] = str(pd.to_datetime(dis[DATE]).max().date())
            for spec in COMMODITY:
                name = _pick(dis, spec)
                if not name:
                    continue
                h = _history(DISAGG, name)
                if not h.empty:
                    out["commodity"].append(_pack_commodity(spec, name, h))
        except Exception as e:
            out["errors"]["disagg"] = str(e)[:160]

        _cache.update({"ts": now, "data": out})
        return out
