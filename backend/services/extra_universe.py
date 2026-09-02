# ============================================================
# services/extra_universe.py
# Augments the search index (search.db -> `tickers`) with the non-equity
# names the dashboard references but the CSV seed never covered:
#   - continuous commodity futures (=F)
#   - European indices (^...) + iShares STOXX 600 sector ETFs (.DE)
#   - major European single stocks (.AS / .PA / .DE / .L / .SW / .CO / .MI)
#   - FX pairs (=X) + the dollar index / UUP
#   - a broader crypto set (-USD)
#   - the volatility / rates complex (^VIX, ^SKEW, ^TNX, ...)
#
# WHY A SEPARATE MODULE (not the CSVs):
#   seed_tickers.ensure_seeded() only runs when the index is EMPTY, so once
#   search.db exists new CSV rows are never picked up without a manual reseed
#   (which also wipes last_accessed). This module is idempotent — it uses
#   INSERT OR IGNORE and runs on every startup, so it self-heals the index
#   without disturbing existing rows or the user's recency history.
#
# Every symbol here resolves on yfinance, so it also opens cleanly in the
# Ticker Detail page (which fetches live via services.data.fetch_ohlcv).
# ============================================================

import sqlite3
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "search.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS tickers (
    symbol        TEXT PRIMARY KEY,
    name          TEXT,
    sector        TEXT,
    exchange      TEXT,
    category      TEXT,
    is_seed       INTEGER DEFAULT 1,
    first_seen    TEXT,
    last_accessed TEXT
)
"""

# ── iShares STOXX Europe 600 sector UCITS ETFs (XETRA) ────────
# Sector names mirror services/europe.py SECTOR_NAMES (kept in sync).
_EU_SECTORS = {
    "EXV1.DE": "Banks", "EXV2.DE": "Telecommunications", "EXV3.DE": "Technology",
    "EXV4.DE": "Health Care", "EXV5.DE": "Automobiles & Parts", "EXV6.DE": "Basic Resources",
    "EXV7.DE": "Chemicals", "EXH1.DE": "Oil & Gas", "EXH2.DE": "Financial Services",
    "EXH3.DE": "Food & Beverage", "EXH4.DE": "Industrial Goods & Services",
    "EXH5.DE": "Insurance", "EXH6.DE": "Media", "EXH7.DE": "Personal & Household Goods",
    "EXH8.DE": "Retail", "EXH9.DE": "Utilities",
}

# (symbol, name, sector, exchange, category)
_ROWS: list[tuple[str, str, str, str, str]] = [
    # ── Commodity futures (continuous) ──────────────────────
    ("CL=F", "Crude Oil WTI Futures", "Energy", "NYMEX", "commodity_future"),
    ("BZ=F", "Brent Crude Oil Futures", "Energy", "ICE", "commodity_future"),
    ("NG=F", "Natural Gas Futures", "Energy", "NYMEX", "commodity_future"),
    ("RB=F", "RBOB Gasoline Futures", "Energy", "NYMEX", "commodity_future"),
    ("HO=F", "Heating Oil Futures", "Energy", "NYMEX", "commodity_future"),
    ("GC=F", "Gold Futures", "Metals", "COMEX", "commodity_future"),
    ("SI=F", "Silver Futures", "Metals", "COMEX", "commodity_future"),
    ("HG=F", "Copper Futures", "Metals", "COMEX", "commodity_future"),
    ("PL=F", "Platinum Futures", "Metals", "NYMEX", "commodity_future"),
    ("PA=F", "Palladium Futures", "Metals", "NYMEX", "commodity_future"),
    ("ZC=F", "Corn Futures", "Agriculture", "CBOT", "commodity_future"),
    ("ZW=F", "Wheat Futures", "Agriculture", "CBOT", "commodity_future"),
    ("ZS=F", "Soybean Futures", "Agriculture", "CBOT", "commodity_future"),
    ("KC=F", "Coffee Futures", "Agriculture", "ICE", "commodity_future"),
    ("SB=F", "Sugar Futures", "Agriculture", "ICE", "commodity_future"),
    ("CC=F", "Cocoa Futures", "Agriculture", "ICE", "commodity_future"),
    ("CT=F", "Cotton Futures", "Agriculture", "ICE", "commodity_future"),

    # ── European indices ────────────────────────────────────
    ("^GDAXI", "DAX Index", "Index - Germany", "XETRA", "index"),
    ("^STOXX50E", "EURO STOXX 50 Index", "Index - Eurozone", "STOXX", "index"),
    ("^STOXX", "STOXX Europe 600 Index", "Index - Europe", "STOXX", "index"),
    ("^FCHI", "CAC 40 Index", "Index - France", "Euronext Paris", "index"),
    ("^FTSE", "FTSE 100 Index", "Index - United Kingdom", "LSE", "index"),
    ("^IBEX", "IBEX 35 Index", "Index - Spain", "BME", "index"),
    ("FTSEMIB.MI", "FTSE MIB Index", "Index - Italy", "Borsa Italiana", "index"),
    ("^AEX", "AEX Index", "Index - Netherlands", "Euronext Amsterdam", "index"),
    ("^SSMI", "SMI Index", "Index - Switzerland", "SIX", "index"),
    ("^BFX", "BEL 20 Index", "Index - Belgium", "Euronext Brussels", "index"),
    ("^OMX", "OMX Stockholm 30 Index", "Index - Sweden", "Nasdaq Nordic", "index"),
    ("^N100", "Euronext 100 Index", "Index - Europe", "Euronext", "index"),

    # ── Major European single stocks ────────────────────────
    # Netherlands (Euronext Amsterdam)
    ("ASML.AS", "ASML Holding NV", "Technology", "Euronext Amsterdam", "eu_equity"),
    ("ASM.AS", "ASM International NV", "Technology", "Euronext Amsterdam", "eu_equity"),
    ("ADYEN.AS", "Adyen NV", "Financials", "Euronext Amsterdam", "eu_equity"),
    ("INGA.AS", "ING Groep NV", "Financials", "Euronext Amsterdam", "eu_equity"),
    ("PRX.AS", "Prosus NV", "Technology", "Euronext Amsterdam", "eu_equity"),
    ("HEIA.AS", "Heineken NV", "Consumer Staples", "Euronext Amsterdam", "eu_equity"),
    ("PHIA.AS", "Koninklijke Philips NV", "Health Care", "Euronext Amsterdam", "eu_equity"),
    ("WKL.AS", "Wolters Kluwer NV", "Industrials", "Euronext Amsterdam", "eu_equity"),
    ("AD.AS", "Ahold Delhaize NV", "Consumer Staples", "Euronext Amsterdam", "eu_equity"),
    # France (Euronext Paris)
    ("MC.PA", "LVMH Moet Hennessy Louis Vuitton SE", "Consumer Discretionary", "Euronext Paris", "eu_equity"),
    ("OR.PA", "L'Oreal SA", "Consumer Staples", "Euronext Paris", "eu_equity"),
    ("AIR.PA", "Airbus SE", "Industrials", "Euronext Paris", "eu_equity"),
    ("TTE.PA", "TotalEnergies SE", "Energy", "Euronext Paris", "eu_equity"),
    ("SU.PA", "Schneider Electric SE", "Industrials", "Euronext Paris", "eu_equity"),
    ("SAN.PA", "Sanofi SA", "Health Care", "Euronext Paris", "eu_equity"),
    ("RMS.PA", "Hermes International SCA", "Consumer Discretionary", "Euronext Paris", "eu_equity"),
    # Germany (XETRA)
    ("SAP.DE", "SAP SE", "Technology", "XETRA", "eu_equity"),
    ("SIE.DE", "Siemens AG", "Industrials", "XETRA", "eu_equity"),
    ("RHM.DE", "Rheinmetall AG", "Industrials", "XETRA", "eu_equity"),
    ("ALV.DE", "Allianz SE", "Financials", "XETRA", "eu_equity"),
    ("DTE.DE", "Deutsche Telekom AG", "Communication", "XETRA", "eu_equity"),
    ("MBG.DE", "Mercedes-Benz Group AG", "Consumer Discretionary", "XETRA", "eu_equity"),
    ("VOW3.DE", "Volkswagen AG", "Consumer Discretionary", "XETRA", "eu_equity"),
    ("BAS.DE", "BASF SE", "Materials", "XETRA", "eu_equity"),
    # United Kingdom (LSE)
    ("SHEL.L", "Shell plc", "Energy", "LSE", "eu_equity"),
    ("AZN.L", "AstraZeneca plc", "Health Care", "LSE", "eu_equity"),
    ("HSBA.L", "HSBC Holdings plc", "Financials", "LSE", "eu_equity"),
    ("ULVR.L", "Unilever plc", "Consumer Staples", "LSE", "eu_equity"),
    ("BP.L", "BP plc", "Energy", "LSE", "eu_equity"),
    ("RIO.L", "Rio Tinto plc", "Materials", "LSE", "eu_equity"),
    # Switzerland (SIX)
    ("NESN.SW", "Nestle SA", "Consumer Staples", "SIX", "eu_equity"),
    ("NOVN.SW", "Novartis AG", "Health Care", "SIX", "eu_equity"),
    ("ROG.SW", "Roche Holding AG", "Health Care", "SIX", "eu_equity"),
    ("UBSG.SW", "UBS Group AG", "Financials", "SIX", "eu_equity"),
    # Denmark
    ("NOVO-B.CO", "Novo Nordisk A/S", "Health Care", "Nasdaq Copenhagen", "eu_equity"),
    # Italy
    ("ENEL.MI", "Enel SpA", "Utilities", "Borsa Italiana", "eu_equity"),
    ("ISP.MI", "Intesa Sanpaolo SpA", "Financials", "Borsa Italiana", "eu_equity"),
    # Spain
    ("SAN.MC", "Banco Santander SA", "Financials", "BME", "eu_equity"),
    ("IBE.MC", "Iberdrola SA", "Utilities", "BME", "eu_equity"),

    # ── FX pairs + dollar ───────────────────────────────────
    ("EURUSD=X", "EUR/USD", "FX - Major", "FOREX", "fx"),
    ("EURGBP=X", "EUR/GBP", "FX - Cross", "FOREX", "fx"),
    ("EURJPY=X", "EUR/JPY", "FX - Cross", "FOREX", "fx"),
    ("GBPUSD=X", "GBP/USD", "FX - Major", "FOREX", "fx"),
    ("JPY=X", "USD/JPY", "FX - Major", "FOREX", "fx"),
    ("AUDUSD=X", "AUD/USD", "FX - Major", "FOREX", "fx"),
    ("USDCAD=X", "USD/CAD", "FX - Major", "FOREX", "fx"),
    ("USDCHF=X", "USD/CHF", "FX - Major", "FOREX", "fx"),
    ("DX-Y.NYB", "US Dollar Index (DXY)", "FX - Dollar Index", "ICE", "fx"),

    # ── ETFs the dashboard uses but the seed missed ─────────
    ("UUP", "Invesco DB US Dollar Index Bullish Fund", "Currency - Dollar", "PCX", "etf"),
    ("SOXX", "iShares Semiconductor ETF", "Industry ETF - Semiconductors", "NGM", "etf"),
    ("RSP", "Invesco S&P 500 Equal Weight ETF", "Broad Market", "PCX", "etf"),
    ("IWF", "iShares Russell 1000 Growth ETF", "Style - Growth", "PCX", "etf"),
    ("IWD", "iShares Russell 1000 Value ETF", "Style - Value", "PCX", "etf"),

    # ── Broader crypto ──────────────────────────────────────
    ("SOL-USD", "Solana USD", "Crypto - Layer 1", "CCC", "crypto"),
    ("XRP-USD", "XRP USD", "Crypto - Payments", "CCC", "crypto"),
    ("ADA-USD", "Cardano USD", "Crypto - Layer 1", "CCC", "crypto"),
    ("DOGE-USD", "Dogecoin USD", "Crypto - Meme", "CCC", "crypto"),
    ("BNB-USD", "BNB USD", "Crypto - Exchange", "CCC", "crypto"),
    ("LTC-USD", "Litecoin USD", "Crypto - Payments", "CCC", "crypto"),
    ("AVAX-USD", "Avalanche USD", "Crypto - Layer 1", "CCC", "crypto"),
    ("DOT-USD", "Polkadot USD", "Crypto - Layer 0", "CCC", "crypto"),
    ("LINK-USD", "Chainlink USD", "Crypto - Oracle", "CCC", "crypto"),
    ("MATIC-USD", "Polygon USD", "Crypto - Layer 2", "CCC", "crypto"),
    ("BCH-USD", "Bitcoin Cash USD", "Crypto - Payments", "CCC", "crypto"),
    ("TRX-USD", "TRON USD", "Crypto - Layer 1", "CCC", "crypto"),

    # ── Volatility / rates complex ──────────────────────────
    ("^VIX", "CBOE Volatility Index", "Volatility", "CBOE", "volatility"),
    ("^VIX3M", "CBOE 3-Month Volatility Index", "Volatility", "CBOE", "volatility"),
    ("^VVIX", "CBOE VVIX Index (vol of vol)", "Volatility", "CBOE", "volatility"),
    ("^SKEW", "CBOE SKEW Index", "Volatility", "CBOE", "volatility"),
    ("^VXN", "CBOE Nasdaq-100 Volatility Index", "Volatility", "CBOE", "volatility"),
    ("^TNX", "US 10-Year Treasury Yield", "Rates", "CBOE", "rate"),
    ("^IRX", "US 13-Week Treasury Bill Yield", "Rates", "CBOE", "rate"),
    ("^FVX", "US 5-Year Treasury Yield", "Rates", "CBOE", "rate"),
    ("^TYX", "US 30-Year Treasury Yield", "Rates", "CBOE", "rate"),
]

# Fold in the STOXX 600 sector ETFs with a consistent naming scheme.
for _sym, _sec in _EU_SECTORS.items():
    _ROWS.append((_sym, f"iShares STOXX Europe 600 {_sec} UCITS ETF", _sec, "XETRA", "sector_etf_eu"))


def ensure_extra_seeded() -> dict:
    """
    Idempotently add the curated non-equity universe to search.db.

    These rows are marked is_seed=2 ("searchable but NOT warmed"): they show up
    in the ticker search and open on demand in Ticker Detail (live fetch), but
    they are deliberately excluded from the cache warmer's universe so the warm
    job doesn't hammer ~90 extra futures/FX/EU names on every boot (which was
    both slow and produced "possibly delisted" noise for the ones that don't
    resolve cleanly). See services/universe.get_equity_universe().

    Safe to call on every startup: new rows insert as is_seed=2, and any rows a
    previous run inserted as is_seed=1 are upgraded to 2. Rows a user added via
    lookup (is_seed=0) are never touched.
    """
    now_iso = datetime.utcnow().isoformat()
    payload = [
        (sym, name, sector, exchange, category, now_iso)
        for (sym, name, sector, exchange, category) in _ROWS
    ]
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(_SCHEMA)
        before = conn.execute("SELECT COUNT(*) FROM tickers").fetchone()[0]
        conn.executemany(
            """
            INSERT INTO tickers
                (symbol, name, sector, exchange, category, is_seed, first_seen, last_accessed)
            VALUES (?, ?, ?, ?, ?, 2, ?, NULL)
            ON CONFLICT(symbol) DO UPDATE SET
                is_seed = 2
            WHERE tickers.is_seed = 1
            """,
            payload,
        )
        conn.commit()
        after = conn.execute("SELECT COUNT(*) FROM tickers").fetchone()[0]
    added = after - before
    print(f"  [extra_universe] {len(_ROWS)} curated symbols processed, {added} newly added ({after} total, search-only).")
    return {"processed": len(_ROWS), "added": added, "total": after}


if __name__ == "__main__":
    ensure_extra_seeded()
