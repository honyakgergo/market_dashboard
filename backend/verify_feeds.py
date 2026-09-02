"""
verify_feeds.py  —  run ONCE from backend/ (conda env: swinglab) before the
remaining pages are built.

    cd C:\\Users\\honya\\Documents\\money_dashboard\\backend
    python verify_feeds.py

Writes nothing, touches no DB. It only prints, and surfaces the exact magic
strings the new fetchers need (CFTC dataset codes + contract names, EXV->sector
tickers, CBOE put/call endpoint). Paste the full output back.
"""
from io import StringIO
import sys
import textwrap
import pandas as pd
import requests

HDRS = {"User-Agent": "Mozilla/5.0 (money_dashboard verify)"}
SECTION = lambda t: print("\n" + "=" * 78 + f"\n{t}\n" + "=" * 78)


# --------------------------------------------------------------------------- #
# 1. CFTC  — TFF (ES/NQ/ZN/6E) + Disaggregated (metals/energy)
# --------------------------------------------------------------------------- #
CFTC_CANDIDATES = {
    "TFF_futures_only":        "gpe5-46if",   # Traders in Financial Futures – confirm
    "disaggregated_fut_only":  "72hh-3qpy",   # Disaggregated futures-only – confirm
    "disaggregated_combined":  "kh3c-gbw2",   # confirmed via docs
    "legacy_futures_only":     "6dca-aqww",   # confirmed via docs
}
CFTC_BASE = "https://publicreporting.cftc.gov/resource/{code}.json"
WANT = ["S&P 500", "NASDAQ", "TREASURY", "EURO FX", "GOLD", "SILVER", "COPPER", "CRUDE OIL"]


def check_cftc():
    SECTION("1. CFTC  (Socrata public API — no key needed)")
    for label, code in CFTC_CANDIDATES.items():
        url = CFTC_BASE.format(code=code)
        try:
            r = requests.get(url, params={"$limit": 1}, headers=HDRS, timeout=20)
            print(f"\n[{label}]  code={code}  HTTP {r.status_code}")
            if r.status_code != 200:
                print(f"   -> non-200 head: {r.text[:160]}"); continue
            rows = r.json()
            if not rows:
                print("   -> 200 but empty"); continue
            print(f"   -> columns ({len(rows[0])}): {list(rows[0].keys())}")
        except Exception as e:
            print(f"[{label}] ERROR: {e}")

    for label in ("TFF_futures_only", "disaggregated_fut_only"):
        code = CFTC_CANDIDATES[label]
        print(f"\n--- distinct contract names, latest report [{label}] ---")
        try:
            r = requests.get(CFTC_BASE.format(code=code), headers=HDRS, timeout=30,
                             params={"$order": "report_date_as_yyyy_mm_dd DESC", "$limit": 900})
            r.raise_for_status()
            df = pd.DataFrame(r.json())
            name_col = next((c for c in df.columns if c in
                            ("market_and_exchange_names", "contract_market_name", "commodity_name")), None)
            if not name_col:
                print(f"   !! no name column in {list(df.columns)[:20]}"); continue
            latest = df[df["report_date_as_yyyy_mm_dd"] == df["report_date_as_yyyy_mm_dd"].max()]
            names = sorted(latest[name_col].dropna().unique())
            for kw in WANT:
                hits = [n for n in names if kw in n.upper()]
                print(f"   {kw:12s} -> " + (" | ".join(hits[:4]) if hits else "(none this report)"))
        except Exception as e:
            print(f"   ERROR pulling names: {e}")


def check_naaim():
    SECTION("2. NAAIM Exposure Index (weekly)")
    url = "https://www.naaim.org/programs/naaim-exposure-index/"
    try:
        r = requests.get(url, headers=HDRS, timeout=25)
        print(f"HTTP {r.status_code}  bytes={len(r.text)}"); r.raise_for_status()
        tables = pd.read_html(StringIO(r.text))
        print(f"parsed {len(tables)} table(s)")
        for i, t in enumerate(tables):
            t.columns = [str(c) for c in t.columns]
            print(f"\n  table[{i}] shape={t.shape} cols={list(t.columns)[:8]}")
            print(textwrap.indent(t.head(3).to_string(), "     "))
    except Exception as e:
        print(f"ERROR: {e}  (fallback: locate the CSV/export link — report this)")


