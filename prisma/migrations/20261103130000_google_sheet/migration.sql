-- CreateTable
CREATE TABLE "GoogleSheetConfig" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "spreadsheetId" TEXT NOT NULL,
    "spreadsheetTitle" TEXT,
    "tabName" TEXT NOT NULL DEFAULT 'Order Calling Sheet',
    "saEmail" TEXT NOT NULL,
    "saKeyEnc" TEXT NOT NULL,
    "formatted" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "connectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastPushAt" DATETIME,
    "lastPushRows" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "updatedAt" DATETIME NOT NULL
);
