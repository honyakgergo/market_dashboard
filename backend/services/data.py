# ============================================================
# services/data.py
# Responsible for: fetching OHLCV data + SQLite caching
# ============================================================

import sqlite3
import threading
import logging
import pandas as pd
import yfinance as yf
from pathlib import Path
from datetime import datetime, timedelta

# yfinance logs "$TICKER: possibly delisted; no price data found" at ERROR
# level for every symbol that doesn't resolve (dead tickers, and transient
# rate-limit false-negatives during bulk warms). Those are already handled by
# our own try/except + the cache-warmer summary, so quiet the library's logger
# to keep the console readable. This does not affect our own logging.
logging.getLogger("yfinance").setLevel(logging.CRITICAL)

DB_PATH = Path(__file__).parent.parent / "cache.db"
MA_WARMUP_DAYS = 300

# yfinance is not thread-safe — concurrent downloads corrupt data.
# This lock ensures only one yf.download runs at a time.
_yf_lock = threading.Lock()


# ------------------------------------------------------------
# Database setup
# ------------------------------------------------------------

def _init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS ohlcv (
                ticker    TEXT,
                date      TEXT,
                open      REAL,
                high      REAL,
                low       REAL,
                close     REAL,
                volume    REAL,
                PRIMARY KEY (ticker, date)
            )
        """)
        conn.commit()

_init_db()


# ------------------------------------------------------------
# Validation — detect garbage data from yfinance
# ------------------------------------------------------------

def _validate_fetched_data(ticker: str, df: pd.DataFrame) -> bool:
    """
    Reject data that looks corrupted.
    Returns True if data looks valid, False if it should be rejected.
    """
    if df.empty or len(df) < 5:
        return False

    # Tickers that trade at very low absolute prices — always valid
    LOW_PRICE_TICKERS = {"EURUSD=X", "^IRX"}
    if ticker in LOW_PRICE_TICKERS:
        return True

    close = df["Close"]
    if isinstance(close, pd.DataFrame):
        close = close.iloc[:, 0]

    last_close = float(close.iloc[-1])
    max_close  = float(close.max())

    # Check 1: internal consistency — last close shouldn't be <10% of max in same series
    if max_close > 0 and last_close < max_close * 0.1:
        print(f"  REJECT {ticker}: last close {last_close:.2f} is <10% of max {max_close:.2f}")
        return False

    # Check 2: known minimum price floors
    KNOWN_MINIMUMS = {
        "MSFT": 50, "NVDA": 20, "GOOGL": 50, "AMZN": 50, "META": 50,
        "CAT": 100, "UNH": 100, "COST": 100, "V": 50, "RTX": 50,
        "ASML": 100, "JPM": 50, "NVO": 20, "BTC-USD": 1000,
        "AIR.PA": 20, "SAP.DE": 50, "SIE.DE": 30, "RHM.DE": 20,
        "SMH": 50, "QQQ": 100, "SPY": 100, "GLD": 50, "TLT": 30,
        "XLV": 20, "XLF": 10, "XLE": 20, "XBI": 20,
        "CVX": 50, "TSM": 20,
    }

    # Known maximum price ceilings — for indices that shouldn't be high
    KNOWN_MAXIMUMS = {
        "^VIX": 100,
        "^TNX": 20,
    }

    min_expected = KNOWN_MINIMUMS.get(ticker)
    if min_expected and last_close < min_expected * 0.1:
        print(f"  REJECT {ticker}: close {last_close:.2f} far below expected minimum ~{min_expected}")
        return False

    max_expected = KNOWN_MAXIMUMS.get(ticker)
    if max_expected and last_close > max_expected:
        print(f"  REJECT {ticker}: close {last_close:.2f} far above expected maximum ~{max_expected}")
        return False

    # Check 3: reject if data looks like a different ticker got returned
    # Crypto trades >$0.10, equities >$1 — anything below is garbage
    if ticker.endswith("-USD") and last_close < 0.01:
        print(f"  REJECT {ticker}: crypto close {last_close:.4f} impossibly low")
        return False
    if not ticker.endswith("-USD") and not ticker.startswith("^") and last_close < 1.0:
        print(f"  REJECT {ticker}: equity close {last_close:.2f} impossibly low")
        return False

    return True


def _purge_ticker_cache(ticker: str):
    """Remove all cached data for a ticker — used when bad data is detected."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute("DELETE FROM ohlcv WHERE ticker = ?", (ticker,))
            conn.commit()
        print(f"  PURGED cache for {ticker}")
    except Exception:
        pass


# ------------------------------------------------------------
# Cache helpers
# ------------------------------------------------------------

def _load_from_cache(ticker: str, start: str, end: str) -> pd.DataFrame:
    with sqlite3.connect(DB_PATH) as conn:
        df = pd.read_sql(
            "SELECT date, open, high, low, close, volume FROM ohlcv "
            "WHERE ticker = ? AND date BETWEEN ? AND ? ORDER BY date",
            conn,
            params=(ticker, start, end),
        )
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"])
    df = df.set_index("date")
    df.index.name = "Date"
    df.columns = ["Open", "High", "Low", "Close", "Volume"]
    return df


