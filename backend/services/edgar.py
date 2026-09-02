# ============================================================
# services/edgar.py
# SEC EDGAR XBRL client — deep fundamental history that yfinance can't give
# (Yahoo serves only ~4 annual / ~5 quarterly periods; EDGAR has the full
# filing history for free). US filers only.
#
# Uses the companyconcept API and relies on SEC's calendar "frame" tags
# (e.g. CY2023Q2 / CY2023) to get one clean, deduped value per calendar
# quarter / year. SEC requires a descriptive User-Agent — edit SEC_UA below
# to your own contact if you ever get throttled.
# ============================================================

import re
import time
import threading
from datetime import date

import requests

SEC_UA = {"User-Agent": "money_dashboard research (contact: you@example.com)"}

_TTL_MAP = 86400        # ticker→CIK map: refresh daily
_TTL_CONCEPT = 43200    # per-concept facts: 12h
_lock = threading.Lock()
_cik = {"ts": 0.0, "map": None}
_cc_cache: dict = {}

_FRAME_Q = re.compile(r"^CY\d{4}Q[1-4]$")   # quarterly-duration calendar frame
_FRAME_Y = re.compile(r"^CY\d{4}$")         # annual-duration calendar frame

REVENUE = ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues",
           "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"]
EPS = ["EarningsPerShareDiluted", "EarningsPerShareBasic"]
NET_INCOME = ["NetIncomeLoss"]


def cik_for(ticker: str):
    t = (ticker or "").upper()
    if not t:
        return None
    now = time.time()
    with _lock:
        fresh = _cik["map"] is not None and now - _cik["ts"] < _TTL_MAP
    if not fresh:
        try:
            r = requests.get("https://www.sec.gov/files/company_tickers.json",
                             headers=SEC_UA, timeout=15)
            j = r.json()
            m = {}
            for _, row in j.items():
                sym = str(row.get("ticker", "")).upper()
                if sym:
                    m[sym] = str(row.get("cik_str", "")).zfill(10)
            with _lock:
                _cik["map"] = m
                _cik["ts"] = now
        except Exception:
            pass
    with _lock:
        mp = _cik["map"] or {}
    return mp.get(t)


def _facts(cik, names):
    key = (cik, tuple(names))
    now = time.time()
    c = _cc_cache.get(key)
    if c and now - c["ts"] < _TTL_CONCEPT:
        return c["arr"]
    arr = None
    for name in names:
        try:
            r = requests.get(
                f"https://data.sec.gov/api/xbrl/companyconcept/CIK{cik}/us-gaap/{name}.json",
                headers=SEC_UA, timeout=15)
            if r.status_code != 200:
                continue
            units = r.json().get("units", {})
            a = units.get("USD") or units.get("USD/shares")
            if a:
                arr = a
                break
        except Exception:
            continue
    _cc_cache[key] = {"ts": now, "arr": arr}
    return arr


def _days(a, b):
    try:
        return (date.fromisoformat(b) - date.fromisoformat(a)).days
    except Exception:
        return None


def _typed(cik, names):
    """Split a concept's USD facts into discrete-quarter (~90d) and annual
    (~365d) buckets, each deduped by end-date keeping the latest-filed value
    (handles restatements). Duration-based, so it doesn't depend on SEC's
    calendar 'frame' tags being present."""
    arr = _facts(cik, names) or []
    q, qf, ann, af = {}, {}, {}, {}
    for f in arr:
        s, e, v, fl = f.get("start"), f.get("end"), f.get("val"), f.get("filed", "")
        if not s or not e or v is None:
            continue
        d = _days(s, e)
        if d is None:
            continue
        try:
            v = float(v)
        except Exception:
            continue
        if 80 <= d <= 100:
            if e not in q or fl > qf.get(e, ""):
                q[e], qf[e] = v, fl
        elif 350 <= d <= 380:
            if e not in ann or fl > af.get(e, ""):
                ann[e], af[e] = (s, v), fl
    return q, ann


def _quarterly(cik, names):
    """Discrete quarterly series, with the missing 4th quarter of each fiscal
    year reconstructed as annual - (the 3 quarters inside that year's window).
    Q4 is placed at the fiscal-year-end date."""
    q, ann = _typed(cik, names)
    ends = sorted(q.keys())
    for aend, (astart, atot) in ann.items():
        within = [e for e in ends if astart < e <= aend]
        if len(within) == 3 and aend not in q:
            q[aend] = round(atot - sum(q[e] for e in within), 6)
    return [{"date": k, "val": q[k]} for k in sorted(q.keys())]


def _annual(cik, names):
    _, ann = _typed(cik, names)
    return [{"date": e, "val": v} for e, (s, v) in sorted(ann.items())]


def revenue_quarterly(cik):    return _quarterly(cik, REVENUE)
def revenue_annual(cik):       return _annual(cik, REVENUE)
def eps_quarterly(cik):        return _quarterly(cik, EPS)
def net_income_quarterly(cik): return _quarterly(cik, NET_INCOME)
def net_income_annual(cik):    return _annual(cik, NET_INCOME)
