import prisma from "../db.server";
import { aiFallbackReply, HANDOFF_MARK, translateReply, translateToEnglish } from "./ai.server";
import { matchFaq, pickFaqReply } from "./faq";
import { detectIntent, parseSelection, productTerms, type Intent } from "./intent";
import { detectLanguage, type Lang } from "./lang";
import { logEvent } from "./log.server";
import { findLooseOrderRef, findMarkedOrderRef, parseOrderRef, refIsPhone } from "./order-ref";
import { findPhoneInText, normalizePhone, samePhone } from "./phone";
import { productLines, productMessage } from "./product-summary";
import { rateLimited } from "./rate-limit.server";
import { clip, compose, numbered, shortDate, titleCase } from "./reply-format";
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
import { DEFAULT_TEMPLATES, LABELS, statusHi, TEMPLATES_HI, type Templates } from "./templates";

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

/** Shopify / IMS access used by the bot. Replaceable so the conversation logic can be tested without Shopify. */
export type BotDeps = {
  findOrder: typeof findOrderEverywhere;
  findOrders: typeof findOrdersEverywhere;
  getOrders: typeof getOrdersEverywhere;
  searchProducts: typeof searchProducts;
  getProducts: typeof getProductsByIds;
  recommend: typeof recommendProducts;
};
const defaultDeps: BotDeps = {
  findOrder: findOrderEverywhere,
  findOrders: findOrdersEverywhere,
  getOrders: getOrdersEverywhere,
  searchProducts,
  getProducts: getProductsByIds,
  recommend: recommendProducts,
};

const labelsFor = (lang: Lang) => LABELS[lang === "hi" ? "hi" : "en"];

/** The order as short numbered points: details first, then every shipment with its own courier / tracking id / link. */
export function formatOrder(o: OrderSummary, lang: Lang = "en"): string {
  const L = labelsFor(lang);
  const show = (raw: string | null) => (lang === "hi" ? statusHi(raw) : null) ?? (titleCase(raw) || L.unknownStatus);
  const orderStatus = o.cancelled ? L.cancelled : o.closed ? L.closed : L.active;
  const items = o.items.map((i) => `${i.title} × ${i.quantity}`).join(", ");
  const blocks = [
    compose({
      intro: L.intro,
      points: [
        `${L.orderNo}: ${o.name}`,
        `${L.date}: ${shortDate(o.createdAt, L.locale) ?? "—"}`,
        `${L.status}: ${orderStatus}`,
        `${L.fulfillment}: ${o.cancelled ? L.cancelled : show(o.fulfillmentStatus)}`,
        `${L.payment}: ${show(o.financialStatus)}`,
        o.total && `${L.total}: ${o.total}`,
        items && `${L.items}: ${clip(items, 160)}`,
      ],
    }),
  ];
  if (!o.cancelled) {
    if (o.tracking.length) {
      const many = o.tracking.length > 1;
      const shipments = o.tracking.map((t, i) => {
        const delivered = t.status === "DELIVERED";
        return compose({
          intro: many ? `${L.shipment} ${i + 1}:` : undefined,
          points: [
            t.company && `${L.courier}: ${t.company}`,
            t.number && `${L.trackNo}: ${t.number}`,
            t.status && `${L.shipStatus}: ${show(t.status)}`,
            t.resolvedUrl && `${L.trackLink}: ${t.resolvedUrl}`,
            !delivered && shortDate(t.estimatedDeliveryAt, L.locale) ? `${L.eta}: ${shortDate(t.estimatedDeliveryAt, L.locale)}` : null,
          ],
        });
      });
      blocks.push([L.trackIntro, ...shipments].join("\n\n"));
    } else {
      blocks.push(L.noTracking);
      if (o.statusUrl) blocks.push(`${L.statusPage}: ${o.statusUrl}`);
    }
  }
  blocks.push(L.thanks);
  return blocks.join("\n\n");
}

/** A bot answer; `image` is sent first (caption = headline) and `rest` follows as text. */
export type Reply = { text: string; image?: { url: string; caption: string; rest: string } };

/** One product as short numbered points (or the combo contents), plus its photo. */
export function productDetail(p: ProductSummary, lang: Lang = "en"): Reply {
  const m = productMessage(p, labelsFor(lang));
  return { text: m.text, image: p.imageUrl ? { url: p.imageUrl, caption: m.head, rest: m.body } : undefined };
}

