# src/shared/ — isomorphic contracts

Code that is **safe to import from both server and client** and exists so the
two sides share ONE source of truth instead of drifting copies:

```
src/shared/
  permissions.ts       # role → tab matrix (client UX mirror of guard.ts)
  client-actions.ts    # the CLIENT_ACTIONS allowlist (route + store share it)
  ids.ts               # CSPRNG id/reference generation (MD-4 — both sides mint ids)
```

## permissions.ts — the role matrix

- `ALL_TABS` (canonical tab universe + order), `ROLE_TABS` / `tabsForRole()`
  (which tabs each role sees), `OWNER_ROLES`, `KNOWN_ROLES`, `ROLE_LABELS`,
  `landingForRole()`, `usePermissions()` (reads the next-auth session).
- **Mirror, not enforcement**: server truth is `src/backend/lib/guard.ts`
  (per-route `withGuard` allowlists). Keep the two in sync in the same commit;
  unknown roles fail closed everywhere (one safe tab — Overview).
- Note: this file currently carries `'use client'` + `useSession` because
  every consumer so far is a client component (`header`, `app`,
  `command-palette`, `mobile/nav/mobile-bottom-nav`, audit/settings/overview
  tabs). The pure constants (`ALL_TABS`, `ROLE_TABS`, `ROLE_LABELS`, …) are
  isomorphic and server-importable; only the `usePermissions` hook needs a
  session context.

## client-actions.ts — the client-role action allowlist

`CLIENT_ACTIONS`: the actions a client-role user (and the share-link client
surface) may perform. Imported by BOTH sides of the wire — the server routes
`src/app/api/actions` + `src/app/api/sync` validate against it, and
`src/frontend/hooks/use-mjengo.ts` re-exports it for the client store. Type-only
dependency on `@/backend/lib/mjengo` (`ActionType`), so nothing server-side
ever reaches a client bundle.

## ids.ts — the CSPRNG id/reference seam (register MD-4, issue #350)

Every user-visible id and reference in the app draws from ONE isomorphic
CSPRNG seam (`crypto.getRandomValues` — a global in browsers, Node ≥ 19 and
Bun, so server routes and client components run the same single code path;
no `node:crypto` import that would break the client bundle). Consumers:
escrow top-up / invoice-payment auto references
(`autoPaymentReference()` → `MPESA-7XK2P4QA` style, the no-confusables
alphabet), simulated-rail receipts (`randomReferenceSuffix()`), the offline
outbox uid suffix (`randomChars()` + `BASE36_CHARSET`), and registry search
refs (`randomIntInclusive()` → `CS/YYYY/NNNNNN`, format preserved).
Rejection sampling keeps every draw uniform; if the runtime has no CSPRNG
the helpers THROW — there is deliberately no Math.random fallback (a
silently guessable money reference is worse than a loud error). Pinned by
`tests/unit/csprng-ids.test.ts` (format/charset/uniqueness, the rejection
mechanism against a stubbed getRandomValues, and a repo-wide
no-`Math.random(`-in-`src/` sweep).

## Rules for adding files here

A file belongs in `shared/` only if BOTH server and client code import it (or
it is a pure constant contract with zero runtime dependencies on either side).
Client-only helpers go to `src/frontend/`, server-only code to `src/backend/`.
