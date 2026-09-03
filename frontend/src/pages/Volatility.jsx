// ============================================================
// pages/Volatility.jsx
// The vol cockpit, organised around one idea: a vol level means nothing on
// its own. VIX 18 is calm in 2022 and a warning in 2017. So every gauge here
// shows where it sits in its OWN last year — a percentile bar under the
// number — and the page opens with a plain-English verdict assembled from
// those percentiles rather than from any single reading.
//
// Layout, top to bottom:
//   1  regime verdict + the signals behind it
//   2  gauge strip: VIX / term slope / VVIX / VVIX-VIX / SKEW / VRP,
//      each with its percentile rail
//   3  term structure curve + the VIX/VIX3M ratio over time (the single best
//      stress signal there is: above 1 = backwardation = something is wrong)
//   4  implied vs realized — the realized-vol CONE and the VRP series
//   5  cross-index vol and the spreads (who is leading the stress)
//   6  dispersion & correlation, incl. single-name IV vs the index
// ============================================================

import React, { useEffect, useRef } from 'react'
import Plotly from 'plotly.js-dist-min'
import { fetchVol, fetchVolSingleName } from '../api/client'
import { useFetch, StateView, Panel, Pill, fmtNum, fmtPct, useSession, useAutoRefresh, SessionBanner } from '../components/ui'

const C = {
  vix: '#d1d4dc', vxn: '#2962ff', rvx: '#ff6d00',
  vvix: '#9575cd', skew: '#ff8a65', vrp: '#26a69a',
  rv: '#ef5350', ratio: '#26a69a',
  grid: '#1f2430', sep: '#2a2e39', text: '#787b86', dim: '#5a5d68',
  bull: '#26a69a', bear: '#ef5350', side: '#e0a23a',
}

const TONE = { bull: 'var(--bull)', bear: 'var(--bear)', side: 'var(--side)', flat: 'var(--text)' }

