# src/frontend/ — the web UI

Everything the browser renders. Client-facing React code only — **no file in
this tree may import server code by value** (type-only imports from
`@/backend/lib/mjengo` are fine and erased at compile time; the Prisma-touching
payload is fetched over HTTP).

```
src/frontend/
  ui/        # shadcn/ui primitives (button, dialog, table, sheet, command…) — the uikit
  mjengo/    # the app: shell, tabs, domain sections, dialogs, cmdk, nav meta
  auth/      # login screen + next-auth session provider
  i18n/      # English + Kiswahili dictionaries, provider, persisted locale store
  hooks/     # use-mjengo (payload facade + offline outbox), use-toast, use-mobile
  lib/       # client-safe helpers: utils.ts (cn), format.ts (KES / EAT dates)
  pwa/       # SW registration + the "app updated — reload" staleness cue (#148):
             # sw-update-watch.ts (dependency-injected, unit-tested) + sw-update-prompt.tsx
```

## The app shell and tabs

- `mjengo/app.tsx` — `MjengoApp`: auth gate, project bootstrap, tab
  registration, offline banner, share-link client mode, an ErrorBoundary keyed
  per active tab, the ⌘K command palette, and the mobile bottom nav mount.
  Mounted from `src/app/page.tsx` (the only route).
- `mjengo/header.tsx` — brand + summary, global search, notifications sheet,
  share/sync/data-saver chrome, sign-out, and the **desktop** role-filtered
  tab strip (`role="tablist"`).
- Tab surfaces: `overview-tab`, `site-plan-tab`, `materials-tab`, `fundis-tab`,
  `money-tab`, `evidence-tab`, `copilot-tab`, `land-tab`, `finder-tab`,
  `intel-tab`, `ussd-tab`, `audit-tab`, `settings-tab`, `welcome-screen`.
- `mjengo/nav/tab-meta.ts` — per-tab id → icon + i18n label keys (single source
  for both the desktop strip and the mobile bottom bar);
  `nav/use-tablist.ts` — roving-tabindex keyboard navigation.
- Domain sections live next to their tabs: `finder/sections/**` (search,
  dashboard, requests, invoices), `land/sections/**` (parcels, professionals),
  `intel/sections/**`, `overview/**` (role dashboards, activity timeline,
  budget variance drill-down).
- Dialogs: `expense-dialog`, `share-dialog`, `create-project-dialog`,
  `worker-dialogs`, finder/land section dialogs, `project-switcher`.

## UI-kit primitives

- `ui/**` — the stock shadcn/ui (New York) component set, themed via
  `src/app/globals.css` tokens. `components.json` aliases point here
  (`@/frontend/ui`, `@/frontend/lib/utils`, `@/frontend/hooks`) so the CLI
  keeps adding into the right places.
- `mjengo/uikit/` — app-level primitives: `EmptyState`, generic responsive
  `DataTable<T>` (desktop table ⇄ mobile stacked cards, skeletons, empty
  state), `ErrorBoundary` + `withErrorBoundary` HOC.

## Command palette (⌘K / Ctrl+K)

`mjengo/cmdk/command-palette.tsx` + `palette-store.ts` (transient zustand):
role-filtered tab navigation, project switching, quick actions that route to
the real controls (log expense → Overview, add task → Site Plan, take photo →
Copilot). Guarded against typing-in-input and open-dialog states.

## i18n

`i18n/` — `provider.tsx` (`useI18n`/`useT`, `{var}` interpolation), `store.ts`
(persisted `mjengo-os-settings` locale), `types.ts`, `dicts/en.ts` +
`dicts/sw.ts` (568 keys each, flat dot-notation), `dicts/check.ts`
(compile-time parity assert + dev runtime validation). The provider is
mounted once in `src/app/layout.tsx`.

## Client-side architecture: the payload facade + offline outbox

`hooks/use-mjengo.ts` is the single client state seam (zustand + persist):

- Loads the project list (`GET /api/projects`) and the **project payload**
  (`GET /api/project`) — one read model with slices (summary, phases, tasks,
  finance, escrow, evidence, audit events…), built server-side by
  `backend/lib/mjengo.ts`.
- `dispatch(action)` writes mutations into a **persisted offline outbox**
  (indexedDB record `mjengo-os-store` since #351 — localStorage before, with
  read-through adoption of the legacy key) with per-item sync lifecycle
  (pending → syncing → synced | failed | conflict) and conflict rules.
- The outbox drains via **`POST /api/sync`** — idempotent per item
  (`Idempotency-Key` + server-side dedupe), auto-drains on reconnect,
  manual retry only.
- Also owns view mode (owner vs client share-link) and low-data
  `DataMode` (`normal` | `data_saver`).
- `CLIENT_ACTIONS` (what a client-role user / share-link may do) is re-exported
  from `@/shared/client-actions` — the SAME list the server routes validate
  against.

`hooks/use-toast.ts` (shadcn toaster) and `hooks/use-mobile.ts`
(`useIsMobile`, < 768px) round out the hooks.

## lib helpers

`lib/utils.ts` — `cn()` (clsx + tailwind-merge), used by every shadcn
primitive. `lib/format.ts` — `formatKES`, `dateShort`, `timeEAT` (Kenya
locale formatters used across tabs).

## Rules

- Server truth lives in `src/backend/` — this tree mirrors it for UX only
  (role tab sets come from `src/shared/permissions.ts`, the mirror of
  `backend/lib/guard.ts`).
- The mobile bottom bar lives in `src/mobile/nav/` — see that folder's README.
