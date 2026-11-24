-- AlterTable
ALTER TABLE "OrderSheet" ADD COLUMN "items" TEXT;

-- The Google Sheet gets item rows and two more columns: format it again on the next push.
UPDATE "GoogleSheetConfig" SET "formatted" = false;
