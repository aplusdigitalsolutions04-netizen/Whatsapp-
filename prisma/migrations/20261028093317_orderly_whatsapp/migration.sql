-- CreateTable
CREATE TABLE "BotSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "maxVerifyAttempts" INTEGER NOT NULL DEFAULT 3,
    "recommendationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "maxRecommendations" INTEGER NOT NULL DEFAULT 3,
    "recommendationRule" TEXT NOT NULL DEFAULT 'productType',
    "templates" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "customerName" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'bot',
    "status" TEXT NOT NULL DEFAULT 'open',
    "state" TEXT NOT NULL DEFAULT 'idle',
    "pendingOrders" TEXT NOT NULL DEFAULT '[]',
    "verifyAttempts" INTEGER NOT NULL DEFAULT 0,
    "handoffReason" TEXT,
    "lastInboundAt" DATETIME,
    "lastMessageAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "waMessageId" TEXT,
    "inReplyTo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "payload" TEXT NOT NULL,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT,
    "level" TEXT NOT NULL DEFAULT 'info',
    "source" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Conversation_shop_lastMessageAt_idx" ON "Conversation"("shop", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_shop_phone_key" ON "Conversation"("shop", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "Message_waMessageId_key" ON "Message"("waMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_inReplyTo_key" ON "Message"("inReplyTo");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_eventKey_key" ON "WebhookEvent"("eventKey");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_createdAt_idx" ON "WebhookEvent"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_event_createdAt_idx" ON "ActivityLog"("event", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_source_level_createdAt_idx" ON "ActivityLog"("source", "level", "createdAt");
