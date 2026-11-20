-- AlterTable
ALTER TABLE "OrderSheet" ADD COLUMN "landingPrice" REAL;

-- The Google Sheet gets two new columns and green / red colours: make the next push format it again.
UPDATE "GoogleSheetConfig" SET "formatted" = false;
