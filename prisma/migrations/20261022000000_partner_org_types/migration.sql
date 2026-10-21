-- MJG-035 — Partner access model (Phase 1)
-- Additive only: Organization.type (org kind) + Supplier.partnerOrganizationId
-- (links a constructor's supplier record to the partner's real organization).

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'CONSTRUCTOR';

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN "partnerOrganizationId" TEXT;

-- CreateIndex
CREATE INDEX "Supplier_partnerOrganizationId_idx" ON "Supplier"("partnerOrganizationId");

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_partnerOrganizationId_fkey" FOREIGN KEY ("partnerOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
