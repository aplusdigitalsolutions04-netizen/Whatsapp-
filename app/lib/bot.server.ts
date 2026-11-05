import prisma from "../db.server";
import { aiFallbackReply, HANDOFF_MARK, translateReply, translateToEnglish } from "./ai.server";
import { matchFaq, pickFaqReply } from "./faq";
import { detectIntent, extractOrderNumber, parseSelection, productTerms } from "./intent";
import { detectLanguage, type Lang } from "./lang";
import { logEvent } from "./log.server";
import { normalizePhone } from "./phone";
import { rateLimited } from "./rate-limit.server";
import { getSettings, type Settings } from "./settings.server";
import { findOrderEverywhere, findOrdersEverywhere, getOrdersEverywhere } from "./order-lookup.server";
import {
  getProductsByIds,
  orderBelongsTo,
  recommendProducts,
  searchProducts,
  type OrderSummary,
  type ProductSummary,
} from "./shopify-data.server";
import { canSendMedia, sendAndRecord } from "./whatsapp.server";
import { MAX_MEDIA_BYTES, saveMedia } from "./media.server";
import { LABELS, statusHi, TEMPLATES_HI, type Templates } from "./templates";

export type InboundPayload = {
  from: string; // wa_id digits
  id: string; // wamid
  type: string;
  text: string;
  name?: string;
  timestamp?: string;
  /** Attachment; `file` is the stored filename once downloaded. */
  media?: { kind: string; mime: string; name?: string; file?: string };
};

const titleCase = (s: string | null) =>
  s ? s.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Unknown";

export function formatOrder(o: OrderSummary, lang: Lang = "en"): string {
  const L = LABELS[lang === "hi" ? "hi" : "en"];
  const show = (raw: string | null) => (lang === "hi" ? statusHi(raw) : null) ?? titleCase(raw);
  const lines = [
    L.hello,
    `${L.orderNo}: ${o.name}`,
    `${L.date}: ${new Date(o.createdAt).toLocaleDateString(L.locale, { day: "numeric", month: "short", year: "numeric" })}`,
    `${L.status}: ${o.cancelled ? L.cancelled : show(o.fulfillmentStatus)}`,
    `${L.payment}: ${show(o.financialStatus)}`,
  ];
  if (o.total) lines.push(`${L.total}: ${o.total}`);
  if (o.items.length) {
    lines.push(...o.items.map((i) => `${L.product}: ${i.title} × ${i.quantity}${i.sku ? ` (SKU ${i.sku})` : ""}`));
  }
  if (o.tracking.length) {
    for (const t of o.tracking) {
      if (t.company) lines.push(`${L.courier}: ${t.company}`);
      if (t.number) lines.push(`${L.trackNo}: ${t.number}`);
      if (t.resolvedUrl) lines.push(`${L.trackLink}: ${t.resolvedUrl}`);
    }
  } else if (!o.cancelled) {
    lines.push(L.noTracking);
  }
  if (o.statusUrl) lines.push(`${L.statusPage}: ${o.statusUrl}`);
  lines.push(L.thanks);
  return lines.join("\n");
}

export function formatProducts(items: ProductSummary[], lang: Lang = "en"): string {
  const L = LABELS[lang === "hi" ? "hi" : "en"];
  return items
    .map((p) => {
      const price = p.price ? ` — ${lang === "hi" ? `${p.price} ${L.from}` : `${L.from} ${p.price}`}` : "";
      const head = `• ${p.title}${price}${p.available ? ` (${L.inStock})` : ""}`;
      if (p.url) return `${head}\n  ${p.url}`;
      // No storefront link: share the product's details instead.
      const desc = p.description.replace(/\s+/g, " ").trim().slice(0, 200);
      const meta = [p.productType, p.skus[0] ? `SKU ${p.skus[0]}` : ""].filter(Boolean).join(" · ");
      return [head, meta && `  ${meta}`, desc && `  ${desc}`].filter(Boolean).join("\n");
    })
    .join("\n");
}

/** A bot answer; `image` is sent first (caption = headline) and `rest` follows as text. */
export type Reply = { text: string; image?: { url: string; caption: string; rest: string } };

