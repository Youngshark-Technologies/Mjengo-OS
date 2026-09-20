# ADR 0010 — The soft-FK registry: per-column decisions for every relation-free link (DB-9)

- **Status:** Accepted (one constraint shipped — migration `21_transaction_ledger_txn_unique`; one write-time validation added — `InventoryItem.supplierId` at the `upsertItem` seam; everything else documented keep-soft)
- **Date:** 2026-09-25
- **Issue:** [#127](https://github.com/Youngshark-Technologies/Mjengo-OS/issues/127) — audit finding **DB-9** (P3)
- **Deciders:** Backend/Database engineering (task 6-b)
- **Related:** `prisma/schema.prisma` (the per-column comments are the quick reference; this ADR is the inventory of record); `docs/audit/DATABASE_BASELINE.md` §4 (the soft-FK bullet) + §5 (DB-9); migration `10_integrity_constraints` (the additive UNIQUE precedent); ADR 0002 (the Supabase parity stance); `supabase/migrations/0001_schema.sql` (the parity surface)

## Context

The schema deliberately carries a couple dozen **soft foreign keys**: plain
`String` columns whose comments say they point at another row, with no
`@relation`, no FK constraint, and (until this decision) no central inventory.
The audit's worry was precise: *a dangling reference is a landmine — today it
fails closed in the code path someone remembered to guard; tomorrow a new
reader assumes the link resolves.* One case was worse than a landmine:
`Transaction.ledgerTxnId`'s comment claimed "unique per txn" while the schema
enforced nothing — a false invariant a future contributor could rely on.

Why the links are soft at all (the standing reasons, so the table below does
not repeat them):

1. **The additive-migration house rule** — cross-model `@relation` additions
   are schema-block edits with FK DDL; SQLite cannot `ALTER TABLE ADD
   CONSTRAINT` (a real FK needs a table rebuild — never additive). The
   parallel-wave working rule was even stricter: append-at-end model blocks.
2. **Supabase parity** (ADR 0002) — the Postgres design deliberately mirrors
   the Prisma model's relation set; hardening one side only would fork the
   two schemas. Where the design DOES diverge (e.g. `ledger_transactions
   .reversal_of_id` is a real self-FK there), this registry records it.
3. **Polymorphism** — several links point at a row *whose table is named by a
   sibling column* (`Approval.entityType`/`entityId`, `AiInsight.targetType`/
   `targetId`, …). A single FK is impossible by construction.
4. **Append-only trails** — audit rows must outlive their subjects; an FK
   (or a cascade) would fight the append-only posture.

The issue asks for an explicit **per-column** disposition — constrain,
validate, or documented-accept — not a blanket hardening.

## Decision

**One column constrained, five validated (one newly, in this issue), the rest
documented keep-soft — every decision recorded in the registry below.** The
registry is the deliverable: any future sweep starts here, and any new soft
column must add a row (the schema header points contributors at this file).

### Disposition vocabulary

- **constrained** — the database now rejects the failure mode (unique index).
- **validated** — a write-time seam rejects dangling ids at insert/update.
- **keep-soft** — accepted with a named guard (or a named reason no guard is
  needed); the failure mode and its reader behavior are documented here.

## The registry

Guard locations are file + function (line numbers drift; the seam names do
not). "Failure mode" describes what a dangling value would do were it to
exist — the guard is what prevents or contains it.

### 1. Constrained (the false claim, now true)

| Column | Target | Guard / enforcement | Failure mode before | Decision |
|---|---|---|---|---|
| `Transaction.ledgerTxnId` | `LedgerTransaction` | **Migration 21** `Transaction_ledgerTxnId_key` UNIQUE (`prisma/migrations/21_transaction_ledger_txn_unique`). Writers: 8 find-first-or-create seams — `lib/mjengo.ts` `postExpenseTransaction` + `wages.pay`, `modules/invoices/service.ts` `payInvoice`, `modules/wallet/service.ts` `releaseMilestoneAtomic`, `recordPayment`, both reversal paths, `modules/wallet/daraja-callback.ts`. Readers: `modules/wallet/repository.ts` (`ledgerRefByTxnId` maps), `frontend/mjengo/finder/sections/invoices-section.tsx`, `api/v1/milestone-detail.ts` | A duplicate would make every `findFirst({ ledgerTxnId })` pick a row arbitrarily and silently fork money provenance; the schema comment claimed this could not happen | **constrained** (comment was already claiming it — the DB now agrees). NULL = legacy pre-ledger rows; SQLite unique indexes skip NULLs, so any number of NULLs stays legal. Applying over a dup corpus fails loudly — the `10_integrity_constraints` precedent, that is the point |

### 2. Validated (write-time seams reject dangling ids)

| Column | Target | Guard / enforcement | Failure mode contained | Decision |
|---|---|---|---|---|
| `Milestone.phaseId` | `Phase` | `actions/money.ts` `resolvePhase` — `milestone.create` refuses an unknown/foreign phase ("Phase not found in this project") | A typo'd phase id would orphan the milestone's cost attribution | **validated** (pre-existing seam, recorded here) |
| `VariationOrder.phaseId` | `Phase` | same `resolvePhase` — `variation.submit` | same | **validated** (pre-existing) |
| `SitePhoto.zoneId` | `SiteZone` | `actions/evidence.ts` `photo.zone` (zone must exist in-project) **and** `zone.delete` untags photos first (`updateMany zoneId → null` — the manual cascade that replaces an FK's `SetNull`) | A dangling zone id would pin the photo to a ghost zone on the site map | **validated + manual cascade** (pre-existing) |
| `InventoryItem.supplierId` | `Supplier` | **NEW (#127):** `modules/inventory/service.ts` `upsertItem` — the ONE write seam for the column (open/receive/transfer all flow through it) — rejects unknown supplier ids inside the movement `$transaction`; the delivery-posting path (`supply/service.ts` `postDeliveryToInventory`) stamps the PO's supplier, which is real-FK-backed on `PurchaseOrder` | A dangling supplier id on a stock line would render a ghost supplier against the item | **validated** (this issue). Honest scope: rows written before this seam are not swept (additive rule — no data migration); empty-string payloads now normalize to "no link" |
| `Transaction.phaseId` | `Phase` | (adjacent, real FK — listed for contrast) `SetNull` relation; writers validate in-project (`resolvePostingPhaseId` in invoices, `resolvePhase` in money) | — | real FK, out of the soft set |

### 3. Already-unique-but-soft

| Column | Target | Guard / enforcement | Failure mode contained | Decision |
|---|---|---|---|---|
| `PhotoHash.photoId` | `SitePhoto` | `@unique` since migration `06_photo_hash` (the idempotent-backfill key); writers hash just-loaded photos | A second hash row per photo would double-count evidence | **constrained (pre-existing) + keep-soft** (no relation — the Wave-6 append-at-end rule, documented in the model block) |

### 4. Keep-soft, documented (guard named per column)

| Column | Target | Guard / failure mode | Decision |
|---|---|---|---|
| `User.supplierId` | `Supplier` | Read-time fail-closed: `lib/guard.ts` `pinnedSupplierId()` → every supplier-surface caller 403s "no supplier linked" (`api/supplier.ts`, `api/sync.ts`, `api/actions.ts`, `api/notifications.ts`, `api/v1/supply-order-detail.ts`); the id rides the JWT (auth.ts jwt callback) | **keep-soft** — ALTER-ADD-COLUMN house rule (migration `04_supplier_user_link`); an FK's cascade semantics are unwanted for a login-scope stamp |
| `User.projectId` | `Project` | The client-role session pin (guard.ts "the client pin" the supplier pin mirrors); client login boots exactly that project | **keep-soft** — same rationale as `supplierId` (found in the #127 sweep; not in the audit's list) |
| `Approval.entityType` + `entityId` | polymorphic: `material_request` / `purchase_order` / `invoice` | Writers stamp just-loaded row ids (`supply/service.ts`, `invoices/service.ts` approval creates); settle paths query the pair (`where: { entityType, entityId, decision: 'pending' }`); every action is audited | **keep-soft** — polymorphic, no single FK possible |
| `PaymentRequest.relatedEntityType` + `relatedEntityId` | polymorphic: `milestone` / `invoice` / `purchase_order` / `wages` | Writers stamp just-loaded ids; readers null-tolerant (`reports/service.ts` milestone-payment attribution); `relatedEntityType` is CHECK-constrained by migration 19 | **keep-soft** — polymorphic (sweep find) |
| `PaymentRequest.paidTxnId` | `Transaction` | Stamped from the `txnRow` created in the SAME `$transaction` (wallet `recordPayment`, `daraja-callback`); `Transaction` rows have no delete path except the project cascade, which takes the request row too | **keep-soft** — in-transaction provenance makes dangling unreachable short of direct DML |
| `WalletAccount.ledgerAccountId` | `LedgerAccount` | Stamped in the account-creating `$transaction` (`createWallet`); readers fail closed: `walletLedgerTransactions` returns the honest empty txn list when the account row is gone | **keep-soft** |
| `EscrowWallet.ledgerAccountId` | `LedgerAccount` | Stamped from the just-created account in the same `$transaction` (escrow spend/release paths) | **keep-soft** (sweep find — the audit listed only `WalletAccount`'s) |
| `InventoryItem.materialId` | `Material` | **No writer exists** — the optional catalog link is currently always null; nothing reads it join-style | **keep-soft, documented** — wire it (with validation at `upsertItem`) when a writer lands |
| `PhotoHash.packId` | `DrawPack` | Stamped from just-loaded pack rows at freeze; packs have no delete path | **keep-soft** |
| `AiInsight.targetType` + `targetId` | polymorphic: `SitePhoto` / `DrawPack` | Writers stamp just-loaded ids (`modules/ai/authenticity.ts`); advisory rows carry their own detail JSON snapshot; photos/packs only die via the project cascade, which cascades the insight rows too (real FK on `projectId`) | **keep-soft** — polymorphic pair, append-only advisory surface |
| `AiInsight.packId` | `DrawPack` | same | **keep-soft** (sweep find) |
| `DrawPack.ledgerTxnId` | `LedgerTransaction` | Frozen at release from the just-posted txn; the pack row is write-once (no update path, `milestoneId` UNIQUE makes it single-shot); `LedgerTransaction` DELETE is trigger-rejected (migration 14) | **keep-soft** — a frozen snapshot, not a live link (sweep find) |
| `DrawPack.ledgerRef` | `LedgerTransaction.ref` (display) | Frozen display twin of the above | **keep-soft** — snapshot column |
| `LedgerTransaction.reversalOfId` | `LedgerTransaction` (self) | Stamped from the just-reversed txn; double-reversal refused earlier ("Transaction already reversed", `ledger/service.ts`); **parity divergence: the Supabase design declares this one a REAL self-FK (`0001_schema.sql` `reversal_of_id … references`)** | **keep-soft on SQLite** (a real FK needs a table rebuild — not additive); recorded as the known divergence |
| `LedgerAccount.ownerId` (+`ownerType`) | polymorphic: `WalletAccount` / `EscrowWallet` / project | Stamped in the same `$transaction` that creates the wallet/account pair | **keep-soft** — polymorphic |
| `WalletAccount.ownerId` (+`ownerType`) | polymorphic: project / organization / supplier / user | `p.ownerId ?? projectId` passthrough (unvalidated — honest); the one read that cares (`createWallet`-adjacent owner check) guards `ownerType='project'` mismatches | **keep-soft** — display/scope only today |
| `AuditEvent.entity` + `entityId` | polymorphic (anything acted on) | Audit enrichment stamps ids of just-mutated rows; append-only history must outlive its subjects — an FK would fight the trail's purpose | **keep-soft, by design** |
| `Attachment.entityType` + `entityId` | polymorphic: quote / purchase_order / invoice / delivery / boq / payment_request / document | Caller-supplied provenance pointer (documented in the schema header since the migration-19 notes); the upload/confirm flow links real storage objects | **keep-soft** — provenance, not integrity |
| `Milestone.evidencePhotoIds`, `DrawPack.evidencePhotoIds` | JSON arrays of `SitePhoto` ids | Snapshot semantics — the DrawPack set is frozen by design; `parseEvidenceIds` is fail-tolerant; UIs render what resolves | **keep-soft** — JSON snapshots, not relational links |
| `StockMovement.reference` | convention string: PO code / delivery id / `count:<id>` | Mixed-content convention column (codes and ids), documented at the model and in the StockCount lineage note | **keep-soft** — not a pure id; not constrainable |

## Why not a shared validation helper / framework

The issue allowed "a shared validation helper at write time". The sweep found
the write seams are few and idiosyncratic: the polymorphic pairs cannot use
one, the same-`$transaction` provenance columns do not need one, and the
two real gaps (`InventoryItem.supplierId`, and nothing else with a live
writer) were closed with a three-line check inside the existing choke point.
A generic `assertSoftFkExists(tx, table, id)` helper would be indirection
around `findUnique` with no caller — the registry is the durable artifact.

## Supabase parity

The design (ADR 0002) keeps every column above soft too, with three recorded
divergences: `ledger_transactions.reversal_of_id` is a real self-FK there;
`transactions.ledger_txn_id` carries a plain (non-unique) index there while
SQLite now enforces uniqueness — the hardening is deliberately one-sided
until a cutover decision promotes it; and `site_photos.zone_id` /
`payment_requests.paid_txn_id` stay plain on both sides. Cutover planning
should reconcile the first two; nothing here blocks it.

## Consequences

- `Transaction.ledgerTxnId` duplicates are now impossible (and pre-existing
  dupes block the migration loudly — the intended tripwire).
- `InventoryItem.supplierId` cannot dangle going forward; legacy rows are
  unswept (additive rule) — a future data-hygiene pass could backfill-check
  them, recorded here so it is a choice, not an oversight.
- Every soft link has a named home for its guard and its failure mode; new
  soft columns must add a registry row (schema header instruction).
- No behavior change in any fail-closed path the guards already provide
  (issue acceptance): the supplier session pin, the wallet empty-list
  fallback, the zone untag-on-delete all run untouched.
