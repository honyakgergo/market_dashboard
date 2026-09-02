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

  // chart period for ticker detail
  period: '1y',
  setPeriod: (period) => set({ period }),

  // jump to ticker detail for a given symbol (used by search + heatmap clicks)
  openTicker: (symbol) =>
    set((s) => ({ ticker: (symbol || '').toUpperCase(), prevPage: s.page, page: PAGES.TICKER })),
}))
