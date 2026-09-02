// ============================================================
// components/ui.jsx — small shared primitives + data hook
// ============================================================

import React, { useEffect, useState, useCallback, useRef } from 'react'
import { fetchSession } from '../api/client'

// ── Panel ────────────────────────────────────────────────────
export function Panel({ title, right, children, style, bodyStyle }) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 6, display: 'flex', flexDirection: 'column', minHeight: 0, ...style,
    }}>
      {(title || right) && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '9px 12px', borderBottom: '1px solid var(--border)',
        }}>
          <span className="lbl">{title}</span>
          {right}
        </div>
      )}
      <div style={{ padding: 12, flex: 1, minHeight: 0, ...bodyStyle }}>{children}</div>
    </div>
  )
}

// ── Pill ─────────────────────────────────────────────────────
export function Pill({ tone = 'flat', children }) {
  const map = {
    bull: ['var(--bull-wash)', 'var(--bull)'],
    bear: ['var(--bear-wash)', 'var(--bear)'],
    side: ['var(--side-wash)', 'var(--side)'],
    flat: ['var(--elevated)', 'var(--text-muted)'],
    accent: ['rgba(41,98,255,0.12)', 'var(--accent)'],
  }
  const [bg, fg] = map[tone] || map.flat
  return (
    <span className="num" style={{
      background: bg, color: fg, padding: '2px 8px', borderRadius: 4,
      fontSize: 11, fontWeight: 600, letterSpacing: '0.02em',
    }}>{children}</span>
  )
}

// ── Loading / error / empty states ───────────────────────────
export function StateView({ loading, error, empty, emptyHint, children }) {
  if (loading) return <Centered><span className="pulse lbl">Loading…</span></Centered>
  if (error) {
    const pending = error?.response?.status === 404
    return (
      <Centered>
        <div style={{ textAlign: 'center', maxWidth: 420 }}>
          <div className="lbl" style={{ color: pending ? 'var(--side)' : 'var(--bear)' }}>
            {pending ? 'Endpoint pending' : 'Request failed'}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12.5, marginTop: 8, lineHeight: 1.5 }}>
            {pending
              ? 'This surface lights up once its backend endpoint is implemented.'
              : (error?.message || 'Something went wrong.')}
          </div>
        </div>
      </Centered>
    )
  }
  if (empty) return <Centered><span className="lbl-dim">{emptyHint || 'No data'}</span></Centered>
  return children
}

function Centered({ children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: 160 }}>
      {children}
    </div>
  )
}

export const fmtPct = (x, d = 2) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`)
export function useFetch(fn, deps = []) {
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)

  const run = useCallback(() => {
    let alive = true
    setLoading(true); setError(null)
    fn()
      .then((d) => { if (alive) setData(d) })
      .catch((e) => { if (alive) setError(e) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(run, [run])
  return { data, loading, error, reload: run }
}

// ── number formatting ────────────────────────────────────────
export const fmtPctU = (x, d = 2) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`)  // unsigned
export const fmtNum = (x, d = 2) => (x == null ? '—' : Number(x).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }))
export const toneOf = (x) => (x == null ? 'flat' : x > 0 ? 'bull' : x < 0 ? 'bear' : 'flat')

// ── Market session (EU/US clock) ─────────────────────────────
// Polls /session so live pages know whether to auto-refresh and what
// freshness banner to show. Cheap; one poll per minute is plenty.
export function useSession(pollMs = 60000) {
  const [session, setSession] = useState(null)
  useEffect(() => {
    let alive = true
    const load = () => fetchSession().then((s) => { if (alive) setSession(s) }).catch(() => {})
    load()
    const id = setInterval(load, pollMs)
    return () => { alive = false; clearInterval(id) }
  }, [pollMs])
  return session
}

// Calls `reload` every `intervalMs` while `active` is true. Silent when
// inactive (e.g. market closed) so we never hammer yfinance overnight.
export function useAutoRefresh(reload, active, intervalMs = 90000) {
  const saved = useRef(reload)
  useEffect(() => { saved.current = reload }, [reload])
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => saved.current && saved.current(), intervalMs)
    return () => clearInterval(id)
  }, [active, intervalMs])
}

const PHASE_LABEL = {
  overnight: 'Markets closed',
  eu_only: 'EU open · US pre-market',
  overlap: 'EU + US open',
  us_only: 'US open · EU closed',
}

// Small freshness strip for live pages. `market` ('us'|'eu') decides whether
// this page's data is live right now; pass it to colour the dot correctly.
export function SessionBanner({ session, market = 'us', note }) {
  if (!session) return null
  const live = market === 'us' ? session.us_open : session.eu_open
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 2px 0' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
        background: live ? 'var(--bull)' : 'var(--text-dim)', boxShadow: live ? '0 0 8px var(--bull)' : 'none' }} />
      <span className="lbl">{PHASE_LABEL[session.phase] || session.phase}</span>
      <span className="lbl-dim">· {session.now_cet} CET</span>
      <span className="num lbl-dim" style={{ marginLeft: 'auto' }}>
        {live ? (note || 'live · 15-min delayed') : 'last close'}
      </span>
    </div>
  )
}