export default function Volatility() {
  const { data, loading, error, reload } = useFetch(fetchVol, [])
  const session = useSession()
  useAutoRefresh(reload, session?.us_open, 90000)

  // Loaded separately: it needs an option chain per name and takes seconds.
  const sn = useFetch(fetchVolSingleName, [])

  const term = data?.term
  const cross = data?.cross

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: '100%' }}>
        <SessionBanner session={session} market="us" note="live · vol complex" />
        <StateView loading={loading} error={error} empty={!loading && !error && !data}>
          {data && (
            <>
              <RegimeBar regime={data.regime} asOf={data.as_of} />

              {/* ── gauge strip ── */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10 }}>
                <Gauge label="VIX" g={data.vix} hint="30-day implied vol, S&P 500" digits={2} />
                <Gauge label="Term slope" g={term?.slope} digits={2}
                       hint={term?.contango == null ? '' : term.contango ? 'VIX3M − VIX · contango' : 'VIX3M − VIX · BACKWARDATED'}
                       forceTone={term?.contango == null ? null : term.contango ? 'bull' : 'bear'} />
                <Gauge label="VVIX" g={data.vvix} hint="vol-of-vol · tail-hedge demand" digits={1} />
                <Gauge label="VVIX / VIX" g={data.vvix_vix} hint="price of convexity" digits={2} />
                <Gauge label="SKEW" g={data.skew} hint="cost of downside vs upside" digits={1} />
                <Gauge label="VRP" g={data.vrp} digits={2} signed
                       hint={data.vrp?.level == null ? '' : data.vrp.level >= 0 ? 'implied rich vs realized' : 'realized ABOVE implied'}
                       forceTone={data.vrp?.level == null ? null : data.vrp.level >= 0 ? 'bull' : 'bear'} />
              </div>

              {/* ── term structure ── */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.35fr', gap: 10 }}>
                <Panel
                  title="Term structure"
                  right={term?.contango != null &&
                    <Pill tone={term.contango ? 'bull' : 'bear'}>{term.contango ? 'CONTANGO' : 'BACKWARDATION'}</Pill>}
                  bodyStyle={{ padding: 6 }}
                >
                  <TermCurve curve={term?.curve} contango={term?.contango} />
                  <div className="lbl-dim" style={{ padding: '2px 6px 0', lineHeight: 1.45, textTransform: 'none', letterSpacing: 0, fontSize: 10.5 }}>
                    Upward slope (contango) is the normal, calm state — far-dated vol costs more than near-dated.
                    An inverted curve means the market wants protection <em>now</em>, and it is the most reliable
                    single tell that a drawdown is under way rather than over.
                  </div>
                </Panel>

                <Panel
                  title="VIX / VIX3M · the stress switch"
                  right={<PctBadge ctx={term?.vix_vix3m} digits={3} />}
                  bodyStyle={{ padding: 6 }}
                >
                  {term?.vix_vix3m ? (
                    <>
                      <LineChart height={210} series={[{
                        name: 'VIX / VIX3M', x: term.vix_vix3m.history.dates, y: term.vix_vix3m.history.values,
                        color: C.ratio, width: 1.6,
                      }]} hlines={[{ y: 1, color: C.bear, dash: 'dash', label: 'backwardation above' }]} />
                      <div style={{ display: 'flex', gap: 20, padding: '4px 6px 0', flexWrap: 'wrap' }}>
                        <MiniStat label="now" value={fmtNum(term.vix_vix3m.level, 3)}
                                  tone={term.vix_vix3m.level > 1 ? 'bear' : 'bull'} />
                        <MiniStat label="1y percentile" value={pctText(term.vix_vix3m.pctile)} />
                        <MiniStat label="backwardated days / 60" value={term.days_backwardated_60 ?? '—'}
                                  tone={term.days_backwardated_60 > 5 ? 'bear' : 'flat'} />
                        <MiniStat label="VIX9D / VIX" value={fmtNum(term.vix9d_vix?.level, 3)}
                                  tone={term.vix9d_vix?.level > 1 ? 'bear' : 'flat'} />
                      </div>
                    </>
                  ) : <Note msg="VIX3M unavailable via the feed" />}
                </Panel>
              </div>

              {/* ── implied vs realized ── */}
              <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 10 }}>
                <Panel title="Realized-vol cone · SPY" right={<span className="lbl-dim">3y percentile bands</span>} bodyStyle={{ padding: 6 }}>
                  {data.rv_cone ? <VolCone cone={data.rv_cone} implied={data.vix?.level} />
                                : <Note msg="cone unavailable" />}
                  <div className="lbl-dim" style={{ padding: '2px 6px 0', lineHeight: 1.45, textTransform: 'none', letterSpacing: 0, fontSize: 10.5 }}>
                    Each band is where realized vol has spent 10–90% of the last three years at that horizon.
                    The dot is today. Above the band = the index really is moving unusually for that window;
                    inside it = whatever the headlines say, this is ordinary.
                  </div>
                </Panel>

                <Panel title="Variance risk premium · VIX − SPY realized (21d)"
                       right={<PctBadge ctx={data.vrp} digits={2} />} bodyStyle={{ padding: 6 }}>
                  {data.vrp?.history ? (
                    <>
                      <LineChart height={210} series={[{
                        name: 'VRP', x: data.vrp.history.dates, y: data.vrp.history.values,
                        color: C.vrp, width: 1.6, fillZero: true,
                      }]} hlines={[{ y: 0, color: C.sep, dash: 'dot' }]} />
                      <div style={{ display: 'flex', gap: 20, padding: '4px 6px 0', flexWrap: 'wrap' }}>
                        <MiniStat label="implied" value={fmtNum(data.vrp.implied, 2)} />
                        <MiniStat label="realized 21d" value={fmtNum(data.vrp.realized_21d, 2)} />
                        <MiniStat label="ratio" value={fmtNum(data.vrp.ratio, 2)} />
                        <MiniStat label="premium" value={signed(data.vrp.level, 2)}
                                  tone={data.vrp.level >= 0 ? 'bull' : 'bear'} />
                      </div>
                    </>
                  ) : <Note msg="VRP unavailable" />}
                  <div className="lbl-dim" style={{ padding: '4px 6px 0', lineHeight: 1.45, textTransform: 'none', letterSpacing: 0, fontSize: 10.5 }}>
                    Positive = options price more movement than the index delivered; this is the edge systematic
                    vol sellers harvest. It goes sharply negative in a shock — which is precisely when that trade
                    stops working.
                  </div>
                </Panel>
              </div>

              {/* ── cross-index ── */}
              <Panel
                title="Cross-index implied vol · who is leading the stress"
                right={<span className="num lbl-dim">
                  VIX {fmtNum(cross?.levels?.vix, 1)} · VXN {fmtNum(cross?.levels?.vxn, 1)}
                  {cross?.rvx_is_proxy ? ' · RVX (IWM realized proxy)' : ` · RVX ${fmtNum(cross?.levels?.rvx, 1)}`}
                </span>}
                bodyStyle={{ padding: 6 }}
              >
                {cross ? (
                  <>
                    <LineChart height={250} yTitle="vol pts" series={[
                      { name: 'VIX · S&P 500', x: cross.dates, y: cross.vix, color: C.vix, width: 1.8 },
                      { name: 'VXN · Nasdaq 100', x: cross.dates, y: cross.vxn, color: C.vxn, width: 1.4 },
                      { name: cross.rvx_is_proxy ? 'RVX · IWM realized proxy' : 'RVX · Russell 2000',
                        x: cross.dates, y: cross.rvx, color: C.rvx, width: 1.4, dash: cross.rvx_is_proxy ? 'dot' : 'solid' },
                    ]} />
                    <div style={{ display: 'flex', gap: 26, padding: '6px 6px 0', flexWrap: 'wrap' }}>
                      <SpreadStat label="VXN − VIX" sub="tech premium" s={cross.spread_vxn_vix} />
                      <SpreadStat label="RVX − VIX" sub="small-cap / breadth premium" s={cross.spread_rvx_vix} />
                      <span className="lbl-dim" style={{ lineHeight: 1.45, textTransform: 'none', letterSpacing: 0, fontSize: 10.5, maxWidth: 480 }}>
                        Above zero, that index is more feared than the S&P. Tech-led stress and breadth-led stress
                        are different problems and tend to resolve differently.
                      </span>
                    </div>
                  </>
                ) : <Note msg="cross-index history unavailable" />}
              </Panel>

              {/* ── dispersion ── */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.25fr', gap: 10 }}>
                <Correlation d={data.dispersion} />
                <SingleName sn={sn} />
              </div>
            </>
          )}
        </StateView>
      </div>
    </div>
  )
}

