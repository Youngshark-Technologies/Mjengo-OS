-- 21_ledger_reversals_as_rows (issue #133 — DB-11: reversals as new rows)
--
-- WHY: migration 14's LedgerTransaction_update_guard whitelisted TWO legal
-- updates on ledger_transactions — the posting transition (pending→posted,
-- where the balance gate fires) and reversal marking (posted→'reversed' +
-- reversalRef, written by reverseLedgerTransaction after posting the mirrored
-- reversal). That second whitelist made "immutable" mean "no edits except
-- reversal marking": the original ledger row WAS mutated on every reversal,
-- and the mutation was the only thing the Supabase update guard allowed.
--
-- The cleaner model (this migration + the #133 service change): a reversal
-- exists PURELY as a new row — the reversal transaction already carries
-- reversalOfId → the original, so "was this reversed?" is DERIVED from that
-- link and never stamped onto the original. The service no longer UPDATEs
-- the original (postLedgerTransactionInTx's marking block is deleted;
-- the double-reversal guard reads the derived link), so the whitelist's
-- reversal-marking arm has no remaining writer — and an unwritten whitelist
-- is a standing hole for every other writer. This migration therefore
-- DROPS and re-CREATEs the live trigger (applied migrations are immutable;
-- 14 and its verbatim 19 recreation stay in the history) with the
-- tightened policy:
--
--   · the ONLY legal UPDATE on ledger_transactions is the posting
--     transition pending→posted (still required: that UPDATE is where
--     LedgerTransaction_posting_gate asserts Σdebits = Σcredits — SQLite's
--     closest equivalent of the Supabase deferred COMMIT constraint);
--   · every other column — including status and reversalRef — is frozen;
--     in particular the previously-legal reversal marking
--     (posted→'reversed' + reversalRef) is now REJECTED, giving
--     ledger_transactions the same practical write surface as
--     ledger_entries (INSERT + the one gated transition, UPDATE/DELETE
--     otherwise rejected).
--
-- COLUMN DECISION (additive house rule — no destructive migration):
--   · status stays ('pending'|'posted'|'reversed' CHECK from migration 19)
--     but 'reversed' is now LEGACY ONLY: pre-#133 rows may still carry the
--     stamp (their reversals also carry reversalOfId, so the derived read
--     agrees with them); nothing writes it anymore, and this trigger
--     freezes it in place.
--   · reversalRef stays as a nullable legacy column — no longer written;
--     readers derive the reversing ref from the reversalOfId link
--     (ledger service reversalRefsByTxnId / findReversalOf).
--
-- DOUBLE-REVERSAL GUARD, DB-ENFORCED: reversalOfId was a plain nullable
-- column — nothing prevented two reversal transactions from pointing at the
-- same original (the old status-stamp guard raced under concurrency). The
-- unique index below closes that: at most ONE reversal row per original,
-- so even a writer that bypasses the service's derived check fails closed
-- (P2002) instead of double-crediting money. NULLs are unaffected (SQLite
-- unique indexes treat NULLs as distinct), so ordinary non-reversal rows
-- are untouched.
--
-- LEGACY-DATA CAVEAT (documented, fail-closed): if a pre-#133 database
-- somehow holds TWO reversals pointing at one original (only possible via
-- the old guard's concurrency race — the marking and the reversal post were
-- atomic, so this requires a manual/maintenance-mode write), the CREATE
-- UNIQUE INDEX below ABORTS the migration loudly. That is deliberate:
-- duplicate reversals are double-posted money and must be reconciled by
-- hand under maintenance mode before the constraint can apply. No deployed
-- database is known to carry such rows.
--
-- Additive apart from the trigger swap: no table rebuild, no column drops,
-- no data rewrite. The LedgerMaintenance archival exemption keeps bypassing
-- the guard exactly as in migration 14 (the WHEN clause is unchanged).

-- ---------------------------------------------------------------------------
-- §1 The tightened update guard — posting transition ONLY (replaces the
--    migration-14/19 definition, whose reversal-marking arm is removed).
--    DROP TRIGGER IF EXISTS keeps the replay idempotent per statement.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "LedgerTransaction_update_guard";
CREATE TRIGGER "LedgerTransaction_update_guard"
BEFORE UPDATE ON "LedgerTransaction"
WHEN NOT EXISTS (SELECT 1 FROM "LedgerMaintenance" WHERE "id" = 1 AND "allow" = 1)
BEGIN
  SELECT RAISE(ABORT, 'DB-11 (#133): ledger_transactions is immutable except the posting transition (pending→posted) — reversals are NEW rows linked via reversalOfId, the original is never updated')
  WHERE NEW."id" <> OLD."id"
     OR NEW."ref" IS NOT OLD."ref"
     OR NEW."description" IS NOT OLD."description"
     OR NEW."occurredAt" IS NOT OLD."occurredAt"
     OR NEW."projectId" IS NOT OLD."projectId"
     OR NEW."postedBy" IS NOT OLD."postedBy"
     OR NEW."postedRole" IS NOT OLD."postedRole"
     OR NEW."idempotencyKey" IS NOT OLD."idempotencyKey"
     OR NEW."reversalOfId" IS NOT OLD."reversalOfId"
     OR NEW."reversalRef" IS NOT OLD."reversalRef"
     OR NEW."createdAt" IS NOT OLD."createdAt"
     OR NOT (OLD."status" = 'pending' AND NEW."status" = 'posted');
END;

-- ---------------------------------------------------------------------------
-- §2 One reversal per original — the DB-level double-reversal backstop.
--    Mirrors schema.prisma reversalOfId @unique (Prisma's index name, so
--    `prisma migrate diff` stays clean). NULLs (ordinary rows) never
--    collide; the Supabase design carries the twin as the UNIQUE index on
--    ledger_transactions.reversal_of_id (0001_schema.sql).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "LedgerTransaction_reversalOfId_key" ON "LedgerTransaction"("reversalOfId");