/** Full details of one product: name, price, compare-at price, description (+ photo). */
export function productDetail(p: ProductSummary, lang: Lang = "en"): Reply {
  const L = LABELS[lang === "hi" ? "hi" : "en"];
  const head = [`🛍️ *${p.title}*`];
  if (p.price) head.push(`${L.price}: ${p.price}`);
  if (p.compareAtPrice) {
    head.push(`${L.compareAt}: ~${p.compareAtPrice}~${p.discountPercent ? ` (${L.save} ${p.discountPercent}%)` : ""}`);
  }
  const rest: string[] = [];
  const desc = p.fullDescription.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 2800);
  if (desc) rest.push(`${L.description}:\n${desc}`);
  rest.push(`${L.stock}: ${p.available ? L.inStock : "—"}`);
  if (p.url) rest.push(`${L.link}: ${p.url}`);
  const headText = head.join("\n");
  const restText = rest.join("\n\n");
  return {
    text: `${headText}\n\n${restText}`,
    image: p.imageUrl ? { url: p.imageUrl, caption: headText, rest: restText } : undefined,
  };
}

/** Compact numbered list (name, price, compare-at) so the customer can pick one. */
export function productList(items: ProductSummary[], lang: Lang = "en"): string {
  const L = LABELS[lang === "hi" ? "hi" : "en"];
  const lines = items.map((p, i) => {
    const price = p.price ? `\n    ${L.price}: ${p.price}` : "";
    const cmp = p.compareAtPrice ? `\n    ${L.compareAt}: ~${p.compareAtPrice}~` : "";
    return `${i + 1}. *${p.title}*${price}${cmp}`;
  });
  return `${L.found}\n\n${lines.join("\n\n")}\n\n${L.pickProduct(items.length)}`;
}

type Conv = NonNullable<Awaited<ReturnType<typeof prisma.conversation.findUnique>>>;

async function update(conv: Conv, data: Partial<Pick<Conv, "state" | "pendingOrders" | "verifyAttempts" | "mode" | "handoffReason" | "lang">>) {
  Object.assign(conv, data);
  await prisma.conversation.update({ where: { id: conv.id }, data });
}

async function handoff(shop: string, conv: Conv, reason: string) {
  await update(conv, { mode: "human", handoffReason: reason, state: "idle", pendingOrders: "[]" });
  await logEvent({ shop, source: "bot", event: "handoff", detail: reason });
}

async function deliverOrder(shop: string, conv: Conv, order: OrderSummary) {
  await update(conv, { state: "idle", pendingOrders: "[]", verifyAttempts: 0 });
  await logEvent({ shop, source: "shopify", event: "order_retrieved", detail: `${order.name} (${order.source ?? "shopify"})` });
  return formatOrder(order, asLang(conv.lang));
}

const asLang = (v: string): Lang => (v === "hi" || v === "hinglish" ? v : "en");

/** Customer-facing texts in the language the customer is writing in. */
const tpl = (conv: Conv, s: Settings): Templates => (conv.lang === "hi" ? TEMPLATES_HI : s.templates);

async function failVerification(shop: string, conv: Conv, s: Settings) {
  const attempts = conv.verifyAttempts + 1;
  await update(conv, { verifyAttempts: attempts });
  await logEvent({ shop, source: "bot", event: "verification_failed", detail: `attempt ${attempts}` });
  const t = tpl(conv, s);
  // Same words whether the order does not exist or belongs to someone else: nothing about other people's orders is revealed.
  if (attempts >= s.maxVerifyAttempts) {
    await handoff(shop, conv, "Too many failed order verifications");
    return `${t.noOrderFound}\n\n${t.handoff}`;
  }
  return t.noOrderFound;
}

/** Looks up an order by number in Shopify and the IMS, and only releases it if it carries the sender's phone number. */
async function orderByNumberFlow(shop: string, conv: Conv, number: string, s: Settings) {
  const sender = normalizePhone(conv.phone);
  const order = sender ? await findOrderEverywhere(shop, number, sender) : null;
  // Identical reply for "not found" and "belongs to someone else": no information leak.
  if (!order) return failVerification(shop, conv, s);
  return deliverOrder(shop, conv, order);
}

