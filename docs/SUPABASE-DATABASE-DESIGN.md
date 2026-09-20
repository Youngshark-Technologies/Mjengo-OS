# Mjengo-OS — Supabase Database Design (Target State)

**Issue:** #95 · **ADR:** [0002](adr/0002-supabase-database.md) · **Status:** Approved design (no runtime cutover)
**Artifacts:** [`supabase/migrations/0001_schema.sql`](../supabase/migrations/0001_schema.sql) (68 tables) · [`0002_rls.sql`](../supabase/migrations/0002_rls.sql) (RLS + integrity triggers) · [`0003_platform.sql`](../supabase/migrations/0003_platform.sql) (storage, realtime, pg_cron)
**Contract tests:** [`tests/unit/supabase-design.test.ts`](../tests/unit/supabase-design.test.ts)

This document defines how the Mjengo-OS database **should be** on Supabase,
derived 1:1 from the shipped Prisma/SQLite model (v0.2.5, 68 models) and the
audited authorization posture (`guard.ts`, `scope.ts`, `permissions.ts`).
It is the reference for the Phase-1 cutover and the Phase-2 Supabase Auth
adoption. Nothing here changes the running dev app (still SQLite).

---

## 1. Why this design exists

SQLite carried the project through six build waves and 1,645 tests, but paying
users require: managed backups/PITR, a DB-enforced tenancy layer under the API
guard (defense in depth — the same principle the audits pinned for the
frontend), pooled connections, object storage with signed URLs, realtime
notification fan-out, and a cron story without bespoke systemd units.
Supabase provides all of it on plain PostgreSQL, which keeps the Prisma data
model and the entire service layer portable. See ADR 0002 for the option
comparison and the phased decision.

## 2. Adoption phases (what actually changes, when)

| | Phase 1 — Managed Postgres | Phase 2 — Supabase Auth + RLS-first |
|---|---|---|
| **Database** | `prisma/schema.prisma` switches `provider = "postgresql"` (+ `@map` snake_case annotations); `DATABASE_URL` → Supabase pooler (pgbouncer, transaction mode) | unchanged |
| **Identity** | NextAuth v4 credentials (unchanged) — `public.users` lives in Postgres | Supabase Auth + `public.profiles` + custom access token hook; `public.users` retired after cutover |
| **Enforcement** | `guard.ts` (unchanged authority); app connects via the service-level role which **bypasses RLS by design** — RLS protects PostgREST/analytics/direct paths | RLS becomes the row-tenancy layer for PostgREST/supabase-js traffic; API keeps action authorization |
| **Storage** | `lib/storage` s3-compat driver → Supabase S3-compatible endpoint | same |
| **Jobs** | pg_cron ticks `POST /api/jobs/run` (bearer token, fail-closed, unchanged) | same |
| **Realtime** | optional: notifications via Realtime instead of polling | same |

The split is deliberate and honest: **RLS answers "which rows"; the API
answers "which actions."** Duplicating the full action matrix in RLS would
create a second, drift-prone source of truth. RLS write grants are therefore
never *narrower* than the API allows (that would break legitimate actions)
but may be broader (the API still refuses the action).

## 3. Mapping rules (Prisma/SQLite → PostgreSQL)

Binding for every future schema change — the contract tests pin them:

