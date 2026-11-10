// Turns a Shopify product (title, description, variants, tags) into a few short numbered points.
// Nothing is invented: every point comes from the listing. When the listing is unclear the reply says so.
import { clip, compose, numbered } from "./reply-format.ts";

export type ProductLike = {
  title: string;
  handle?: string;
  /** Plain-text description (may have lost its line breaks). */
  description: string;
  /** HTML description; preferred because lists and line breaks survive. */
  descriptionHtml?: string;
  productType?: string;
  tags?: string[];
  vendor?: string;
  price: string | null;
  compareAtPrice?: string | null;
  discountPercent?: number | null;
  available?: boolean;
  url: string | null;
  variants?: { title: string; price: string | null; sku: string | null }[];
};

export type ProductLabels = {
  details: string;
  comboIntro: string;
  mainProduct: string;
  included: string;
  optional: string;
  comboPrice: string;
  price: string;
  warranty: string;
  stock: string;
  inStock: string;
  save: string;
  viewProduct: string;
  viewCombo: string;
  options: string;
  noDetails: string;
  comboUnclear: string;
  askTeam: string;
  piece: string;
  pieces: string;
  pack: string;
  packs: string;
};

// ---------- HTML / text ----------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", bull: "•", times: "×", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', reg: "®", trade: "™", copy: "©" };

/** Description HTML -> text where every list item, paragraph and line break is its own line. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\s*\/\s*(p|div|h[1-6]|ul|ol|tr|table|section)\s*>/gi, "\n")
    .replace(/<\s*(p|div|h[1-6]|ul|ol|tr|table|section)[^>]*>/gi, "\n")
    .replace(/<\s*\/\s*t[dh]\s*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type Line = { text: string; bullet: boolean; blankBefore: boolean };

const BULLET = /^\s*(?:[-–—•·*▪●►✔✓✅➤→]+|\d{1,2}[.)])\s+/;

function toLines(text: string): Line[] {
  const out: Line[] = [];
  let blank = false;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.replace(/\s+/g, " ").trim();
    if (!t) {
      blank = true;
      continue;
    }
    const bullet = BULLET.test(raw);
    out.push({ text: t.replace(BULLET, "").trim(), bullet, blankBefore: blank });
    blank = false;
  }
  return out;
}

const linesOf = (p: ProductLike): Line[] => toLines(p.descriptionHtml?.trim() ? htmlToText(p.descriptionHtml) : p.description || "");

// ---------- Specs, features, warranty ----------

const SPEC = /^([A-Za-z][A-Za-z0-9 /&().+]{1,38}?)\s*(?::|：|\s[-–—]\s)\s*(.{1,100})$/;
const IMPORTANT = /(type|technology|function|connect|interface|print|speed|resolution|ram|storage|memory|capacity|size|weight|colou?r|model|brand|compat|processor|display|screen|battery|power|material|paper|ink|toner|cartridge|duplex|wi-?fi|usb)/i;
const WARRANTY = /(warranty|guarantee|वारंटी|गारंटी)/i;

function warrantyOf(lines: Line[]): string | null {
  for (const l of lines) {
    if (!WARRANTY.test(l.text)) continue;
    const m = l.text.match(SPEC);
    const value = m && WARRANTY.test(m[1]) ? m[2] : l.text;
    return clip(value, 90);
  }
  return null;
}

// ---------- Combos ----------

const COMBO_WORDS = /\b(combo|bundle|kit|set of|pack of|with free|offer pack)\b/i;
const INCLUDED_HDR =
  /^(?:what(?:'s|\s+is|\s+are)?\s+)?(?:included|in\s+the\s+box|in\s+the\s+pack(?:age)?|package\s+(?:contents|includes?|contains)|box\s+contents|(?:combo|bundle|kit|set|pack)\s+(?:includes?|contains|contents|details)|you\s+(?:will\s+)?get|includes?|contains|containing|contents)\b[\s:：-]*(.*)$/i;
const OPTIONAL_HDR = /^(?:optional(?:\s+accessor(?:y|ies))?|not\s+included|excluded|sold\s+separately|available\s+separately|extra\s+accessor(?:y|ies)|add[- ]?ons?)\b[\s:：-]*(.*)$/i;
const UNIT = "pcs?|pieces?|packs?|nos?|units?|sets?|pairs?|reams?|rolls?";
const NOT_QTY_NEXT = /^(gb|tb|mb|kb|inch|in|mp|w|v|mah|hz|ghz|mm|cm|kg|g|ml|l)\b/i;

export type ComboItem = { name: string; qty: string | null };
export type ComboInfo = { main: string; included: ComboItem[]; optional: string[] };

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function qtyLabel(n: number, unit: string | undefined, L: Pick<ProductLabels, "piece" | "pieces" | "pack" | "packs">): string {
  const u = (unit ?? "").toLowerCase();
  const isPack = /^(packs?|reams?|rolls?|sets?)/.test(u);
  const word = isPack ? (n === 1 ? L.pack : L.packs) : n === 1 ? L.piece : L.pieces;
  return `${n} ${word}`;
}

/** "2 x USB Cable", "USB Cable - 1 pc", "1 Pack Printer Paper", "Toner (optional)". Quantities are only read, never guessed. */
export function parseComboItem(raw: string): { name: string; qty: { n: number; unit?: string } | null; optional: boolean } | null {
  let s = raw.replace(/\s+/g, " ").replace(/[.;,]+$/, "").trim();
  if (!s || s.length > 90) return null;
  let optional = false;
  const opt = s.match(/\(\s*optional\s*\)|\boptional\b/i);
  if (opt) {
    optional = true;
    s = s.replace(/\(\s*optional\s*\)|\boptional\b:?/i, "").replace(/\s+/g, " ").trim();
  }
  let qty: { n: number; unit?: string } | null = null;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{1,3})\s*(?:x|×|\*)\s*(.+)$/i))) {
    qty = { n: Number(m[1]) };
    s = m[2];
  } else if ((m = s.match(new RegExp(`^(\\d{1,3})\\s*(${UNIT})\\b\\.?\\s*(?:of\\s+)?(.+)$`, "i")))) {
    qty = { n: Number(m[1]), unit: m[2] };
    s = m[3];
  } else if ((m = s.match(new RegExp(`^(.+?)\\s*[-–:(]\\s*(\\d{1,3})\\s*(${UNIT})?\\)?$`, "i")))) {
    qty = { n: Number(m[2]), unit: m[3] };
    s = m[1];
  } else if ((m = s.match(/^(.+?)\s*(?:x|×|\*)\s*(\d{1,3})$/i))) {
    qty = { n: Number(m[2]) };
    s = m[1];
  } else if ((m = s.match(/^(\d{1,2})\s+([A-Za-z].*)$/)) && !NOT_QTY_NEXT.test(m[2]) && !/^in\b/i.test(m[2])) {
    qty = { n: Number(m[1]) };
    s = m[2];
  }
  s = s.replace(/^(?:and|with|\+|&)\s+/i, "").replace(/\s*(?:combo|bundle|kit|offer)\s*$/i, "").trim();
  if (s.length < 2 || !/[\p{L}\p{M}]/u.test(s)) return null;
  return { name: cap(s), qty, optional };
}

