'use client'

import { useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { HardHat } from 'lucide-react'
import LandingView from '@/components/marketing/landing-view'
import { AuthView } from '@/components/views/auth-view'
import { AppShell } from '@/components/app/app-shell'
import { api, ApiClientError } from '@/lib/api-client'
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
