-- CreateTable
CREATE TABLE "SeoProduct" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "vendor" TEXT NOT NULL DEFAULT '',
    "productType" TEXT NOT NULL DEFAULT '',
    "tags" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "descText" TEXT NOT NULL DEFAULT '',
    "seoTitle" TEXT NOT NULL DEFAULT '',
    "seoDescription" TEXT NOT NULL DEFAULT '',
    "thumb" TEXT NOT NULL DEFAULT '',
    "images" TEXT NOT NULL DEFAULT '[]',
    "issues" TEXT NOT NULL DEFAULT '[]',
    "score" INTEGER NOT NULL DEFAULT 100,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "warnings" INTEGER NOT NULL DEFAULT 0,
    "scannedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SeoScan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "SeoBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'preview',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" DATETIME
);

-- CreateTable
CREATE TABLE "SeoChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL DEFAULT '',
    "mediaId" TEXT,
    "before" TEXT NOT NULL DEFAULT '',
    "after" TEXT NOT NULL,
    "warn" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "appliedAt" DATETIME,
    CONSTRAINT "SeoChange_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "SeoBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SeoProduct_shop_productId_key" ON "SeoProduct"("shop", "productId");
CREATE INDEX "SeoProduct_shop_score_idx" ON "SeoProduct"("shop", "score");
CREATE INDEX "SeoScan_shop_startedAt_idx" ON "SeoScan"("shop", "startedAt");
CREATE INDEX "SeoBatch_shop_createdAt_idx" ON "SeoBatch"("shop", "createdAt");
CREATE INDEX "SeoChange_batchId_status_idx" ON "SeoChange"("batchId", "status");