async function decideReply(shop: string, conv: Conv, msg: InboundPayload, s: Settings, fixedLang?: Lang): Promise<string | Reply> {
  const text = msg.text.trim();
  if (!text) return msg.media ? tpl(conv, s).mediaReceived : tpl(conv, s).unknown;

  // Follow the customer's language; ambiguous input ("2", "#1001") keeps the previous one.
  if (!fixedLang) {
    const detected = detectLanguage(text);
    if (detected && detected !== "other" && detected !== conv.lang) await update(conv, { lang: detected });
  }
  const lang: Lang = fixedLang ?? asLang(conv.lang);
  const ui = lang === "hi" ? "hi" : "en"; // fixed UI strings exist in English and Hindi; Hinglish readers get English
  const t = tpl(conv, s);
  const intent = detectIntent(text);
  const sender = normalizePhone(conv.phone);

  if (intent.type === "agent") {
    await handoff(shop, conv, "Customer requested a human agent");
    return t.handoff;
  }

  if (conv.state === "awaiting_order_selection") {
    let ids: string[] = [];
    try {
      ids = JSON.parse(conv.pendingOrders || "[]");
    } catch {
      /* corrupt state: treated as nothing pending */
    }
    const pick = parseSelection(text, ids.length);
    if (pick) {
      const [order] = await getOrdersEverywhere(shop, [ids[pick - 1]]);
      if (!order || !sender || !orderBelongsTo(order, sender)) return failVerification(shop, conv, s);
      return deliverOrder(shop, conv, order);
    }
    const num = extractOrderNumber(text) ?? text.trim().match(/^(\d{3,10})$/)?.[1];
    if (num) return orderByNumberFlow(shop, conv, num, s);
    return `${t.chooseOrder}\n${LABELS[ui].pick(ids.length)}`;
  }

  if (conv.state === "awaiting_product_selection") {
    let ids: string[] = [];
    try {
      ids = JSON.parse(conv.pendingOrders || "[]");
    } catch {
      /* corrupt state: treated as nothing pending */
    }
    const pick = parseSelection(text, ids.length);
    if (pick) {
      const [product] = await getProductsByIds(shop, [ids[pick - 1]]);
      await update(conv, { state: "idle", pendingOrders: "[]" });
      if (product) return productDetail(product, lang);
      return t.noProduct;
    }
    // Not a number: the customer typed a name or moved on, so run a normal search below.
    await update(conv, { state: "idle", pendingOrders: "[]" });
  }

  if (conv.state === "awaiting_order_number") {
    const num = extractOrderNumber(text) ?? text.trim().match(/^(\d{3,10})$/)?.[1];
    if (num) return orderByNumberFlow(shop, conv, num, s);
  }

  // Predefined quick replies (website, policies...) beat order lookup unless an order number was given.
  if (intent.type !== "tracking" && !("orderNumber" in intent && intent.orderNumber)) {
    const faqs = await prisma.faq.findMany({ where: { shop, enabled: true } });
    const hit = matchFaq(text, faqs);
    if (hit) {
      await logEvent({ shop, source: "bot", event: "faq_answered", detail: hit.title.slice(0, 60) });
      return pickFaqReply(hit, lang);
    }
  }

  if (intent.type === "order" || intent.type === "tracking") {
    if (intent.orderNumber) return orderByNumberFlow(shop, conv, intent.orderNumber, s);
    if (!sender) {
      await update(conv, { state: "awaiting_order_number" });
      return t.askOrderNumber;
    }
    const orders = await findOrdersEverywhere(shop, sender);
    if (orders.length === 0) {
      await update(conv, { state: "awaiting_order_number" });
      return t.askOrderNumber;
    }
    if (orders.length === 1) return deliverOrder(shop, conv, orders[0]);
    const shown = orders.slice(0, 5);
    await update(conv, { state: "awaiting_order_selection", pendingOrders: JSON.stringify(shown.map((o) => (o.source === "ims" ? `ims:${o.name}` : o.id))) });
    const list = shown
      .map((o, i) => `${i + 1}. ${o.name} — ${(lang === "hi" ? statusHi(o.fulfillmentStatus) : null) ?? titleCase(o.fulfillmentStatus)} (${new Date(o.createdAt).toLocaleDateString(LABELS[ui].locale)})`)
      .join("\n");
    return `${t.chooseOrder}\n${list}`;
  }

  // Explicit product request, or any short message that is just product words ("printer", "hp laser"):
  // send store links when we have it, otherwise say it's unavailable.
  const wordCount = text.split(/\s+/).length;
  const productQuery =
    intent.type === "product" ? intent.query : intent.type === "unknown" && wordCount <= 6 ? text : null;
  if (productQuery !== null) {
    if (productTerms(productQuery).length) return productReply(shop, conv, productQuery, s, t, lang, ui);
    if (intent.type === "product") return t.unknown;
  }

  if (intent.type === "greeting") return t.greeting;

  // Optional AI fallback. With no key (or on any AI error) this returns null and the bot
  // behaves exactly as before.
  if (!rateLimited(`ai:${conv.phone}`, 20, 3_600_000)) {
    const ai = await askAi(shop, conv, text, lang);
    if (ai === HANDOFF_MARK) {
      await handoff(shop, conv, "AI could not answer; passed to a human");
      return t.handoff;
    }
    if (ai) return ai;
  }
  return t.unknown;
}

