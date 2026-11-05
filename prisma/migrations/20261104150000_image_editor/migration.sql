-- CreateTable
CREATE TABLE "ImageJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "settings" TEXT NOT NULL DEFAULT '{}',
    "total" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "ImageItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "folder" TEXT NOT NULL DEFAULT '',
    "ext" TEXT NOT NULL DEFAULT 'jpg',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "note" TEXT,
    "inBytes" REAL NOT NULL DEFAULT 0,
    "outBytes" REAL NOT NULL DEFAULT 0,
    "width" INTEGER NOT NULL DEFAULT 0,
    "height" INTEGER NOT NULL DEFAULT 0,
    "ms" INTEGER NOT NULL DEFAULT 0,
    "outName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "ImageItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ImageJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ImageSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "workers" INTEGER NOT NULL DEFAULT 2,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "ImageJob_shop_createdAt_idx" ON "ImageJob"("shop", "createdAt");
CREATE INDEX "ImageItem_jobId_status_idx" ON "ImageItem"("jobId", "status");
CREATE INDEX "ImageItem_shop_finishedAt_idx" ON "ImageItem"("shop", "finishedAt");
