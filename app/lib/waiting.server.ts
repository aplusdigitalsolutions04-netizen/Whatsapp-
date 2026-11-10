import prisma from "../db.server";

/** A customer the bot handed over (asked for the support team) and nobody has answered yet. */
export type Waiting = { id: string; name: string; phone: string; reason: string | null; at: string };

/** Open chats waiting for a person, newest first. Feeds the pop-up alert in every page and the dashboard banner. */
export async function getWaiting(shop: string, take = 5): Promise<Waiting[]> {
  const rows = await prisma.conversation.findMany({
    where: { shop, status: "open", mode: "human" },
    orderBy: { lastInboundAt: "desc" },
    take,
  });
  return rows.map((c) => ({
    id: c.id,
    name: c.customerName || c.phone,
    phone: c.phone,
    reason: c.handoffReason,
    at: (c.lastInboundAt ?? c.lastMessageAt).toISOString(),
  }));
}
