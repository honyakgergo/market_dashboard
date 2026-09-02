# ============================================================
# services/ticker_search.py
# Search/lookup over the seeded ticker universe (search.db).
#
# This DB is the SEARCH INDEX — metadata for ~552 tickers (S&P 500 + ETFs +
# crypto). It is NOT the price cache. Price data flows through
# services/data.py + cache.db. The index is built by seed_tickers.py from
# data/sp500_seed.csv + data/etf_seed.csv.
#
# Read-only against `tickers`, except:
#   - mark_accessed() updates last_accessed when a user picks a ticker
#   - lookup_and_add() inserts new rows for tickers not in the seed
# ============================================================

import sqlite3
import threading
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "search.db"

# Guard concurrent writes to search.db. Reads are fine without a lock
# (SQLite handles them), but multi-threaded writes can collide.
_db_lock = threading.Lock()


# ------------------------------------------------------------
# Connection helper — read-only by default, opt-in to write
# ------------------------------------------------------------

def _connect(write: bool = False) -> sqlite3.Connection:
    """Open a connection to search.db. Read-only unless write=True."""
    if write:
        conn = sqlite3.connect(DB_PATH)
    else:
        # ?mode=ro is the safest way to express "I will not write"
        conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


# ------------------------------------------------------------
# Search
# ------------------------------------------------------------

def search(query: str, limit: int = 10) -> list[dict]:
    """
    Search the tickers table. Ranks results:
      1. Exact symbol match
      2. Symbol prefix match
      3. Company name substring match
    Within each tier, sorted by last_accessed DESC (most recently used first).
    """
    q = (query or "").strip()
    if not q:
        return []

    q_upper = q.upper()
    q_like_sym = f"{q_upper}%"
    q_like_name = f"%{q.lower()}%"

    sql = """
        SELECT symbol, name, sector, exchange, category, last_accessed
        FROM tickers
        WHERE UPPER(symbol) LIKE ?
           OR LOWER(name) LIKE ?
        ORDER BY
            CASE
                WHEN UPPER(symbol) = ?            THEN 0
                WHEN UPPER(symbol) LIKE ?         THEN 1
                ELSE 2
            END,
            last_accessed DESC NULLS LAST,
            symbol
        LIMIT ?
    """
    with _connect() as conn:
        rows = conn.execute(
            sql, (q_like_sym, q_like_name, q_upper, q_like_sym, limit)
        ).fetchall()
    return [dict(r) for r in rows]


def get_recent(limit: int = 5) -> list[dict]:
    """Tickers most recently accessed by the user."""
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT symbol, name, sector, exchange, category, last_accessed
            FROM tickers
            WHERE last_accessed IS NOT NULL
            ORDER BY last_accessed DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_one(symbol: str) -> dict | None:
    """Look up a single ticker by exact symbol. Returns None if not present."""
    sym = (symbol or "").strip().upper()
    if not sym:
        return None
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT symbol, name, sector, exchange, category, last_accessed
            FROM tickers
            WHERE UPPER(symbol) = ?
            """,
            (sym,),
        ).fetchone()
    return dict(row) if row else None


# ------------------------------------------------------------
# Mutation — small surface
# ------------------------------------------------------------

def mark_accessed(symbol: str) -> bool:
    """Update last_accessed = now() for the given symbol.
    Returns True if a row was updated.
    """
    sym = (symbol or "").strip().upper()
    if not sym:
        return False
    now_iso = datetime.utcnow().isoformat()
    with _db_lock, _connect(write=True) as conn:
        cur = conn.execute(
            "UPDATE tickers SET last_accessed = ? WHERE UPPER(symbol) = ?",
            (now_iso, sym),
        )
        conn.commit()
        return cur.rowcount > 0


def lookup_and_add(symbol: str, validator_fn) -> dict | None:
    """
    Validate a ticker that's not in our seed, then add it.

    `validator_fn(symbol)` must:
      - return a dict with at least {name, sector?, exchange?} if valid
      - raise (or return None) if invalid

    Returns the inserted row dict on success, None on failure.

    The validator is injected so this module stays decoupled from yfinance.
    Caller (main.py) wires in services.data.fetch_ohlcv-based validation.
    """
    sym = (symbol or "").strip().upper()
    if not sym:
        return None

    # Already in DB? Don't validate again — just return what we have.
    existing = get_one(sym)
    if existing:
        return existing

    # Validate via injected function
    try:
        info = validator_fn(sym)
    except Exception:
        return None
    if not info:
        return None

    now_iso = datetime.utcnow().isoformat()
    row = {
        "symbol":   sym,
        "name":     info.get("name") or sym,
        "sector":   info.get("sector") or "Unknown",
        "exchange": info.get("exchange") or "",
        "category": info.get("category") or "large_equity",
        "is_seed":  0,
        "first_seen":    now_iso,
        "last_accessed": now_iso,
    }

    with _db_lock, _connect(write=True) as conn:
        conn.execute(
            """
            INSERT INTO tickers
              (symbol, name, sector, exchange, category, is_seed, first_seen, last_accessed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol) DO NOTHING
            """,
            (
                row["symbol"], row["name"], row["sector"], row["exchange"],
                row["category"], row["is_seed"], row["first_seen"], row["last_accessed"],
            ),
        )
        conn.commit()

    return get_one(sym)


# ------------------------------------------------------------
# Health
# ------------------------------------------------------------

def stats() -> dict:
    """Cache stats — useful for debugging and the /tickers/stats endpoint."""
    with _connect() as conn:
        total       = conn.execute("SELECT COUNT(*) FROM tickers").fetchone()[0]
        seeded      = conn.execute("SELECT COUNT(*) FROM tickers WHERE is_seed = 1").fetchone()[0]
        user_added  = conn.execute("SELECT COUNT(*) FROM tickers WHERE is_seed = 0").fetchone()[0]
        accessed    = conn.execute("SELECT COUNT(*) FROM tickers WHERE last_accessed IS NOT NULL").fetchone()[0]
    return {
        "total":       total,
        "seeded":      seeded,
        "user_added":  user_added,
        "ever_accessed": accessed,
        "db_path":     str(DB_PATH),
    }