def _save_to_cache(ticker: str, df: pd.DataFrame):
    # Flatten MultiIndex columns if present
    if isinstance(df.columns, pd.MultiIndex):
        df = df.copy()
        df.columns = df.columns.get_level_values(0)

    records = []
    for date, row in df.iterrows():
        try:
            records.append((
                ticker,
                str(date.date()),
                float(row["Open"].iloc[0])  if isinstance(row["Open"], pd.Series)  else float(row["Open"]),
                float(row["High"].iloc[0])  if isinstance(row["High"], pd.Series)  else float(row["High"]),
                float(row["Low"].iloc[0])   if isinstance(row["Low"], pd.Series)   else float(row["Low"]),
                float(row["Close"].iloc[0]) if isinstance(row["Close"], pd.Series) else float(row["Close"]),
                float(row["Volume"].iloc[0]) if isinstance(row["Volume"], pd.Series) else float(row["Volume"]),
            ))
        except (ValueError, IndexError):
            continue
    with sqlite3.connect(DB_PATH) as conn:
        conn.executemany("""
            INSERT OR REPLACE INTO ohlcv (ticker, date, open, high, low, close, volume)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, records)
        conn.commit()


def _cache_is_fresh(ticker: str, total_days: int) -> bool:
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            "SELECT MIN(date), MAX(date), COUNT(*) FROM ohlcv WHERE ticker = ?",
            (ticker,)
        ).fetchone()

    if not row or row[2] == 0:
        return False

    min_date = datetime.strptime(row[0], "%Y-%m-%d")
    max_date = datetime.strptime(row[1], "%Y-%m-%d")
    expected_start = datetime.now() - timedelta(days=total_days)

    covers_period = min_date <= expected_start + timedelta(days=5)
    is_recent     = (datetime.now() - max_date).days <= 1

    return covers_period and is_recent


# ------------------------------------------------------------
# Public API
# ------------------------------------------------------------

def fetch_ohlcv(ticker: str, period: str = "1y", interval: str = "1d",
                use_cache: bool = True, warmup: bool = True) -> pd.DataFrame:
    period_days = _period_to_days(period)
    total_days  = period_days + (MA_WARMUP_DAYS if warmup else 0)
    start_date  = (datetime.now() - timedelta(days=total_days)).strftime("%Y-%m-%d")
    end_date    = datetime.now().strftime("%Y-%m-%d")

    # Try cache first — also check if a larger cached range covers this request
    if use_cache and interval == "1d":
        # Check if cache covers the requested range
        if _cache_is_fresh(ticker, total_days):
            df = _load_from_cache(ticker, start_date, end_date)
            if not df.empty:
                if _validate_fetched_data(ticker, df):
                    return df
                else:
                    print(f"  Cached data for {ticker} failed validation — purging and refetching")
                    _purge_ticker_cache(ticker)

        # Check if a larger cached range exists (e.g. 10Y cache for a 1Y request)
        max_days = _period_to_days("10y") + MA_WARMUP_DAYS
        if total_days < max_days and _cache_is_fresh(ticker, max_days):
            df = _load_from_cache(ticker, start_date, end_date)
            if not df.empty:
                if _validate_fetched_data(ticker, df):
                    return df

    # Fetch from yfinance
    df = _fetch_from_yfinance(ticker, start_date, end_date, interval)

    # Validate before caching
    if not _validate_fetched_data(ticker, df):
        # Try one more time — yfinance sometimes returns garbage on first call
        print(f"  Retrying {ticker}...")
        df = _fetch_from_yfinance(ticker, start_date, end_date, interval)
        if not _validate_fetched_data(ticker, df):
            raise ValueError(f"yfinance returned invalid data for {ticker} after retry")

    # Save to cache
    if interval == "1d":
        _save_to_cache(ticker, df)

    return df


def _fetch_from_yfinance(ticker: str, start: str, end: str, interval: str) -> pd.DataFrame:
    acquired = _yf_lock.acquire(timeout=30)
    if not acquired:
        raise ValueError(f"yfinance lock timeout for {ticker} — another fetch is stuck")
    try:
        raw = yf.download(ticker, start=start, end=end, interval=interval,
                          auto_adjust=True, progress=False)
    finally:
        _yf_lock.release()

    if raw.empty:
        raise ValueError(f"No data returned for {ticker}. Check the ticker symbol.")

    # Handle MultiIndex columns from yfinance
    if isinstance(raw.columns, pd.MultiIndex):
        # For single ticker, just drop the ticker level
        raw = raw.droplevel("Ticker", axis=1) if "Ticker" in raw.columns.names else raw
        # If still MultiIndex, take first level
        if isinstance(raw.columns, pd.MultiIndex):
            raw.columns = raw.columns.get_level_values(0)

    # Ensure all columns are 1D Series, not DataFrames
    df = pd.DataFrame(index=raw.index)
    for col in ["Open", "High", "Low", "Close", "Volume"]:
        s = raw[col]
        if isinstance(s, pd.DataFrame):
            s = s.iloc[:, 0]
        df[col] = s.values

    df.dropna(subset=["Close"], inplace=True)
    df.index = pd.to_datetime(df.index)
    df.index.name = "Date"

    today = pd.Timestamp.now(tz="America/New_York").normalize().tz_localize(None)
    if not df.empty and df.index[-1] >= today:
        df = df.iloc[:-1]

    return df


def _period_to_days(period: str) -> int:
    mapping = {
        "1mo":  35,
        "3mo":  95,
        "6mo":  185,
        "1y":   370,
        "2y":   740,
        "3y":   1110,
        "4y":   1480,
        "5y":   1850,
        "10y":  3700,
    }
    return mapping.get(period, 370)