// ── regime verdict ───────────────────────────────────────────
function RegimeBar({ regime, asOf }) {
  if (!regime) return null
  return (
    <Panel bodyStyle={{ padding: '11px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div className="lbl">Vol regime</div>
          <div className="num" style={{ fontSize: 22, fontWeight: 600, color: TONE[regime.tone] || 'var(--text)', marginTop: 2 }}>
            {(regime.label || '').toUpperCase()}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 260, display: 'flex', flexWrap: 'wrap', gap: '3px 14px' }}>
          {(regime.signals || []).map((s, i) => (
            <span key={i} className="lbl-dim" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 11 }}>· {s}</span>
          ))}
        </div>
        <span className="num lbl-dim">{asOf}</span>
      </div>
    </Panel>
  )
}

// ── gauge with a percentile rail ─────────────────────────────
// The rail is the point of this component: it turns "SKEW is 148" into
// "SKEW is higher than it has been 82% of the last year".
function Gauge({ label, g, hint, digits = 2, signed: isSigned = false, forceTone = null }) {
  if (!g) {
    return (
      <Panel bodyStyle={{ padding: '10px 12px' }}>
        <div className="lbl">{label}</div>
        <div className="num" style={{ fontSize: 20, color: 'var(--text-dim)', marginTop: 3 }}>—</div>
        <div className="lbl-dim" style={{ marginTop: 2 }}>unavailable</div>
      </Panel>
    )
  }
  const p = g.pctile
  const tone = forceTone || (p == null ? 'flat' : p >= 0.8 ? 'bear' : p <= 0.2 ? 'bull' : 'flat')
  const chgTone = g.chg == null ? 'flat' : g.chg > 0 ? 'bear' : g.chg < 0 ? 'bull' : 'flat'
  return (
    <Panel bodyStyle={{ padding: '10px 12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="lbl">{label}</span>
        {g.chg != null && (
          <span className="num" style={{ fontSize: 10, color: TONE[chgTone] }}>
            {g.chg >= 0 ? '+' : ''}{Number(g.chg).toFixed(digits)}
          </span>
        )}
      </div>
      <div className="num" style={{ fontSize: 20, fontWeight: 600, color: TONE[tone], marginTop: 2 }}>
        {isSigned ? signed(g.level, digits) : fmtNum(g.level, digits)}
      </div>
      <PctRail pctile={p} />
      <div className="lbl-dim" style={{ marginTop: 3, textTransform: 'none', letterSpacing: 0, fontSize: 10 }}>
        {p != null ? `${Math.round(p * 100)}th pctile · 1y ${fmtNum(g.min_52w, digits)}–${fmtNum(g.max_52w, digits)}` : (hint || '')}
      </div>
      {p != null && hint ? (
        <div className="lbl-dim" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 10 }}>{hint}</div>
      ) : null}
    </Panel>
  )
}

