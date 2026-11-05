import type { Lang } from "./lang";

export type FaqLike = {
  keywords: string;
  replyEn: string;
  replyHi: string;
  replyHinglish?: string;
  questions?: string;
  enabled: boolean;
};

/** Lowercase tokens; letters, Devanagari marks and digits kept, surrounding punctuation stripped ("wery.in" stays whole). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, ""))
    .filter(Boolean);
}

export function splitKeywords(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((k) => tokenize(k).join(" "))
    .filter((k) => k.length >= 2);
}

// Filler words ignored by fuzzy question matching (English, Hinglish, Hindi).
const STOP = new Set(
  (
    "a an the is are am was were be do does did have has i me my mine we our you your it its this that these those and or but " +
    "can could will would should may might to of for in on at by with from about as if so than then there here please pls tell " +
    "know want need get give let how what when where why which who whom any some there ok okay hi hello hey kindly " +
    "kya hai hain ho hoga hogi hota hoti ka ki ke ko se mein me main par aap aapka aapki aapke mera meri mere mujhe hum humko " +
    "kaise kaisa kab kahan kaun kyun kyu kitna kitne kitni karna karni karo karun karein kare kar chahiye chahie bhi toh to " +
    "ye yeh woh wo abhi bata batao bataiye bataye sakta sakte sakti sakata dena dijiye diya de do " +
    "क्या है हैं हो का की के को से में पर मैं मेरा मेरी मुझे आप कैसे कब कहाँ कहां कौन क्यों कितना कितने करना करें करो चाहिए भी तो यह वह अभी बताओ बताइए"
  ).split(/\s+/),
);

const stem = (w: string) => (/^[a-z]+$/.test(w) && w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w);

export function contentTokens(text: string): string[] {
  return [...new Set(tokenize(text).map(stem).filter((w) => !STOP.has(w)))];
}

const MAX_WORDS = 8;
const FUZZY_MIN_COVERAGE = 0.66;

type Question<T> = { faq: T; tokens: string[] };
type Index<T> = {
  phrases: Map<string, T>;
  byToken: Map<string, Question<T>[]>;
  sig: string;
};
let cached: Index<FaqLike> | null = null;

function buildIndex<T extends FaqLike>(faqs: T[]): Index<T> {
  const phrases = new Map<string, T>();
  const byToken = new Map<string, Question<T>[]>();
  for (const faq of faqs) {
    if (!faq.enabled) continue;
    for (const k of splitKeywords(faq.keywords)) {
      if (k.split(" ").length <= MAX_WORDS && !phrases.has(k)) phrases.set(k, faq);
    }
    for (const line of (faq.questions ?? "").split("\n")) {
      const tokens = contentTokens(line);
      if (tokens.length < 2) continue; // single-word questions are too ambiguous for fuzzy matching
      const q: Question<T> = { faq, tokens };
      for (const t of tokens) {
        const list = byToken.get(t);
        if (list) list.push(q);
        else byToken.set(t, [q]);
      }
    }
  }
  return { phrases, byToken, sig: "" };
}

const signature = (faqs: FaqLike[]) =>
  faqs
    .map(
      (f) =>
        `${f.enabled ? 1 : 0}:${f.keywords.length}:${f.keywords.slice(0, 24)}:${f.keywords.slice(-24)}` +
        `:${(f.questions ?? "").length}:${(f.questions ?? "").slice(0, 24)}:${(f.questions ?? "").slice(-24)}`,
    )
    .join("|");

/**
 * 1) Exact phrase: any 1..8-word run of the message found in the keyword index (O(words), fast
 *    even with 100k phrases); the longest phrase wins.
 * 2) Fuzzy: a stored question matches when at least 2/3 of its content words appear in the message.
 */
export function matchFaq<T extends FaqLike>(text: string, faqs: T[]): T | null {
  const sig = signature(faqs);
  if (!cached || cached.sig !== sig) cached = { ...buildIndex(faqs), sig };
  const index = cached as Index<T>;
  const words = tokenize(text);

  let best: { faq: T; len: number } | null = null;
  for (let i = 0; i < words.length; i++) {
    let phrase = "";
    for (let j = i; j < Math.min(words.length, i + MAX_WORDS); j++) {
      phrase = phrase ? `${phrase} ${words[j]}` : words[j];
      const hit = index.phrases.get(phrase);
      if (hit && (!best || phrase.length > best.len)) best = { faq: hit, len: phrase.length };
    }
  }
  if (best) return best.faq;

  const msg = contentTokens(text);
  if (msg.length < 2 || msg.length > 14) return null;
  const hits = new Map<Question<T>, number>();
  for (const t of msg) for (const q of index.byToken.get(t) ?? []) hits.set(q, (hits.get(q) ?? 0) + 1);
  let top: { faq: T; coverage: number; matched: number } | null = null;
  for (const [q, matched] of hits) {
    const coverage = matched / q.tokens.length;
    if (matched < 2 || coverage < FUZZY_MIN_COVERAGE) continue;
    if (!top || coverage > top.coverage || (coverage === top.coverage && matched > top.matched)) {
      top = { faq: q.faq, coverage, matched };
    }
  }
  return top?.faq ?? null;
}

/** Reply in the customer's language; falls back English → whichever exists so a reply is always sent. */
export function pickFaqReply(f: Pick<FaqLike, "replyEn" | "replyHi" | "replyHinglish">, lang: Lang): string {
  const order =
    lang === "hi"
      ? [f.replyHi, f.replyHinglish, f.replyEn]
      : lang === "hinglish"
        ? [f.replyHinglish, f.replyEn, f.replyHi]
        : [f.replyEn, f.replyHinglish, f.replyHi];
  return order.map((r) => (r ?? "").trim()).find(Boolean) ?? "";
}
