# Database & Data-Integrity Baseline Audit (Phase 0.7)

- **Auditor:** Task 2-d — Database/Data-Integrity Baseline Lead (re-audit, from scratch)
- **Date:** 2026-09-16
- **Repo state:** `main @ 8b0003a` (clean tree)
- **Scope:** `prisma/schema.prisma` (68 models), `prisma/migrations/0..9`, `prisma/seed*`, `src/backend` (ledger/wallet/inventory/invoices/sync/audit), `supabase/migrations/0001–0003`, `docs/SUPABASE-DATABASE-DESIGN.md`, ADR 0002
- **Method:** READ-ONLY research. No DB created, no prisma commands, no installs. Evidence = file:line + model names. A scripted column-level cross-check of schema.prisma vs the concatenated migration DDL was run offline (text parsing only).
- **Prior claims under test:** "no migration drift", "wallet idempotency via natural keys", "derived closing stock", "68-model schema", "68-table DDL / 69-table RLS matrix".

---

## 1. Prisma schema census — 68 models, 0 enums

`prisma/schema.prisma` (1,353 lines): **68 `model` blocks, zero `enum` blocks** — every status/role/ladder is a free-text `String` with a comment listing legal values (e.g. `Milestone.status` L323, `Invoice.status` L872, `User.role` L441). No CHECK constraints exist on the SQLite side. The Supabase design adds `CHECK`s for these ladders (`0001_schema.sql` L48-49, L130-133, …).

### Domain map (model counts per domain)

| Domain | Models | Evidence (schema.prisma lines) |
|---|---|---|
| Projects / phases / tasks / milestones / variations | 6 | `Project` 10, `Phase` 79, `Task` 98, `Milestone` 316, `VariationOrder` 337, `DrawPack` 366 (evidence pack, milestone-frozen) |
| Workers / attendance / payroll | 2 | `Worker` 128, `Attendance` 151 (`wage`, `paid`, `version`) |
| Materials / supply / RFQ / quotes / POs / deliveries | 13 | `Material` 180, `Delivery` 189, `Consumption` 205, `Supplier` 607, `CatalogItem` 635, `MaterialRequest` 653, `MaterialRequestLine` 669, `ApprovalRule` 680, `Approval` 696, `Quote` 712, `QuoteLine` 735, `PurchaseOrder` 747, `PurchaseOrderLine` 770 |
| Order deliveries (physical) | 3 | `OrderDelivery` 784, `OrderDeliveryLine` 821, `DeliveryPhoto` 844 |
| Wallet / accounts / ledger / payments | 6 | `LedgerAccount` 962, `LedgerTransaction` 980, `LedgerEntry` 998, `IdempotencyRecord` 1012, `WalletAccount` 1023, `PaymentRequest` 1038 (+ `EscrowWallet` 306 projection, counted under projects; `Transaction` 245 legacy journal) |
| Invoices | 2 | `Invoice` 863, `InvoiceLine` 892 |
| Inventory / BOQ | 3 | `InventoryItem` 1065, `StockMovement` 1085, `Boq` 1102 (+ `BoqLine` 1114) |
| Land / parcels / professionals | 7 | `LandParcel` 502, `ParcelDocument` 523, `TitleSearch` 538, `Professional` 557, `CredentialCheck` 578, `ParcelAssignment` 589, `ProjectTeam` 484 |
| Evidence / photos / zones / alerts | 6 | `SitePhoto` 218, `PhotoComment` 390, `SiteZone` 404, `Alert` 233, `Attachment` 1142, `PhotoHash` 1280 |
| Intel / score / flags / health | 7 | `RiskAssessment` 906, `MjengoScore` 923, `IntelDigest` 936, `PricePoint` 947, `FeatureFlag` 1213, `ProjectHealth` 1223, `AiInsight` 1301 |
| Notifications / push | 2 | `Notification` 417, `PushSubscription` 469 |
| Sync / events / jobs / versions | 4 | `Task.version` 125 & `Attendance.version` 177 (outbox conflict metadata — there is NO Outbox table; the outbox is client-side, applied via `/api/sync`), `DomainEvent` 1177, `JobRecord` 1190 |
| AI insights / reviews / digests | 3 | `AiReviewNote` 1250, `TrustDigest` 1336, (AiInsight counted under intel) |
| Users / sessions | 1 | `User` 436 (NextAuth credentials; sessions are JWT, not DB rows) |
| Share tokens | 1 | `Project.shareToken` 12 `@unique @default(cuid())` |
| Trust extras | 3 | `Recap` 270, `SavedSupplier` 1127, `AuditEvent` 283 |

Total = 68 (matches prior QA claim).

---

## 2. Invariant verdicts

### 2.1 FINANCIAL — "the ledger never lies": **PARTIAL — service-level only on SQLite; Float money**