function PctRail({ pctile }) {
  if (pctile == null) return <div style={{ height: 4, marginTop: 7 }} />
  const pos = Math.max(1.5, Math.min(98.5, pctile * 100))
  return (
    <div style={{ position: 'relative', height: 4, borderRadius: 2, marginTop: 7,
      background: 'linear-gradient(90deg, rgba(38,166,154,0.55) 0%, rgba(122,134,153,0.35) 50%, rgba(239,83,80,0.55) 100%)' }}>
      <div style={{ position: 'absolute', left: `${pos}%`, top: -3, transform: 'translateX(-50%)',
        width: 2, height: 10, background: 'var(--text)', borderRadius: 1 }} />
    </div>
  )
}

function PctBadge({ ctx, digits = 2 }) {
  if (!ctx) return null
  return (
    <span className="num lbl-dim">
      {fmtNum(ctx.level, digits)}
      {ctx.pctile != null && ` · ${Math.round(ctx.pctile * 100)}th pctile`}
      {ctx.z != null && ` · ${ctx.z >= 0 ? '+' : ''}${ctx.z}σ`}
    </span>
  )
}

// ── term-structure curve ─────────────────────────────────────
function TermCurve({ curve, contango }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current || !curve?.length) return
    const col = contango ? C.bull : C.bear
    const trace = {
      type: 'scatter', mode: 'lines+markers+text',
      x: curve.map((p) => p.dtm), y: curve.map((p) => p.level),
      text: curve.map((p) => `${p.label}  ${p.level}`), textposition: 'top center',
      textfont: { size: 10, color: '#d1d4dc' },
      line: { color: col, width: 2.4, shape: 'spline', smoothing: 0.5 },
      marker: { size: 9, color: col, line: { color: '#131722', width: 1.5 } },
      hovertemplate: '%{text}<extra></extra>',
    }
    const layout = {
      margin: { l: 38, r: 16, t: 24, b: 34 }, paper_bgcolor: 'transparent',
      plot_bgcolor: contango ? 'rgba(38,166,154,0.035)' : 'rgba(239,83,80,0.045)',
      font: { family: 'IBM Plex Mono, monospace', size: 9, color: C.text }, showlegend: false,
      xaxis: { title: { text: 'days to maturity', font: { size: 9 } }, gridcolor: C.grid,
               tickvals: curve.map((p) => p.dtm), ticktext: curve.map((p) => p.label) },
      yaxis: { gridcolor: C.grid, side: 'right' },
    }
    Plotly.react(ref.current, [trace], layout, { responsive: true, displayModeBar: false })
  }, [curve, contango])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])
  if (!curve?.length) return <Note msg="term-structure tickers unavailable via the feed" />
  return <div ref={ref} style={{ width: '100%', height: 216 }} />
}