| Prisma | PostgreSQL | Notes |
|---|---|---|
| `String @id @default(cuid())` | `text primary key` | App-supplied cuid. UUIDs were considered and rejected: the offline-sync, outbox and idempotency layers key on these strings byte-for-byte. |
| camelCase model name | snake_case **plural** table | Supabase community convention (auth.users, storage.objects). Collective-noun exceptions: `ProjectTeam → project_team`, `ProjectHealth → project_health`. Column exception: `Phase.order → order_index` (`order` is a reserved word). The full mapping is pinned test-side — a rename on either side fails CI. |
| `Float` money | `numeric(18,2)` | KES exact decimal. Fixes the Float-money defect class at the boundary (migration coercion §11). |
| `Float` quantities | `numeric(18,3)` | Fractional site quantities (2.5 bags) without binary drift. |
| `Float` lat/lng | `double precision` | Geographic, not money. |
| `DateTime` | `timestamptz` | All timestamps zone-aware. `Attendance.date` stays `text` (YYYY-MM-DD site-local day — a calendar date, not a moment). |
| JSON-in-string columns | `jsonb` | `evidence`, `skills`, `override_log`, `findings`, `components`, `items`, `dimensions`, `payload`, `notification_prefs`, `extracted_json`, … |
| Status ladder comments | `text` + `CHECK` | Additive wave evolution without `ALTER TYPE` ceremony — the house rule for additive migrations maps directly. |
| `@updatedAt` | trigger `touch_updated_at()` | DB-owned once Prisma is not the only writer (18 tables wired). |
| relations | FKs with the exact Prisma `onDelete` (Cascade/SetNull/Restrict) | Plain-scalar columns in Prisma stay plain here (`users.project_id`, `users.supplier_id`, `milestones.phase_id`, `variation_orders.phase_id`, `inventory_items.material_id`, `inventory_items.supplier_id`, `escrow_wallets.ledger_account_id`, `payment_requests.paid_txn_id`, `transactions.ledger_txn_id`, `draw_packs.ledger_txn_id`, `photo_hashes.*`, `ai_insights.pack_id`) — the app treats a dangling id as fail-closed, not an integrity error. |
| uniques | `unique` constraints/indexes | `projects.share_token`, `escrow_wallets.project_id`, `draw_packs.milestone_id`, `delivery_photos(delivery_id, attachment_id)`, `inventory_items(project_id, material_name, location)`, `saved_suppliers(project_id, supplier_id)`, `push_subscriptions.endpoint`, `users.email` (citext), `ledger_accounts.code`, `ledger_transactions.ref`, `ledger_transactions.idempotency_key`, `idempotency_records.key`, `wallet_accounts.code`, `feature_flags.key`, `photo_hashes.photo_id` |

**Deliberate additions over strict Prisma parity** (each one is a
strengthening, documented, and tested):

1. **FK indexes on every FK column** — SQLite never had them; Postgres joins
   require them (hot paths get composites: attendance day views, transaction
   date ordering, latest-N digest/score reads).
2. **Non-negative CHECKs** on money/quantity columns (`budget`, `amount`,
   `wage`, `daily_rate`, `stock_qty`, …); `> 0` where zero is nonsensical
   (`ledger_entries.amount`, `milestones.amount`, `payment_requests.amount`).
3. **Monotonic version guards** on `tasks.version` / `attendances.version`
   (offline-sync contract: a stale write can never roll a row back).
