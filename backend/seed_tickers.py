# ============================================================
# backend/seed_tickers.py
# Builds the search index (search.db -> `tickers`) from the seed CSVs.
#
# search.db is the SEARCH INDEX, not the price cache. It is regenerated from
# data/sp500_seed.csv + data/etf_seed.csv rather than copied as a binary, so
# the project stays self-contained and the index is reproducible.
#
#   ensure_seeded()  — called on app startup; seeds only if the table is empty
#   reseed()         — drops and rebuilds (run this module directly)
#
# Usage:  python seed_tickers.py
# ============================================================

import csv
import sqlite3
from datetime import datetime
from pathlib import Path

from services.validate import classify

BACKEND_DIR = Path(__file__).parent
DB_PATH = BACKEND_DIR / "search.db"
DATA_DIR = BACKEND_DIR / "data"
SEED_FILES = ["sp500_seed.csv", "etf_seed.csv"]

_SCHEMA = """
CREATE TABLE IF NOT EXISTS tickers (
    symbol        TEXT PRIMARY KEY,
    name          TEXT,
    sector        TEXT,
    exchange      TEXT,
    category      TEXT,
    is_seed       INTEGER DEFAULT 1,
    first_seen    TEXT,
    last_accessed TEXT
)
"""


def _count() -> int:
    if not DB_PATH.exists():
        return 0
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute(_SCHEMA)
            return conn.execute("SELECT COUNT(*) FROM tickers").fetchone()[0]
    except sqlite3.Error:
        return 0


def _load_rows() -> list[dict]:
    rows: list[dict] = []
    now_iso = datetime.utcnow().isoformat()
    for fname in SEED_FILES:
        fpath = DATA_DIR / fname
        if not fpath.exists():
            print(f"  WARNING: seed file missing: {fpath}")
            continue
        with open(fpath, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                symbol = (r.get("symbol") or "").strip().upper()
                if not symbol:
                    continue
                sector = (r.get("sector") or "").strip()
                rows.append({
                    "symbol":   symbol,
                    "name":     (r.get("name") or symbol).strip(),
                    "sector":   sector or "Unknown",
                    "exchange": (r.get("exchange") or "").strip(),
                    "category": classify(symbol, sector),
                    "is_seed":  1,
                    "first_seen":    now_iso,
                    "last_accessed": None,
                })
    return rows


def seed(force: bool = False) -> dict:
    """Build the index. With force=False, existing rows are kept (INSERT OR IGNORE)."""
    rows = _load_rows()
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(_SCHEMA)
        if force:
            conn.execute("DELETE FROM tickers")
        conn.executemany(
            """
            INSERT OR IGNORE INTO tickers
                (symbol, name, sector, exchange, category, is_seed, first_seen, last_accessed)
            VALUES (:symbol, :name, :sector, :exchange, :category, :is_seed, :first_seen, :last_accessed)
            """,
            rows,
        )
        conn.commit()
        total = conn.execute("SELECT COUNT(*) FROM tickers").fetchone()[0]
    print(f"  Seeded search index: {len(rows)} rows processed, {total} total in {DB_PATH.name}")
    return {"processed": len(rows), "total": total}


def reseed() -> dict:
    """Drop all rows and rebuild from the seed CSVs."""
    return seed(force=True)


def ensure_seeded() -> dict:
    """Seed only if the index is empty. Safe to call on every startup."""
    if _count() > 0:
        return {"seeded": False, "total": _count()}
    print("  Search index empty — seeding from CSVs...")
    result = seed(force=False)
    return {"seeded": True, **result}


if __name__ == "__main__":
    reseed()
