import { contentTokens } from "./faq.ts";

export type Intent =
  | { type: "agent" }
  | { type: "greeting" }
  | { type: "order"; orderNumber?: string }
  | { type: "tracking"; orderNumber?: string }
  | { type: "product"; query: string }
  | { type: "unknown" };

export function extractOrderNumber(text: string): string | undefined {
  const hash = text.match(/#\s?(\d{3,10})\b/);
  if (hash) return hash[1];
  const m = text.match(/\border(?:\s*(?:no|number|id))?\s*[:-]?\s*#?(\d{3,10})\b/i);
  if (m) return m[1];
  const hi = text.match(/(?:ऑर्डर|आर्डर|ओर्डर)\s*(?:नंबर|नं|no)?\s*[:-]?\s*#?(\d{3,10})/i);
  if (hi) return hi[1];
  return undefined;
}

// Hindi (Devanagari) has no ASCII word boundaries, so these use plain substring checks.
const HI_AGENT = /(एजेंट|इंसान|कस्टमर केयर|सपोर्ट|किसी से बात|व्यक्ति से बात)/;
const HI_TRACK = /(ट्रैक|कहाँ|कहां|कब आएगा|कब तक|डिलीवरी|शिपमेंट|कूरियर)/;
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
  const orderNumber = extractOrderNumber(text);
  if (
    /\b(track|tracking|shipment|shipped|courier|delivery|awb|where is my|kahan|kahaan|kab aayega|kab tak|pahunchega)\b/.test(t) ||
    HI_TRACK.test(t)
  ) {
    return { type: "tracking", orderNumber };
  }
  if (/\b(order|status|invoice|payment)\b/.test(t) || HI_ORDER.test(t) || orderNumber) {
    return { type: "order", orderNumber };
  }
  const prod = t.match(
    /\b(?:do you have|looking for|need|want|buy|price of|price for|cost of|show me|search|availability of|available|product|recommend)\s+(?:a |an |the |some )?(.+)$/,
  );
  if (prod && prod[1].trim().length >= 2) {
    return { type: "product", query: prod[1].replace(/[?.!]+$/, "").trim() };
  }
  // Hinglish / Hindi: "<product> chahiye", "<product> ka price", "<product> hai kya"
  const hiProd = t.match(/^(.{2,60}?)\s+(?:chahiye|chahie|ka price|ki price|ka rate|ki kimat|hai kya|available hai|चाहिए|का प्राइस|की कीमत|है क्या|उपलब्ध है)/);
  if (hiProd) return { type: "product", query: hiProd[1].trim() };
  if (/^(hi|hello|hey|hii+|namaste|namaskar|good (morning|afternoon|evening))\b/.test(t) || HI_GREET.test(t)) {
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

