# ADR 0010: The soft-FK registry

**Status:** accepted (2026-09-20, issue #127 / audit DB-9) · **Owner:** repo
maintainer · **Review trigger:** any new soft scalar link, any promotion of
a listed column to a real relation, or the Supabase cutover (which
re-decides every row against real FKs + RLS)

## Context

The Prisma schema carries a set of **soft foreign keys**: plain `String`
columns documented (in inline comments) as pointing at another row, with no
`@relation`, no FK constraint, and no unique index. They can dangle
silently; safety comes from fail-closed checks in application code — each
guard living wherever someone remembered to write it. The 2026-09-16 audit
(catalogued as DB-9) called this a landmine: "today it fails closed in the
code path someone remembered to guard; tomorrow a new reader assumes the
link resolves." One column was worse — `Transaction.ledgerTxnId`'s comment
claimed "unique per txn" while the schema held no such constraint.

Since the audit, several of the originally-listed columns have been
promoted to real relations incidentally (through the waves that rebuilt
their model blocks): `Milestone.phaseId`, `SitePhoto.phaseId`,
`Transaction.phaseId`, `Delivery.materialId`, `Consumption.materialId`,
`PhotoComment.photoId` now carry real `@relation`s. This ADR is the honest
current-state inventory of every REMAINING soft link, its guard, its
failure mode, and the per-column decision — the "sweep, document, and
constrain where claimed" the issue asked for.

## Decision

**One column is CONSTRAINED** (migration
`22_transaction_ledger_link_unique`): `Transaction.ledgerTxnId` gains the
`@unique` its comment always claimed. Every writer stamps a
`LedgerTransaction` minted in the same Prisma transaction (1:1 by
construction — wallet service, daraja-callback, invoices, `mjengo.ts`), so
the index turns future drift into a loud P2002 at the write site instead of
a silent duplicate that would double-count any ledger→money reconciliation
join. Multiple NULLs stay legal (local-money rows with no ledger link).

**Every other soft link is KEPT SOFT by explicit decision**, each with its
reasoning recorded below. The three decision classes from the issue:
*constrain* (done — one column), *validate* (write-time target-existence
checks — evaluated per column below; none warranted: every candidate is
either written from a row read in the same transaction or guarded
fail-closed at read), *document* (this registry).

## The registry

| # | Column (model) | Target | Guard location(s) | Failure mode | Decision + why |
|---|---|---|---|---|---|
| 1 | `Transaction.ledgerTxnId` | `LedgerTransaction` | Writers mint the target in the same Prisma tx (wallet/service.ts, daraja-callback.ts, invoices/service.ts, lib/mjengo.ts) | A duplicate would double-count ledger→money joins; a dangling id breaks nothing at read (joined only for display refs) | **CONSTRAINED** — unique index (migration 22); the comment's claim is now schema truth |
| 2 | `User.supplierId` | `Supplier` | Session shaping fails closed — supplier-role sessions resolve their Supplier row at login; missing row = "no supplier linked" refusal (auth.ts authorize + supplier session shaping) | A supplier user with a dangling id cannot act (fail closed, honest error) | **Keep soft** — nullable optional link; a real FK would cascade-delete user accounts with supplier rows, the wrong blast radius for an account↔portal linkage |
| 3 | `EscrowWallet.ledgerAccountId` | `LedgerAccount` | `ensureAccountTx` upserts the account at wallet creation (wallet/service.ts) and re-resolves by natural key on every op | Dangling = the next wallet op re-creates the account by natural key (self-healing, idempotent) | **Keep soft** — the account is derived state keyed `WALLET:<code>`/`ESCROW:<project>`; the natural key, not the id, is the identity |
| 4 | `WalletAccount.ledgerAccountId` | `LedgerAccount` | Same `ensureAccountTx` seam as #3 | Same self-healing by natural key | **Keep soft** — same reasoning as #3 |
| 5 | `InventoryItem.materialId` | `Material` | Catalog links stamped at receive/adjust from the material row being written; reads treat it as enrichment (the item's `materialName`/`unit` are the source of truth) | Dangling = the item shows without catalog enrichment | **Keep soft** — optional enrichment link (the comment says exactly this); items are keyed `(@@unique(projectId, materialName, location))`, not by catalog identity |
| 6 | `InventoryItem.supplierId` | `Supplier` | Stamped at receive from the delivery's supplier; display-only | Dangling = the receive history shows no supplier name | **Keep soft** — display attribution, not integrity-bearing |
| 7 | `SitePhoto.zoneId` | `Zone` (free-text location taxonomy) | Photos group by zone name strings in the UI; zone rows are a convenience index, not the identity | Dangling = photo shows ungrouped | **Keep soft** — zones are name-keyed display taxonomy; an FK would break the free-text zone names photos legitimately carry |
| 8 | `VariationOrder.phaseId` | `Phase` | Written from the phase picker (a real row); reports read it as attribution | Dangling = variation shows unattributed | **Keep soft** — nullable attribution, same class as `Transaction.phaseId` pre-promotion; promote with the phase model when phases get their rebuild wave |
| 9 | `PhotoHash.photoId` | `SitePhoto` | `@unique` (backfill idempotence); the hash screen resolves photos by id from live rows | Dangling = the authenticity screen skips the row | **Keep soft-but-unique** — append-only screen (no Wave-6 path updates/deletes); documented in the model header; uniqueness held, referentiality deliberately not (the parallel-wave append-only house rule recorded there) |
| 10 | `PhotoHash.packId` | `DrawPack` | Stamped at freeze from the pack row; null = on-demand backfill | Dangling = the row reports "on-demand" provenance | **Keep soft** — packs are never deleted (the same model header's reasoning) |
| 11 | `AiInsight.targetId` | `SitePhoto` \| `DrawPack` (polymorphic) | The insight screen joins by `targetType` + id against live rows | Dangling = the finding is skipped in the screen | **Keep soft** — polymorphic target; a real FK is impossible without table-per-target indirection |
| 12 | `AiInsight.packId` | `DrawPack` | Same as #10 | Same as #10 | **Keep soft** — same reasoning |
| 13 | `PaymentRequest.paidTxnId` | `Transaction` | Stamped by the pay seam at payment completion (the row it just created) | Dangling = the request shows unpaid; the ledger reconciles by idempotency key, not this link | **Keep soft** — a post-hoc display link; the money truth lives in the ledger's idempotency discipline |
| 14 | `ApprovalRule.entityType` + `entityId` | polymorphic (any audited entity) | The approval engine dispatches by `entityType` string; unknown ids fail closed (no rule matches → refusal posture) | Dangling = rule never fires (fail closed) | **Keep soft** — polymorphic by design (schema comment: "no FK; the trail is audited") |
| 15 | `AuditEvent.entityId` | polymorphic | The audit trail is append-only and must survive target deletion (an audit row whose subject was deleted is CORRECT history, not a dangling reference) | Dangling = intended behavior | **Keep soft** — an FK with Cascade would delete audit history; an FK with Restrict would block deletions. The audit trail's whole point is outliving its subjects |

## Consequences

- The false-uniqueness landmine is gone: `Transaction.ledgerTxnId` is
  unique at the database (P2002 on drift), and the comment now points at
  the constraint instead of asserting an unreferenced claim.
- Every remaining soft link has a written decision with its guard — the
  sweep the audit asked for is discoverable in one place instead of
  scattered inline comments.
- The Supabase cutover (ADR 0002) re-decides these rows against real FKs +
  RLS where the Postgres engine makes different trade-offs cheap; this
  registry is the input to that pass.
- New soft scalars require a registry row (the review trigger) — a comment
  alone is no longer the documentation posture.
