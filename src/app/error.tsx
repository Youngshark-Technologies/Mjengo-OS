'use client'

// MJG-049 — route-level error boundary. Catches unhandled render/runtime
// errors in the page tree and offers a client-side retry instead of the
// default Next crash page. The app is a single page (SPA), so a root-level
// boundary is the right scope.

import { useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'

import { Button } from '@/components/ui/button'

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  // Surface the failure for client-side diagnostics (digest links it to
  // server logs when one exists).
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50 p-6">
      <div className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-6 text-center shadow-sm sm:p-8">
        <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-stone-950">
          <AlertTriangle className="size-6 text-amber-500" aria-hidden="true" />
        </div>
        <h1 className="mt-4 text-xl font-semibold tracking-tight text-stone-900">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm text-stone-500">
          An unexpected error interrupted this view. Your data is safe — try again.
        </p>
        {error.digest ? (
          <p className="mt-2 text-xs text-stone-400">Error ID: {error.digest}</p>
        ) : null}
        <Button
          onClick={reset}
          className="mt-6 h-11 w-full bg-amber-500 text-stone-950 hover:bg-amber-600"
        >
          Retry
        </Button>
        <p className="mt-4 text-sm text-stone-500">
          or{' '}
          <a href="/" className="font-medium text-amber-700 underline-offset-4 hover:underline">
            go back home
          </a>
        </p>
      </div>
    </div>
  )
}
