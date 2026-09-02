# ============================================================
# services/indicators.py
# Responsible for: all per-ticker technical indicators
# Each function is pure — takes a Series, returns a Series
# ============================================================

import pandas as pd
import numpy as np


def compute_ma(close: pd.Series, window: int) -> pd.Series:
    """Simple Moving Average over a rolling window."""
    return close.rolling(window=window).mean()


def compute_bollinger(close: pd.Series, window: int = 20, num_std: float = 2.0) -> pd.DataFrame:
    """
    Bollinger Bands: middle band is MA, upper/lower are +/- num_std standard deviations.

    Returns:
        DataFrame with columns: BB_mid, BB_upper, BB_lower
    """
    mid   = close.rolling(window=window).mean()
    std   = close.rolling(window=window).std()
    return pd.DataFrame({
        "BB_mid"  : mid,
        "BB_upper": mid + num_std * std,
        "BB_lower": mid - num_std * std,
    }, index=close.index)


def compute_zscore(close: pd.Series, window: int = 20) -> pd.Series:
    """
    Z-Score: how many standard deviations price is from its rolling mean.
    > +2 = overbought, < -2 = oversold.
    """
    mean = close.rolling(window=window).mean()
    std  = close.rolling(window=window).std()
    return (close - mean) / std


def compute_rsi(close: pd.Series, window: int = 14) -> pd.Series:
    """
    RSI using Wilder's smoothing (matches TradingView).
    > 70 = overbought, < 30 = oversold.
    """
    delta    = close.diff()
    gain     = delta.clip(lower=0)
    loss     = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1/window, min_periods=window, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1/window, min_periods=window, adjust=False).mean()
    rs       = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def compute_atr(high: pd.Series, low: pd.Series, close: pd.Series, window: int = 14) -> pd.Series:
    """
    ATR using Wilder's smoothing (matches TradingView).
    Measures volatility — used for stop loss placement and position sizing.
    """
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low  - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(alpha=1/window, min_periods=window, adjust=False).mean()


def compute_autocorr(close: pd.Series, window: int = 20, lag: int = 1) -> pd.Series:
    """
    Rolling lag-1 autocorrelation of daily returns.
    > +0.2  = trending   → macro swing candidate
    < -0.2  = reverting  → mean reversion candidate
    in between = neutral → no clear edge
    """
    returns = close.pct_change()
    return returns.rolling(window).apply(lambda x: x.autocorr(lag=lag), raw=False)


def autocorr_label(val: float) -> str:
    """Convert autocorrelation float to strategy hint string."""
    if pd.isna(val):
        return "unknown"
    if val > 0.2:
        return "trending"
    if val < -0.2:
        return "reverting"
    return "neutral"


def compute_all(df: pd.DataFrame) -> pd.DataFrame:
    """
    Convenience function — compute all indicators and return enriched DataFrame.
    Input DataFrame must have columns: Open, High, Low, Close, Volume.

    Returns:
        Original DataFrame with added columns:
        MA50, MA200, BB_mid, BB_upper, BB_lower,
        Zscore, RSI, ATR, AutoCorr
    """
    df = df.copy()
    df["MA50"]    = compute_ma(df["Close"], 50)
    df["MA200"]   = compute_ma(df["Close"], 200)

    bb = compute_bollinger(df["Close"])
    df = pd.concat([df, bb], axis=1)

    df["Zscore"]  = compute_zscore(df["Close"])
    df["RSI"]     = compute_rsi(df["Close"])
    df["ATR"]     = compute_atr(df["High"], df["Low"], df["Close"])
    df["AutoCorr"]= compute_autocorr(df["Close"])
    return df
