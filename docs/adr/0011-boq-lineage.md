# ADR 0011: BOQ line-level lineage (structural, not name-matched)

**Status:** accepted (2026-09-20, issue #203 / audit procurement finding) ·
**Owner:** repo maintainer · **Review trigger:** any new hop in the
BOQ → request → PO → delivery → consumption chain, or the Supabase
cutover (RLS policies inherit these FKs)

## Context

The BOQ is the estimate-of-record a client signed off on, but nothing
linked material usage back to it. The chain BOQ → material request → PO →
delivery worked structurally on the header hops only; the LINE-level hops
were name strings and free-text: `boqToRequest` created request lines with
the only BOQ linkage being the request's notes string (`From BOQ "<name>"
v<version>"`), PO lines carried no link to the request lines they priced,
and consumption (`StockMovement.reference`) was free text. No query could
answer "BOQ line X estimated 200 bags; how many were delivered, consumed,
what remains?" — the dashboard's "BOQ-lite" view derived required-vs-
purchased by fuzzy `materialKey` name matching (`supply/insights.ts`),
not the BOQ and not consumption.

## Decision

**Line-level lineage lands as structural FK columns, one per hop**
(migration `23_boq_lineage`), not a lineage table:

- `MaterialRequestLine.boqLineId → BoqLine` (stamped by `boqToRequest`,
  which builds one request line per selected BOQ line);
- `PurchaseOrderLine.requestLineId → MaterialRequestLine` (stamped by
  `createOrder`, which prices one PO line per request line);
- `StockMovement.requestLineId → MaterialRequestLine` (stamped by
  `consumeStock` from the operator's request-line pick);
- delivery lines already FK `orderLineId` — the chain closes.

**Why columns, not a link table:** every hop is 1 line → at most 1 line.
A link table would split each line's identity from its lineage and add a
join for a cardinality the columns already carry.

**Why nullable + SetNull (the issue's own framing):** deleting a BOQ line
— or a request — must never break the row that referenced it. The
request/PO/movement SURVIVES as a legacy/name-only row (the documented
fallback, the same posture as `PurchaseOrder.requestId`'s SetNull header
hop); the append-only `StockMovement` keeps its audit trail while losing
only its attribution (ADR 0010 registry row 15's "audit trails outlive
their subjects").

**Why real FKs, not soft scalars:** migration 09 set the exact precedent
for the money-side analogue — `Transaction.phaseId` landed as a
column-level `REFERENCES … ON DELETE SET NULL` in an additive `ADD
COLUMN` (issue #39, PR #70). SQLite accepts column-level REFERENCES in
ADD COLUMN; the boot pragma assert (#135) keeps enforcement on. ADR 0010's
soft-FK registry governs only columns that STAY soft — these are real
relations.

**The derived view:** `supply/insights.ts boqProgress` walks the chain
per BOQ line — estimated (`BoqLine.qty`) / requested (Σ request-line qty
where `boqLineId`) / ordered (Σ PO-line qty via `requestLineId`) /
delivered (Σ delivery-line qty via `orderLineId`) / consumed (Σ
`StockMovement` qty via `requestLineId`) — and lists legacy rows (NULL
links, including every pre-migration row) SEPARATELY instead of guessing
them into the lineage by name. The fuzzy BOQ-lite view remains the
name-based fallback for those rows. The dashboard boq-card renders the
lineage view when links exist.

## Consequences

- Quantity-overrun detection is now possible per BOQ line (requested vs
  estimated, ordered vs requested) without name matching; the view never
  silently drifts when names differ between BOQ, request and PO lines.
- Historical rows (pre-#203, or written by flows that bypass the stamping
  seams) read as legacy — surfaced separately, never guessed.
- `boqToRequest`, `createOrder` and `consumeStock` each gained one
  stamping seam; the writers are transactional, so a stamped link is
  always a real row (FK enforced).
- Deleting a BOQ line detaches its request lines (SetNull) rather than
  breaking them; the lineage view then reports them as legacy rows.
