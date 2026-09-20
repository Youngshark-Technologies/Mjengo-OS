// Inventory domain types (spec §33/§35) — the project payload slices and the
// shapes the UI renders. Closing stock is always derived from movements.

export type StockMovementType =
  | 'opening'
  | 'received'
  | 'consumed'
  | 'transferred_in'
  | 'transferred_out'
  | 'returned'
  | 'damaged'
  | 'adjusted'

export interface InventoryItemRow {
  id: string
  materialName: string
  unit: string
  location: string
  supplierId: string | null
  openingQty: number
  receivedQty: number
  consumedQty: number
  transferredQty: number
  returnedQty: number
  damagedQty: number
  adjustedQty: number
  closingQty: number
  stockValue: number
  /** #207: explicit per-item reorder point — when set it governs the flag. */
  reorderLevel: number | null
  /** #207: computed by the ONE rule (modules/inventory/low-stock.ts). */
  lowStock: boolean
  updatedAt: string
}

export interface StockMovementRow {
  id: string
  inventoryItemId: string
  materialName: string
  unit: string
  type: StockMovementType
  quantity: number
  unitCost: number | null
  reference: string | null
  /** #203: structured consumption attribution — the source MaterialRequestLine (null = unattributed / legacy). */
  requestLineId: string | null
  note: string | null
  recordedBy: string
  createdAt: string
}

// ---- Stock reconciliation (issue #194) ---------------------------------------
// Count session rows for the project payload. variance is COMPUTED on read
// (expectedQty − countedQty — one definition, see countVariance); postedQty
// is the adjustment actually appended from the line (null until posted).

export type StockCountStatus = 'open' | 'posted'

export interface StockCountItemRow {
  id: string
  inventoryItemId: string
  materialName: string
  unit: string
  location: string
  countedQty: number
  expectedQty: number
  /** Signed variance = expectedQty − countedQty (>0: book overstates). */
  variance: number
  /** Adjustment appended from this line (counted − expected); null until posted. */
  postedQty: number | null
}

/** An InventoryItem that was NOT part of a count session (listed separately). */
export interface UncountedItemRow {
  inventoryItemId: string
  materialName: string
  unit: string
  location: string
  /** Derived closing as of the count's countedAt (history query — honest). */
  expectedQty: number
}

export interface StockCountRow {
  id: string
  countedBy: string
  countedAt: string
  note: string | null
  status: StockCountStatus
  postedAt: string | null
  postedBy: string | null
  itemCount: number
  items: StockCountItemRow[]
  uncounted: UncountedItemRow[]
  createdAt: string
}

export interface InventorySlice {
  items: InventoryItemRow[]
  movements: StockMovementRow[]
  /** Stock reconciliation history (issue #194), newest first. */
  counts: StockCountRow[]
}

export interface BoqLineRow {
  id: string
  materialName: string
  unit: string
  qty: number
  /** Estimated unit price in KSh — cents in the column, ÷100 at this DTO boundary (#285). */
  estUnitPrice: number
  category: string | null
  note: string | null
}

export interface BoqRow {
  id: string
  name: string
  version: number
  status: string
  lines: BoqLineRow[]
  /** Σ qty × estUnitPrice in KSh — accumulated in integer cents (mulQtyCents/sumCents), ÷100 at this DTO boundary (#285). */
  total: number
  createdAt: string
}

export interface BoqSlice {
  boqs: BoqRow[]
}