def check_aaii():
    SECTION("3. AAII Investor Sentiment (weekly)")
    url = "https://www.aaii.com/sentimentsurvey/sent_results"
    try:
        r = requests.get(url, headers=HDRS, timeout=25)
        print(f"HTTP {r.status_code}  bytes={len(r.text)}"); r.raise_for_status()
        try:
            tables = pd.read_html(StringIO(r.text))
            print(f"parsed {len(tables)} table(s)")
            for i, t in enumerate(tables[:3]):
                t.columns = [str(c) for c in t.columns]
                print(f"  table[{i}] shape={t.shape} cols={list(t.columns)[:8]}")
        except ValueError:
            print("no HTML tables — likely JS-rendered. Report this; fallback = the")
            print("downloadable historical xls on aaii.com.")
    except Exception as e:
        print(f"ERROR: {e}")


def check_putcall():
    SECTION("4. CBOE equity/total put-call ratio (daily)")
    for url in ("https://cdn.cboe.com/api/global/us_indices/daily_prices/PCALL.json",
                "https://cdn.cboe.com/api/global/us_indices/daily_prices/_PCALL.json"):
        try:
            r = requests.get(url, headers=HDRS, timeout=20)
            print(f"HTTP {r.status_code}  <- {url}")
            if r.status_code == 200:
                print(f"   head: {r.text[:200]}")
        except Exception as e:
            print(f"ERROR {url}: {e}")
    print("If both fail, report it — fallback is the daily CSV mirror.")


EXV_CANDIDATES = [f"EXV{i}.DE" for i in range(1, 10)] + [f"EXH{i}.DE" for i in range(1, 10)]


def check_europe_etfs():
    SECTION("5. EXV/EXH iShares STOXX Europe 600 sector ETFs (yfinance)")
    try:
        import yfinance as yf
    except ImportError:
        print("yfinance not importable — run in swinglab. Skipping."); return
    ok = []
    for t in EXV_CANDIDATES:
        try:
            h = yf.Ticker(t).history(period="1mo")
            if h is None or h.empty:
                print(f"  {t:9s} -> EMPTY"); continue
            name = ""
            try:
                name = (yf.Ticker(t).info or {}).get("longName", "") or ""
            except Exception:
                pass
            print(f"  {t:9s} -> rows={len(h):3d} last={h.index[-1].date()}  {name}")
            ok.append(t)
        except Exception as e:
            print(f"  {t:9s} -> ERROR {e}")
    print(f"\n  resolved: {ok}")


COMMOD = {"crude": "CL=F", "gold": "GC=F", "silver": "SI=F", "copper": "HG=F",
          "natgas": "NG=F", "brent": "BZ=F", "btc": "BTC-USD",
          "ust10y_fut": "ZN=F", "dxy": "DX-Y.NYB", "tlt": "TLT", "ief": "IEF"}


def check_commodities():
    SECTION("6. Commodity / cross-asset tickers (yfinance)")
    try:
        import yfinance as yf
    except ImportError:
        print("yfinance not importable — run in swinglab. Skipping."); return
    for label, t in COMMOD.items():
        try:
            h = yf.Ticker(t).history(period="5d")
            print(f"  {label:11s} {t:10s} -> " + (f"rows={len(h)} last={h.index[-1].date()}" if not h.empty else "EMPTY"))
        except Exception as e:
            print(f"  {label:11s} {t:10s} -> ERROR {e}")


if __name__ == "__main__":
    print("money_dashboard feed verification —", pd.Timestamp.now())
    for fn in (check_cftc, check_naaim, check_aaii, check_putcall, check_europe_etfs, check_commodities):
        try:
            fn()
        except Exception as e:
            print(f"\n!! {fn.__name__} crashed: {e}", file=sys.stderr)
    print("\n" + "=" * 78 + "\nDONE. Paste the whole output back.\n" + "=" * 78)
