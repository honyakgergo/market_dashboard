// ============================================================
// components/TickerSearch.jsx
// Command-palette ticker search over the seeded universe.
// Same backend contract as SwingLab: symbol/name ranked search,
// recent list on empty query, and on-demand lookup+add for symbols
// not in the seed.
// ============================================================

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { searchTickers, fetchRecentTickers, lookupTicker, selectTicker } from '../api/client'
import { useStore } from '../store/useStore'

export default function TickerSearch() {
  const openTicker = useStore((s) => s.openTicker)

  const [open, setOpen]       = useState(false)
  const [q, setQ]             = useState('')
  const [results, setResults] = useState([])
  const [recent, setRecent]   = useState([])
  const [active, setActive]   = useState(0)
  const [busy, setBusy]       = useState(false)
  const [notFound, setNotFound] = useState(false)

  const boxRef   = useRef(null)
  const inputRef = useRef(null)
  const debounce = useRef(null)

  // Cmd/Ctrl-K to focus search
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(true)
        setTimeout(() => inputRef.current?.focus(), 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // close on outside click
  useEffect(() => {
    const onClick = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [])

  // recent list when opened with empty query
  useEffect(() => {
    if (open && !q) {
      fetchRecentTickers(8).then(setRecent).catch(() => setRecent([]))
    }
  }, [open, q])

  // debounced search
  useEffect(() => {
    setNotFound(false)
    if (!q) { setResults([]); return }
    clearTimeout(debounce.current)
    debounce.current = setTimeout(() => {
      searchTickers(q, 12)
        .then((r) => { setResults(r); setActive(0) })
        .catch(() => setResults([]))
    }, 130)
    return () => clearTimeout(debounce.current)
  }, [q])

  const choose = useCallback((sym) => {
    if (!sym) return
    selectTicker(sym)
    openTicker(sym)
    setOpen(false)
    setQ('')
    setResults([])
  }, [openTicker])

  // when no match, try a live lookup+add
  const tryLookup = useCallback(async () => {
    const sym = q.trim().toUpperCase()
    if (!sym) return
    setBusy(true); setNotFound(false)
    try {
      const row = await lookupTicker(sym)
      if (row?.symbol) choose(row.symbol)
      else setNotFound(true)
    } catch {
      setNotFound(true)
    } finally {
      setBusy(false)
    }
  }, [q, choose])

  const list = q ? results : recent

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, list.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') {
      if (list[active]) choose(list[active].symbol)
      else if (q.trim()) tryLookup()
    }
    else if (e.key === 'Escape') { setOpen(false) }
  }

  return (
    <div ref={boxRef} style={{ position: 'relative', width: 340 }}>
      <div
        onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 0) }}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          height: 30, padding: '0 10px',
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 4, cursor: 'text',
        }}
      >
        <SearchIcon />
        <input
          ref={inputRef}
          value={q}
          placeholder="Search ticker or company…"
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          style={{ flex: 1, fontSize: 12.5 }}
        />
        <kbd className="lbl-dim" style={{ border: '1px solid var(--border)', borderRadius: 3, padding: '1px 5px' }}>⌘K</kbd>
      </div>

      {open && (
        <div style={{
          position: 'absolute', top: 36, left: 0, right: 0, zIndex: 50,
          background: 'var(--surface)', border: '1px solid var(--border-strong)',
          borderRadius: 6, boxShadow: '0 8px 28px rgba(0,0,0,0.55)',
          maxHeight: 360, overflowY: 'auto', padding: 4,
        }}>
          {!q && recent.length > 0 && (
            <div className="lbl-dim" style={{ padding: '6px 10px 4px' }}>Recent</div>
          )}

          {list.map((t, i) => (
            <Row key={t.symbol} t={t} activeRow={i === active}
                 onHover={() => setActive(i)} onClick={() => choose(t.symbol)} />
          ))}

          {q && list.length === 0 && !busy && !notFound && (
            <div style={{ padding: '12px 10px', color: 'var(--text-muted)', fontSize: 12.5 }}>
              No match in universe — press Enter to look up
              <span className="num accent"> {q.toUpperCase()}</span> on yfinance.
            </div>
          )}
          {busy && <div style={{ padding: '12px 10px', color: 'var(--text-muted)' }}>Looking up…</div>}
          {notFound && (
            <div style={{ padding: '12px 10px', color: 'var(--bear)', fontSize: 12.5 }}>
              "{q.toUpperCase()}" not found on yfinance.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Row({ t, activeRow, onHover, onClick }) {
  return (
    <div
      onMouseEnter={onHover}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'baseline', gap: 10,
        padding: '7px 10px', borderRadius: 4, cursor: 'pointer',
        background: activeRow ? 'var(--elevated)' : 'transparent',
      }}
    >
      <span className="num" style={{ fontWeight: 600, minWidth: 64, color: 'var(--text)' }}>{t.symbol}</span>
      <span style={{ flex: 1, color: 'var(--text-muted)', fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
      <span className="lbl-dim">{t.sector}</span>
    </div>
  )
}

function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2">
      <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}
