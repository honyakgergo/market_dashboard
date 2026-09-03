// ============================================================
// store/useStore.js — global UI state (zustand)
// ============================================================

import { create } from 'zustand'

export const PAGES = {
  OVERVIEW: 'overview',
  IDEAS: 'ideas',
  ETF: 'etf',
  MACRO: 'macro',
  VOL: 'vol',
  EUROPE: 'europe',
  COMMOD: 'commod',
  POS: 'positioning',
  NEWS: 'news',
  TICKER: 'ticker',
}

export const useStore = create((set) => ({
  // which surface is showing
  page: PAGES.OVERVIEW,
  prevPage: null,
  setPage: (page) => set((s) => ({ prevPage: s.page, page })),
  back: () => set((s) => ({ page: (s.prevPage && s.prevPage !== s.page) ? s.prevPage : PAGES.OVERVIEW })),

  // the ticker the detail page is focused on
  ticker: 'SPY',
  setTicker: (ticker) => set({ ticker: (ticker || '').toUpperCase() }),

  // NOTE: there is deliberately no chart-period state here any more. The daily
  // chart loads a ticker's full history once and the period buttons only move
  // the visible window, so the framing is local view state on the chart — not
  // something the rest of the app needs to know about.

  // jump to ticker detail for a given symbol (used by search + heatmap clicks)
  openTicker: (symbol) =>
    set((s) => ({ ticker: (symbol || '').toUpperCase(), prevPage: s.page, page: PAGES.TICKER })),
}))
