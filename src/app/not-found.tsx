// MJG-049 — root-level 404. Renders inside the root layout, so the Tailwind
// design tokens are available. Simple styled page with a link home.

import { HardHat } from 'lucide-react'

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50 p-6">
      <div className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-6 text-center shadow-sm sm:p-8">
        <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-stone-950">
          <HardHat className="size-6 text-amber-500" aria-hidden="true" />
        </div>
        <h1 className="mt-4 text-xl font-semibold tracking-tight text-stone-900">Page not found</h1>
        <p className="mt-2 text-sm text-stone-500">
          The page you're looking for doesn't exist or may have moved.
        </p>
        <p className="mt-6 text-sm text-stone-500">
          <a href="/" className="font-medium text-amber-700 underline-offset-4 hover:underline">
            Go back home
          </a>
        </p>
      </div>
    </div>
  )
}
