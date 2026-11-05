-- CreateTable
CREATE TABLE "Faq" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "keywords" TEXT NOT NULL,
    "replyEn" TEXT NOT NULL,
    "replyHi" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Faq_shop_enabled_idx" ON "Faq"("shop", "enabled");
