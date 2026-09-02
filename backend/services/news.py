# ============================================================
# services/news.py
# Headline aggregation for the News page. Pulls yfinance Ticker.news for each
# watchlist symbol, normalizes the (nested, versioned) schema, dedupes stories
# across symbols (merging ticker tags), and returns a unified newest-first
# feed. Per-symbol results cached ~15 min; STORY items only (no videos/ads).
#
# Schema note: modern yfinance puts fields under item['content'] (title,
# summary, pubDate, canonicalUrl.url, provider.displayName, contentType);
# older builds are flat (title/link/publisher/providerPublishTime). Both handled.
# ============================================================

import time
import threading
from datetime import datetime

import yfinance as yf

from services.data import _yf_lock
from services import watchlist as wl

_cache: dict = {}   # symbol -> {ts, items}
_TTL = 900          # 15 min
_lock = threading.Lock()


def _first(*vals):
    for v in vals:
        if v:
            return v
    return None


def _best_thumb(res):
    """Pick the highest-resolution thumbnail (Yahoo lists several sizes; the
    last one is usually the tiny 140px square, so choose by max width)."""
    best, best_w = None, -1
    for r in res or []:
        u, w = r.get("url"), (r.get("width") or 0)
        if u and w > best_w:
            best, best_w = u, w
    if best:
        return best
    return (res[0].get("url") if res else None)


def _parse_ts(item, content):
    pd_ = (content or {}).get("pubDate")
    if pd_:
        try:
            return int(datetime.fromisoformat(pd_.replace("Z", "+00:00")).timestamp())
        except Exception:
            pass
    ep = item.get("providerPublishTime")
    if ep:
        try:
            return int(ep)
        except Exception:
            pass
    return None


def _normalize(item):
    if not isinstance(item, dict):
        return None
    content = item.get("content")
    if content:  # modern nested schema
        ctype = content.get("contentType")
        if ctype and ctype != "STORY":
            return None
        title = content.get("title")
        summary = content.get("summary") or content.get("description")
        url = _first((content.get("canonicalUrl") or {}).get("url"),
                     (content.get("clickThroughUrl") or {}).get("url"))
        publisher = (content.get("provider") or {}).get("displayName")
        thumb = None
        res = (content.get("thumbnail") or {}).get("resolutions") or []
        if res:
            thumb = _best_thumb(res)
        ts = _parse_ts(item, content)
    else:  # legacy flat schema
        if item.get("type") and item.get("type") != "STORY":
            return None
        title, summary = item.get("title"), item.get("summary")
        url, publisher = item.get("link"), item.get("publisher")
        thumb = None
        res = (item.get("thumbnail") or {}).get("resolutions") or []
        if res:
            thumb = _best_thumb(res)
        ts = _parse_ts(item, None)

    if not title or not url:
        return None
    return {
        "id": url,
        "title": title.strip(),
        "summary": ((summary or "").strip()[:280] or None),
        "url": url,
        "publisher": publisher,
        "published": ts,
        "thumbnail": thumb,
    }


def _symbol_news(sym, limit=12):
    now = time.time()
    c = _cache.get(sym)
    if c and now - c["ts"] < _TTL:
        return c["items"]

    raw = []
    acquired = _yf_lock.acquire(timeout=20)
    try:
        raw = yf.Ticker(sym).news or []
    except Exception:
        raw = []
    finally:
        if acquired:
            _yf_lock.release()

    items = []
    for it in raw:
        n = _normalize(it)
        if n:
            items.append(n)
        if len(items) >= limit:
            break

    with _lock:
        _cache[sym] = {"ts": now, "items": items}
    return items


def build_ticker_news(ticker, limit=12):
    sym = (ticker or "").strip().upper()
    if not sym:
        return {"items": []}
    items = sorted(_symbol_news(sym, limit), key=lambda x: x["published"] or 0, reverse=True)
    return {"symbol": sym, "items": items, "as_of": datetime.utcnow().isoformat()}


def build_watchlist_news(hours=None):
    items_by_url = {}
    for w in wl.get_watchlist():
        sym, label = w["symbol"], w["label"]
        for n in _symbol_news(sym):
            entry = items_by_url.get(n["url"])
            if entry is None:
                entry = {**n, "tickers": []}
                items_by_url[n["url"]] = entry
            if not any(t["symbol"] == sym for t in entry["tickers"]):
                entry["tickers"].append({"symbol": sym, "label": label})

    items = list(items_by_url.values())
    if hours:
        cutoff = time.time() - hours * 3600
        items = [i for i in items if (i["published"] or 0) >= cutoff]
    items.sort(key=lambda x: x["published"] or 0, reverse=True)
    return {"items": items, "count": len(items), "as_of": datetime.utcnow().isoformat()}
