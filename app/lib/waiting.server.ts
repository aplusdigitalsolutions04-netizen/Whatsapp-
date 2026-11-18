import prisma from "../db.server";

/** A customer the bot handed over (asked for the support team) and nobody has answered yet. */
export type Waiting = { id: string; name: string; phone: string; reason: string | null; at: string; channel: "whatsapp" | "web" };

/** Name shown for a waiting customer; a website visitor without a name is "Website visitor ABCD". */
export const waitingName = (c: { customerName: string | null; phone: string; channel: string }) =>
  c.customerName || (c.channel === "web" ? `Website visitor ${c.phone.replace(/^web:/, "").slice(0, 4).toUpperCase()}` : c.phone);

/** Open chats waiting for a person, newest first. Feeds the pop-up alert in every page and the dashboard banner. */
export async function getWaiting(shop: string, take = 5): Promise<Waiting[]> {
  const rows = await prisma.conversation.findMany({
    where: { shop, status: "open", mode: "human" },
    orderBy: { lastInboundAt: "desc" },
    take,
  });
  return rows.map((c) => ({
    id: c.id,
    name: waitingName(c),
    phone: c.phone,
    channel: c.channel === "web" ? "web" : "whatsapp",
    reason: c.handoffReason,
    at: (c.lastInboundAt ?? c.lastMessageAt).toISOString(),
  }));
}
