-- AlterTable
ALTER TABLE "BotSettings" ADD COLUMN "orderConfirmFlow" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "OrderConfirmation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderGid" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "customerName" TEXT,
    "address" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'asked',
    "lastInboundId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderConfirmation_shop_orderGid_key" ON "OrderConfirmation"("shop", "orderGid");

-- CreateIndex
CREATE INDEX "OrderConfirmation_conversationId_state_idx" ON "OrderConfirmation"("conversationId", "state");

-- CreateIndex
CREATE INDEX "OrderConfirmation_conversationId_lastInboundId_idx" ON "OrderConfirmation"("conversationId", "lastInboundId");