// ── realized-vol cone ────────────────────────────────────────
function VolCone({ cone, implied }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current || !cone?.bands?.length) return
    const x = cone.bands.map((b) => b.window)
    const y = (key) => cone.bands.map((b) => b[key])
    const band = (key, color, dash = 'dot', fill) => ({
      type: 'scatter', mode: 'lines', x, y: y(key),
      line: { color, width: 1, dash }, name: key,
      fill, fillcolor: fill ? 'rgba(122,134,153,0.13)' : undefined,
      hovertemplate: `${key} %{y:.1f}<extra></extra>`, showlegend: false,
    })
    // Plotly's `tonexty` fills to the PREVIOUS trace, so the order here is the
    // shading. p10 first, then p90 filling back to it, paints the whole 10–90
    // envelope; the naive p90→p75→p50→p25→p10 ordering instead shades a
    // 75-to-90 wedge and leaves the actual cone empty.
    const traces = [
      band('p10', 'rgba(122,134,153,0.45)'),
      band('p90', 'rgba(122,134,153,0.45)', 'dot', 'tonexty'),
      band('p25', 'rgba(122,134,153,0.35)'),
      band('p75', 'rgba(122,134,153,0.35)', 'dot', 'tonexty'),
      band('p50', 'rgba(209,212,220,0.7)', 'dash'),
      {
        type: 'scatter', mode: 'lines+markers', x,
        y: cone.current.map((c) => c.level), name: 'today',
        line: { color: C.rv, width: 2.4 },
        marker: { size: 9, color: C.rv, line: { color: '#131722', width: 1.5 } },
        hovertemplate: '%{x}d realized %{y:.1f}<extra></extra>', showlegend: false,
      },
    ]
    if (implied != null) {
      traces.push({
        type: 'scatter', mode: 'lines', x: [x[0], x[x.length - 1]], y: [implied, implied],
        line: { color: C.vix, width: 1.4, dash: 'dash' },
        hovertemplate: `VIX ${implied}<extra></extra>`, showlegend: false,
      })
    }
    const layout = {
      margin: { l: 40, r: 14, t: 10, b: 32 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 9, color: C.text }, showlegend: false,
      hovermode: 'x unified',
      hoverlabel: { bgcolor: '#1e222d', bordercolor: C.sep, font: { family: 'IBM Plex Mono, monospace', size: 10, color: '#d1d4dc' } },
      xaxis: { gridcolor: C.grid, tickvals: x, ticktext: x.map((w) => `${w}d`),
               title: { text: 'lookback window', font: { size: 9 } } },
      yaxis: { gridcolor: C.grid, side: 'right', title: { text: 'annualized vol %', font: { size: 9 } } },
      annotations: implied != null ? [{
        x: x[x.length - 1], y: implied, text: 'VIX', showarrow: false,
        xanchor: 'right', yanchor: 'bottom', font: { size: 9, color: C.vix },
      }] : [],
    }
    Plotly.react(ref.current, traces, layout, { responsive: true, displayModeBar: false })
  }, [cone, implied])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])
  return <div ref={ref} style={{ width: '100%', height: 226 }} />
}

// ── generic multi-line time chart ────────────────────────────
function LineChart({ series, height = 240, yTitle, hlines = [] }) {
  const ref = useRef(null)
  useEffect(() => {
    const clean = (series || []).filter((s) => s && s.x?.length && s.y?.some((v) => v != null))
    if (!ref.current || !clean.length) return
    const traces = clean.map((s) => ({
      type: 'scatter', mode: 'lines', x: s.x, y: s.y, name: s.name,
      line: { color: s.color, width: s.width || 1.5, dash: s.dash || 'solid' },
      connectgaps: true, hovertemplate: `${s.name}  %{y:.2f}<extra></extra>`,
    }))
    const shapes = hlines.map((h) => ({
      type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: h.y, y1: h.y,
      line: { color: h.color || C.sep, width: 1, dash: h.dash || 'dot' },
    }))
    const layout = {
      margin: { l: 44, r: 14, t: clean.length > 1 ? 22 : 8, b: 26 },
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      font: { family: 'IBM Plex Mono, monospace', size: 9, color: C.text },
      showlegend: clean.length > 1,
      legend: { orientation: 'h', y: 1.16, x: 0, font: { size: 9.5 }, bgcolor: 'transparent' },
      hovermode: 'x unified',
      hoverlabel: { bgcolor: '#1e222d', bordercolor: C.sep, font: { family: 'IBM Plex Mono, monospace', size: 10, color: '#d1d4dc' } },
      xaxis: { gridcolor: C.grid, showspikes: true, spikecolor: '#4a4f5c', spikethickness: 1, spikedash: 'solid', spikemode: 'across', spikesnap: 'cursor' },
      yaxis: { gridcolor: C.grid, side: 'right', title: yTitle ? { text: yTitle, font: { size: 9 } } : undefined },
      shapes,
    }
    Plotly.react(ref.current, traces, layout, { responsive: true, displayModeBar: false })
  }, [series, yTitle, hlines])
  useEffect(() => { const el = ref.current; return () => { if (el) Plotly.purge(el) } }, [])
  return <div ref={ref} style={{ width: '100%', height }} />
}

