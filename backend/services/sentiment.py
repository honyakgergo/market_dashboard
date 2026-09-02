# ============================================================
# services/sentiment.py
# Positioning / sentiment feeds outside yfinance:
#   - NAAIM Exposure Index (weekly active-manager equity exposure)
#   - AAII bull/neutral/bearish (weekly retail sentiment)
# Both are scraped from cell-content tables (labels live in the first row,
# not the headers) and accumulated into sentiment.db so history grows week
# over week. AAII's full historical export is membership-gated, so we build
# history forward from the ~22 weeks the public page exposes.
# Weekly data → long TTL cache.
# ============================================================

import time
import threading
import sqlite3
from io import StringIO
from pathlib import Path
from datetime import datetime

import pandas as pd
import requests

DB = Path(__file__).parent.parent / "sentiment.db"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
HDRS = {"User-Agent": UA, "Accept": "text/html,application/xhtml+xml"}

_cache: dict = {"ts": 0.0, "data": None}
_TTL = 6 * 3600
_lock = threading.Lock()


def _init():
    with sqlite3.connect(DB) as c:
        c.execute("CREATE TABLE IF NOT EXISTS naaim (date TEXT PRIMARY KEY, value REAL)")
        c.execute("CREATE TABLE IF NOT EXISTS aaii (date TEXT PRIMARY KEY, bullish REAL, neutral REAL, bearish REAL)")
        c.commit()
_init()


