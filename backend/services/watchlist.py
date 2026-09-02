# ============================================================
# services/watchlist.py
# A small persisted watchlist (SQLite) for the News page — the symbols the
# user owns plus a macro basket (gold/silver/oil/treasuries via liquid ETF
# proxies, which carry news where futures don't). Self-seeds on first use.
# Also serves a lightweight last-price / % change quote for the price strip.
# ============================================================

import sqlite3
import time
from pathlib import Path
from datetime import datetime

import yfinance as yf

from services.data import _yf_lock

DB = Path(__file__).parent.parent / "watchlist.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS watchlist (
    symbol   TEXT PRIMARY KEY,
    label    TEXT,
    grp      TEXT DEFAULT 'Holdings',
    sort     INTEGER DEFAULT 0,
    added_at TEXT
)
"""

# (symbol, friendly label, group). Macro uses ETF proxies that actually carry
# news. Holdings are just sensible defaults the user can remove.
_DEFAULTS = [
    ("AAPL", "Apple",             "Holdings"),
    ("MSFT", "Microsoft",         "Holdings"),
    ("NVDA", "NVIDIA",            "Holdings"),
    ("GLD",  "Gold",              "Macro"),
    ("SLV",  "Silver",            "Macro"),
    ("USO",  "Oil (WTI)",         "Macro"),
    ("TLT",  "Treasuries 20Y+",   "Macro"),
]

_GROUP_ORDER = "CASE grp WHEN 'Holdings' THEN 0 WHEN 'Macro' THEN 1 ELSE 2 END"

_q_cache = {"ts": 0.0, "data": {}}


def _ensure(conn):
    conn.execute(_SCHEMA)
    n = conn.execute("SELECT COUNT(*) FROM watchlist").fetchone()[0]
    if n == 0:
        now = datetime.utcnow().isoformat()
        conn.executemany(
            "INSERT OR IGNORE INTO watchlist (symbol, label, grp, sort, added_at) VALUES (?,?,?,?,?)",
            [(s, l, g, i, now) for i, (s, l, g) in enumerate(_DEFAULTS)],
        )
        conn.commit()


def get_watchlist():
    with sqlite3.connect(DB) as conn:
        _ensure(conn)
        rows = conn.execute(
            f"SELECT symbol, label, grp, sort FROM watchlist ORDER BY {_GROUP_ORDER}, sort, symbol"
        ).fetchall()
    return [{"symbol": r[0], "label": r[1] or r[0], "group": r[2] or "Holdings", "sort": r[3]} for r in rows]


def add_item(symbol, label=None, group="Holdings"):
    sym = (symbol or "").strip().upper()
    if not sym:
        return get_watchlist()
    with sqlite3.connect(DB) as conn:
        _ensure(conn)
        mx = conn.execute("SELECT COALESCE(MAX(sort), 0) FROM watchlist").fetchone()[0]
        conn.execute(
            "INSERT OR REPLACE INTO watchlist (symbol, label, grp, sort, added_at) VALUES (?,?,?,?,?)",
            (sym, (label or sym).strip(), group or "Holdings", mx + 1, datetime.utcnow().isoformat()),
        )
        conn.commit()
    return get_watchlist()


def remove_item(symbol):
    sym = (symbol or "").strip().upper()
    with sqlite3.connect(DB) as conn:
        _ensure(conn)
        conn.execute("DELETE FROM watchlist WHERE symbol = ?", (sym,))
        conn.commit()
    return get_watchlist()


def get_quotes(symbols):
    """Last price + 1-day % change for the watchlist price strip. One bulk
    download, cached 60s."""
    syms = [s for s in symbols if s]
    if not syms:
        return {}
    now = time.time()
    if now - _q_cache["ts"] < 60 and all(s in _q_cache["data"] for s in syms):
        return {s: _q_cache["data"][s] for s in syms}

    out = {}
    acquired = _yf_lock.acquire(timeout=25)
    try:
        df = yf.download(syms, period="5d", interval="1d", auto_adjust=True,
                         progress=False, threads=False, group_by="ticker")
        for s in syms:
            try:
                close = df["Close"] if len(syms) == 1 else df[s]["Close"]
                close = close.dropna()
                if len(close) >= 2:
                    last, prev = float(close.iloc[-1]), float(close.iloc[-2])
                    out[s] = {"price": round(last, 2), "change_pct": round(last / prev - 1, 4)}
                elif len(close) == 1:
                    out[s] = {"price": round(float(close.iloc[-1]), 2), "change_pct": None}
            except Exception:
                continue
    except Exception:
        pass
    finally:
        if acquired:
            _yf_lock.release()

    _q_cache["ts"] = now
    _q_cache["data"].update(out)
    return out
