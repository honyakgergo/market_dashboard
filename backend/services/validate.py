"""
services/validate.py — OHLCV price validator (copied from SwingLab).

Validates daily OHLCV data returned by yfinance against per-category sanity
thresholds. Calibrated against the actual seeded universe (sp500_seed.csv +
etf_seed.csv) and refined against an empirical 5y validation run.

Public API:
    classify(symbol: str, sector: str) -> str
        Maps (symbol, sector) -> one of:
        'mega_equity' | 'large_equity' | 'volatile_equity' | 'broad_etf'
        | 'sector_etf' | 'commodity_etf' | 'vol_etf' | 'leveraged_etf' | 'crypto'

    validate_ohlcv(df, symbol, sector) -> ValidationResult
        Returns (is_valid, issues_list, flagged_dates).
        Does NOT modify the dataframe. Caller decides what to do with flags.

    quality_flag(df, symbol, sector) -> pd.Series
        Returns a same-length bool Series; True where the row failed any check.
        Suitable for adding as a 'quality_flag' column to the OHLCV df.

Design choice: flag-and-keep. We never reject or repair. The caller (UI or
backtest) decides whether to trust flagged days. Repair is the silent killer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

import pandas as pd


# ---------------------------------------------------------------------------
# Category thresholds — calibrated against the actual seeded universe and
# refined against an empirical 5y validation run (May 2026).
#
# Each threshold is the max plausible legitimate single-day return for that
# bucket. Above the threshold we flag, but we keep the row.
# ---------------------------------------------------------------------------

CATEGORY_MAX_DAILY_PCT = {
    "mega_equity":     0.25,   # AAPL, MSFT, JPM — top ~15 by mkt cap
    "large_equity":    0.40,   # default for S&P 500 GICS-classified stocks
    "volatile_equity": 0.55,   # known earnings-volatile names (HOOD IPO unlock = 50%)
    "broad_etf":       0.20,   # SPY, QQQ, IWM, DIA, VTI, VOO, bonds
    "sector_etf":      0.25,   # XLK, XLF, XLE, international ETFs
    "commodity_etf":   0.40,   # USO, UNG, GLD, SLV
    "vol_etf":         1.00,   # VIXY — Feb 2018 hit ~85%
    "leveraged_etf":   0.50,   # TQQQ/SQQQ/UPRO
    "crypto":          0.60,   # BTC/ETH — March 2020 hit ~50%
}

# Universal hard limits (scale-error detection).
# These catch decimal-place errors and unadjusted splits, independent of category.
SCALE_ERROR_RATIO_HIGH = 5.0   # 5x previous close in one day = scale error
SCALE_ERROR_RATIO_LOW = 0.20   # 0.2x previous close = inverse scale error

# Stale-price detection: N consecutive identical closes is suspicious for
# liquid names. >5 is a red flag for liquid tickers.
STALE_STREAK_THRESHOLD = 5

# Recency: data should be at most this many days old (accounts for weekends
# and US market holidays). 5 covers a normal long weekend.
MAX_DAYS_OLD_DEFAULT = 5


# ---------------------------------------------------------------------------
# Classification — uses the sector field already in your seed CSVs.
# ---------------------------------------------------------------------------

# GICS sectors from sp500_seed.csv
_GICS_SECTORS = {
    "Communication Services", "Consumer Discretionary", "Consumer Staples",
    "Energy", "Financials", "Health Care", "Industrials",
    "Information Technology", "Materials", "Real Estate", "Utilities",
}

# Top S&P 500 by market cap — these have lower realistic daily ranges
# than typical names because of their size. Conservative threshold (25%).
_MEGA_EQUITY_SYMBOLS = frozenset({
    "AAPL", "MSFT", "GOOGL", "GOOG", "AMZN", "NVDA", "META", "BRK-B",
    "JPM", "V", "MA", "JNJ", "WMT", "PG", "XOM", "UNH",
})

# Names with known earnings volatility or high-beta profiles.
# Calibrated against the empirical 5y validation run — these are the names
# that produced >40% legitimate single-day moves in the seeded universe.
_VOLATILE_EQUITY_SYMBOLS = frozenset({
    # Originally identified high-beta / earnings-volatile names
    "NFLX", "SNAP", "PINS", "RBLX", "U", "PLTR", "COIN", "HOOD",
    "ROKU", "ZM", "PTON", "DKNG", "RIVN", "LCID",
    # Added from empirical 5y validation — names with documented >40% moves:
    "CVNA",   # Carvana — multiple 40%+ moves during 2022 distress
    "SMCI",   # Super Micro — AI-driven swings, multiple 30%+ days
    "APP",    # AppLovin — earnings 46% pop Nov 2024
    "EPAM",   # EPAM — Ukraine war exposure, -45% Feb 2022
    "SATS",   # EchoStar — multiple 30-70% moves
    "TTD",    # The Trade Desk — adtech earnings volatility
    "BIIB",   # Biogen — drug trial binary events
    "DXCM",   # DexCom — guidance shocks
    "CNC",    # Centene — guidance withdrawal Jul 2025
    "ALGN",   # Align Technology — earnings volatility
    "FISV",   # Fiserv — earnings miss Oct 2025 (-44%)
    "GL",     # Globe Life — Fuzzy Panda short report Apr 2024 (-53%)
    "WST",    # West Pharmaceutical — Feb 2025 -38%
    "DDOG",   # Datadog — software earnings
    "PANW",   # Palo Alto — Feb 2024 -28%
    "ORCL",   # Oracle — Sep 2025 +36% on AI demand surprise
    "DELL",   # Dell — Mar 2024 +32% AI server surprise
    "VRT",    # Vertiv — multiple earnings pops
    "SNPS",   # Synopsys — Sep 2025 +36%
    "DG",     # Dollar General — Aug 2024 guidance cut
})


def classify(symbol: str, sector: str | None) -> str:
    """Map (symbol, sector) to a category for threshold lookup.

    Symbol-based rules win over sector-based rules — explicit > generic.
    """
    sec = (sector or "").strip()

    # Crypto first (sector starts with 'Crypto -')
    if sec.startswith("Crypto"):
        return "crypto"

    # ETF families
    if sec.startswith("Leveraged"):
        return "leveraged_etf"
    if sec == "Volatility":
        return "vol_etf"
    if sec.startswith("Commodity"):
        return "commodity_etf"
    if sec.startswith("Sector ETF") or sec.startswith("Industry ETF"):
        return "sector_etf"
    if sec == "Broad Market":
        return "broad_etf"
    if sec.startswith("Bond"):
        # Bonds rarely move >5%/day even for HYG. Treat as broad ETF threshold.
        return "broad_etf"
    if sec.startswith("International"):
        return "sector_etf"  # similar daily-move profile to US sector ETFs

    # Equity classification
    if sec in _GICS_SECTORS:
        if symbol in _MEGA_EQUITY_SYMBOLS:
            return "mega_equity"
        if symbol in _VOLATILE_EQUITY_SYMBOLS:
            return "volatile_equity"
        # Default for S&P 500 stocks not explicitly mega or volatile:
        # large_equity at 40%. Catches genuine outliers without false-flagging
        # typical earnings reactions.
        return "large_equity"

    # Unknown — use the safest (widest) bucket so we don't false-flag
    return "volatile_equity"


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------

@dataclass
class ValidationResult:
    symbol: str
    category: str
    is_valid: bool
    issues: list[str] = field(default_factory=list)
    flagged_dates: list[pd.Timestamp] = field(default_factory=list)

    def __bool__(self) -> bool:
        return self.is_valid

    def summary(self) -> str:
        if self.is_valid:
            return f"{self.symbol} ({self.category}): OK"
        return (
            f"{self.symbol} ({self.category}): {len(self.issues)} issues, "
            f"{len(self.flagged_dates)} flagged dates\n  - "
            + "\n  - ".join(self.issues)
        )


# ---------------------------------------------------------------------------
# Main validation
# ---------------------------------------------------------------------------

REQUIRED_COLUMNS = ("Open", "High", "Low", "Close", "Volume")


def validate_ohlcv(
    df: pd.DataFrame,
    symbol: str,
    sector: str | None = None,
    *,
    max_days_old: int = MAX_DAYS_OLD_DEFAULT,
    today: pd.Timestamp | None = None,
) -> ValidationResult:
    """Validate a yfinance OHLCV dataframe.

    Does not modify df. Returns a ValidationResult describing what's wrong.
    Caller decides whether to drop, flag, or accept.
    """
    category = classify(symbol, sector)
    result = ValidationResult(symbol=symbol, category=category, is_valid=True)

    # ---- structural checks (fatal-style; if any of these fail, no point continuing per-row)
    if df is None or len(df) == 0:
        result.is_valid = False
        result.issues.append("empty dataframe")
        return result

    missing = set(REQUIRED_COLUMNS) - set(df.columns)
    if missing:
        result.is_valid = False
        result.issues.append(f"missing columns: {sorted(missing)}")
        return result

    if not isinstance(df.index, pd.DatetimeIndex):
        result.is_valid = False
        result.issues.append(f"index is {type(df.index).__name__}, expected DatetimeIndex")
        return result

    # ---- column-level checks
    close = df["Close"]

    if close.isna().all():
        result.is_valid = False
        result.issues.append("Close column is entirely NaN")
        return result

    n_nan_close = close.isna().sum()
    if n_nan_close > 0:
        result.issues.append(f"{n_nan_close} NaN values in Close column")
        result.is_valid = False

    n_zero_close = (close == 0).sum()
    if n_zero_close > 0:
        result.issues.append(f"{n_zero_close} zero values in Close column")
        result.is_valid = False

    n_neg_close = (close < 0).sum()
    if n_neg_close > 0:
        result.issues.append(f"{n_neg_close} negative values in Close column")
        result.is_valid = False

    # ---- OHLC internal consistency
    bad_hl = (df["High"] < df["Low"]).sum()
    if bad_hl > 0:
        result.issues.append(f"{bad_hl} rows with High < Low")
        result.is_valid = False

    # close outside [low, high] — allow small tolerance for float noise
    tol = 1e-6
    bad_close = (
        (df["Close"] > df["High"] + tol) | (df["Close"] < df["Low"] - tol)
    ).sum()
    if bad_close > 0:
        result.issues.append(f"{bad_close} rows with Close outside [Low, High]")
        result.is_valid = False

    # ---- per-row sanity: scale errors and excessive returns
    returns = close.pct_change()
    abs_returns = returns.abs()

    # Scale errors: ratio of consecutive closes
    ratio = close / close.shift(1)
    scale_errors_high = ratio[ratio > SCALE_ERROR_RATIO_HIGH]
    scale_errors_low = ratio[(ratio < SCALE_ERROR_RATIO_LOW) & (ratio > 0)]

    if len(scale_errors_high):
        for date, r in scale_errors_high.items():
            result.issues.append(
                f"scale error (high) on {date.date()}: "
                f"close ratio {r:.2f}x prev"
            )
            result.flagged_dates.append(date)
        result.is_valid = False

    if len(scale_errors_low):
        for date, r in scale_errors_low.items():
            result.issues.append(
                f"scale error (low) on {date.date()}: "
                f"close ratio {r:.3f}x prev (possible unadjusted split)"
            )
            result.flagged_dates.append(date)
        result.is_valid = False

    # Category-based excessive returns (but only those NOT already caught as scale errors)
    threshold = CATEGORY_MAX_DAILY_PCT[category]
    already_flagged = set(result.flagged_dates)
    excessive = abs_returns[
        (abs_returns > threshold) & (~abs_returns.index.isin(already_flagged))
    ]
    if len(excessive):
        for date, r in excessive.items():
            result.issues.append(
                f"return on {date.date()}: {r:.1%} exceeds {category} "
                f"threshold {threshold:.0%}"
            )
            result.flagged_dates.append(date)
        result.is_valid = False

    # ---- stale price detection (consecutive identical closes)
    diff = close.diff()
    same_as_prev = (diff == 0).astype(int)
    if same_as_prev.any():
        runs = same_as_prev.groupby((diff != 0).cumsum()).sum()
        max_streak = int(runs.max())
        if max_streak > STALE_STREAK_THRESHOLD:
            result.issues.append(
                f"stale prices: {max_streak} consecutive identical closes"
            )
            result.is_valid = False

    # ---- recency
    last_date = df.index[-1]
    ref = today if today is not None else pd.Timestamp(datetime.now().date())
    if last_date.tzinfo is not None:
        last_date = last_date.tz_localize(None)
    days_old = (ref - last_date.normalize()).days
    if days_old > max_days_old:
        result.issues.append(
            f"data ends {days_old} days ago (last bar: {last_date.date()})"
        )
        result.is_valid = False

    return result


def quality_flag(
    df: pd.DataFrame,
    symbol: str,
    sector: str | None = None,
) -> pd.Series:
    """Return a same-length bool Series; True where the row fails any check.

    Use to add a `quality_flag` column to OHLCV before persisting to SQLite.
    Rows with True are kept but should be displayed differently and excluded
    from any metric calculations the user opts to filter on.
    """
    result = validate_ohlcv(df, symbol, sector)
    flag = pd.Series(False, index=df.index, name="quality_flag")
    for date in result.flagged_dates:
        if date in flag.index:
            flag.loc[date] = True
    # also flag structural issues row-by-row
    if "Close" in df.columns:
        flag |= df["Close"].isna()
        flag |= (df["Close"] == 0)
        if "High" in df.columns and "Low" in df.columns:
            flag |= (df["High"] < df["Low"])
    return flag