def _iso(d: str) -> str | None:
    d = (d or "").strip()
    for fmt in ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d"):
        try:
            return datetime.strptime(d, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _pct(x) -> float | None:
    v = pd.to_numeric(str(x).replace("%", "").strip(), errors="coerce")
    return None if pd.isna(v) else round(float(v) / 100, 4)


# ── NAAIM ────────────────────────────────────────────────────
def _refresh_naaim():
    r = requests.get("https://www.naaim.org/programs/naaim-exposure-index/", headers=HDRS, timeout=25)
    r.raise_for_status()
    tables = pd.read_html(StringIO(r.text))
    if not tables:
        return
    t = tables[0]
    t.columns = [str(c) for c in t.columns]
    recs = []
    for _, row in t.iloc[1:].iterrows():           # row 0 = header labels
        d = _iso(str(row.get("0", "")))
        v = pd.to_numeric(str(row.get("1", "")).replace("%", ""), errors="coerce")
        if d and pd.notna(v):
            recs.append((d, float(v)))
    if recs:
        with sqlite3.connect(DB) as c:
            c.executemany("INSERT OR REPLACE INTO naaim (date, value) VALUES (?, ?)", recs)
            c.commit()


def _naaim_payload():
    with sqlite3.connect(DB) as c:
        rows = c.execute("SELECT date, value FROM naaim ORDER BY date").fetchall()
    if not rows:
        return None
    dates = [r[0] for r in rows]
    vals = [r[1] for r in rows]
    last, prev = vals[-1], (vals[-2] if len(vals) > 1 else None)
    s = pd.Series(vals)
    return {
        "dates": dates, "values": vals, "n": len(vals), "last": last,
        "change": round(last - prev, 2) if prev is not None else None,
        "pctile": round(float((s < last).mean()), 3) if len(s) >= 8 else None,
        "min": round(float(s.min()), 2), "max": round(float(s.max()), 2),
    }


# ── AAII ─────────────────────────────────────────────────────
def _assign_years(raw):
    """raw = [(mon_day, bull, neu, bear), ...] most-recent first, no year.
    Infer years by walking back and rolling the year when the month jumps up."""
    now = datetime.now()
    year = now.year
    out, prev_m = [], None
    for i, (ds, b, n, be) in enumerate(raw):
        try:
            dt = datetime.strptime(f"{ds} {year}", "%b %d %Y")
        except ValueError:
            out.append((None, b, n, be))
            continue
        if i == 0:
            if (dt - now).days > 5:                # "most recent" is actually last year
                year -= 1
                dt = dt.replace(year=year)
        elif prev_m is not None and dt.month > prev_m:
            year -= 1
            dt = dt.replace(year=year)
        prev_m = dt.month
        out.append((dt.strftime("%Y-%m-%d"), b, n, be))
    return out


AAII_URL = "https://www.aaii.com/sentimentsurvey/sent_results"
AAII_HDRS = {**HDRS, "Referer": "https://www.aaii.com/", "Accept-Language": "en-US,en;q=0.9"}


def _refresh_aaii():
    """Fetch + parse the AAII results table. Raises with a clear message on any
    failure so the reason surfaces to the UI. Retries once (bot protection is
    intermittent); a single success persists to the DB."""
    status = None
    r = None
    for attempt in range(2):
        r = requests.get(AAII_URL, headers=AAII_HDRS, timeout=25)
        status = r.status_code
        if status == 200:
            break
        time.sleep(1.0)
    if status != 200 or r is None:
        raise RuntimeError(f"HTTP {status}")
    tables = pd.read_html(StringIO(r.text))
    target = None
    for tb in tables:
        if tb.shape[0] < 2:                        # guard empty tables (no iloc[0])
            continue
        tb.columns = [str(c) for c in tb.columns]
        first = " ".join(str(x) for x in tb.iloc[0].tolist()).lower()
        if "bullish" in first and "bearish" in first:
            target = tb
            break
    if target is None:
        raise RuntimeError(f"no sentiment table ({len(tables)} tables parsed)")
    raw = []
    for _, row in target.iloc[1:].iterrows():      # row 0 = header labels
        ds = str(row.get("0", "")).strip()
        b, n, be = _pct(row.get("1")), _pct(row.get("2")), _pct(row.get("3"))
        if ds and b is not None and be is not None:
            raw.append((ds, b, n, be))
    recs = [(d, b, n, be) for (d, b, n, be) in _assign_years(raw) if d]
    if not recs:
        raise RuntimeError(f"parsed 0 usable rows from {target.shape[0] - 1} data rows")
    with sqlite3.connect(DB) as c:
        c.executemany("INSERT OR REPLACE INTO aaii (date, bullish, neutral, bearish) VALUES (?, ?, ?, ?)", recs)
        c.commit()
    return len(recs)


def _aaii_payload(note=None):
    with sqlite3.connect(DB) as c:
        rows = c.execute("SELECT date, bullish, neutral, bearish FROM aaii ORDER BY date").fetchall()
    if not rows:
        return {"available": False, "note": note}
    dates = [r[0] for r in rows]
    bull = [r[1] for r in rows]
    neu = [r[2] for r in rows]
    bear = [r[3] for r in rows]
    spread = [round(b - be, 4) for b, be in zip(bull, bear)]
    s = pd.Series(spread)
    last_spread = spread[-1]
    return {
        "available": True, "note": note, "n": len(rows),
        "dates": dates, "bullish": bull, "neutral": neu, "bearish": bear, "spread": spread,
        "last": {"date": dates[-1], "bullish": bull[-1], "neutral": neu[-1], "bearish": bear[-1], "spread": last_spread},
        "spread_pctile": round(float((s < last_spread).mean()), 3) if len(s) >= 8 else None,
        "hist_avg_bull": round(float(pd.Series(bull).mean()), 4),
    }


# ── build ────────────────────────────────────────────────────
def build_sentiment(force: bool = False) -> dict:
    with _lock:
        now = time.time()
        if not force and _cache["data"] and now - _cache["ts"] < _TTL:
            return _cache["data"]

        out = {"naaim": None, "aaii": None, "errors": {}}

        try:
            _refresh_naaim()
        except Exception as e:
            out["errors"]["naaim"] = str(e)[:160]
        out["naaim"] = _naaim_payload()

        aaii_note = None
        try:
            _refresh_aaii()
        except Exception as e:
            aaii_note = f"{type(e).__name__}: {str(e)[:100]}"
            out["errors"]["aaii"] = aaii_note
        out["aaii"] = _aaii_payload(aaii_note)

        _cache.update({"ts": now, "data": out})
        return out
