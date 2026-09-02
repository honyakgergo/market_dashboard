# ============================================================
# services/options.py
# Options used as INDICATORS for the underlying (not for trading options):
# put/call ratio, ATM IV, IV rank/percentile, 25-delta skew & risk reversal,
# approximate dealer GEX, and Black-Scholes greeks computed locally.
#
# IV rank requires history we can't backfill, so we snapshot ATM IV daily
# into options_iv.db starting now; the rank/percentile mature over time.
# ============================================================

import math
import sqlite3
from datetime import datetime
from pathlib import Path

import pandas as pd
import yfinance as yf

from services.data import _yf_lock, _load_from_cache

IV_DB = Path(__file__).parent.parent / "options_iv.db"


# ── Black-Scholes greeks ─────────────────────────────────────

def _norm_cdf(x): return 0.5 * (1 + math.erf(x / math.sqrt(2)))
def _norm_pdf(x): return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)


def bs_greeks(S, K, T, r, sigma, is_call=True) -> dict:
    if S <= 0 or K <= 0 or T <= 0 or sigma <= 0:
        return {"delta": None, "gamma": None, "vega": None, "theta": None}
    d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    gamma = _norm_pdf(d1) / (S * sigma * math.sqrt(T))
    vega = S * _norm_pdf(d1) * math.sqrt(T) / 100
    if is_call:
        delta = _norm_cdf(d1)
        theta = (-S * _norm_pdf(d1) * sigma / (2 * math.sqrt(T)) - r * K * math.exp(-r * T) * _norm_cdf(d2)) / 365
    else:
        delta = _norm_cdf(d1) - 1
        theta = (-S * _norm_pdf(d1) * sigma / (2 * math.sqrt(T)) + r * K * math.exp(-r * T) * _norm_cdf(-d2)) / 365
    return {"delta": delta, "gamma": gamma, "vega": vega, "theta": theta}


# ── IV-rank snapshot store ───────────────────────────────────