/** Compact numbered list (name, price) so the customer can pick one. */
export function productList(items: ProductSummary[], lang: Lang = "en"): string {
  const L = labelsFor(lang);
  const rows = items.map((p) => `*${p.title}*${p.price ? `\n   ${L.price}: ${p.price}` : ""}${p.compareAtPrice ? ` (~${p.compareAtPrice}~)` : ""}`);
  return compose({ intro: L.found, points: rows, next: L.pickProduct(items.length) });
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

/** Order details, then the "anything else?" question (answered by awaiting_followup below). */
async function deliverOrder(shop: string, conv: Conv, order: OrderSummary, s: Settings) {
  await update(conv, { state: "awaiting_followup", pendingOrders: "[]", verifyAttempts: 0 });
  await logEvent({ shop, source: "shopify", event: "order_retrieved", detail: `${order.name} (${order.source ?? "shopify"})` });
  return [formatOrder(order, asLang(conv.lang)), tpl(conv, s).askMore].filter(Boolean).join("\n\n");
}

/** Adds the "anything else?" question to a product answer (text and the text that follows the photo). */
async function withFollowup(conv: Conv, s: Settings, reply: Reply): Promise<Reply> {
  const more = tpl(conv, s).askMore;
  if (!more) return reply;
  await update(conv, { state: "awaiting_followup", pendingOrders: "[]" });
  return { text: `${reply.text}\n\n${more}`, image: reply.image ? { ...reply.image, rest: `${reply.image.rest}\n\n${more}` } : undefined };
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

/** Looks up an order by its number (#W1219 / W1219 / 1219) in Shopify and the IMS, and only releases it if it carries the sender's phone number. */
async function orderByNumberFlow(shop: string, conv: Conv, number: string, s: Settings, deps: BotDeps) {
  const sender = normalizePhone(conv.phone);
  const order = sender ? await deps.findOrder(shop, number, sender) : null;
  // Identical reply for "not found" and "belongs to someone else": no information leak.
  if (!order) return failVerification(shop, conv, s);
  return deliverOrder(shop, conv, order, s);
}

/** Orders placed with the sender's own number: one -> its details, several -> a numbered list to choose from, none -> ask. */
async function orderOverview(shop: string, conv: Conv, s: Settings, deps: BotDeps, lang: Lang) {
  const t = tpl(conv, s);
  const L = labelsFor(lang);
  const sender = normalizePhone(conv.phone);
  const orders = sender ? await deps.findOrders(shop, sender) : [];
  if (orders.length === 0) {
    await update(conv, { state: "awaiting_order_number" });
    return t.askOrderNumber;
  }
  if (orders.length === 1) return deliverOrder(shop, conv, orders[0], s);
  const shown = orders.slice(0, 5);
  await update(conv, { state: "awaiting_order_selection", pendingOrders: JSON.stringify(shown.map((o) => (o.source === "ims" ? `ims:${o.name}` : o.id))) });
  const list = numbered(
    shown.map((o) => `${o.name} — ${o.cancelled ? L.cancelled : (lang === "hi" ? statusHi(o.fulfillmentStatus) : null) ?? (titleCase(o.fulfillmentStatus) || L.unknownStatus)} (${shortDate(o.createdAt, L.locale) ?? "—"})`),
  );
  return `${t.chooseOrder}\n\n${list}`;
}

/**
 * The customer typed a mobile number. Orders are only shown for the number they are chatting from:
 * anyone could type someone else's number, so a different number never reveals anything (not even whether it has orders).
 */
async function phoneFlow(shop: string, conv: Conv, typed: string, s: Settings, deps: BotDeps, lang: Lang) {
  const sender = normalizePhone(conv.phone);
  if (!sender || !samePhone(typed, sender)) {
    await logEvent({ shop, source: "bot", event: "phone_mismatch", detail: "order lookup by a different number was refused" });
    return tpl(conv, s).phoneMismatch;
  }
  return orderOverview(shop, conv, s, deps, lang);
}

/** "How would you like to check your order?" with numbered choices (answered by awaiting_order_choice). */
async function askOrderHow(conv: Conv, s: Settings) {
  await update(conv, { state: "awaiting_order_choice" });
  return tpl(conv, s).askOrderDetails;
}

const readIds = (conv: Conv): string[] => {
  try {
    return JSON.parse(conv.pendingOrders || "[]");
  } catch {
    return []; // corrupt state: treated as nothing pending
  }
};

export async function decideReply(
  shop: string,
  conv: Conv,
  msg: InboundPayload,
  s: Settings,
  fixedLang?: Lang,
  deps: BotDeps = defaultDeps,
): Promise<string | Reply> {
  const text = msg.text.trim();
  if (!text) return msg.media ? tpl(conv, s).mediaReceived : tpl(conv, s).unknown;

  // Follow the customer's language; ambiguous input ("2", "#W1219") keeps the previous one.
  if (!fixedLang) {
    const detected = detectLanguage(text);
    if (detected && detected !== "other" && detected !== conv.lang) await update(conv, { lang: detected });
  }
  const lang: Lang = fixedLang ?? asLang(conv.lang);
  const ui = lang === "hi" ? "hi" : "en"; // fixed UI strings exist in English and Hindi; Hinglish readers get English
  const t = tpl(conv, s);
  let intent: Intent = detectIntent(text);
  const sender = normalizePhone(conv.phone);

  if (intent.type === "agent") {
    await handoff(shop, conv, "Customer requested a human agent");
    return t.handoff;
  }

  // Answer to the welcome menu: 1 Find a Product, 2 Check Order Status, 3 Track My Shipment, 4 Product Information, 5 Support.
  if (conv.state === "awaiting_menu") {
    const pick = parseSelection(text, 5);
    await update(conv, { state: "idle" });
    if (pick === 1 || pick === 4) {
      await update(conv, { state: "awaiting_product_query" });
      return t.askProductName;
    }
    if (pick === 2 || pick === 3) return askOrderHow(conv, s);
    if (pick === 5) {
      await handoff(shop, conv, "Customer chose support from the menu");
      return t.handoff;
    }
    // Anything else is a normal message and is handled below.
  }

  // Answer to "Anything else I can help with?": 1 Find a Product, 2 Check Order Status, 3 Support. "thanks" / "no" ends politely.
  if (conv.state === "awaiting_followup") {
    const pick = parseSelection(text, 3);
    await update(conv, { state: "idle" });
    if (pick === 1) {
      await update(conv, { state: "awaiting_product_query" });
      return t.askProductName;
    }
    if (pick === 2) return askOrderHow(conv, s);
    if (pick === 3) {
      await handoff(shop, conv, "Customer chose support after an answer");
      return t.handoff;
    }
    if (/^(no|nope|nahi|nahin|नहीं|nothing|thanks?|thank you|thankyou|ok|okay|done|bas|shukriya|dhanyavad|धन्यवाद|शुक्रिया)\b/i.test(text)) return t.thanksReply;
  }

  // "How would you like to check your order?": 1 this WhatsApp number, 2 order number, 3 registered mobile number.
  if (conv.state === "awaiting_order_choice") {
    const pick = parseSelection(text, 3);
    if (pick === 1) return orderOverview(shop, conv, s, deps, lang);
    if (pick === 2 || pick === 3) {
      await update(conv, { state: "awaiting_order_number" });
      return pick === 2 ? t.typeOrderNumber : t.typeMobileNumber;
    }
    // A number typed straight away ("#W1219", "9876543210") is handled with the next block.
  }

  if (conv.state === "awaiting_order_selection") {
    const ids = readIds(conv);
    const pick = parseSelection(text, ids.length);
    if (pick) {
      const [order] = await deps.getOrders(shop, [ids[pick - 1]]);
      if (!order || !sender || !orderBelongsTo(order, sender)) return failVerification(shop, conv, s);
      return deliverOrder(shop, conv, order, s);
    }
    const ref = findMarkedOrderRef(text) ?? findLooseOrderRef(text) ?? parseOrderRef(text);
    if (ref) return orderByNumberFlow(shop, conv, ref.key, s, deps);
    return `${t.chooseOrder}\n${LABELS[ui].pick(ids.length)}`;
  }

  if (conv.state === "awaiting_product_selection") {
    const ids = readIds(conv);
    const pick = parseSelection(text, ids.length);
    if (pick) {
      const [product] = await deps.getProducts(shop, [ids[pick - 1]]);
      await update(conv, { state: "idle", pendingOrders: "[]" });
      if (product) return withFollowup(conv, s, productDetail(product, lang));
      return t.noProduct;
    }
    // Not a number: the customer typed a name or moved on, so run a normal search below.
    await update(conv, { state: "idle", pendingOrders: "[]" });
  }

  if (conv.state === "awaiting_product_query") {
    await update(conv, { state: "idle" });
    if (!["order", "tracking", "greeting"].includes(intent.type)) {
      const query = intent.type === "product" ? intent.query : text;
      if (productTerms(query).length) return productReply(shop, conv, query, s, t, lang, ui, deps);
      await update(conv, { state: "awaiting_product_query" });
      return t.askProductName;
    }
  }

  if (conv.state === "awaiting_order_number" || conv.state === "awaiting_order_choice") {
    if (conv.state === "awaiting_order_number") {
      const pick = parseSelection(text, 2); // the question listed "1. Order Number, 2. registered mobile number"
      if (pick === 1) return t.typeOrderNumber;
      if (pick === 2) return t.typeMobileNumber;
    }
    const marked = findMarkedOrderRef(text);
    if (marked && !refIsPhone(marked)) return orderByNumberFlow(shop, conv, marked.key, s, deps);
    const phone = findPhoneInText(text);
    if (phone) return phoneFlow(shop, conv, phone, s, deps, lang);
    const ref = findLooseOrderRef(text) ?? parseOrderRef(text);
    if (ref) return orderByNumberFlow(shop, conv, ref.key, s, deps);
  }

  // A bare "W1219" is an order only when it is one of THIS customer's orders; otherwise it may be a product model.
  if (intent.type === "order" && intent.weak && intent.orderNumber) {
    const found = sender ? await deps.findOrder(shop, intent.orderNumber, sender) : null;
    if (found) return deliverOrder(shop, conv, found, s);
    intent = { type: "unknown" };
  }

  // Predefined quick replies (website, policies...) beat order lookup unless an order number or phone was given.
  const hasRef = (intent.type === "order" || intent.type === "tracking") && !!(intent.orderNumber || intent.phone);
  if (intent.type !== "tracking" && !hasRef) {
    const faqs = await prisma.faq.findMany({ where: { shop, enabled: true } });
    const hit = matchFaq(text, faqs);
    if (hit) {
      await logEvent({ shop, source: "bot", event: "faq_answered", detail: hit.title.slice(0, 60) });
      return pickFaqReply(hit, lang);
    }
  }

  if (intent.type === "order" || intent.type === "tracking") {
    if (intent.orderNumber) return orderByNumberFlow(shop, conv, intent.orderNumber, s, deps);
    if (intent.phone) return phoneFlow(shop, conv, intent.phone, s, deps, lang);
    return askOrderHow(conv, s);
  }

  // Explicit product request, or any short message that is just product words ("printer", "hp laser"):
  // send store links when we have it, otherwise say it's unavailable.
  const wordCount = text.split(/\s+/).length;
  const productQuery =
    intent.type === "product" ? intent.query : intent.type === "unknown" && wordCount <= 6 ? text : null;
  if (productQuery !== null) {
    if (productTerms(productQuery).length) return productReply(shop, conv, productQuery, s, t, lang, ui, deps);
    if (intent.type === "product") return t.unknown;
  }

  if (intent.type === "greeting") {
    // Only the built-in menu is a numbered menu we can interpret; a custom greeting is just sent as written.
    if (t.greeting === DEFAULT_TEMPLATES.greeting || t.greeting === TEMPLATES_HI.greeting) await update(conv, { state: "awaiting_menu" });
    return t.greeting;
  }

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

async function productReply(shop: string, conv: Conv, query: string, s: Settings, t: Templates, lang: Lang, ui: "en" | "hi", deps: BotDeps): Promise<string | Reply> {
  await logEvent({ shop, source: "bot", event: "product_inquiry", detail: query.slice(0, 80) });
  const found = await deps.searchProducts(shop, query, 5);
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

  // One clear match (or the only one containing every word typed) -> short key points + photo right away.
  const terms = productTerms(query);
  const exact = found.filter((p) => terms.every((w) => p.title.toLowerCase().includes(w)));
  const single = found.length === 1 ? found[0] : exact.length === 1 && terms.length > 1 ? exact[0] : null;
  if (single) {
    const reply = productDetail(single, lang);
    if (s.recommendationsEnabled && s.maxRecommendations > 0) {
      const recs = await deps.recommend(shop, single, s.recommendationRule, s.maxRecommendations);
      if (recs.length) {
        const more = `${LABELS[ui].more}\n${productLines(recs)}`;
        reply.text += `\n\n${more}`;
        if (reply.image) reply.image.rest += `\n\n${more}`;
        await logEvent({ shop, source: "bot", event: "recommendation_sent", detail: `${recs.length} item(s)` });
      }
    }
    return withFollowup(conv, s, reply);
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