async function productReply(shop: string, conv: Conv, query: string, s: Settings, t: Templates, lang: Lang, ui: "en" | "hi"): Promise<string | Reply> {
  await logEvent({ shop, source: "bot", event: "product_inquiry", detail: query.slice(0, 80) });
  const found = await searchProducts(shop, query, 5);
  // Powers the "Product Enquiries" page: which number asked for which product, and whether we had it.
  await prisma.productEnquiry
    .create({
      data: {
        shop, conversationId: conv.id, phone: conv.phone, customerName: conv.customerName,
        query: query.slice(0, 120), found: found.length > 0, products: JSON.stringify(found.slice(0, 5).map((p) => p.title)),
      },
    })
    .catch(() => undefined);
  if (!found.length) return t.noProduct;

  // One clear match (or the only one containing every word typed) -> full details + photo right away.
  const terms = productTerms(query);
  const exact = found.filter((p) => terms.every((w) => p.title.toLowerCase().includes(w)));
  const single = found.length === 1 ? found[0] : exact.length === 1 && terms.length > 1 ? exact[0] : null;
  if (single) {
    const reply = productDetail(single, lang);
    if (s.recommendationsEnabled && s.maxRecommendations > 0) {
      const recs = await recommendProducts(shop, single, s.recommendationRule, s.maxRecommendations);
      if (recs.length) {
        const more = `${LABELS[ui].more}\n${formatProducts(recs, lang)}`;
        reply.text += `\n\n${more}`;
        if (reply.image) reply.image.rest += `\n\n${more}`;
        await logEvent({ shop, source: "bot", event: "recommendation_sent", detail: `${recs.length} item(s)` });
      }
    }
    return reply;
  }
  await update(conv, { state: "awaiting_product_selection", pendingOrders: JSON.stringify(found.map((p) => p.id)) });
  return productList(found, lang);
}

async function askAi(shop: string, conv: Conv, question: string, lang: Lang) {
  const [faqs, recent] = await Promise.all([
    prisma.faq.findMany({ where: { shop, enabled: true } }),
    prisma.message.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: "desc" }, take: 7 }),
  ]);
  const facts = faqs
    .filter((f) => f.replyEn.trim() || f.replyHi.trim())
    .map((f) => `- ${f.title.replace(/^WERY: /, "")}: ${f.replyEn.trim() || f.replyHi.trim()}`)
    .join("\n")
    .slice(0, 8000);
  const history = recent
    .reverse()
    .slice(0, -1) // the current question is passed separately
    .map((m) => ({ role: m.direction === "in" ? ("user" as const) : ("assistant" as const), content: m.body.slice(0, 500) }));
  return aiFallbackReply({ shop, lang, question, history, facts });
}

