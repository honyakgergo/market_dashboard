# ============================================================
# services/cache_warmer.py
# Pre-fetches the full universe on startup + periodic background refresh.
#
# Adapted from SwingLab: the universe now comes from services.universe
# (seeded search index + macro + FX) instead of strategy watchlists, and the
# warm period is 2y — enough for 200-day MAs, 1y returns, and 52-week
# high/low on the overview heatmap, while keeping first-boot time reasonable.
# data.py still caches/serves longer ranges on demand.
# ============================================================

import time
import threading

from services.data import fetch_ohlcv, _cache_is_fresh, _period_to_days, MA_WARMUP_DAYS
from services.universe import get_warm_universe

# Maximum period warmed on boot — covers all shorter dashboard periods.
MAX_PERIOD = "2y"
MAX_DAYS = _period_to_days(MAX_PERIOD) + MA_WARMUP_DAYS


def warm_cache(force: bool = False) -> dict:
    """
    Fetch all universe tickers with `MAX_PERIOD` data and store in SQLite.
    Skips tickers that already have fresh cache unless force=True.
    Retries failed tickers up to 3 times with delay.
    """
    all_tickers = get_warm_universe()
    results = {"cached": 0, "skipped": 0, "failed": 0, "errors": []}
    total = len(all_tickers)

    print(f"\n{'='*52}")
    print(f"  CACHE WARMER — {total} tickers, period={MAX_PERIOD}")
    print(f"{'='*52}")

    if total == 0:
        print("  No tickers to warm (search index not seeded yet?).")
        return results

    t0 = time.time()
    failed_tickers = []

    for i, ticker in enumerate(all_tickers, 1):
        if not force and _cache_is_fresh(ticker, MAX_DAYS):
            print(f"  [{i:3d}/{total}] {ticker:12s}  SKIP (cache fresh)")
            results["skipped"] += 1
            continue

        for attempt in range(3):
            try:
                t1 = time.time()
                fetch_ohlcv(ticker, period=MAX_PERIOD, use_cache=False)
                elapsed = round(time.time() - t1, 1)
                print(f"  [{i:3d}/{total}] {ticker:12s}  OK  ({elapsed}s)")
                results["cached"] += 1
                break
            except Exception as e:
                if attempt < 2:
                    time.sleep(3)  # wait before retry
                else:
                    print(f"  [{i:3d}/{total}] {ticker:12s}  FAIL after 3 attempts: {e}")
                    results["failed"] += 1
                    results["errors"].append({"ticker": ticker, "error": str(e)})
                    failed_tickers.append(ticker)

    # Final retry pass for any remaining failures after a longer pause
    if failed_tickers:
        print(f"\n  Retrying {len(failed_tickers)} failed tickers after 10s pause...")
        time.sleep(10)
        for ticker in failed_tickers[:]:
            try:
                fetch_ohlcv(ticker, period=MAX_PERIOD, use_cache=False)
                print(f"  {ticker:12s}  RECOVERED")
                results["failed"] -= 1
                results["cached"] += 1
                failed_tickers.remove(ticker)
            except Exception:
                print(f"  {ticker:12s}  STILL FAILED")

    elapsed = round(time.time() - t0, 1)
    print(f"\n  Done in {elapsed}s — {results['cached']} fetched, "
          f"{results['skipped']} skipped, {results['failed']} failed\n")

    return results


def daily_refresh():
    """Refresh cache for all tickers. Runs as a background thread."""
    print("\n  [REFRESH] Starting daily cache refresh...")
    warm_cache(force=True)
    print("  [REFRESH] Daily refresh complete.\n")


def start_background_refresh(interval_hours: float = 6):
    """Start a background thread that refreshes cache periodically (default 6h)."""
    def loop():
        while True:
            time.sleep(interval_hours * 3600)
            try:
                daily_refresh()
            except Exception as e:
                print(f"  [REFRESH] Error: {e}")

    t = threading.Thread(target=loop, daemon=True)
    t.start()
    print(f"  [REFRESH] Background refresh scheduled every {interval_hours}h")
