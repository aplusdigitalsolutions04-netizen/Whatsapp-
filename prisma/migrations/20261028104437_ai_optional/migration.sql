-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BotSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "maxVerifyAttempts" INTEGER NOT NULL DEFAULT 3,
    "recommendationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "maxRecommendations" INTEGER NOT NULL DEFAULT 3,
    "recommendationRule" TEXT NOT NULL DEFAULT 'productType',
    "templates" TEXT NOT NULL DEFAULT '{}',
    "aiEnabled" BOOLEAN NOT NULL DEFAULT false,
    "aiProvider" TEXT NOT NULL DEFAULT 'openai',
    "aiModel" TEXT NOT NULL DEFAULT '',
    "aiKeyEnc" TEXT,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_BotSettings" ("enabled", "maxRecommendations", "maxVerifyAttempts", "recommendationRule", "recommendationsEnabled", "shop", "templates", "updatedAt") SELECT "enabled", "maxRecommendations", "maxVerifyAttempts", "recommendationRule", "recommendationsEnabled", "shop", "templates", "updatedAt" FROM "BotSettings";
DROP TABLE "BotSettings";
ALTER TABLE "new_BotSettings" RENAME TO "BotSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
