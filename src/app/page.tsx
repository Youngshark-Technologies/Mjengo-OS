'use client'

import { useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, HardHat } from 'lucide-react'
import LandingView from '@/components/marketing/landing-view'
import { AuthView } from '@/components/views/auth-view'
import { AppShell } from '@/components/app/app-shell'
import { Button } from '@/components/ui/button'
import { api, ApiClientError } from '@/lib/api-client'
import { getStartedHref } from '@/lib/app-url'
import { useAppStore, type AuthMode } from '@/lib/store'
import type { SessionUser } from '@/lib/types'

type MeResult = SessionUser | null

function BootSplash() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50" role="status" aria-label="Loading MjengoOS">
      <div className="flex flex-col items-center gap-4">
        <div className="rounded-xl bg-stone-950 p-3 shadow-lg">
          <HardHat className="h-8 w-8 text-amber-500" aria-hidden="true" />
        </div>
        <div className="h-1 w-24 overflow-hidden rounded-full bg-stone-200">
          <div className="h-full w-1/2 animate-pulse rounded-full bg-amber-500" />
        </div>
      </div>
    </div>
  )
}

// MJG-055 — shown when the boot call to /api/auth/me fails with anything
// other than 401 (network error, 5xx, timeout…). Same visual language as
// src/app/error.tsx; Retry re-runs the boot check via `me.refetch()`.
function BootErrorCard({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50 p-6" role="alert">
      <div className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-6 text-center shadow-sm sm:p-8">
        <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-stone-950">
          <AlertTriangle className="size-6 text-amber-500" aria-hidden="true" />
        </div>
        <h1 className="mt-4 text-xl font-semibold tracking-tight text-stone-900">
          Couldn't reach MjengoOS
        </h1>
        <p className="mt-2 text-sm text-stone-500">
          We couldn't verify your session. Check your connection and try again.
        </p>
        {message ? <p className="mt-2 text-xs text-stone-400">{message}</p> : null}
        <Button
          onClick={onRetry}
          className="mt-6 h-11 w-full bg-amber-500 text-stone-950 hover:bg-amber-600"
        >
          Retry
        </Button>
      </div>
    </div>
  )
}

function Root() {
  const queryClient = useQueryClient()
  const [showAuth, setShowAuth] = useState(false)
  const setAuthMode = useAppStore((s) => s.setAuthMode)

  // MJG-028 — deep links: /#get-started and /#signin open the auth view.
  // This makes NEXT_PUBLIC_APP_URL-driven CTAs (same or cross origin) land
  // directly on authentication instead of the marketing landing.
  // MJG-055 — the hash also carries mode intent: #get-started is a
  // registration CTA, so it opens the auth view in REGISTER mode; #signin is
  // a returning-user CTA, so it opens in LOGIN mode. Manual mode switching in
  // the auth view still works — the hash is cleared right after opening, so
  // it only seeds the initial mode.
  // Two paths: (1) mount with the hash already present (direct deep link /
  // cross-origin arrival), (2) same-page hash changes (the SPA does not
  // remount on hash navigation, so `hashchange` must be handled too).
  useEffect(() => {
    const openAuthFromHash = () => {
      const hash = window.location.hash
      const intent: AuthMode | null =
        hash === '#get-started' ? 'register' : hash === '#signin' ? 'login' : null
      if (!intent) return
      // Deferred (not synchronous) — opening auth is non-urgent and avoids
      // cascading renders on mount.
      const t = setTimeout(() => {
        setAuthMode(intent)
        setShowAuth(true)
        window.history.replaceState(null, '', window.location.pathname + window.location.search)
      }, 0)
      return () => clearTimeout(t)
    }
    const cleanupTimer = openAuthFromHash()
    window.addEventListener('hashchange', openAuthFromHash)
    return () => {
      cleanupTimer?.()
      window.removeEventListener('hashchange', openAuthFromHash)
    }
  }, [])

  const me = useQuery({
    queryKey: ['me'],
    queryFn: async (): Promise<MeResult> => {
      try {
        return await api.get<SessionUser>('/api/auth/me')
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 401) return null
        throw err
      }
    },
    staleTime: 60_000,
    retry: 1,
  })

  // MJG-055 — a 401 resolves to `null` (unauthenticated → landing/auth flow);
  // any other boot failure (network error, 5xx, timeout) lands in `me.isError`
  // and must offer a retry instead of stranding the user on the splash. While
  // a retry (manual or the built-in single automatic retry) is in flight the
  // splash shows again.
  const booting = me.isError ? me.isFetching : me.isLoading
  if (booting) return <BootSplash />
  if (me.isError) {
    return <BootErrorCard message={me.error.message} onRetry={() => void me.refetch()} />
  }

  const user = me.data ?? null

  if (user) {
    return (
      <AppShell
        user={user}
        onLogout={() => {
          setShowAuth(false)
          queryClient.setQueryData(['me'], null)
        }}
      />
    )
  }

  if (showAuth) {
    return (
      <AuthView
        onAuthed={() => {
          queryClient.invalidateQueries({ queryKey: ['me'] })
        }}
      />
    )
  }

  return (
    <LandingView
      onExplore={() => {
        document.getElementById('pillars')?.scrollIntoView({ behavior: 'smooth' })
      }}
      onGetStarted={() => setShowAuth(true)}
      getStartedHref={getStartedHref}
    />
  )
}

export default function Home() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { refetchOnWindowFocus: false, staleTime: 15_000 },
        },
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  )
}
