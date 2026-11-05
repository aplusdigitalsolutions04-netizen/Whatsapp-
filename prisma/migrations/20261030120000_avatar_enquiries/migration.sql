-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "avatarFile" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "avatarAt" DATETIME;

-- CreateTable
CREATE TABLE "ProductEnquiry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "conversationId" TEXT,
    "phone" TEXT NOT NULL,
    "customerName" TEXT,
    "query" TEXT NOT NULL,
    "found" BOOLEAN NOT NULL DEFAULT false,
    "products" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ProductEnquiry_shop_createdAt_idx" ON "ProductEnquiry"("shop", "createdAt");
CREATE INDEX "ProductEnquiry_shop_phone_idx" ON "ProductEnquiry"("shop", "phone");
