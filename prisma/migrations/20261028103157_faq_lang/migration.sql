-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "customerName" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'bot',
    "status" TEXT NOT NULL DEFAULT 'open',
    "state" TEXT NOT NULL DEFAULT 'idle',
    "pendingOrders" TEXT NOT NULL DEFAULT '[]',
    "verifyAttempts" INTEGER NOT NULL DEFAULT 0,
    "lang" TEXT NOT NULL DEFAULT 'en',
    "handoffReason" TEXT,
    "lastInboundAt" DATETIME,
    "lastMessageAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Conversation" ("createdAt", "customerName", "handoffReason", "id", "lastInboundAt", "lastMessageAt", "mode", "pendingOrders", "phone", "shop", "state", "status", "verifyAttempts") SELECT "createdAt", "customerName", "handoffReason", "id", "lastInboundAt", "lastMessageAt", "mode", "pendingOrders", "phone", "shop", "state", "status", "verifyAttempts" FROM "Conversation";
DROP TABLE "Conversation";
ALTER TABLE "new_Conversation" RENAME TO "Conversation";
CREATE INDEX "Conversation_shop_lastMessageAt_idx" ON "Conversation"("shop", "lastMessageAt");
CREATE UNIQUE INDEX "Conversation_shop_phone_key" ON "Conversation"("shop", "phone");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