/** Processes one inbound WhatsApp message. Safe to call again for the same message id. */
export async function handleInbound(shop: string, msg: InboundPayload) {
  const phone = normalizePhone(msg.from) ?? `+${msg.from.replace(/\D/g, "")}`;
  const now = new Date();
  const conv = await prisma.conversation.upsert({
    where: { shop_phone: { shop, phone } },
    create: { shop, phone, customerName: msg.name ?? null, lastInboundAt: now, lastMessageAt: now },
    update: {
      lastInboundAt: now,
      lastMessageAt: now,
      status: "open",
      ...(msg.name ? { customerName: msg.name } : {}),
    },
  });

  await prisma.message
    .create({
      data: {
        conversationId: conv.id,
        direction: "in",
        sender: "customer",
        body: (msg.text || (msg.media ? "" : `[${msg.type} message]`)).slice(0, 4000),
        waMessageId: msg.id,
        status: "received",
        mediaKind: msg.media?.kind ?? null,
        mediaMime: msg.media?.mime ?? null,
        mediaName: msg.media?.name ?? null,
        mediaFile: msg.media?.file ?? null,
      },
    })
    .catch(() => undefined); // already stored on an earlier attempt

  const s = await getSettings(shop);
  if (conv.mode === "human" || !s.enabled) return;

  const key = msg.id;
  const rawText = msg.text.trim();
  const detected = detectLanguage(rawText);

  // Any-language support: other scripts are translated to English, answered by the normal bot, and translated back.
  let pivot: string | null = null;
  let work = msg;
  if (rawText && (detected === "other" || (detected === null && conv.lang.startsWith("x:")))) {
    if (detected === "other") {
      const t = rateLimited(`tr:${phone}`, 60, 3_600_000) ? null : await translateToEnglish(shop, rawText);
      if (!t) {
        const body = `${s.templates.unsupportedLanguage}\n\n${TEMPLATES_HI.unsupportedLanguage}`;
        const sent = await sendAndRecord({ shop, conversationId: conv.id, to: phone, body, sender: "bot", inReplyTo: key });
        if (!sent.ok) throw new Error(sent.error ?? "send failed");
        return;
      }
      pivot = t.language;
      work = { ...msg, text: t.english };
      if (conv.lang !== `x:${pivot}`) await update(conv, { lang: `x:${pivot}` });
    } else {
      pivot = conv.lang.slice(2);
    }
  }
  // Inside the pipeline an English view of the conversation is used when pivoting.
  const view: Conv = pivot ? { ...conv, lang: "en" } : conv;

  let decided: string | Reply;
  try {
    decided = await decideReply(shop, view, work, s, pivot ? "en" : undefined);
  } catch (e) {
    await logEvent({ shop, source: "bot", level: "error", event: "lookup_failed", detail: String((e as Error).message) });
    // Distinct key so a later successful retry can still deliver the real answer.
    await sendAndRecord({ shop, conversationId: conv.id, to: phone, body: tpl(view, s).lookupError, sender: "bot", inReplyTo: `${msg.id}:err` });
    throw e;
  }
  const out: Reply = typeof decided === "string" ? { text: decided } : decided;
  if (!out.text.trim()) return;

  // Product photo first (caption = name/price), then the rest as text. Any photo problem falls back to plain text.
  let text = out.text;
  if (out.image && !pivot && (await canSendMedia())) {
    const media = await fetchProductImage(out.image.url);
    if (media) {
      const img = await sendAndRecord({
        shop, conversationId: conv.id, to: phone, body: out.image.caption, sender: "bot", inReplyTo: `${key}:img`, media,
      });
      if (img.ok) text = out.image.rest;
    }
  }
  if (pivot) text = (await translateReply(shop, text, pivot)) ?? text;
  const sent = await sendAndRecord({ shop, conversationId: conv.id, to: phone, body: text, sender: "bot", inReplyTo: key });
  if (!sent.ok) throw new Error(sent.error ?? "send failed");
}

async function fetchProductImage(url: string): Promise<{ kind: string; mime: string; file: string } | null> {
  try {
    if (new URL(url).protocol !== "https:") return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!res.ok || !["image/jpeg", "image/png", "image/webp"].includes(mime)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_MEDIA_BYTES) return null;
    const saved = saveMedia(buf, mime);
    return { kind: "image", mime: saved.mime, file: saved.file };
  } catch {
    return null;
  }
}
