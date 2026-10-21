// MJG-028 — public app origin for the marketing CTAs.
// Set NEXT_PUBLIC_APP_URL (e.g. https://mjengoupdate.vercel.app) to make the
// landing-page CTAs navigate to the app; the app opens its auth view when it
// receives the #get-started / #signin deep-link hashes (src/app/page.tsx).
// Empty/undefined keeps the historical in-page auth behavior (sandbox default).
export const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '')

export const getStartedHref = APP_URL ? `${APP_URL}/#get-started` : null
export const signInHref = APP_URL ? `${APP_URL}/#signin` : null
