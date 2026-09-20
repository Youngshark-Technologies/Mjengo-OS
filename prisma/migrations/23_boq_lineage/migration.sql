-- 23_boq_lineage (issue #203 / ADR 0011 — BOQ-to-consumption traceability):
-- the line-level lineage chain lands as THREE nullable SetNull FK columns, one
-- per hop of BoqLine → MaterialRequestLine → PurchaseOrderLine → (delivery
-- lines already FK orderLineId) with StockMovement closing the loop from
-- consumption back to the request line.
--
-- WHY FK COLUMNS, NOT A LINEAGE TABLE: every hop is 1 line → at most 1 line
-- (boqToRequest creates one request line per selected BOQ line; createOrder
-- prices one PO line per request line; a consumption draws against at most
-- one request line). A link table would split each line's identity from its
-- lineage and add a join for a cardinality the columns already carry.
--
-- WHY SetNull (the issue's own framing): deleting a BOQ line — or a request —
-- must never break the row that referenced it. The request/PO/movement
-- SURVIVES as a legacy/name-only row (the documented fallback, same posture
-- as PurchaseOrder.requestId's SetNull header hop), and the append-only
-- StockMovement keeps its audit trail while losing only its attribution
-- (ADR 0010 registry row #15's "audit trails outlive their subjects").
--
-- WHY REAL FKS, NOT SOFT SCALARS (the migration 04 User.supplierId posture):
-- the issue explicitly asks for SetNull semantics, and migration 09 set the
-- exact precedent for the money-side analogue — Transaction.phaseId landed as
-- `ALTER TABLE ... ADD COLUMN ... REFERENCES "Phase"("id") ON DELETE SET NULL`
-- (issue #39, PR #70). SQLite accepts a column-level REFERENCES in ADD COLUMN
-- (the standalone ADD CONSTRAINT statement is the impossible one), the boot
-- pragma assert (#135) keeps enforcement on, and ADR 0010's soft-FK registry
-- only governs columns that stay soft — these are real relations, so no
-- registry row is required.
--
-- ADDITIVE-ONLY: three ADD COLUMNs (all nullable, no default — every existing
-- row reads NULL = "legacy/name-only row", exactly the pre-#203 behavior) and
-- ONE index. Nothing dropped, nothing rewritten, zero data migration.
--
-- LEGACY HONESTY: rows written before this migration (and PO lines whose
-- requests pre-date it) carry NULL links — the BOQ-vs-actual lineage view
-- lists them separately instead of guessing by name; the fuzzy BOQ-lite view
-- (supply/insights.ts boqRows) remains the name-based fallback for those.

-- AlterTable: lineage hop 1 — BOQ line → request line.
ALTER TABLE "MaterialRequestLine" ADD COLUMN "boqLineId" TEXT REFERENCES "BoqLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: lineage hop 2 — request line → PO line (ordered/delivered walk).
ALTER TABLE "PurchaseOrderLine" ADD COLUMN "requestLineId" TEXT REFERENCES "MaterialRequestLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: lineage hop 3 — consumption movement → request line (consumed).
ALTER TABLE "StockMovement" ADD COLUMN "requestLineId" TEXT REFERENCES "MaterialRequestLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex: DB-6-style hot path for the lineage reads — the BOQ-vs-actual
-- per-line queries filter MaterialRequestLine by boqLineId (same discipline
-- as StockMovement's inventoryItemId index).
CREATE INDEX "MaterialRequestLine_boqLineId_idx" ON "MaterialRequestLine"("boqLineId");
