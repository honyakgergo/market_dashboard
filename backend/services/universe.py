# ============================================================
# services/universe.py
# Central definition of the dashboard's ticker universe.
#
# Replaces SwingLab's strategy WATCHLIST/MACRO_TICKERS coupling. The dashboard
# warms the FULL seeded universe (for the market-overview heatmap + breadth)
# plus macro series and FX, so every browseable name has fresh daily data.
# ============================================================

import sqlite3
from pathlib import Path

from services.macro import MACRO_TICKERS

SEARCH_DB = Path(__file__).parent.parent / "search.db"

# FX pairs for the cross-asset / ETF monitor row.
# EUR/USD and USD/JPY matter directly for an EUR-base investor holding USD
# assets; EUR/JPY is the cross. yfinance symbols.
FX_TICKERS = ["EURUSD=X", "JPY=X", "EURJPY=X"]

# Cross-asset / index tickers the dashboard references that may not be in the
# seeded equity/ETF universe. Union-ed in so they always get warmed.
EXTRA_TICKERS = [
    "^VIX", "^VIX3M", "^TNX", "^IRX", "^SKEW",   # vol complex + rates
    "SPY", "QQQ", "IWM", "DIA",                  # broad equity
    "SOXX", "SMH",                               # semis
    "RSP",                                       # equal-weight (concentration)
    "IWF", "IWD",                                # growth / value (rotation ratio)
]


def get_equity_universe() -> list[str]:
    """Symbols the cache warmer should keep fresh: the seeded CSV universe
    (is_seed=1) plus any names the user looked up (is_seed=0). Excludes the
    curated search-only extras (is_seed=2 — commodities/FX/EU stocks/crypto)
    which are fetched live on demand instead of warmed. Empty list if the
    index isn't seeded yet."""
    if not SEARCH_DB.exists():
        return []
    try:
        with sqlite3.connect(f"file:{SEARCH_DB}?mode=ro", uri=True) as conn:
            rows = conn.execute(
                "SELECT symbol FROM tickers WHERE COALESCE(is_seed, 1) != 2"
            ).fetchall()
        return [r[0] for r in rows]
    except sqlite3.Error:
        return []


def get_warm_universe() -> list[str]:
    """Full set of tickers the cache warmer should keep fresh."""
    tickers = set(get_equity_universe())
    tickers.update(MACRO_TICKERS.values())
    tickers.update(FX_TICKERS)
    tickers.update(EXTRA_TICKERS)
    return sorted(tickers)
