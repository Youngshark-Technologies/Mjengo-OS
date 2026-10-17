'use client'

import { create } from 'zustand'

export type ViewKey =
  | 'dashboard'
  | 'sites'
  | 'inventory'
  | 'procurement'
  | 'deliveries'
  | 'workforce'
  | 'evidence'
  | 'payments'

export type AuthMode = 'login' | 'register'

interface AppState {
  view: ViewKey
  setView: (view: ViewKey) => void
  authMode: AuthMode
  setAuthMode: (mode: AuthMode) => void
}

export const useAppStore = create<AppState>((set) => ({
  view: 'dashboard',
  setView: (view) => set({ view }),
  authMode: 'login',
  setAuthMode: (authMode) => set({ authMode }),
}))
