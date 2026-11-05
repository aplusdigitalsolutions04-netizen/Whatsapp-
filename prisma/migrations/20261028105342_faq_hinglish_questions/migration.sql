-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Faq" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "keywords" TEXT NOT NULL,
    "replyEn" TEXT NOT NULL,
    "replyHi" TEXT NOT NULL,
    "replyHinglish" TEXT NOT NULL DEFAULT '',
    "questions" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Faq" ("createdAt", "enabled", "id", "keywords", "replyEn", "replyHi", "shop", "title") SELECT "createdAt", "enabled", "id", "keywords", "replyEn", "replyHi", "shop", "title" FROM "Faq";
DROP TABLE "Faq";
ALTER TABLE "new_Faq" RENAME TO "Faq";
CREATE INDEX "Faq_shop_enabled_idx" ON "Faq"("shop", "enabled");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
