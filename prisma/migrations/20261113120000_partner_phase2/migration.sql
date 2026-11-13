-- MJG-036 — Partner access model (Phase 2, parts b+c)
-- Additive only:
--   Delivery.carrierOrganizationId / acknowledgedAt / acknowledgedById
--     (logistics partners receive + acknowledge delivery tasks);
--   PurchaseOrder.acknowledgedAt / acknowledgedByOrganizationId
--     (supplier partners acknowledge a sent PO);
--   Shipment (supplier-partner shipment log, cascade-deleted with its PO).

-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN "carrierOrganizationId" TEXT;

-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN "acknowledgedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN "acknowledgedById" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN "acknowledgedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN "acknowledgedByOrganizationId" TEXT;

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "carrierName" TEXT NOT NULL,
    "trackingNo" TEXT,
    "shippedAt" TIMESTAMP(3),
    "estimatedArrival" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Delivery_carrierOrganizationId_idx" ON "Delivery"("carrierOrganizationId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_acknowledgedByOrganizationId_idx" ON "PurchaseOrder"("acknowledgedByOrganizationId");

-- CreateIndex
CREATE INDEX "Shipment_purchaseOrderId_idx" ON "Shipment"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "Shipment_organizationId_idx" ON "Shipment"("organizationId");

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_carrierOrganizationId_fkey" FOREIGN KEY ("carrierOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_acknowledgedByOrganizationId_fkey" FOREIGN KEY ("acknowledgedByOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
