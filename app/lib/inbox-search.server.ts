import prisma from "../db.server";
import { last10, MATCH_SCORE, phoneNeedle, snippetAround, type MatchKind } from "./inbox-search";
import { orderNameMatches, parseOrderRef, refIsPhone } from "./order-ref";

export type InboxMatch = { kind: MatchKind; /** the order name for an order match ("#W1219") */ order?: string; /** the matching message, shortened */ snippet?: string };

const FETCH = 200; // conversations looked at before ranking
const SHOW = 50;

/**
 * Searches the shop's chats the way WhatsApp does: by phone number (any way it is typed), by the customer's name, by an ORDER ID
 * (the chat of the customer who placed that order, and chats where the id was written), and by any word inside the messages.
 * `base` is the filter already chosen (shop, tab, open/closed ...). Best matches first: order, number, name, message; newest first inside each.
 */
export async function searchInbox(shop: string, q: string, base: Record<string, unknown>) {
  const text = q.trim().slice(0, 60);
  // words inside messages only from 2 characters: one letter matches almost every message and would scan them all on every keystroke
  const or: Record<string, unknown>[] = [{ customerName: { contains: text } }];
  const inMessages = text.length >= 2;
  if (inMessages) or.push({ messages: { some: { body: { contains: text } } } });

  // an order id: find the order in the Order Update sheet and look for chats with the customer's number
  const ref = parseOrderRef(text);
  const orderPhones = new Map<string, string>(); // last 10 digits -> order name
  if (ref && !refIsPhone(ref)) {
    const rows = await prisma.orderSheet.findMany({ where: { shop, orderName: { contains: ref.digits } }, select: { orderName: true, primaryMobile: true, altMobile: true, altMobileShopify: true }, take: 30 });
    for (const o of rows) {
      if (!o.orderName || !orderNameMatches(o.orderName, ref)) continue;
      for (const p of [o.primaryMobile, o.altMobile, o.altMobileShopify]) if (last10(p).length === 10) orderPhones.set(last10(p), o.orderName);
    }
    for (const p of orderPhones.keys()) or.push({ phone: { contains: p } });
  }
  const needle = phoneNeedle(text);
  if (needle) or.push({ phone: { contains: needle } });

  const found = await prisma.conversation.findMany({
    where: { AND: [base, { OR: or }] },
    orderBy: { lastMessageAt: "desc" },
    take: FETCH,
    include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
  });

  // the newest message of each chat that contains the text (shown as the preview)
  const hits = found.length && inMessages
    ? await prisma.message.findMany({ where: { conversationId: { in: found.map((c) => c.id) }, body: { contains: text } }, orderBy: { createdAt: "desc" }, take: 600, select: { conversationId: true, body: true } })
    : [];
  const hitBody = new Map<string, string>();
  for (const h of hits) if (!hitBody.has(h.conversationId)) hitBody.set(h.conversationId, h.body);

  const lower = text.toLowerCase();
  const ranked = found.map((c) => {
    let match: InboxMatch;
    const orderName = orderPhones.get(last10(c.phone));
    if (orderName && last10(c.phone).length === 10) match = { kind: "order", order: orderName };
    else if (needle && c.phone.replace(/\D/g, "").includes(needle)) match = { kind: "phone" };
    else if ((c.customerName ?? "").toLowerCase().includes(lower)) match = { kind: "name" };
    else match = { kind: "message", snippet: snippetAround(hitBody.get(c.id) ?? "", text) };
    if (match.kind !== "message" && hitBody.has(c.id)) match.snippet = snippetAround(hitBody.get(c.id)!, text);
    return { c, match };
  });
  ranked.sort((a, b) => MATCH_SCORE[b.match.kind] - MATCH_SCORE[a.match.kind] || b.c.lastMessageAt.getTime() - a.c.lastMessageAt.getTime());
  return ranked.slice(0, SHOW);
}
