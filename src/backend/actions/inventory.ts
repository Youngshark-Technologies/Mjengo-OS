// Inventory & BOQ actions (spec §28/§33/§35) — dispatched from
// lib/mjengo.ts applyAction(), which auto-writes the AuditEvent for every
// success — never log manually here.
//
// Thin controller, fat service: this dispatcher only routes; every rule lives
// in src/backend/modules/inventory/service.ts. F-PROCURE implements the service.

import {
  openStock,
  receiveStock,
  consumeStock,
  transferStock,
  returnStock,
  damageStock,
  adjustStock,
  recordStockCount,
  postCountAdjustments,
  setCountCadence,
  createBoq,
  upsertBoqLine,
  deleteBoqLine,
  approveBoq,
  boqToRequest,
  saveSupplier,
  unsaveSupplier,
  updateQuote,
} from '@/backend/modules/inventory/service'

export const INVENTORY_ACTIONS = [
  'inventory.open', // { materialName, unit, qty, unitCost?, location?, supplierId?, reorderLevel? } — opening stock; reorderLevel (#207) sets the item's explicit low-stock threshold (absent = leave any stored level alone)
  'inventory.receive', // { inventoryItemId | materialName+unit+location, qty, unitCost?, reference?, note?, reorderLevel? } — reorderLevel (#207) as above
  'inventory.consume', // { inventoryItemId, qty, reference?, note?, requestLineId? } — requestLineId (#203) optionally attributes the draw to a source request line of THIS project (the BOQ-vs-actual "consumed" column); absent = unattributed
  'inventory.transfer', // { inventoryItemId, qty, toLocation, note? }
  'inventory.return', // { inventoryItemId, qty, note? }
  'inventory.damage', // { inventoryItemId, qty, damageNote }
  'inventory.adjust', // { inventoryItemId, qty, reason } — count correction (±)
  'inventory.count', // { countedBy, countedAt?, note?, blind?, counts: [{ inventoryItemId, countedQty }] } — record a physical stock count session (issue #194); blind: true (REC-1 #359) records that the counter never saw the book quantities until after saving
  'inventory.count.post', // { countId, postedBy? } — post the count-linked adjustments (`adjusted` movements referencing the count)
  'inventory.count.schedule', // { intervalDays: number | null } — set/clear the store's recurring count cadence in whole days (REC-1 #359; null clears — "due" is derived on read from the last count + interval)
  'boq.create', // { name, lines?: [{ materialName, unit?, qty?, estUnitPrice?, category?, note? }] } — estUnitPrice is KSh, converted to cents at the write boundary (#285)
  'boq.line.upsert', // { boqId, id?, materialName, unit, qty, estUnitPrice? (KSh → cents at the boundary, #285), category?, note? } — when id is given it must name a line of boqId's BOQ in the caller's project; foreign/unknown ids are refused (#286)
  'boq.line.delete', // { id }
  'boq.approve', // { id }
  'boq.to_request', // { id, lineIds? } — generate MaterialRequest from BOQ lines
  'supplier.save', // { supplierId, note? } — save to project's supplier shortlist
  'supplier.unsave', // { supplierId }
  'quote.update', // { id, validUntil?, terms?, lines?: [...] } — quote validity/terms/multi-line detail
] as const

export async function applyInventoryAction(
  type: string,
  payload: any,
  projectId: string,
): Promise<any> {
  const p = payload ?? {}
  switch (type) {
    case 'inventory.open':
      return openStock(projectId, p)
    case 'inventory.receive':
      return receiveStock(projectId, p)
    case 'inventory.consume':
      return consumeStock(projectId, p)
    case 'inventory.transfer':
      return transferStock(projectId, p)
    case 'inventory.return':
      return returnStock(projectId, p)
    case 'inventory.damage':
      return damageStock(projectId, p)
    case 'inventory.adjust':
      return adjustStock(projectId, p)
    case 'inventory.count':
      return recordStockCount(projectId, p)
    case 'inventory.count.post':
      return postCountAdjustments(projectId, p)
    case 'inventory.count.schedule':
      return setCountCadence(projectId, p)
    case 'boq.create':
      return createBoq(projectId, p)
    case 'boq.line.upsert':
      return upsertBoqLine(projectId, p)
    case 'boq.line.delete':
      return deleteBoqLine(projectId, p)
    case 'boq.approve':
      return approveBoq(projectId, p)
    case 'boq.to_request':
      return boqToRequest(projectId, p)
    case 'supplier.save':
      return saveSupplier(projectId, p)
    case 'supplier.unsave':
      return unsaveSupplier(projectId, p)
    case 'quote.update':
      return updateQuote(projectId, p)
    default:
      throw new Error(`Unknown inventory action: ${type}`)
  }
}