// ── correlation / dispersion ─────────────────────────────────
function Correlation({ d }) {
  const r = d?.realized
  const corr = d?.corr_used
  const state = d?.state
  const pos = corr == null ? 50 : Math.max(0, Math.min(1, corr)) * 100
  const stateTone = state === 'tightening' ? 'bear' : state === 'broadening' ? 'bull' : 'side'
  return (
    <Panel title="Correlation & dispersion · realized">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {d?.corr_history ? (
          <LineChart height={150} series={[{
            name: 'avg pairwise corr', x: d.corr_history.dates, y: d.corr_history.values,
            color: C.vvix, width: 1.6,
          }]} hlines={[{ y: 0.55, color: C.bear, dash: 'dot' }, { y: 0.35, color: C.bull, dash: 'dot' }]} />
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {state && <Pill tone={stateTone}>{state.toUpperCase()}</Pill>}
          <span className="lbl-dim">avg pairwise correlation {corr != null ? corr.toFixed(2) : '—'}</span>
        </div>

        <div>
          <div style={{ position: 'relative', height: 8, borderRadius: 4,
            background: 'linear-gradient(90deg, var(--bull) 0%, var(--side) 50%, var(--bear) 100%)', opacity: 0.8 }}>
            <div style={{ position: 'absolute', left: `${pos}%`, top: -3, transform: 'translateX(-50%)', width: 3, height: 14, background: 'var(--text)', borderRadius: 1 }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
            <span className="lbl-dim">broadening · stock picking works</span>
            <span className="lbl-dim">tightening · one macro trade</span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <MiniStat label="Realized dispersion" value={r ? `${(r.dispersion * 100).toFixed(1)}%` : '—'} />
          <MiniStat label="Basket" value={r ? `${r.n} names · ${r.window}d` : '—'} />
          {r?.best && <MiniStat label="Best" value={`${r.best.symbol} ${fmtPct(r.best.ret, 1)}`} tone="bull" />}
          {r?.worst && <MiniStat label="Worst" value={`${r.worst.symbol} ${fmtPct(r.worst.ret, 1)}`} tone="bear" />}
        </div>

        {d?.dspx?.level != null && (
          <div style={{ borderTop: '1px solid var(--hairline)', paddingTop: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span className="lbl">DSPX · Cboe dispersion index</span>
              <PctBadge ctx={d.dspx} digits={2} />
            </div>
          </div>
        )}

        <div className="lbl-dim" style={{ lineHeight: 1.45, textTransform: 'none', letterSpacing: 0, fontSize: 10.5 }}>
          Correlation toward 1 means everything is moving together and index hedges work but stock selection does
          not. Toward 0, index vol stays low while individual names still swing — the tape rewards picking.
        </div>
      </div>
    </Panel>
  )
}

// ── single-name IV vs the index ──────────────────────────────
function SingleName({ sn }) {
  const d = sn?.data
  return (
    <Panel
      title="Single-name IV vs the index · dispersion"
      right={d?.as_of ? <span className="num lbl-dim">{d.as_of}</span> : null}
    >
      {sn?.loading ? (
        <div className="lbl-dim pulse" style={{ padding: 8 }}>
          loading option chains — one per name, this takes a few seconds…
        </div>
      ) : sn?.error || !d?.index ? (
        <Note msg="option chains unavailable right now (Yahoo throttles this) — reload in a minute" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <MiniStat label={`${d.index.symbol} ATM IV`} value={`${fmtNum(d.index.iv, 1)}%`} />
            <MiniStat label="avg single-name IV" value={`${fmtNum(d.avg_name_iv, 1)}%`} />
            <MiniStat label="dispersion ratio" value={fmtNum(d.dispersion_ratio, 2)}
                      tone={d.dispersion_ratio > 1.35 ? 'bull' : d.dispersion_ratio < 1.1 ? 'bear' : 'flat'} />
            <MiniStat label="implied corr (proxy)" value={d.implied_corr_proxy != null ? d.implied_corr_proxy.toFixed(2) : '—'}
                      tone={d.implied_corr_proxy > 0.55 ? 'bear' : d.implied_corr_proxy < 0.35 ? 'bull' : 'flat'} />
          </div>

          <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: 'var(--mono)', fontSize: 11.5 }}>
            <thead>
              <tr>
                {['Name', 'ATM IV', 'RV 21d', 'IV − RV', '25Δ skew'].map((h, i) => (
                  <th key={h} className="lbl" style={{ textAlign: i ? 'right' : 'left', padding: '3px 6px', color: 'var(--text-dim)', fontWeight: 500 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderTop: '1px solid var(--border)' }}>
                <IvRow row={d.index} bold />
              </tr>
              {(d.names || []).map((r) => (
                <tr key={r.symbol} style={{ borderTop: '1px solid var(--hairline)' }}>
                  <IvRow row={r} />
                </tr>
              ))}
            </tbody>
          </table>

          <div className="lbl-dim" style={{ lineHeight: 1.45, textTransform: 'none', letterSpacing: 0, fontSize: 10.5 }}>
            <strong>IV − RV</strong> is each name's own variance premium: positive means its options are priced above
            how much the stock has actually been moving. The <strong>dispersion ratio</strong> is average single-name
            IV over index IV — high means the market expects the members to move a lot while the index does not, i.e.
            to move in <em>different directions</em>. {d.note}
          </div>
        </div>
      )}
    </Panel>
  )
}

function IvRow({ row, bold }) {
  const w = bold ? 600 : 400
  const d = row.iv_minus_rv
  return (
    <>
      <td style={{ padding: '4px 6px', fontWeight: w, color: bold ? 'var(--text)' : 'var(--text-muted)' }}>{row.symbol}</td>
      <td style={{ padding: '4px 6px', textAlign: 'right', fontWeight: w }}>{fmtNum(row.iv, 1)}</td>
      <td style={{ padding: '4px 6px', textAlign: 'right', color: 'var(--text-muted)' }}>{fmtNum(row.rv_21d, 1)}</td>
      <td style={{ padding: '4px 6px', textAlign: 'right', color: d == null ? 'var(--text-dim)' : d >= 0 ? 'var(--bull)' : 'var(--bear)' }}>
        {signed(d, 1)}
      </td>
      <td style={{ padding: '4px 6px', textAlign: 'right', color: 'var(--text-muted)' }}>{signed(row.skew_25d, 1)}</td>
    </>
  )
}

// ── small pieces ─────────────────────────────────────────────
function MiniStat({ label, value, tone = 'flat' }) {
  return (
    <div>
      <div className="lbl">{label}</div>
      <div className="num" style={{ fontSize: 13.5, marginTop: 2, color: TONE[tone] }}>{value}</div>
    </div>
  )
}

function SpreadStat({ label, sub, s }) {
  if (!s) return null
  const tone = s.last > 0 ? 'bear' : 'bull'
  return (
    <div>
      <div className="lbl">{label}</div>
      <div className="num" style={{ fontSize: 14, marginTop: 2, color: TONE[tone] }}>
        {signed(s.last, 2)}
        {s.pctile != null && <span className="lbl-dim" style={{ marginLeft: 7 }}>{Math.round(s.pctile * 100)}th</span>}
      </div>
      <div className="lbl-dim" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 10 }}>{sub}</div>
    </div>
  )
}

function Note({ msg }) { return <div className="lbl-dim" style={{ padding: 12 }}>{msg}</div> }

const signed = (x, d = 2) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${Number(x).toFixed(d)}`)
const pctText = (p) => (p == null ? '—' : `${Math.round(p * 100)}th`)
