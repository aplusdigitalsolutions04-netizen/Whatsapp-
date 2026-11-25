-- CreateTable
CREATE TABLE "ImsConfig" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "url" TEXT NOT NULL DEFAULT '',
    "keyEnc" TEXT NOT NULL DEFAULT '',
    "keyHint" TEXT NOT NULL DEFAULT '',
    "lastOkAt" DATETIME,
    "lastError" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ImsPush" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderGid" TEXT NOT NULL,
    "orderName" TEXT,
    "event" TEXT NOT NULL DEFAULT 'order.created',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ImsPush_shop_orderGid_key" ON "ImsPush"("shop", "orderGid");

-- CreateIndex
CREATE INDEX "ImsPush_shop_status_nextAttemptAt_idx" ON "ImsPush"("shop", "status", "nextAttemptAt");
