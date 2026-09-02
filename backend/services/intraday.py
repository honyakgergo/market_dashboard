# ============================================================
# services/intraday.py
# Intraday bars at a selectable resolution (1m/5m/15m/30m/60m), on-demand
# and ephemeral (never cached). Adds a session-anchored VWAP (resets each
# calendar day). Powers the Ticker Detail intraday view and any live page
# that needs an index/stock intraday line. Uses the shared yfinance lock.
#
# yfinance intraday limits: 1m ≤ 7 days back, 2–90m ≤ 60 days back,
# all ~15 min delayed. This is a monitor, not an execution feed.
# ============================================================

import pandas as pd
import yfinance as yf

from services.data import _yf_lock, _load_from_cache
from datetime import datetime, timedelta

VALID_INTERVALS = {"1m", "2m", "5m", "15m", "30m", "60m", "90m"}


def _clamp_days(interval: str, days: int) -> int:
    days = max(1, int(days))
    if interval == "1m":
        return min(days, 7)
    return min(days, 60)


def fetch_intraday(ticker: str, interval: str = "5m", days: int = 1) -> dict:
    """Fetch intraday bars at `interval` over the last `days` sessions.

    Returns bars with a per-day VWAP and the % change vs the prior daily close.
    """
    if interval not in VALID_INTERVALS:
        interval = "5m"
    days = _clamp_days(interval, days)

    acquired = _yf_lock.acquire(timeout=30)
    if not acquired:
        raise ValueError(f"yfinance lock timeout for {ticker}")
    try:
        raw = yf.download(ticker, period=f"{days}d", interval=interval,
                          auto_adjust=True, prepost=False, progress=False)
    finally:
        _yf_lock.release()

    if raw is None or raw.empty:
        raise ValueError(f"No intraday data for {ticker}")

    if isinstance(raw.columns, pd.MultiIndex):
        raw.columns = raw.columns.get_level_values(0)

    # Per-day session VWAP: cumulative (typical*vol)/cumulative vol, reset daily.
    raw = raw.copy()
    raw["_day"] = raw.index.date
    typical = (raw["High"] + raw["Low"] + raw["Close"]) / 3.0
    tpv = (typical * raw["Volume"]).groupby(raw["_day"]).cumsum()
    cumv = raw["Volume"].groupby(raw["_day"]).cumsum()
    raw["_vwap"] = (tpv / cumv).where(cumv > 0)

    bars = []
    for ts, row in raw.iterrows():
        try:
            bars.append({
                "ts": ts.isoformat(),
                "time": ts.strftime("%H:%M"),
                "date": ts.strftime("%Y-%m-%d"),
                "open": round(float(row["Open"]), 4),
                "high": round(float(row["High"]), 4),
                "low": round(float(row["Low"]), 4),
                "close": round(float(row["Close"]), 4),
                "volume": int(row["Volume"]) if pd.notna(row["Volume"]) else None,
                "vwap": round(float(row["_vwap"]), 4) if pd.notna(row["_vwap"]) else None,
            })
        except (ValueError, TypeError):
            continue

    # Prior daily close (from the warmed daily cache) for the % change.
    prev_close = None
    end = datetime.now().strftime("%Y-%m-%d")
    start = (datetime.now() - timedelta(days=20)).strftime("%Y-%m-%d")
    dfd = _load_from_cache(ticker.upper(), start, end)
    if dfd is not None and len(dfd):
        prev_close = round(float(dfd["Close"].iloc[-1]), 4)

    last = bars[-1]["close"] if bars else None
    change = (last / prev_close - 1) if (last and prev_close) else None

    return {
        "ticker": ticker.upper(),
        "interval": interval,
        "days": days,
        "as_of": bars[-1]["ts"] if bars else None,
        "prev_close": prev_close,
        "last": last,
        "change": round(change, 4) if change is not None else None,
        "bars": bars,
    }
