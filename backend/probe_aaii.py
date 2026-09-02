"""
probe_aaii.py  — run from backend/ (swinglab env).  AAII returns HTTP 200 now,
so it's reachable; this shows WHERE the sentiment numbers live so I can pin the
parser, and checks whether the full historical export is downloadable.

    python probe_aaii.py

Paste the whole output back.
"""
from io import StringIO
import pandas as pd
import requests

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
HDRS = {"User-Agent": UA, "Accept": "text/html,application/xhtml+xml"}


def probe_results_page():
    print("=" * 70, "\n1. sent_results page tables\n", "=" * 70, sep="")
    url = "https://www.aaii.com/sentimentsurvey/sent_results"
    try:
        r = requests.get(url, headers=HDRS, timeout=25)
        print(f"HTTP {r.status_code}  bytes={len(r.text)}")
        if r.status_code != 200:
            print("head:", r.text[:200]); return
        tables = pd.read_html(StringIO(r.text))
        print(f"parsed {len(tables)} table(s)\n")
        for i, t in enumerate(tables):
            t.columns = [str(c) for c in t.columns]
            print(f"--- table[{i}]  shape={t.shape}  cols={list(t.columns)[:10]}")
            print(t.head(5).to_string()[:1500])
            print()
    except Exception as e:
        print("ERROR:", e)


def probe_exports():
    print("=" * 70, "\n2. candidate historical export files\n", "=" * 70, sep="")
    candidates = [
        "https://www.aaii.com/files/surveys/sentiment.xls",
        "https://www.aaii.com/files/surveys/sentiment.xlsx",
        "https://www.aaii.com/files/surveys/sentiment.csv",
        "https://www.aaii.com/sentimentsurvey/sent_results.xls",
    ]
    for url in candidates:
        try:
            r = requests.get(url, headers=HDRS, timeout=25, stream=True)
            ct = r.headers.get("content-type", "?")
            clen = r.headers.get("content-length", "?")
            print(f"HTTP {r.status_code:<4} type={ct:<40} len={clen}  <- {url}")
            if r.status_code == 200 and ("sheet" in ct or "excel" in ct or "csv" in ct or "octet" in ct):
                # try to read the first rows
                try:
                    if url.endswith(".csv"):
                        df = pd.read_csv(StringIO(r.text))
                    else:
                        df = pd.read_excel(r.content, sheet_name=0)
                    df.columns = [str(c) for c in df.columns]
                    print(f"   -> parsed {df.shape}  cols={list(df.columns)[:8]}")
                    print("  ", df.head(3).to_string()[:600])
                except Exception as e:
                    print("   -> present but parse failed:", str(e)[:100])
        except Exception as e:
            print(f"ERROR {url}: {e}")


if __name__ == "__main__":
    probe_results_page()
    probe_exports()
    print("\n" + "=" * 70 + "\nDONE. Paste it all back.\n" + "=" * 70)
