import prisma from "../db.server";
import { logEvent } from "./log.server";
import { askAddressText, confirmedText, declinedText, parseYesNo } from "./order-confirm";

/** How long a question stays open. After that the customer's "yes" is treated like any other message. */
const OPEN_MS = 72 * 3_600_000;

export type ConfirmReply = { reply: string; handoffReason?: string };

type Row = NonNullable<Awaited<ReturnType<typeof prisma.orderConfirmation.findFirst>>>;

function replyFor(row: Row): ConfirmReply {
  if (row.state === "address") return { reply: askAddressText({ orderName: row.orderName, customerName: row.customerName, phone: row.phone, address: row.address }) };
  if (row.state === "confirmed") return { reply: confirmedText(row.orderName) };
  return { reply: declinedText(row.orderName), handoffReason: `Customer did not confirm order ${row.orderName}` };
}

/**
 * Called for every message of a customer who has an open order question. Returns the reply to send, or null when the message
 * is not a clear yes/no (the normal bot then answers it, the question stays open).
 *   asked   + YES -> show number and address, ask again   asked/address + NO -> hand over to an agent
 *   address + YES -> order confirmed
 * Calling it again with the same inbound message id gives the same reply (no double step when WhatsApp redelivers a message).
 */
export async function handleConfirmationReply(shop: string, conversationId: string, text: string, inboundId: string): Promise<ConfirmReply | null> {
  const again = await prisma.orderConfirmation.findFirst({ where: { shop, conversationId, lastInboundId: inboundId } });
  if (again) return replyFor(again);

  const row = await prisma.orderConfirmation.findFirst({
    where: { shop, conversationId, state: { in: ["asked", "address"] }, createdAt: { gte: new Date(Date.now() - OPEN_MS) } },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;
  const answer = parseYesNo(text);
  if (!answer) return null;

  const state = answer === "no" ? "declined" : row.state === "asked" ? "address" : "confirmed";
  const next = await prisma.orderConfirmation.update({ where: { id: row.id }, data: { state, lastInboundId: inboundId } });
  await logEvent({ shop, source: "bot", event: `order_${state}`, detail: `${row.orderName}: customer answered ${answer.toUpperCase()}` });
  return replyFor(next);
}