def _init_iv_db():
    with sqlite3.connect(IV_DB) as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS iv_snapshots (
            ticker TEXT, date TEXT, atm_iv REAL, PRIMARY KEY (ticker, date))""")
        conn.commit()


def _snapshot_iv(ticker: str, atm_iv: float):
    if atm_iv is None or atm_iv <= 0:
        return
    _init_iv_db()
    today = datetime.now().strftime("%Y-%m-%d")
    with sqlite3.connect(IV_DB) as conn:
        conn.execute("INSERT OR REPLACE INTO iv_snapshots (ticker, date, atm_iv) VALUES (?,?,?)",
                     (ticker.upper(), today, float(atm_iv)))
        conn.commit()


def _iv_rank(ticker: str, current: float) -> dict:
    if not IV_DB.exists() or current is None:
        return {"rank": None, "percentile": None, "history_days": 0}
    with sqlite3.connect(IV_DB) as conn:
        rows = conn.execute("SELECT atm_iv FROM iv_snapshots WHERE ticker = ?", (ticker.upper(),)).fetchall()
    vals = [r[0] for r in rows if r[0]]
    if len(vals) < 2:
        return {"rank": None, "percentile": None, "history_days": len(vals)}
    lo, hi = min(vals), max(vals)
    rank = (current - lo) / (hi - lo) if hi > lo else None
    pct = sum(1 for v in vals if v < current) / len(vals)
    return {"rank": round(rank, 3) if rank is not None else None,
            "percentile": round(pct, 3), "history_days": len(vals)}


# ── helpers ──────────────────────────────────────────────────

def _spot(ticker: str) -> float | None:
    df = _load_from_cache(ticker.upper(), "2000-01-01", datetime.now().strftime("%Y-%m-%d"))
    if df is not None and len(df):
        return float(df["Close"].iloc[-1])
    return None


def _risk_free() -> float:
    df = _load_from_cache("^IRX", "2000-01-01", datetime.now().strftime("%Y-%m-%d"))
    if df is not None and len(df):
        try:
            return max(0.0, float(df["Close"].iloc[-1]) / 100)
        except Exception:
            pass
    return 0.04


def _nearest(series_strikes, target):
    return min(range(len(series_strikes)), key=lambda i: abs(series_strikes[i] - target))


# ── main ─────────────────────────────────────────────────────

def build_options(ticker: str) -> dict:
    t = ticker.upper()
    S = _spot(t)
    r = _risk_free()

    acquired = _yf_lock.acquire(timeout=30)
    if not acquired:
        raise ValueError("yfinance lock timeout")
    try:
        yt = yf.Ticker(t)
        expirations = list(yt.options or [])
        if S is None:
            try:
                S = float(yt.fast_info["last_price"])
            except Exception:
                S = None
        if not expirations or S is None:
            raise ValueError(f"No options data for {t}")

        today = datetime.now().date()
        dte_list = [(e, (datetime.strptime(e, "%Y-%m-%d").date() - today).days) for e in expirations]
        # representative expiry for skew/greeks: closest to ~35 DTE among >=20d
        # (avoids the coarse front-week strike grid), falling back to nearest >=7d.
        candidates = [(e, d) for e, d in dte_list if d >= 20]
        if candidates:
            front = min(candidates, key=lambda x: abs(x[1] - 35))[0]
        else:
            front = next((e for e, d in dte_list if d >= 7), expirations[0])
        # aggregate P/C over the first 3 expiries
        near = [e for e, _ in dte_list[:3]]

        chain = yt.option_chain(front)
        calls, puts = chain.calls.copy(), chain.puts.copy()

        # aggregate volume / OI for put-call ratios
        pc_vol_num = pc_vol_den = pc_oi_num = pc_oi_den = 0.0
        for e in near:
            ch = yt.option_chain(e)
            pc_vol_num += float(ch.puts["volume"].fillna(0).sum())
            pc_vol_den += float(ch.calls["volume"].fillna(0).sum())
            pc_oi_num += float(ch.puts["openInterest"].fillna(0).sum())
            pc_oi_den += float(ch.calls["openInterest"].fillna(0).sum())
    finally:
        _yf_lock.release()

    T = max((datetime.strptime(front, "%Y-%m-%d").date() - today).days, 1) / 365

    calls = calls[(calls["impliedVolatility"] > 0)].reset_index(drop=True)
    puts = puts[(puts["impliedVolatility"] > 0)].reset_index(drop=True)

    # ATM IV (avg of nearest-strike call & put)
    atm_iv = None
    if len(calls) and len(puts):
        ci = _nearest(list(calls["strike"]), S)
        pi = _nearest(list(puts["strike"]), S)
        atm_iv = round(float((calls["impliedVolatility"].iloc[ci] + puts["impliedVolatility"].iloc[pi]) / 2), 4)

    # 25-delta skew & risk reversal
    skew = rr = iv25c = iv25p = None
    if len(calls):
        cd = [(bs_greeks(S, k, T, r, iv, True)["delta"], iv) for k, iv in zip(calls["strike"], calls["impliedVolatility"])]
        cd = [(d, iv) for d, iv in cd if d is not None]
        if cd:
            iv25c = float(min(cd, key=lambda x: abs(x[0] - 0.25))[1])
    if len(puts):
        pd_ = [(bs_greeks(S, k, T, r, iv, False)["delta"], iv) for k, iv in zip(puts["strike"], puts["impliedVolatility"])]
        pd_ = [(d, iv) for d, iv in pd_ if d is not None]
        if pd_:
            iv25p = float(min(pd_, key=lambda x: abs(x[0] - (-0.25)))[1])
    if iv25c is not None and iv25p is not None:
        rr = round(iv25c - iv25p, 4)            # 25Δ risk reversal (call IV - put IV)
        skew = round(iv25p - iv25c, 4)           # put-side richness

    # approximate dealer gamma exposure (caveated):
    # GEX ≈ S^2 * 0.01 * 100 * Σ(gamma_call*OI_call − gamma_put*OI_put)
    gex = 0.0
    for k, iv, oi in zip(calls["strike"], calls["impliedVolatility"], calls["openInterest"].fillna(0)):
        g = bs_greeks(S, k, T, r, iv, True)["gamma"]
        if g: gex += g * float(oi)
    for k, iv, oi in zip(puts["strike"], puts["impliedVolatility"], puts["openInterest"].fillna(0)):
        g = bs_greeks(S, k, T, r, iv, False)["gamma"]
        if g: gex -= g * float(oi)
    gex_notional = round(gex * 100 * S * S * 0.01, 0)

    # snapshot ATM IV + compute rank
    _snapshot_iv(t, atm_iv)
    ivr = _iv_rank(t, atm_iv)

    return {
        "ticker": t,
        "spot": round(S, 2),
        "risk_free": round(r, 4),
        "front_expiry": front,
        "dte": round(T * 365),
        "atm_iv": atm_iv,
        "iv_rank": ivr["rank"],
        "iv_percentile": ivr["percentile"],
        "iv_history_days": ivr["history_days"],
        "put_call_volume": round(pc_vol_num / pc_vol_den, 3) if pc_vol_den else None,
        "put_call_oi": round(pc_oi_num / pc_oi_den, 3) if pc_oi_den else None,
        "iv_25d_call": round(iv25c, 4) if iv25c is not None else None,
        "iv_25d_put": round(iv25p, 4) if iv25p is not None else None,
        "risk_reversal_25d": rr,
        "skew_25d": skew,
        "gex_notional": gex_notional,
        "note": "GEX is an approximation (assumes dealers short gamma); IV rank matures as daily snapshots accumulate.",
    }
