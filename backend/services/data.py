# ============================================================
# services/data.py
# Responsible for: fetching OHLCV data + SQLite caching
# ============================================================

import sqlite3
import threading
import time
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
        # Per-ticker cache bookkeeping.
        #
        # earliest_asked — how far back we have ASKED the feed for this ticker.
        #   Needed because "the cache starts in 2015" does not tell you whether
        #   2015 is where our data runs out or where the instrument was listed.
        #   Without it a deep request ("give me everything") could never be
        #   served from cache, since the cache would have to contain bars from
        #   before the ticker existed in order to look complete.
        #
        # refreshed_at — unix time of the last successful write from the feed.
        #   This, NOT the date of the last bar, is what decides whether the
        #   cache is current. Judging freshness by bar date requires guessing
        #   which session should exist by now, and that guess is wrong on
        #   weekends, on market holidays, before a market's open, and on every
        #   non-US calendar — which is exactly how a board of European ETFs ends
        #   up quietly serving last week's closes. "We asked the feed 20 minutes
        #   ago and this is what it gave us" needs no calendar at all.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS ohlcv_reach (
                ticker         TEXT PRIMARY KEY,
                earliest_asked TEXT
            )
        """)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(ohlcv_reach)")}
        if "refreshed_at" not in cols:
            conn.execute("ALTER TABLE ohlcv_reach ADD COLUMN refreshed_at REAL")
        conn.commit()

_init_db()


def _get_reach(ticker: str) -> str | None:
    try:
        with sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True) as conn:
            row = conn.execute(
                "SELECT earliest_asked FROM ohlcv_reach WHERE ticker = ?", (ticker,)
            ).fetchone()
        return row[0] if row and row[0] else None
    except sqlite3.Error:
        return None


def _get_refreshed_at(ticker: str) -> float | None:
    try:
        with sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True) as conn:
            row = conn.execute(
                "SELECT refreshed_at FROM ohlcv_reach WHERE ticker = ?", (ticker,)
            ).fetchone()
        return float(row[0]) if row and row[0] else None
    except (sqlite3.Error, TypeError, ValueError):
        return None


def _set_reach(ticker: str, start: str | None = None, touch: bool = True):
    """Record a successful feed write for `ticker`.

    `start` extends the known reach (kept at the earliest ever requested);
    `touch` stamps refreshed_at so freshness checks know the data is new.
    """
    now = time.time() if touch else None
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute("""
                INSERT INTO ohlcv_reach (ticker, earliest_asked, refreshed_at)
                VALUES (?, ?, ?)
                ON CONFLICT(ticker) DO UPDATE SET
                  earliest_asked = CASE
                      WHEN excluded.earliest_asked IS NULL THEN earliest_asked
                      WHEN earliest_asked IS NULL THEN excluded.earliest_asked
                      ELSE MIN(earliest_asked, excluded.earliest_asked) END,
                  refreshed_at = COALESCE(excluded.refreshed_at, refreshed_at)
            """, (ticker, start, now))
            conn.commit()
    except sqlite3.Error:
        pass


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
    # Compare against the RECENT maximum, not the all-time one.
    #
    # The check below rejects a series whose last close is under 10% of its max,
    # which catches a corrupt splice inside a normal 1–2 year window. Over a full
    # multi-decade history it catches something else entirely: any real company
    # trading 90% below a peak it set in 2000 or 2021 — of which there are many.
    # Bounding the window keeps the original intent and stops full history from
    # being thrown away as "garbage".
    max_close = float(close.iloc[-500:].max())

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
            # Drop the reach marker too — otherwise the next deep request would
            # trust an emptied cache as "already complete".
            conn.execute("DELETE FROM ohlcv_reach WHERE ticker = ?", (ticker,))
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


def cache_last_date(ticker: str) -> datetime | None:
    """Date of the newest cached bar for `ticker`, or None if nothing is cached."""
    try:
        with sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True) as conn:
            row = conn.execute("SELECT MAX(date) FROM ohlcv WHERE ticker = ?", (ticker,)).fetchone()
    except sqlite3.Error:
        return None
    if not row or not row[0]:
        return None
    try:
        return datetime.strptime(row[0], "%Y-%m-%d")
    except ValueError:
        return None


def cache_is_current(ticker: str, max_age_minutes: float = 45) -> bool:
    """Was this ticker refreshed from the feed recently enough to trust?

    Freshness is measured in "how long since we asked", not "how old is the last
    bar", because only the first question has a calendar-free answer. If we
    pulled the symbol 20 minutes ago then whatever we got IS the newest data
    that exists, whether that is today's close, Friday's close, or the last bar
    before a holiday.
    """
    ts = _get_refreshed_at(ticker)
    if ts is None:
        return False
    return (time.time() - ts) <= max_age_minutes * 60


def daily_close_series(ticker: str, days: int = 420, min_rows: int = 20,
                       max_age_minutes: float = 45, lock_timeout: int = 20):
    """Fresh daily close series for any symbol — cache first, live fetch second.

    This is the accessor every live dashboard surface (Europe / Commodities /
    Volatility) should use for symbols that are NOT in the warm universe.

    The cache is only trusted when it was refreshed inside `max_age_minutes`;
    otherwise we refetch from yfinance and WRITE THE RESULT BACK, so the next
    caller reads a fresh cache instead of downloading again.

    Why this matters: reading the cache unconditionally is how a symbol that was
    fetched once — e.g. an EU sector ETF pulled in by a one-off ticker lookup —
    goes on being served from that old snapshot forever, while symbols that were
    never cached at all silently get live (correct) data. That asymmetry is
    exactly the "only the sector I searched before is up to date" symptom.

    Returns a pandas Series of closes indexed by date, or None.
    """
    end = datetime.now().strftime("%Y-%m-%d")
    start = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")

    if cache_is_current(ticker, max_age_minutes):
        df = _load_from_cache(ticker, start, end)
        if df is not None and len(df) >= min_rows:
            return df["Close"].astype(float)

    acquired = _yf_lock.acquire(timeout=lock_timeout)
    if not acquired:
        # Couldn't get the lock — better to serve a stale cache than nothing,
        # but say so by falling back only if there is enough of it to plot.
        df = _load_from_cache(ticker, start, end)
        if df is not None and len(df) >= min_rows:
            return df["Close"].astype(float)
        return None
    try:
        raw = yf.download(ticker, period=_days_to_period(days), interval="1d",
                          auto_adjust=True, progress=False, threads=False)
    except Exception:
        raw = None
    finally:
        _yf_lock.release()

    if raw is not None and not raw.empty:
        if isinstance(raw.columns, pd.MultiIndex):
            raw.columns = raw.columns.get_level_values(0)
        if "Close" in raw.columns:
            fresh = raw.dropna(subset=["Close"])
            if len(fresh):
                # Persist so the next read is a cache hit, not another download.
                if {"Open", "High", "Low", "Volume"}.issubset(fresh.columns):
                    try:
                        _save_to_cache(ticker, fresh)
                        _set_reach(ticker, start)
                    except Exception:
                        pass
                return fresh["Close"].astype(float)

    # Live fetch failed — fall back to whatever is cached rather than blanking
    # the panel entirely.
    df = _load_from_cache(ticker, start, end)
    if df is not None and len(df) >= min_rows:
        return df["Close"].astype(float)
    return None


def _days_to_period(days: int) -> str:
    for limit, period in ((40, "1mo"), (100, "3mo"), (200, "6mo"), (400, "1y"),
                          (800, "2y"), (1900, "5y"), (3800, "10y")):
        if days <= limit:
            return period
    return "max"


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
                    return _trim_forming_bar(df)
                else:
                    print(f"  Cached data for {ticker} failed validation — purging and refetching")
                    _purge_ticker_cache(ticker)

        # Check if a larger cached range exists (e.g. 10Y cache for a 1Y request)
        max_days = _period_to_days("10y") + MA_WARMUP_DAYS
        if total_days < max_days and _cache_is_fresh(ticker, max_days):
            df = _load_from_cache(ticker, start_date, end_date)
            if not df.empty:
                if _validate_fetched_data(ticker, df):
                    return _trim_forming_bar(df)

        # Deep request: we have already asked the feed for at least this far
        # back, so whatever is cached IS the instrument's full history. Serve
        # it if it is recent, rather than re-downloading decades of bars on
        # every load of the full-history chart.
        reach = _get_reach(ticker)
        if reach and reach <= start_date and cache_is_current(ticker, max_age_minutes=45):
            df = _load_from_cache(ticker, start_date, end_date)
            if not df.empty and _validate_fetched_data(ticker, df):
                return _trim_forming_bar(df)

    # Fetch from yfinance
    df = _fetch_from_yfinance(ticker, start_date, end_date, interval)

    # Validate before caching
    if not _validate_fetched_data(ticker, df):
        # Try one more time — yfinance sometimes returns garbage on first call
        print(f"  Retrying {ticker}...")
        df = _fetch_from_yfinance(ticker, start_date, end_date, interval)
        if not _validate_fetched_data(ticker, df):
            raise ValueError(f"yfinance returned invalid data for {ticker} after retry")

    # Store everything, hand back only completed sessions.
    if interval == "1d":
        _save_to_cache(ticker, df)
        _set_reach(ticker, start_date)
        return _trim_forming_bar(df)

    return df


def _fetch_from_yfinance(ticker: str, start: str, end: str, interval: str) -> pd.DataFrame:
    acquired = _yf_lock.acquire(timeout=30)
    if not acquired:
        raise ValueError(f"yfinance lock timeout for {ticker} — another fetch is stuck")
    try:
        # yfinance treats `end` as EXCLUSIVE. Passing end=today therefore asks
        # for everything up to *yesterday*, which left the entire cache — and so
        # every page reading it — one session behind for good: after a close, the
        # session that just finished could never enter the cache. Ask through
        # tomorrow and let the completed-session filter below decide what to keep.
        raw = yf.download(ticker, start=start, end=_day_after(end), interval=interval,
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

    # NOTE: deliberately unfiltered — everything the feed has, today's forming
    # bar included. Whether that last bar is wanted depends on the CONSUMER, so
    # the decision is made at read time by _trim_forming_bar (see below), not
    # baked into what we store.
    return df


def _trim_forming_bar(df: pd.DataFrame) -> pd.DataFrame:
    """Enforce the 'last bar is the most recent COMPLETED session' contract.

    Two callers depend on it in opposite directions:
      · overview / etf_monitor in LIVE mode overlay an intraday snapshot and
        measure today's return against the last cached bar, so that bar must
        still be the PREVIOUS close while the session is running;
      · the same pages in CLOSE mode read the last bar AS today's close.
    So a bar dated today is dropped only while the US cash session is open.

    Applied on read rather than on write because the cache is shared with
    daily_close_series, which serves live non-US surfaces and legitimately wants
    today's bar. Filtering at write time would force one contract on both and
    silently corrupt whichever one lost.
    """
    if df is None or df.empty:
        return df
    today = pd.Timestamp.now(tz="America/New_York").normalize().tz_localize(None)
    if df.index[-1] >= today and _us_session_open():
        return df.iloc[:-1]
    return df


def _day_after(date_str: str) -> str:
    try:
        return (datetime.strptime(date_str, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    except ValueError:
        return date_str


def _us_session_open() -> bool:
    """True while US cash equities are trading. Imported lazily and defensively:
    services.session is pure time logic, but a failure here must not be able to
    break data fetching."""
    try:
        from services.session import market_session
        return bool(market_session().get("us_open"))
    except Exception:
        return False


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
        "20y":  7400,
        # "max" = every bar the feed has. 60 years covers the oldest series on
        # Yahoo (indices back to the 1920s are the exception, and asking for
        # more days than exist is harmless — you just get what there is).
        "max":  22000,
    }
    return mapping.get(period, 370)
