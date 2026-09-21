-- 24_rec1_blind_counts_cadence (issue #359 / REC-1) — the three
-- reconciliation residuals from #194: blind-count mode, scheduled count
-- cadence, variance alerting.
--
-- ADDITIVE-ONLY (house rule): two ALTER TABLE ADD COLUMNs, nothing else.
-- No table is rebuilt, no index changes, no data rewrite.
--
--   · StockCount.blind — this count session ran BLIND: the counter entered
--     physical quantities without the book (expected) figures on screen;
--     the variance view only appeared after saving. Default false — every
--     pre-#359 session was recorded with the expected quantities visible in
--     the dialog, and history must not claim blindness it did not have.
--     SQLite adds the column with DEFAULT false, so existing rows read as
--     not-blind with no backfill.
--   · Project.countIntervalDays — recurring count cadence for the site
--     store, in whole days (7 = weekly, 30 = monthly…). NULL = no cadence
--     (the pre-#359 contract: counts happen when someone runs one).
--     nextCountDue is NOT a column: it is DERIVED on read (last count +
--     interval — modules/inventory/count-cadence.ts), so there is no cron
--     to run, no schedule row to drift, and the answer is always honest
--     about the rows that exist.
--
-- Variance alerting (the third residual) needs NO migration: variance is
-- already computed on read (expectedQty − countedQty, one definition in
-- modules/inventory/repository.ts) and the anomaly scan is a read-side
-- rule over the existing rows.
--
-- Drift verified before/after with:
--   bunx prisma migrate diff --from-migrations prisma/migrations \
--     --to-schema-datamodel prisma/schema.prisma --script   # → empty after

-- AlterTable
ALTER TABLE "StockCount" ADD COLUMN "blind" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "countIntervalDays" INTEGER;
