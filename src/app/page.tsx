'use client'

import { useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { HardHat } from 'lucide-react'
import LandingView from '@/components/marketing/landing-view'
import { AuthView } from '@/components/views/auth-view'
import { AppShell } from '@/components/app/app-shell'
import { api, ApiClientError } from '@/lib/api-client'
import { getStartedHref } from '@/lib/app-url'
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

function Root() {
  const queryClient = useQueryClient()
  const [showAuth, setShowAuth] = useState(false)

  // MJG-028 — deep links: /#get-started and /#signin open the auth view.
  // This makes NEXT_PUBLIC_APP_URL-driven CTAs (same or cross origin) land
  // directly on authentication instead of the marketing landing.
  // Two paths: (1) mount with the hash already present (direct deep link /
  // cross-origin arrival), (2) same-page hash changes (the SPA does not
  // remount on hash navigation, so `hashchange` must be handled too).
  useEffect(() => {
    const openAuthFromHash = () => {
      if (window.location.hash !== '#get-started' && window.location.hash !== '#signin') return
      // Deferred (not synchronous) — opening auth is non-urgent and avoids
      // cascading renders on mount.
      const t = setTimeout(() => {
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

  if (me.isLoading || me.isError) return <BootSplash />

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