> **UPDATE (2026-09-19, task 4-c / #124):** DB-3 is now CLOSED on the SQLite
> path — migration `14_ledger_invariants` ports the Supabase semantics:
> Σdebits = Σcredits asserted by the `LedgerTransaction_posting_gate`
> trigger at the pending→posted transition (SQLite has no deferred
> triggers/commit hooks, and Prisma writes each leg as its own INSERT, so
> the gate is the final UPDATE of the posting flow — the closest
> commit-equivalent seam), `ledger_entries` append-only (UPDATE/DELETE
> rejected), a reversal-only update whitelist on `ledger_transactions`,
> CHECKs for `side`/`amount > 0`, and a `LedgerMaintenance` one-row flag as
> the `mjengo.allow_maintenance` twin. The service-level `validateLines`
> stays as a fail-fast pre-check. The bullets below are the pre-#124
> baseline, kept for history. (The Float-era bullets were already closed by
> #122's integer cents.)

> **UPDATE (2026-09-23, issue #133 / DB-11 in the tracker — audit-file DB-10):**
> reversal marking — the one legal mutation #124 left on `ledger_transactions` —
> is GONE. Reversals are now purely NEW rows: `reverseLedgerTransaction`
> posts the mirrored transaction carrying `reversalOfId` → original and
> writes NOTHING else; "was this reversed?" is DERIVED from that link
> (`findReversalOf` / `isReversed` / `reversalRefsByTxnId` in
> modules/ledger/service.ts — the single seam; the finance slice, wallet txn
> lists and the double-reversal guard all read it). Migration
> `21_ledger_reversals_as_rows` drops/re-creates the live
> `LedgerTransaction_update_guard` with the posting transition (pending→
> posted, the balance gate) as the ONLY legal UPDATE — the previously-legal
> `posted→'reversed' + reversalRef` write is now rejected — and adds a
> UNIQUE index on `reversalOfId` (one reversal per original, the DB-level
> double-reversal backstop the old status-stamp guard lacked under
> concurrency). The `status`/`reversalRef` columns are kept as documented
> LEGACY (additive house rule): pre-#133 rows may still carry the stamps —
> consistent with the derived read, since the old flow posted the reversal
> row first — and the guard freezes them in place. The Supabase design moved
> in lockstep: `ledger_transactions` joined the blanket append-only set
> (INSERT/SELECT-only like `ledger_entries`; the reversal-only update guard
> and its update policy were removed; `reversal_of_id` is UNIQUE).

> **MONEY-CONVENTIONS UPDATE (2026-09-21, issue #282):** `StockMovement.unitCost`
> is integer **cents end-to-end** — the one #122 column whose writers kept
> storing KSh after the BigInt migration (the frontend "Unit cost (KSh)"
> contract flowed raw into the column; supply's `postDeliveryToInventory`
> round-tripped the PO line's cents through `centsToKes` before writing),
> while `loadInventorySlice` read it back as cents — every displayed unit
> cost and the stockValue rollup were ÷100 understated. Normalized: the
> inventory service's `parseUnitCost` is THE KSh→cents boundary (payload KSh
> in → `Cents` stored, ≤2 dp, ≤ MAX_MONEY_KES — `parseNonNegativeMoneyCents`),
> `postDeliveryToInventory` now stores the PO line's cents untouched, and
> `loadInventorySlice` remains the cents→KSh read boundary. Migration 12 had
> already converted all pre-#122 historical rows (`CAST(ROUND(unitCost*100))`);
> the seed-extras already wrote BigInt cents; no production DB exists —
> reseed-not-migrate, documented in the #282 PR. The twin drift on
> `BoqLine.estUnitPrice` (#285) is still open.

- **Model:** `LedgerTransaction` (ref `@unique`, `idempotencyKey @unique`, `reversalOfId`, `status posted|reversed`) + `LedgerEntry` (`txnId`, `accountId`, `side debit|credit`, `amount Float`) — schema.prisma L980–1008.
- **Balanced check is service code only:** `modules/ledger/service.ts` `validateLines` L114–125 throws when Σdebits ≠ Σcredits — with a **`Math.abs(debit-credit) > 0.005` float tolerance** (L122), an explicit acknowledgement of binary-float money. Nothing at the DB level (SQLite has no cross-row CHECK; no trigger). Any writer that bypasses `postLedgerTransaction*` can post unbalanced legs — and `prisma/seed-extras/money.ts` L41–53 does exactly that (`db.ledgerTransaction.create` + `db.ledgerEntry.create` directly).
- **Immutability is convention + one legal mutation:** `reverseLedgerTransaction` (L191–213) creates mirrored entries and **updates** the original row (`status: 'reversed'`, `reversalRef`) — so "immutable" really means "no edits except reversal marking". Not DB-enforced on SQLite.
- **Money representation:** **Float/REAL everywhere** — `Project.budget` (L17), `LedgerEntry.amount` (L1005), `EscrowWallet.balance` (L310), `Transaction.amount` (L250), `Invoice.total`, `PaymentRequest.amount`, `StockMovement.unitCost`. No Int-cents, no Decimal anywhere in the Prisma schema.
- **Balances derived, projections kept in-tx:** `derivedBalance` (ledger/service.ts L216–225) sums entries; `EscrowWallet.balance` is a projection updated inside the same `db.$transaction` as the posting (wallet/service.ts L232 `balance: { decrement }`, L867–872 top-up upsert) — drift cannot occur silently.
- **Race safety:** wallet ops re-check balance INSIDE the transaction and replay-check BEFORE the balance check (wallet/service.ts L644–671); `nextLedgerRef` uses an in-process counter — collision fails closed on `ref @unique` (documented BE-10, ledger/service.ts L88–105).
- **Fix in target state:** Supabase `0002_rls.sql` L344–366 adds a **deferred constraint trigger** asserting Σdebits = Σcredits at COMMIT, a reversal-only update guard (L309–340), and `NUMERIC(18,2)` money in `0001_schema.sql`.
- **Verdict:** idempotency and atomicity are genuinely strong (and test-pinned in `tests/unit/ledger.test.ts` L137–312); the *invariant itself* lives only in TypeScript on the SQLite path, on Float money.

### 2.2 INVENTORY — closing stock derived: **VERIFIED for storage; service has atomicity bugs**

- `InventoryItem` (L1065–1079) stores **no qty column**; `@@unique([projectId, materialName, location])`. `StockMovement` (L1085–1098) is the append-only movement ledger (opening/received/consumed/transferred_in/out/returned/damaged/adjusted).
- Closing is always recomputed from movements: `modules/inventory/repository.ts` L13–24 (`closingQty = opening + received + returned + transferred_in − transferred_out − consumed − damaged + adjusted`); service functions reduce `item.movements.concat([movement])` (inventory/service.ts L45, L52, L60).
- **Bugs found (DB-2):**
  - `consumeStock` (L56–63) **creates the movement row, then** computes closing and throws "Cannot consume more than closing stock" — with **no `db.$transaction`** and no rollback, the over-consumption row is already persisted; the DB can hold negative closing stock after the error.
  - `returnStock`/`damageStock`/`adjustStock` return **hardcoded `closingQty: 0`** (L78, L85, L92) — the derived-stock claim is not honored in these response payloads.
  - `transferStock` (L65–72) has no closing guard at all and writes out+in movements non-atomically (a crash between them loses one leg).
- **Verdict:** storage model is genuinely derived (prior claim verified); the service layer around it is not money-grade.

### 2.3 PAYMENT — idempotency & replay: **VERIFIED (strongest invariant in the repo)**

- **Natural keys:** `withdrawNaturalKey` / `transferNaturalKey` (wallet/service.ts L612–626, L677–692) — deterministic from wallet/amount/rail/note/actor, no timestamps; deposit uses `wallet.deposit:<id>:<amount>:<reference>` when a reference exists (L576–580). Replay check runs BEFORE the balance check (L651–657) so a retry that emptied the wallet replays instead of erroring.
- **DB backstop:** `LedgerTransaction.idempotencyKey @unique` (schema L992) + `IdempotencyRecord.key @unique` (L1014). A concurrent same-key double-post hits P2002 and rolls the whole money transaction back.
- **Header idempotency:** `wallet/http.ts` `withIdempotency` L73–132 — `Idempotency-Key` header, stored payload fingerprint, **409 on key reuse with a different payload** (BE-9); failures never recorded.
- **Daraja callback** (`daraja-callback.ts`): durable intent `daraja.intent:<CheckoutRequestID>` (L85–94) → callback processed only if ResultCode 0 **AND** the provider query API independently verifies (L212–225) → amount = approved request re-read in-tx, callback metadata is log-only (L269–271, L321–325) → posting keyed `daraja.callback:<CheckoutRequestID>` (L277) → dedupe record written after commit (L330–341). In-memory `seenCheckouts` set is only a fast path (L46–56).
- **Reconcile sweep** (`daraja-reconcile.ts` L181–300): finds unsettled intents, re-drives the SAME callback processor (synthesized body never trusted), probe budget 25/run, follow-up chaining, max-age 60 min then honest pending forever.
- **Escrow projection drift alarm** (issue #212, landed 2026-09-19): `EscrowWallet.balance` is a projection of the `ESCROW:<projectId>` ledger entries — until #212 the derived-vs-stored comparison existed ONLY as the Money-tab chip's request-time computation (`wallet/repository.ts` loadFinanceSlice), so drift from a bypassing writer / partial write / seed script was invisible unless a human opened the tab. Now the scheduled `reconciliation` job folds in a cross-project sweep (jobs/handlers.ts `runEscrowDriftCheck`): for every escrow wallet, the #144 SQL-SUM derived balance vs the stored projection, exact cents (the chip's #122 convention), READ-ONLY (deliberately via `derivedBalance`, not `escrowDerivedBalance()` — its `ensureAccount` is a write); per-project findings persisted on the JobRecord result JSON; `|drift| ≥ ESCROW_DRIFT_ALERT_CENTS` (default 1) emits an `escrow.drift` DomainEvent whose policy notifies finance AND contractor (the multi-audience fan-out). Scheduling is piggybacked on the drain endpoint: `POST /api/jobs/run` seeds one `reconciliation` row at most once per `RECONCILIATION_CHECK_INTERVAL_MIN` (default daily) — never stacked (queued/retrying dedupe), no new scheduler infra. Tests: `tests/unit/reconciliation-job.test.ts`.
- **Test pins:** `tests/unit/wallet-idempotency.test.ts` L195–331, `daraja-reconcile.test.ts`, `mpesa-daraja.test.ts`, `reconciliation-job.test.ts`.
- **Verdict:** verified; minor note — `withIdempotency` records AFTER run, so a *concurrent* same-key pair can both execute; only the ledger-keyed mutations are protected at the DB layer (all wallet mutations are).

### 2.4 TENANT — organization model: **ABSENT — single-operator by design**

- **No Organization/Team/Workspace model exists.** `Project` is the tenancy root. `User.projectId` (L442) pins client-role accounts to one project; `User.supplierId` (L447, plain scalar, no FK) pins supplier-role accounts to one Supplier row. Staff roles see **all projects** (`OWNER_ROLES` in `src/shared/permissions.ts`, mirrored in RLS `is_staff()`).
- **Supabase design:** same semantics, DB-enforced — `0002_rls.sql` helpers `can_read_project/can_write_project` (client pinned to `app_project_id` JWT claim), `is_own_supplier_row` (supplier row pin), staff band org-wide (L55–83). **233 policies across 69 tables** (68 + `profiles`), RLS enabled + `anon` revoked on all 69 (L100–124). Multi-org verticalization is **explicitly out of scope** (design doc §10.4); `project_members` scoping is a documented follow-up.
- **Verdict:** today = single-operator SaaS-less deployment; the Supabase design encodes exactly today's authorization, not multi-company tenancy.

### 2.5 AUDIT — who/when/what: **GOOD core, three gaps**

- `AuditEvent` (schema L283–300): `kind`, `actor`, `role`, `summary`, `meta`, `entity/entityId`, `before/after` (JSON snapshots), `ip`, `userAgent`, `requestId`, `createdAt` — append-only; `lib/audit.ts` `logAudit` is the **only writer** (grep: single `db.auditEvent.create`).
- Every mutation dispatched through `applyAction` is logged after success (`lib/mjengo.ts` L666–672); `/api/actions` L187, `/api/ussd` L188, `/api/whatsapp` L175 wrap it in `withAuditContext` (AsyncLocalStorage, `lib/audit.ts` L32–37) so ip/userAgent/requestId ride along; `/api/sync` and `/api/share` call `applyAction` (audited, without ambient ctx).
- **Decision enrichment (issue #218, landed 2026-09-22):** `before`/`after` — schema-supported and API-returned since W3-B but never populated by any writer — are now written by the three decision actions. `milestone.decide` / `variation.decide` / `payment.decide` handlers return their pre-read state + decision facts on a reserved `__audit` result key (the `__actor`/`__role` payload convention mirrored on the result; stripped by `applyAction` before any caller sees it — response contracts byte-identical); `auditEnrichmentFor` (`lib/audit.ts`, beside `summarizeAction`) shapes them: meta = the decision payload (decision, note ≤500 chars, amount as integer-cents string, entity name/code, evidence photo ids) + the money refs that ride the result (ledgerRef/ledgerTxnId/drawPackId on milestone approve); before/after = the frozen status transition (e.g. `{ status: 'release_requested', evidencePhotoIds }` → `{ status: 'released', … }` — a decision-time snapshot, later evidence changes never rewrite it); entity = the Prisma model name (`Milestone`/`VariationOrder`/`PaymentRequest` — the DrawPack convention; historical rows keep the lowercase kind). The ctx merge is additive over the ambient request context (ip/ua/requestId survive). `logAudit`'s serialization is BigInt-safe and guarded: a raw BigInt in meta/before serializes as a string and a non-serializable value degrades to the row without that column — never the whole-row loss the pre-#218 stringify could produce. Tests: `tests/unit/money-actions-audit.test.ts` (15: approve/reject for all three actions, frozen-evidence, additive merge, failed-pack null, truncation, hardening).
- **Gaps (DB-4):** (a) **v1 money routes bypass the audit trail** — `api/v1/payments.ts`, `wallet-deposit/withdraw/transfer.ts` call the wallet service directly; payments.ts L29–30 admits "the caller can audit" but no caller does; (b) `logAudit` runs **after** the mutation, **outside** its transaction, and **swallows errors** (lib/audit.ts L91–93) — a crash between mutation and log, or a failed insert, silently loses the trail; (c) money-critical decisions inside the ledger itself are recorded on `LedgerTransaction.postedBy/postedRole` (good) but not mirrored to AuditEvent by the v1 path.

### 2.6 Migrations — **NO DRIFT FOUND (structural)**

List (`prisma/migrations`, `migration_lock.toml` = sqlite):

| # | Name | Content |
|---|---|---|
| 0 | `0_init` (945 ln) | 60 CREATE TABLEs + 11 unique indexes only |
| 1 | `1_mjengo_score` | `MjengoScore` (additive) |
| 2 | `2_draw_pack` | `DrawPack` + `milestoneId` unique |
| 3 | `3_push_subscription` | `PushSubscription` + endpoint unique |
| 4 | `4_supplier_user_link` | `ALTER TABLE User ADD supplierId` (plain scalar, no FK by house rule) |
| 5 | `5_ai_review_note` | `AiReviewNote` |
| 6 | `6_photo_hash` | `PhotoHash` + photoId unique |
| 7 | `7_ai_insight` | `AiInsight` |
| 8 | `8_trust_digest` | `TrustDigest` |
| 9 | `9_schema_reconcile` | closes the documented db-push drift: `Task.version`, `Attendance.version`, `Transaction.phaseId`, `Notification.deliveryDetail`, `DeliveryPhoto` table + unique + index |

- **Cross-check performed:** offline parse of schema.prisma vs all migration DDL: **68/68 tables, every scalar column present on both sides, no SQL-only columns** (all "schema-only" deltas were Prisma relation fields). 60 + 7 + 1 = 68 tables.
- 1–9 are additive-only by documented house rule (each header states no ALTER/DROP/UPDATE/DELETE); ordering is consistent (FK deps satisfied inside 0_init; `9` reconciles late columns).
- Caveat: `prisma migrate diff` could not be run (read-only mandate, no installs) — this is a static structural verification, matching the diff-empty claim recorded in `9_schema_reconcile` L24–26.

### 2.7 Seeds — **rich demo data, ZERO production guard**

`prisma/seed-all.ts` chains 8 scripts (L36–45): `seed.ts` (3 projects: Nyumba Yangu, +2 more; phases/tasks/workers/attendance/materials/deliveries/transactions/photos/alerts/recaps; inline professionals → land → supply → invoices → intel), `users.ts` (8 accounts: contractor/client/admin/finance/supervisor/procurement/qs/supplier — scrypt hashes, passwords printed in headers), `tasks.ts`, `domain.ts`, `evidence.ts`, `money.ts` (escrow, milestones, variations, ledger, payment requests), `intel.ts` (re-run), `trust.ts` (attendance history + kiosk PINs).

- **Every script begins with `deleteMany` wipes** (seed.ts L37–57 wipes 21 tables incl. `auditEvent`, `transaction`, `project`), and `users.ts` L29 wipes `User`.
- **No `NODE_ENV`/production guard anywhere in `prisma/`** (grep verified). `bun run seed` against a production `DATABASE_URL` destroys all data. → DB-5.
- `money.ts` writes ledger rows directly (bypasses service validation) — demo-only pattern risk.

---

## 3. Supabase design assessment — **CONSISTENT with Prisma, verifiably complete**

- **Table count:** `0001_schema.sql` = 68 `create table` (one per Prisma model, snake_case, `Phase.order → order_index` documented exception); `0002` adds `profiles` (Supabase Auth mapping) → 69 under RLS. Matches the claimed "68-table DDL / 69-table RLS matrix".
- **Sampled column drift (wallet, supply, attendance, land):** none. `ledger_accounts/transactions/entries`, `wallet_accounts`, `payment_requests` (0001 L925–1035), `suppliers/quotes/purchase_orders/material_requests/approvals` (L587–755), `attendances` (L123–151), `land_parcels/parcel_documents/title_searches/professionals` (L481–580) all map 1:1 to the Prisma models, including soft columns (`payment_requests.paid_txn_id` plain, `site_photos.zone_id` plain).
- **Type upgrades (documented, deliberate):** money `NUMERIC(18,2)`, qty `NUMERIC(18,3)`, `timestamptz`, JSON-in-string → JSONB, status ladders → `CHECK`, non-negative money CHECKs, `ledger_transactions.reversal_of_id` self-FK (0001 L953).
- **RLS completeness:** 233 policies, every one of the 69 tables carries ≥1 policy, all target `authenticated`, `anon` fully revoked; append-only tables (audit_events, ledger_entries, stock_movements, draw_packs, mjengo_scores, …15 tables, L292–305) have INSERT+SELECT policies only plus `reject_mutation()` triggers that fire even for service_role; ledger update guard whitelists reversal-marking only; escrow `balance >= 0` trigger; version-monotonicity triggers on tasks/attendances.
- **Platform layer (`0003`):** storage buckets `site-photos` (public — mirrors today's share-link posture, review item S-1) + `documents` (private, signed URLs), path convention `{project_id}/…`; Realtime on `notifications` + `domain_events` (replica identity full); pg_cron `*/5` drains `/api/jobs/run` with token/host read from Supabase Vault at runtime (never embedded in SQL). The escrow `balance >= 0` trigger still asserts no derived-vs-projection equality — but since #212 the app-side scheduled reconciliation check (see §2.3) runs identically against the migrated data (the job reads `escrow_wallets.balance` + `ledger_entries` sums, both NUMERIC-exact), so the drift alarm covers the Supabase stack too; a DB-level projection-equality trigger remains a possible future hardening.
- **Contradictions vs current app:** none structural. Behavioral deltas are loud and documented: (1) project DELETE cascades now **fail** against append-only triggers unless `mjengo.allow_maintenance` is set (design §5.3/§9) — an operational change vs today's silent cascade; (2) `order_code`/`invoice_code`/`request_code` stay non-unique (Prisma parity, §10.1). The design is pinned by `tests/unit/supabase-design.test.ts` (model→table completeness, RLS coverage, money typing, FK index coverage, append-only wiring) — the test's own title ("the Float-money fix stays fixed") confirms the current-schema Float weakness.
- **Consistency verdict:** the Supabase design is a faithful, hardening superset of the shipped schema; it fixes DB-1, DB-3, DB-6, DB-11 by construction.

---

## 4. Indexes & constraints

- **SQLite (shipped):** only **11 unique indexes** (`0_init` L913–945: shareToken, email, escrow projectId, ledger code/ref/idempotencyKey, idempotency key, wallet code, InventoryItem triple, SavedSupplier pair, FeatureFlag key) + later uniques (DrawPack.milestoneId, PushSubscription.endpoint, PhotoHash.photoId, DeliveryPhoto pair) + **exactly ONE non-unique index** (`DeliveryPhoto_deliveryLineId_idx`, migration 9 L48). No index on any FK, none on hot paths: `Attendance(projectId,date)`, `Transaction(projectId,date)`, `LedgerEntry(accountId)`, `StockMovement(inventoryItemId)`, `JobRecord(status,runAt)`, `Notification(projectId,read)`, `AuditEvent(projectId,createdAt)`. → **index half landed 2026-09-17 by migration `10_integrity_constraints` (Attendance/LedgerEntry/StockMovement) and 2026-09-19 by migration `15_hot_path_indexes` (#144: JobRecord(status,runAt), Notification(projectId,read) + Notification(projectId,createdAt), AuditEvent(projectId,createdAt)) — planner usage pinned by EXPLAIN QUERY PLAN tests.**
- **In-memory aggregation:** `derivedBalance`, `withdrawWallet`, `transferWallet`, `depositWallet` load **all** entries of an account via `findMany` and reduce in JS (ledger/service.ts L216–225; wallet/service.ts L589–592, L647–650) — O(n) per call, no SQL `SUM`. → DB-6. **CLOSED 2026-09-19 by #144: all balance paths aggregate in SQL (`ledgerEntry.groupBy` Σdebit/Σcredit over the LedgerEntry(accountId) index — constant memory), incl. the wallet list / finance slice (one grouped aggregate) and the in-tx re-checks (still inside the posting transaction). Equivalence to the old reduce is property-tested over random entry sets on a real migrated SQLite.**
- **FK cascades:** Prisma relations declare Cascade/Restrict/SetNull consistently (e.g. `Delivery.materialId` Restrict, L194; `LedgerEntry.accountId` Restrict, L1003). Caveat (DB-12): SQLite FK enforcement depends on the connection's `PRAGMA foreign_keys` — Prisma's SQLite connector behavior should be verified once before relying on DB-level cascade/restrict outside Prisma Client. → **CLOSED 2026-09-23 via #135: the connector's ON posture is now VERIFIED (pinned on the real engine — fresh-client read-back 1, orphan Delivery insert rejected P2003 end-to-end, tests/unit/db-fk-pragma-realdb.test.ts) and ASSERTED AT BOOT — `src/instrumentation.ts` runs `PRAGMA foreign_keys = ON` + read-back verification via `ensureForeignKeys()` (src/backend/lib/db.ts) before the server serves anything; a failure is a fatal boot error, and non-Prisma writer entrypoints (seeds, scripts) assert the same. Non-Prisma connections still own their pragma — documented in DEPLOYMENT.md §7.2 with the BE-10 multi-process caveat.**
- **Soft FKs (documented no-FK scalars):** `User.supplierId`, `Approval.entityType/entityId`, `WalletAccount.ledgerAccountId`, `InventoryItem.materialId/supplierId`, `Milestone.phaseId`, `VariationOrder.phaseId`, `SitePhoto.zoneId`, `PhotoHash.photoId/packId`, `AiInsight.targetId`, `PaymentRequest.paidTxnId`, `Transaction.ledgerTxnId` — **2026-09-20 #127 CLOSED the sweep**: `Transaction.ledgerTxnId` gained the `@unique` its comment always claimed (migration `22_transaction_ledger_link_unique` — every writer is 1:1 by construction, P2002 on drift, NULLs legal for local-money rows), and every remaining soft link carries an explicit per-column decision with guard locations and failure modes in **ADR 0010** (`docs/adr/0010-soft-fk-registry.md` — the central registry; several originally-listed columns were incidentally promoted to real relations by later waves: `Milestone.phaseId`, `SitePhoto.phaseId`, `Transaction.phaseId`, `Delivery.materialId`, `Consumption.materialId`, `PhotoComment.photoId`). → DB-8/DB-9.
- **Attendance day-row uniqueness is convention only:** appliers do `findFirst({workerId, date})` then create (`lib/mjengo.ts` L1128–1133, `actions/trust.ts` L83–89) — no `@@unique([workerId, date])`. → DB-7.

---

## 5. Findings

| ID | Severity | Finding | Evidence | Proposed issue title |
|---|---|---|---|---|
| DB-1 | High | All money is `Float`/`REAL` (no Int cents, no Decimal); ledger balance check carries a 0.005 float tolerance | schema L17, L250, L1005, L310; ledger/service.ts L122; supabase-design.test.ts §3 names it "the Float-money fix" | "Replace Float money with integer cents (or Decimal) across schema + services" |
| DB-2 | High | Inventory service: over-consumption movement persists before the negative-stock throw (no transaction); return/damage/adjust return fake `closingQty: 0`; transfer legs non-atomic and unguarded | inventory/service.ts L56–63, L65–72, L78/85/92 | "inventory.consume can persist negative stock: wrap movement+check in one transaction, derive all closingQty" — same non-atomicity class on the quote-editing path (`updateQuote` deleteMany + recreate loop, no transaction) was filed as #147 from the 2026-09-16 audit spot-check — **CLOSED 2026-09-22 via #147: header edit + full line rewrite in ONE `db.$transaction` (guards inside), pinned by a stub failure-injection suite + a real-engine suite whose mid-rewrite failure is injected by the engine itself (sub-cent price vs the BigInt cents column)** |
| DB-3 | High | Balanced-ledger and append-only invariants are service-code-only on SQLite; seeds already bypass them | ledger/service.ts L114–125; seed-extras/money.ts L41–53; fixed only in supabase 0002 L281–366 | "DB-enforce ledger balance + append-only on the SQLite path (triggers or guard) or land Supabase Phase-1 sooner" — **CLOSED 2026-09-19 by #124 (migration 14; see §2.1 update)** |
| DB-4 | Medium-High | v1 money routes leave no AuditEvent; logAudit is post-hoc, out-of-transaction, error-swallowing | api/v1/payments.ts L29–30; lib/audit.ts L91–93 | "Audit trail gaps: v1 wallet/payment mutations unaudited; make logAudit fail-visible" |
| DB-5 | Medium-High | Seeds wipe 20+ tables with no production guard | seed.ts L37–57; users.ts L29; no NODE_ENV check anywhere in prisma/ | "Refuse to run seeds when NODE_ENV=production (or require SEED_CONFIRM=WIPE)" |
| DB-6 | Medium | Only 1 non-unique index in the whole DB; hot paths are full scans; balances computed by loading all entries into memory | 0_init L913–945; wallet/service.ts L589–592, L647–650; ledger/service.ts L216–225 | "Add hot-path indexes (attendance project+date, ledgerEntry accountId, jobs queue) + SQL SUM aggregation" — **CLOSED 2026-09-19: index half by migration 10 (see §4) + migration `15_hot_path_indexes`; aggregation half by #144 (SQL SUM balances on every balance path)** |
| DB-7 | Medium | No unique constraint on Attendance (workerId, date) — duplicate day rows possible under concurrent check-in/USSD/sync | schema L151–178; mjengo.ts L1128–1133; trust.ts L83–89 | "Enforce one attendance day-row per (workerId, date) — unique constraint + upsert" |
| DB-8 | Medium | Business codes not unique: requestCode/orderCode/invoiceCode/requestCode; `Transaction.ledgerTxnId` comment claims uniqueness it doesn't have | schema L657, L749, L865, L1040, L264; design doc §10.1 admits it | "Promote business codes to unique (data audit first) — MR-/PO-/INV-/PR- + Transaction.ledgerTxnId" |
| DB-9 | Low-Medium | 11+ soft FK columns can dangle (mostly fail-closed in code, documented) | schema L447, L700–701, L1031, L1071, L320, L341, L225, L1282–1288 | "Harden soft FK links (supplierId, approval entity, wallet ledger link) with validation or constraints" — **RESOLVED 2026-09-20 via #127**: Transaction.ledgerTxnId @unique (migration 22) + the ADR 0010 registry with per-column constrain/validate/keep-soft decisions and guard locations |
| DB-10 | Low | "Immutable" ledger rows ARE updated for reversal marking; no enforcement on SQLite | ledger/service.ts L181–186; guard exists only in supabase 0002 L309–340 | "Document/align ledger immutability semantics (reversal-only update) on both paths" — **CLOSED on SQLite 2026-09-19 by #124 (reversal-only update whitelist trigger)** — **SUPERSEDED & CLOSED PROPERLY 2026-09-23 by #133 (tracker DB-11): reversals are new rows linked via reversalOfId, "is reversed?" derived from the link; migration 21 tightens the update guard to the posting transition only + UNIQUE reversalOfId; Supabase design made ledger_transactions INSERT/SELECT-only (see §2.1 update)** |
| DB-11 | Low | Zero enums / zero CHECKs on SQLite — status ladders are free text | schema census §1; CHECKs only in supabase 0001 | "Constrain status ladders (enums or CHECKs) to catch typos early" |
| DB-12 | Low | SQLite `PRAGMA foreign_keys` enforcement for raw/prisma-external writers unverified; in-process ledger ref counter documented multi-process limit | migrations (all FKs); ledger/service.ts L88–105 (BE-10) | "Verify FK pragma posture for SQLite; note multi-process ref-counter limit in deploy docs" — **CLOSED 2026-09-23 via #135: boot-time execute+read-back assert (`ensureForeignKeys()` in src/backend/lib/db.ts, wired into `src/instrumentation.ts` and every seed/script entrypoint, fatal on OFF); Prisma's ON posture + P2003 orphan rejection pinned on the real engine; deploy note with the BE-10 multi-process caveat in DEPLOYMENT.md §7.2** |

**Contradictions vs prior claims:** "68-model schema" ✅ verified. "No migration drift" ✅ verified structurally (68/68 tables, column-level match; 9_schema_reconcile closed the earlier drift). "Wallet idempotency via natural keys" ✅ verified + test-pinned. "Derived closing stock" ⚠️ verified for the storage model but the prior QA missed DB-2 (service-level atomicity/return-value bugs). Supabase "68-table DDL / 69-table RLS" ✅ verified (68 tables; 233 policies / 69 tables incl. profiles; storage+realtime+pg_cron all present). The implicit "ledger never lies is safe" posture is only service-level on SQLite (DB-1/DB-3) — the design doc itself concedes this by calling NUMERIC money "the Float-money fix".

---

## Worklog entry (Task 2-d)

- Census: prisma/schema.prisma = 68 models, 0 enums, all status ladders free-text; mapped all 68 across 15 domains (money core, supply, land, intel, AI, platform).
- Financial invariant: double-entry balance + append-only live ONLY in TypeScript (validateLines, 0.005 float tolerance); money is Float/REAL everywhere — no cents/Decimal; escrow projection kept in-tx; Supabase 0002's deferred balanced-legs trigger + NUMERIC(18,2) is the real fix (DB-1, DB-3).
- Inventory invariant: closing derived from StockMovement sums (no stored qty) — claim VERIFIED; but found consumeStock persisting over-consumption before its own negative-stock throw, hardcoded closingQty:0 on return/damage/adjust, and non-atomic transfers (DB-2).
- Payment invariant: strongest area — natural keys, Idempotency-Key + payload-fingerprint 409, Daraja intent/callback durable dedupe + provider-query verification + reconcile sweep; all DB-backstopped by @unique ledger idempotencyKey. Verified with tests.
- Tenant: no Organization model — single-operator, Project-rooted; Supabase RLS (233 policies / 69 tables, anon revoked) encodes today's scoping, multi-org explicitly out of scope.
- Audit: AuditEvent append-only with actor/before/after/ip/requestId on every applyAction; gaps: v1 money routes unaudited, logAudit best-effort outside the mutation tx (DB-4).
- Migrations 0–9 listed and cross-checked offline: 68/68 tables, zero column drift → prior "no migration drift" claim holds structurally (prisma migrate diff not runnable under read-only mandate).
- Seeds: 8-script destructive demo seed, 3 projects + 8 users, NO production guard (DB-5); money seed bypasses the ledger service.
- Supabase design: 1:1 with Prisma on all sampled domains (wallet/supply/attendance/land), complete RLS matrix, storage/realtime/pg_cron with vault-held secrets; honest review items (non-unique codes, public photo bucket S-1).
- Delivered docs/audit/DATABASE_BASELINE.md with 12 findings (DB-1..DB-12, 3 High) and proposed issue titles; next: file issues, prioritize DB-1/DB-2/DB-3 before any real-money pilot.
