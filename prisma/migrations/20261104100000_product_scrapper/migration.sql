-- CreateTable
CREATE TABLE "FinderRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "brand" TEXT NOT NULL DEFAULT '',
    "mode" TEXT NOT NULL,
    "site" TEXT NOT NULL DEFAULT '',
    "minPrice" REAL,
    "maxPrice" REAL,
    "maxProducts" INTEGER NOT NULL DEFAULT 30,
    "maxPages" INTEGER NOT NULL DEFAULT 3,
    "skipEarlier" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'running',
    "checked" INTEGER NOT NULL DEFAULT 0,
    "skippedInStore" INTEGER NOT NULL DEFAULT 0,
    "skippedEarlier" INTEGER NOT NULL DEFAULT 0,
    "log" TEXT NOT NULL DEFAULT '[]',
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "FinderProduct" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "brand" TEXT NOT NULL DEFAULT '',
    "price" TEXT NOT NULL DEFAULT '',
    "comparePrice" TEXT NOT NULL DEFAULT '',
    "discount" INTEGER NOT NULL DEFAULT 0,
    "link" TEXT NOT NULL,
    "linkKey" TEXT NOT NULL,
    "imageCount" INTEGER NOT NULL DEFAULT 0,
    "folder" TEXT NOT NULL DEFAULT '',
    "thumb" TEXT NOT NULL DEFAULT '',
    "isNew" BOOLEAN NOT NULL DEFAULT true,
    "matchReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FinderProduct_runId_fkey" FOREIGN KEY ("runId") REFERENCES "FinderRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "FinderRun_shop_createdAt_idx" ON "FinderRun"("shop", "createdAt");
CREATE INDEX "FinderProduct_runId_idx" ON "FinderProduct"("runId");
CREATE INDEX "FinderProduct_shop_linkKey_idx" ON "FinderProduct"("shop", "linkKey");
