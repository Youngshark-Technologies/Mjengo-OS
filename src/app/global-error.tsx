'use client'

// MJG-049 — global error boundary. Next.js renders this file INSTEAD of the
// root layout when the app shell itself throws, so it must ship its own
// <html>/<body> (Next.js requirement) and cannot rely on globals.css/Tailwind
// — the design tokens (stone-50 background, stone-900 text, amber-500 accent,
// rounded-2xl card on border-stone-200) are mirrored with inline styles.

import { useEffect } from 'react'

export default function GlobalError({
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
    <html lang="en">
      <body
        style={{
          margin: 0,
          backgroundColor: '#fafaf9',
          color: '#1c1917',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        }}
      >
        <style>{`
          #global-error-retry:hover { background-color: #d97706; }
          #global-error-home:hover { text-decoration: underline; }
        `}</style>
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1.5rem',
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: '28rem',
              borderRadius: '1rem',
              border: '1px solid #e7e5e4',
              backgroundColor: '#ffffff',
              padding: '2rem',
              textAlign: 'center',
              boxShadow: '0 1px 2px rgb(0 0 0 / 0.05)',
            }}
          >
            <div
              aria-hidden="true"
              style={{
                margin: '0 auto',
                display: 'flex',
                height: '3rem',
                width: '3rem',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '0.75rem',
                backgroundColor: '#0c0a09',
                color: '#f59e0b',
                fontSize: '1.25rem',
                fontWeight: 700,
              }}
            >
              !
            </div>
            <h1
              style={{
                marginTop: '1rem',
                fontSize: '1.25rem',
                fontWeight: 600,
                letterSpacing: '-0.025em',
                color: '#1c1917',
              }}
            >
              Something went wrong
            </h1>
            <p style={{ marginTop: '0.5rem', fontSize: '0.875rem', lineHeight: 1.5, color: '#78716c' }}>
              A critical error interrupted MjengoOS. Your data is safe — try again.
            </p>
            {error.digest ? (
              <p style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: '#a8a29e' }}>
                Error ID: {error.digest}
              </p>
            ) : null}
            <button
              id="global-error-retry"
              type="button"
              onClick={reset}
              style={{
                marginTop: '1.5rem',
                height: '2.75rem',
                width: '100%',
                cursor: 'pointer',
                borderRadius: '0.75rem',
                border: 'none',
                backgroundColor: '#f59e0b',
                color: '#0c0a09',
                fontSize: '0.875rem',
                fontWeight: 600,
              }}
            >
              Retry
            </button>
            <p style={{ marginTop: '1rem', fontSize: '0.875rem', color: '#78716c' }}>
              or{' '}
              <a
                id="global-error-home"
                href="/"
                style={{ color: '#b45309', fontWeight: 500, textDecoration: 'none' }}
              >
                go back home
              </a>
            </p>
          </div>
        </div>
      </body>
    </html>
  )
}