4. **Ledger self-FK** `ledger_transactions.reversal_of_id` (Prisma kept it as
   a plain column; money-grade referential integrity is worth the FK) with a
   **UNIQUE index** — one reversal per original (#133 / DB-11).
5. **Append-only immutability triggers** + **balanced-legs deferred constraint**;
   `ledger_transactions` is INSERT/SELECT-only like `ledger_entries`
   (#133: reversals are new rows linked via `reversal_of_id`, "was reversed?"
   is derived from the link — there is no reversal-marking update to guard).

## 4. Tenancy model (what RLS encodes)

Mirrors the shipped authorization semantics exactly:

- **Staff band** (`contractor, admin, supervisor, procurement, qs, finance` =
  `OWNER_ROLES`): all projects — matches today's webapp behavior.
  *Known follow-up:* a `project_members` table to tighten staff scoping is
  deliberately NOT designed in (no behavioral change in this wave).
- **Client pin:** a client-role session sees exactly its pinned project
  (`users.project_id` today, `profiles.pinned_project_id` + JWT claim in
  Phase 2). Every project-tenanted policy funnels through
  `can_read_project()` / `can_write_project()` — the RLS twin of
  `v1/scope.ts clientClientProjectPin`.
- **Supplier pin:** a supplier-role session is pinned to its Supplier row;
  project-scoped buyer rows are invisible (the `supplierProjectDeny` twin).
  Suppliers see/write **their own** `suppliers`, `catalog_items`, `quotes`,
  `purchase_orders`, `order_deliveries` (+lines/photos), `invoices` — the
  supplier-portal surface, nothing else.
- **Admin-only surfaces:** `audit_events` reads (mirrors the audit tab),
  `feature_flags` writes (mirrors `api/flags.ts` POST allowlist).
- **anon:** nothing (revoked table privileges + zero policies).
- **service_role / table owner:** bypasses RLS by design — that IS the
  Phase-1 Prisma path and the jobs/notify/drains service path. Triggers
  (immutability, ledger guards) still fire for it — see §5.

Unknown/missing roles fail **closed** everywhere (`is_staff()` on an empty
claim returns false, same as `guard.ts`/`permissions.ts`).

## 5. Money & trust invariants (DB-enforced, not just service-enforced)

These fire for **every** principal including the service role:

1. **Σ debits = Σ credits per ledger transaction** — deferred constraint
   trigger on `ledger_entries`, checked at COMMIT. The service already
   validates balanced legs; the DB now guarantees it survives every writer.
2. **Ledger transactions are INSERT/SELECT-only** (#133 / DB-11) — reversals
   are NEW rows linked via `reversal_of_id` ("was reversed?" is derived from
   the link, never stamped); every UPDATE is rejected and `reversal_of_id`
   is UNIQUE, so at most one reversal can point at any original. (The SQLite
   twin keeps ONE legal update — the pending→posted posting transition that
   carries its balance gate; Postgres defers that check to COMMIT, so it
   needs no transition.)
3. **Append-only tables** (UPDATE/DELETE rejected unless the explicit
   maintenance GUC §9 is set): `audit_events`, `mjengo_scores`,
   `risk_assessments`, `intel_digests`, `project_health`, `draw_packs`,
   `photo_hashes`, `ai_review_notes`, `ai_insights`, `trust_digests`,
   `stock_movements`, `ledger_entries`, `ledger_transactions`,
   `idempotency_records`, `credential_checks`, `price_points`. These tables
   also carry **INSERT+SELECT policies only** — no update/delete policies
   exist at all.
   *Deliberate deviation (loud):* today a project DELETE cascades these away
   silently. Under the target design that cascade fails unless ops sets
   `mjengo.allow_maintenance` — money-grade audit history must not vanish as
   a side effect of a project delete.
4. **Escrow balance ≥ 0** — belt-and-braces for the projection (the ledger
   remains the source of truth; balances always derive from entries).
5. **Idempotency replay guard** rows are insert-only (a replay never mutates
   the recorded response).

## 6. RLS policy matrix (per-table summary)

Full SQL in `0002_rls.sql`. Symbols: S=select I=insert U=update D=delete;
**staff** = staff band; **client** = own pinned project; **supplier** = own
supplier rows; **admin** = admin only; — = no policy (denied).

| Table(s) | S | I | U | D |
|---|---|---|---|---|
| `projects` | can_read | staff | can_write | staff |
| `phases`, `site_photos`, `alerts`, `milestones`, `variation_orders`, `photo_comments`, `project_team`, `land_parcels`, `title_searches`, `material_requests`, `approval_rules`, `payment_requests`, `inventory_items`, `boqs` | can_read | can_write | can_write | staff |
| `tasks` (via phase), `parcel_documents`, `parcel_assignments`, `boq_lines`, `material_request_lines` (via request) | parent-tenancy | parent-write | parent-write / — | staff |
| `workers`, `attendances`, `deliveries`, `consumptions`, `transactions`, `recaps` | can_read | can_write | can_write / — | staff |
| `site_zones` | can_read | can_write | can_write | staff |
| `audit_events` | **admin** | staff | — | — |
| `escrow_wallets` | can_read | staff | staff | staff |
| `notifications` | null+staff or can_read | null+staff or can_write | null+staff or can_write | staff |
| `users` (Phase-1 store) | staff | staff | staff | staff |
| `push_subscriptions` | owner or staff | owner or staff | owner or staff | owner or staff |
| `suppliers` | staff, client, own | staff | staff or own | staff |
| `catalog_items` | staff, client, own | staff or own | staff or own | staff |
| `quotes` (+`quote_lines`) | buyer-tenant or own | own or buyer-write | own or buyer-write | staff |
| `purchase_orders` (+lines) | can_read or own | can_write | can_write or own | staff |
| `order_deliveries` (+lines, `delivery_photos`) | PO-tenant or PO-supplier | PO-write | PO-tenant or PO-supplier | staff |
| `invoices` (+lines) | can_read or own | own or can_write | own or can_write | staff |
| `materials`, `professionals`, `price_points`, `credential_checks` (S) | authenticated | staff | — (append) | — |
| `risk_assessments`, `mjengo_scores`, `intel_digests`, `project_health`, `draw_packs`, `photo_hashes`, `ai_review_notes`, `ai_insights`, `trust_digests`, `stock_movements`, `ledger_entries`, `idempotency_records` | can_read / staff (null-project) | staff / can_write (stock) | — | — |
| `ledger_accounts` | null+staff or can_read | staff | staff / — | staff / — |
| `ledger_transactions` | null+staff or can_read | staff | — (append-only, #133: reversals are new rows via reversal_of_id) / — | — |
| `wallet_accounts`, `job_records`, `domain_events` | staff | staff | staff | staff |
| `feature_flags` | admin+contractor | admin | admin | admin |
| `saved_suppliers`, `approvals`, `consumptions` | can_read | can_write | — | staff |
| `profiles` (Phase 2) | self or staff | staff (+signup trigger) | self-limited or staff (role columns staff-only via trigger) | staff |

## 7. Storage design

| Bucket | Visibility | Layout | Write | Read |
|---|---|---|---|---|
| `site-photos` | **public** | `{project_id}/…` | staff; client into own folder | public URL (share links keep working — today's posture) |
| `documents` | **private** | `{project_id}/…` | staff; client into own folder | policy-gated + service-minted signed URLs |

- **Review item S-1:** public site photos are the current product posture
  (share links). Hardening to signed URLs changes share-link behavior → a
  product decision, tracked, not silently migrated.
- 10 MB photo / 20 MB document caps (`file_size_limit`) mirror the upload
  route's 12 MB raw-body cap family.
- The existing `lib/storage` driver abstraction (local-disk ↔ s3-compat)
  maps 1:1; the s3-compat driver speaks the Supabase S3 gateway.

## 8. Realtime

`notifications` (live badge/toast fan-out — kills the polling loop) and
`domain_events` (ops visibility into §59 event chains) join the
`supabase_realtime` publication with `replica identity full`. Realtime
filters through RLS per subscriber, so a client socket only ever receives
its own project's notification events.

## 9. Ops runbook (maintenance GUC + jobs)

- **Archival/destructive maintenance** (project purges, GDPR-style deletes):
  `begin; set local mjengo.allow_maintenance = 'on'; … commit;` — this is the
  ONLY door past the immutability triggers (§5.3). It is a session GUC: it
  never leaks into normal request traffic, and every use should be a logged
  ops event.
- **Jobs drain:** pg_cron ticks every 5 min → `net.http_post` to the app's
  `POST /api/jobs/run` with the bearer token from Supabase Vault
  (`mjengo_jobs_run_token` + `mjengo_app_url`). The schedule no-ops with a
  notice until both secrets exist — **no host or token is ever embedded in
  SQL**. The drain logic, its timeout wrap, and the fail-closed bearer guard
  stay in the app (unchanged audited code).
- **Backups:** Supabase daily backups + PITR (7-day on standard tier) — the
  operational reason for this whole migration. Monthly `pg_dump` to object
  storage as an exit-grade copy.

## 10. Review items & non-goals (honest ledger)

1. `purchase_orders.order_code`, `invoices.invoice_code`,
   `material_requests.request_code`, `payment_requests.request_code` are
   **not** unique (Prisma parity). Promoting them needs a data audit first —
   follow-up issue when onboarding real data.
2. `order_deliveries.photo_urls` is a superseded legacy JSONB column (kept
   for row compatibility; nothing reads it).
3. Staff role band is org-wide (matches today). A `project_members`
   scoping table is the designed follow-up when multi-team usage appears.
4. Multi-org/tenant verticalization (org_id on every table) is **out of
   scope** — this design keeps single-org deployment semantics and documents
   the seam (the RLS helper functions are the single choke point to thread
   an org claim through later).
5. `Attendance.date` as text YYYY-MM-DD is preserved (site-local calendar
   semantics — converting to a date column is a nicety, not a correctness
   fix; Kenya has no DST and the app formats site-locally).
6. Public site-photos bucket = today's share-link posture (review item S-1).

## 11. Migration plan (SQLite → Supabase)

1. **Freeze:** stop writers, note the SQLite file hash, keep it read-only.
2. **Provision:** fresh Supabase project (region: eu-central-1 or closest to
   the pilot cohort; Nairobi users' latency is dominated by the app edge,
   not the DB region — measure before choosing).
3. **Apply platform layer:** `0001 → 0002 → 0003` (this repo, in order).
4. **ETL:** pgloader or a scripted COPY pipeline with explicit coercions:
   `Float → numeric` (money cast through `round(value, 2)`, quantities
   `round(value, 3)`), JSON strings → `jsonb` (invalid JSON rows are FATAL —
   counted, listed, fixed at source, never silently dropped), `DateTime` →
   `timestamptz` (SQLite stores UTC ISO strings; parse as UTC).
   IDs copy verbatim (text cuid — no rekeying).
5. **Verify (blocking gates):** per-table row counts equal; per-table
   checksum (`md5(string_agg(id, ',' order by id))`) equal; ledger balance
   re-check (Σdebits = Σcredits per txn — the new deferred trigger runs on
   any fixups); spot-check the seeded demo accounts.
6. **Cutover:** flip `DATABASE_URL` (one env var), smoke `/api/health` +
   login + one money action, watch dev.log equivalent for the first hour.
7. **Rollback:** the SQLite file is frozen read-only — flipping the env var
   back is the entire rollback. Data written to Postgres after cutover is
   re-exportable via `pg_dump --data-only` per table (ids are stable text).
   RPO = cutover instant (freeze point), RTO = minutes (env flip).

## 12. Definition of done for this design (tested)

`tests/unit/supabase-design.test.ts` pins, structurally, from the SQL files:

- all 68 Prisma models have a `create table` in `0001_schema.sql` (parsed
  live from `prisma/schema.prisma` — the design cannot drift from the model);
- RLS is enabled and ≥1 policy exists for every one of the 69 tables
  (68 + `profiles`);
- every money column is `numeric(18,2)`, quantities `numeric(18,3)`;
- every timestamp is `timestamptz` (zero bare `timestamp`);
- every FK column is covered by an explicit index (PK/unique/index scan);
- append-only tables have no update/delete policies AND immutability
  triggers wired;
- the balanced-legs constraint trigger exists and `reversal_of_id` is
  UNIQUE (one reversal per original — #133);
- snake_case naming + no secrets in SQL.

Live validation against a real Supabase project (apply → `supabase db lint`
→ row-count parity) happens at Phase-1 cutover time, not in this design PR.

---

*Everything in this file is backed by runnable SQL in `supabase/migrations/`
and pinned by tests. When the schema evolves, the Prisma model and the
Supabase layer must move in the same PR — the contract test enforces the
1:1 table mapping.*
