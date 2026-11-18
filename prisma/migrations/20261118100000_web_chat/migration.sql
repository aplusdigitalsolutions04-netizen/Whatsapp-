-- AlterTable
ALTER TABLE "BotSettings" ADD COLUMN "webWidget" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BotSettings" ADD COLUMN "widgetWhatsapp" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'whatsapp';
