# ============================================================
# services/regime.py
# Responsible for: per-ticker regime detection
# ============================================================

import pandas as pd
from services.indicators import compute_ma, compute_atr


def compute_regime(df: pd.DataFrame, atr_multiplier: float = 0.5) -> pd.Series:
    """
    Classify each bar as Bull / Bear / Sideways using rule-based logic.

    Rules:
        Bull     — Close > MA200 + band AND MA50 > MA200
        Bear     — Close < MA200 - band AND MA50 < MA200
        Sideways — everything in between

    The ATR band prevents rapid regime flipping when price hovers near MA200.

    Args:
        df:             DataFrame with columns: Close, MA50, MA200, ATR
        atr_multiplier: width of the Sideways tolerance band around MA200

    Returns:
        Series with values "Bull", "Bear", or "Sideways"
    """
    regime = pd.Series(index=df.index, dtype=str)

    for i in range(len(df)):
        close = df["Close"].iloc[i]
        ma50  = df["MA50"].iloc[i]
        ma200 = df["MA200"].iloc[i]
        atr   = df["ATR"].iloc[i]

        if pd.isna(ma200) or pd.isna(ma50) or pd.isna(atr):
            regime.iloc[i] = "Sideways"
            continue

        band = atr * atr_multiplier

        if close > ma200 + band and ma50 > ma200:
            regime.iloc[i] = "Bull"
        elif close < ma200 - band and ma50 < ma200:
            regime.iloc[i] = "Bear"
        else:
            regime.iloc[i] = "Sideways"

    return regime
