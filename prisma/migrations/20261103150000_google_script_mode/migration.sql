-- AlterTable
ALTER TABLE "GoogleSheetConfig" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'service';
ALTER TABLE "GoogleSheetConfig" ADD COLUMN "scriptUrl" TEXT;
