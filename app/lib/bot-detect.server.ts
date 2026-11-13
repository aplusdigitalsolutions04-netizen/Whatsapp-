import prisma from "../db.server";
import { looksAutomated, LOOP_LIMIT, LOOP_WINDOW_MS } from "./bot-detect";

/**
 * Called before JAZZ answers a customer message. Returns why the sender looks like a bot (then nothing is sent), or null.
 * Two checks: the text itself (auto-reply wording, an echo of our own message, a repeated paragraph) and a loop guard
 * (JAZZ already sent this chat many replies in a few minutes, which no person asks for).
 */
export async function detectAutomatedSender(conversationId: string, text: string, inboundId: string): Promise<string | null> {
  const [out, inn, recentReplies] = await Promise.all([
    prisma.message.findMany({ where: { conversationId, direction: "out" }, orderBy: { createdAt: "desc" }, take: 12, select: { body: true } }),
    prisma.message.findMany({
      where: { conversationId, direction: "in", waMessageId: { not: inboundId }, createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) } },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { body: true },
    }),
    prisma.message.count({ where: { conversationId, direction: "out", sender: "bot", createdAt: { gte: new Date(Date.now() - LOOP_WINDOW_MS) } } }),
  ]);
  const why = looksAutomated(text, out.map((m) => m.body), inn.map((m) => m.body));
  if (why) return why;
  if (recentReplies >= LOOP_LIMIT) return `JAZZ already sent ${recentReplies} replies in ${LOOP_WINDOW_MS / 60_000} minutes (possible bot loop)`;
  return null;
}