const splitInline = (s: string) => s.split(/\s*(?:,|;|\+|\s&\s|\sand\s|\|)\s*/i).filter(Boolean);

const stripComboWords = (s: string) => s.replace(/\b(combo|bundle|kit|offer|set)\b/gi, "").replace(/\s{2,}/g, " ").replace(/[-+:,|\s]+$/, "").trim();

export function isComboProduct(p: ProductLike): boolean {
  if (COMBO_WORDS.test(p.title) || /(^|[\s-])(combo|bundle)([\s-]|$)/i.test(p.handle ?? "")) return true;
  if ((p.tags ?? []).some((t) => /^(combo|bundle|kit)s?$/i.test(t.trim()))) return true;
  if (/combo|bundle/i.test(p.productType ?? "")) return true;
  return / \+ /.test(p.title); // "Printer + Cable + Paper"
}

/**
 * Main product and what the listing says is included. Returns null when the listing does not make the contents clear,
 * in which case the customer is sent to the team instead of being given a guess.
 */
export function extractCombo(p: ProductLike, labels: Pick<ProductLabels, "piece" | "pieces" | "pack" | "packs">): ComboInfo | null {
  const lines = linesOf(p);
  const items: { name: string; qty: string | null }[] = [];
  const optional: string[] = [];
  const add = (raw: string, forceOptional: boolean) => {
    const it = parseComboItem(raw);
    if (!it) return;
    const label = it.qty ? qtyLabel(it.qty.n, it.qty.unit, labels) : null;
    if (forceOptional || it.optional) optional.push(it.name);
    else if (!items.some((x) => x.name.toLowerCase() === it.name.toLowerCase())) items.push({ name: it.name, qty: label });
  };

  let section: "none" | "inc" | "opt" = "none";
  let count = 0;
  for (const l of lines) {
    const opt = l.text.match(OPTIONAL_HDR);
    const inc = l.text.match(INCLUDED_HDR);
    if (opt) {
      section = "opt";
      count = 0;
      for (const part of splitInline(opt[1])) add(part, true);
      continue;
    }
    if (inc && l.text.length <= 140) {
      section = "inc";
      count = 0;
      for (const part of splitInline(inc[1])) add(part, false);
      continue;
    }
    if (section === "none") continue;
    // The section ends at a blank line (after items), a new "Key: value" heading, or a long sentence.
    const looksLikeSentence = l.text.length > 90 || /[.!?]\s+\S/.test(l.text);
    const spec = l.text.match(SPEC);
    const quantityRow = !!spec && new RegExp(`^\\d{1,3}\\s*(?:${UNIT})?$`, "i").test(spec[2].trim()); // "USB Cable: 1 Piece" is an item
    if ((l.blankBefore && count > 0 && !l.bullet) || (!l.bullet && !!spec && !quantityRow && !/^\d/.test(l.text)) || looksLikeSentence) {
      section = "none";
      continue;
    }
    count++;
    add(l.text, section === "opt");
  }

  let main = "";
  const parts = p.title.split(/\s\+\s|\s*\+\s*|\swith\s(?:free\s)?|\s&\s/i).map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    main = stripComboWords(parts[0]);
    if (!items.length) {
      for (const rest of parts.slice(1)) add(rest, false);
    }
  } else {
    main = stripComboWords(p.title);
  }
  if (!main) main = p.title;
  // The section may list the main product too; it is shown once, as the main product.
  const mainKey = main.toLowerCase();
  const included = items.filter((x) => {
    const k = x.name.toLowerCase();
    return !(k === mainKey || mainKey.includes(k) || k.includes(mainKey));
  });
  if (!included.length) return null;
  return { main, included, optional };
}

