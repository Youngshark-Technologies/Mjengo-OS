# MjengoOS — Hardcoded-Data Elimination Audit (MJG-011)

Date: 2026-10-17 · Scope: full `src/` tree (frontend views, API routes, lib), config, env.
Method: pattern sweep (`mock|fake|placeholder|sample|demo|lorem|TODO|FIXME|console.log`, fake metric literals, secret patterns) + manual review of every view's data source + runtime verification via browser E2E (MJG-012).

## Result: PASS — zero fabricated business data reachable from the UI

Every dashboard number, list, table, badge and activity-feed item is computed server-side
from the SQLite database (`/api/dashboard`, domain list endpoints) and scoped to the
authenticated organization. Refreshing with an empty database shows zeros and empty states,
never fabricated content.

## Findings & replacements

| # | Location | Issue class | Action taken | Verification |
|---|----------|-------------|--------------|--------------|
| 1 | `prisma/schema.prisma` (scaffold `User`/`Post` models) | Scaffold demo models unrelated to product | Replaced by 18-model construction domain (MJG-001); `db push` clean | `bunx prisma db push`; health endpoint |
| 2 | `src/app/page.tsx` (scaffold logo splash) | Placeholder page | Replaced by session-boot SPA: landing (hero) ↔ auth ↔ app shell, all data via API | Browser E2E (MJG-012) |
| 3 | `src/app/api/route.ts` ("Hello, world!") | Placeholder API response | Replaced by real health check: live DB ping, record counts, latency, 503 on DB failure | `curl /api` → 200 `{status:ok,database:connected}` |
| 4 | Dashboard metrics | N/A from scratch — built on real aggregates | `activeSites`, `stockValue = Σ qty×unitCost`, `pendingDeliveries`, `evidenceAwaiting`, `paymentsAwaiting`, `workforceToday`, `monthlySpend (APPROVED/PAID this month)`, `recent[]` merged from 5 real tables | Empty-org zeros + mutation-driven changes verified live |
| 5 | Inventory / deliveries / payments flows | Fake-success risk | Stock changes only via transactional `StockLevel` upsert + `StockMovement` ledger; delivery verification applies accepted quantities exactly once (idempotency guard); payment approval recorded with acting user + timestamp | Agent C live smoke: partial verify applied exactly 5+3; REJECTED applied 0 |
| 6 | Authentication | Fake-auth risk | scrypt password hashing, opaque DB-backed session tokens, httpOnly cookie, expiry cleanup, 401 without enumeration; role checks server-side on every gated endpoint | Agent A live E2E: 9 curl scenarios |
| 7 | `src/components/views/*` | Mock-array risk | All views fetch via TanStack Query from the API; loading/error/empty states everywhere; no static business arrays (grep: `MOCK_│FAKE_│DEMO_│SAMPLE_` = 0 hits) | Grep sweep + browser E2E |
| 8 | Secrets | Committed-credential risk | `.env` contains only `DATABASE_URL` (local SQLite path); no API keys/tokens in repo or code; password fields only ever hashed | Secret-pattern grep = 0 findings |

## Legitimate constants retained (documented, not data)

- UI labels, nav items, enum unions (`src/lib/types.ts` — validated by zod at the API boundary), route names, status→color badge maps, empty-state copy.
- Marketing copy (`src/components/marketing/*`) — static brand content by design.
- Form input placeholders ("e.g. 0722 000 000") — input hints, not stored data.

## Known scaffold artifacts (documented, accepted)

- `examples/`, `skills/` folders and 4 pre-existing tsc errors in them — platform sandbox artifacts outside the application build; untouched.
- `db/custom.db` is a tracked local SQLite runtime file (scaffold convention). Untracking it was rejected: the sandbox git daemon force-checks-out `main` and a tracked→untracked transition risks deleting the live database file. The production deployment path builds from source (`bun run build`) and initializes its own database; this file is dev-runtime only.
- No automatic seed/demo data exists anywhere: a fresh database boots to correct zeros/empty states; organizations are created through real registration only.
