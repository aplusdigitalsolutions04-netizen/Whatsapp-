-- AlterTable
ALTER TABLE "ImageJob" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'upload';

-- AlterTable
ALTER TABLE "ImageItem" ADD COLUMN "productId" TEXT;
ALTER TABLE "ImageItem" ADD COLUMN "productTitle" TEXT;
ALTER TABLE "ImageItem" ADD COLUMN "mediaId" TEXT;
ALTER TABLE "ImageItem" ADD COLUMN "srcUrl" TEXT;
ALTER TABLE "ImageItem" ADD COLUMN "applyStatus" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ImageItem" ADD COLUMN "applyError" TEXT;
ALTER TABLE "ImageItem" ADD COLUMN "appliedAt" DATETIME;
ALTER TABLE "ImageItem" ADD COLUMN "newUrl" TEXT;

-- CreateTable
CREATE TABLE "ImageBackup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL DEFAULT '',
    "originalUrl" TEXT NOT NULL,
    "ext" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "bytes" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restoredAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "ImageBackup_shop_mediaId_key" ON "ImageBackup"("shop", "mediaId");
CREATE INDEX "ImageItem_shop_mediaId_idx" ON "ImageItem"("shop", "mediaId");