// ---------- Messages ----------

/** Key points of an ordinary product: specs first, then features, then warranty. */
export function productPoints(p: ProductLike): { points: string[]; warranty: string | null } {
  const lines = linesOf(p);
  const warranty = warrantyOf(lines);
  const titleKey = p.title.toLowerCase();
  const specs: { text: string; score: number }[] = [];
  const features: string[] = [];
  for (const l of lines) {
    if (WARRANTY.test(l.text)) continue;
    if (INCLUDED_HDR.test(l.text) || OPTIONAL_HDR.test(l.text)) continue;
    const m = l.text.match(SPEC);
    if (m && !/^\d/.test(l.text)) {
      specs.push({ text: `${cap(m[1].trim())}: ${clip(m[2], 70)}`, score: IMPORTANT.test(m[1]) ? 2 : 1 });
    } else if (l.text.length >= 8 && l.text.toLowerCase() !== titleKey) {
      if (l.bullet || l.text.length <= 110) features.push(clip(l.text, 110));
      else {
        const first = l.text.split(/(?<=[.!?])\s+/)[0];
        if (first && first.length >= 8) features.push(clip(first, 110));
      }
    }
  }
  const seen = new Set<string>();
  const uniq = <T extends { text?: string } | string>(arr: T[]) =>
    arr.filter((x) => {
      const k = (typeof x === "string" ? x : x.text ?? "").toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const bestSpecs = uniq([...specs].sort((a, b) => b.score - a.score)).slice(0, 4).map((x) => x.text);
  const room = Math.max(0, 5 - bestSpecs.length);
  const bestFeatures = uniq(features).slice(0, room);
  return { points: [...bestSpecs, ...bestFeatures], warranty };
}

export type ProductMessage = { head: string; body: string; text: string };

/** The customer-facing answer for one product. `head` is the name line (used as photo caption), `body` the points. */
export function productMessage(p: ProductLike, L: ProductLabels): ProductMessage {
  const head = `🛍️ *${p.title}*`;
  const combo = isComboProduct(p) ? extractCombo(p, L) : null;
  const priceLine = (label: string) =>
    p.price
      ? `${label}: ${p.price}${p.compareAtPrice ? ` (~${p.compareAtPrice}~${p.discountPercent ? `, ${L.save} ${p.discountPercent}%` : ""})` : ""}`
      : null;

  if (isComboProduct(p)) {
    if (combo) {
      const rows = [
        `${L.mainProduct}: ${combo.main}`,
        ...combo.included.map((i) => `${i.name}: ${i.qty ?? L.included}`),
      ];
      const note = combo.optional.length ? `${L.optional}: ${combo.optional.join(", ")}` : undefined;
      const body = compose({
        intro: L.comboIntro,
        points: rows,
        note: [note, priceLine(L.comboPrice), p.url ? `${L.viewCombo}: ${p.url}` : null].filter(Boolean).join("\n"),
      });
      return { head, body, text: `${head}\n\n${body}` };
    }
    const body = compose({
      intro: L.comboUnclear,
      note: [priceLine(L.comboPrice), p.url ? `${L.viewCombo}: ${p.url}` : null].filter(Boolean).join("\n"),
      next: L.askTeam,
    });
    return { head, body, text: `${head}\n\n${body}` };
  }

  const { points, warranty } = productPoints(p);
  const named = (p.variants ?? []).filter((v) => v.title && !/^default title$/i.test(v.title));
  const options = named.length > 1 ? `${L.options}: ${clip(named.map((v) => v.title).join(", "), 100)}` : null;
  const rows = [...points, warranty ? `${L.warranty}: ${warranty}` : null, options, priceLine(L.price), p.available === false ? null : p.available ? `${L.stock}: ${L.inStock}` : null];
  const hasInfo = points.length > 0;
  const body = compose({
    intro: hasInfo ? L.details : L.noDetails,
    points: rows,
    note: p.url ? `${L.viewProduct}: ${p.url}` : undefined,
    next: hasInfo ? undefined : L.askTeam,
  });
  return { head, body, text: `${head}\n\n${body}` };
}

/** Compact numbered list for "you may also like" and search results. */
export function productLines(items: { title: string; price: string | null; url: string | null }[]): string {
  return numbered(items.map((p) => `${p.title}${p.price ? ` — ${p.price}` : ""}${p.url ? `\n   ${p.url}` : ""}`));
}
