import { contentTokens } from "./faq.ts";
import { findLooseOrderRef, findMarkedOrderRef, parseOrderRef, refIsPhone } from "./order-ref.ts";
import { findPhoneInText } from "./phone.ts";

export type Intent =
  | { type: "agent" }
  | { type: "greeting" }
  // orderNumber = "W1219" or "1219" (see order-ref.ts); phone = a mobile number the customer typed (E.164);
  // weak = a bare token like "M1005" that could also be a product model, so a miss must fall through to product search.
  | { type: "order"; orderNumber?: string; phone?: string; weak?: boolean }
  | { type: "tracking"; orderNumber?: string; phone?: string }
  | { type: "product"; query: string }
  | { type: "unknown" };

/** Order number the customer clearly marked ("#W1219", "order no 1002", "ऑर्डर नंबर 1002"), as "W1219" / "1002". */
export function extractOrderNumber(text: string): string | undefined {
  return findMarkedOrderRef(text)?.key;
}

// Hindi (Devanagari) has no ASCII word boundaries, so these use plain substring checks.
const HI_AGENT = /(एजेंट|इंसान|कस्टमर केयर|सपोर्ट|किसी से बात|व्यक्ति से बात)/;
const HI_TRACK = /(ट्रैक|कहाँ|कहां|कब आएगा|कब तक|डिलीवरी|शिपमेंट|कूरियर|पार्सल)/;
const HI_ORDER = /(ऑर्डर|आर्डर|ओर्डर|स्टेटस|भुगतान|पेमेंट)/;
const HI_GREET = /^(नमस्ते|नमस्कार|हेलो|हैलो|हाय|हाई|प्रणाम)/;

export function detectIntent(raw: string): Intent {
  const text = raw.trim();
  const t = text.toLowerCase();
  if (!t) return { type: "unknown" };

  if (
    /\b(agent|human|representative|support|person|executive|talk to someone|customer care|insaan|insan|baat karni|baat karna)\b/.test(t) ||
    HI_AGENT.test(t)
  ) {
    return { type: "agent" };
  }
  const markedRef = findMarkedOrderRef(text);
  const marked = markedRef && !refIsPhone(markedRef) ? markedRef.key : undefined;
  const trackWords =
    /\b(track|tracking|shipment|shipped|courier|delivery|delivered|dispatch|dispatched|parcel|awb|where is my|kahan|kahaan|kab aayega|kab tak|pahunchega)\b/.test(t) ||
    HI_TRACK.test(t);
  const orderWords = /\b(order|status|invoice|payment)\b/.test(t) || HI_ORDER.test(t);
  // A bare "W1219" is only an order when the customer is already talking about orders (or sends nothing else).
  const orderNumber = marked ?? (trackWords || orderWords ? findLooseOrderRef(text)?.key : undefined);
  const phone = findPhoneInText(text) ?? undefined;
  const withRefs = <T extends { type: "order" | "tracking" }>(base: T) => ({
    ...base,
    orderNumber,
    ...(phone && !orderNumber ? { phone } : {}),
  });
  if (trackWords) return withRefs({ type: "tracking" as const }) as Intent;
  if (orderWords || orderNumber) return withRefs({ type: "order" as const }) as Intent;
  if (phone && !/[\p{L}\p{M}]{4,}/u.test(text.replace(/\b(my|number|is|mobile|phone|no|mera|meri|hai|registered)\b/gi, ""))) {
    return { type: "order", phone };
  }
  const bare = parseOrderRef(text);
  if (bare && bare.prefix.length === 1) return { type: "order", orderNumber: bare.key, weak: true };
  const prod = t.match(
    /\b(?:do you have|looking for|need|want|buy|price of|price for|cost of|show me|search|availability of|available|product|recommend|tell me (?:more )?about|(?:more )?(?:info|information) (?:about|on|of)|details? (?:of|about|for)|specs? (?:of|for)|specifications? (?:of|for)|features? (?:of|for)|what(?:'s| is) (?:included|in) (?:in )?)\s*(?:a |an |the |some |this )?(.+)$/,
  );
  if (prod && prod[1].trim().length >= 2) {
    return { type: "product", query: prod[1].replace(/[?.!]+$/, "").trim() };
  }
  // Hinglish / Hindi: "<product> chahiye", "<product> ka price", "<product> hai kya"
  const hiProd = t.match(/^(.{2,60}?)\s+(?:chahiye|chahie|ka price|ki price|ka rate|ki kimat|hai kya|available hai|ke baare mein|ke bare mein|ki jankari|ki jaankari|ka detail|ki detail|की जानकारी|के बारे में|चाहिए|का प्राइस|की कीमत|है क्या|उपलब्ध है)/);
  if (hiProd) return { type: "product", query: hiProd[1].trim() };
  if (/^(hi|hello|hey|hii+|namaste|namaskar|menu|help|start|options|good (morning|afternoon|evening))\b/.test(t) || HI_GREET.test(t)) {
    return { type: "greeting" };
  }
  return { type: "unknown" };
}

/** Pure numeric choice from a list ("1", "2."). */
export function parseSelection(text: string, max: number): number | null {
  const m = text.trim().match(/^#?(\d{1,2})\.?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= max ? n : null;
}

// Words that never name a product ("price", "link", thanks...). Everything else is a search term.
const PRODUCT_NOISE = new Set(
  (
    "price prices rate cost link links product products item items show search find buy order available availability stock looking " +
    "recommend thanks thank thankyou ok okay yes no bye welcome good morning evening afternoon night shukriya dhanyavad " +
    "kimat kimaat daam dikhao dikha bhejo send share website store shop online"
  ).split(" "),
);

/** Search terms from free text: filler/noise removed, deduped, capped. */
export function productTerms(text: string): string[] {
  return contentTokens(text.replace(/[^\p{L}\p{M}\p{N}._\- ]/gu, " ").slice(0, 120))
    .filter((w) => !PRODUCT_NOISE.has(w) && (w.length >= 2 || /\p{N}/u.test(w)))
    .slice(0, 5);
}

