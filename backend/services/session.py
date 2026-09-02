# ============================================================
# services/session.py
# The EU / US market clock. Pure time logic, no data fetching.
# Every intraday-capable endpoint keys off market_session() to decide
# whether to serve LIVE intraday data or the LAST CLOSE, and every live
# page shows an honest freshness banner built from this.
#
# Sessions (regular cash hours):
#   US  09:30–16:00 America/New_York
#   EU  09:00–17:30 Europe/Berlin
#
# Note: weekend-aware but NOT holiday-aware. On an exchange holiday the
# banner may say "open" while data is stale; intraday fetches will simply
# return little/no fresh data. Good enough for a personal monitor.
# ============================================================

from datetime import datetime, time
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
EU = ZoneInfo("Europe/Berlin")
UTC = ZoneInfo("UTC")

US_OPEN, US_CLOSE = time(9, 30), time(16, 0)
EU_OPEN, EU_CLOSE = time(9, 0), time(17, 30)

# Minimal 2025–2026 NYSE full-day holidays (extend as needed).
_US_HOLIDAYS = {
    "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
    "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
    "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
}


def _is_open(now_local, open_t, close_t, holidays=None) -> bool:
    if now_local.weekday() >= 5:               # Sat / Sun
        return False
    if holidays and now_local.strftime("%Y-%m-%d") in holidays:
        return False
    return open_t <= now_local.time() <= close_t


def market_session(now_utc: datetime | None = None) -> dict:
    """Return the current EU/US session state.

    phase ∈ {overnight, eu_only, overlap, us_only}
    """
    now = now_utc or datetime.now(UTC)
    now_ny = now.astimezone(NY)
    now_eu = now.astimezone(EU)

    us_open = _is_open(now_ny, US_OPEN, US_CLOSE, _US_HOLIDAYS)
    eu_open = _is_open(now_eu, EU_OPEN, EU_CLOSE)

    if us_open and eu_open:
        phase = "overlap"
    elif us_open:
        phase = "us_only"
    elif eu_open:
        phase = "eu_only"
    else:
        phase = "overnight"

    return {
        "eu_open": eu_open,
        "us_open": us_open,
        "phase": phase,
        "as_of": now.isoformat(),
        "now_cet": now_eu.strftime("%H:%M"),
        "now_et": now_ny.strftime("%H:%M"),
        "us_session": {"open": "09:30", "close": "16:00", "tz": "ET"},
        "eu_session": {"open": "09:00", "close": "17:30", "tz": "CET"},
    }


def data_mode(market: str, session: dict | None = None) -> str:
    """'live' if the given market ('us' | 'eu') is open, else 'close'."""
    s = session or market_session()
    if market == "us":
        return "live" if s["us_open"] else "close"
    if market == "eu":
        return "live" if s["eu_open"] else "close"
    return "close"
