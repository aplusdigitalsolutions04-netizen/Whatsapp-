// Decides whether a scraped product is already in the merchant's Shopify catalog. Pure: no network, no database.
import { norm } from "./parse.ts";

export type CatalogItem = { id: string; title: string; handle: string; vendor: string; skus: string[]; barcodes: string[] };
export type Found = { title: string; brand?: string; skus?: string[]; barcodes?: string[]; link?: string };
export type Match = { reason: string; title: string };

const STOP = new Set(["the", "for", "and", "with", "of", "in", "a", "an", "to", "by", "new", "pack", "set"]);

const tokens = (s: string) => new Set(norm(s).split(" ").filter((t) => t && !STOP.has(t)));
// "1008a", "g10", "250r", "3100u", "14", "15": the parts of a title that tell two models apart
const isModel = (t: string) => (/\d/.test(t) && /[a-z]/.test(t)) || /^\d{2,}$/.test(t);
const modelsOf = (t: Set<string>) => new Set([...t].filter(isModel));
const code = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

type Entry = { item: CatalogItem; tokens: Set<string>; models: Set<string> };
export type Index = { entries: Entry[]; codes: Map<string, CatalogItem> };

export function buildIndex(items: CatalogItem[]): Index {
  const codes = new Map<string, CatalogItem>();
  const entries = items.map((item) => {
    for (const c of [...item.skus, ...item.barcodes]) if (code(c).length >= 4) codes.set(code(c), item);
    const t = tokens(`${item.title}`);
    return { item, tokens: t, models: modelsOf(t) };
  });
  return { entries, codes };
}

/** Similarity of two titles: 1 = same words. Different model numbers (1008a vs 1008, 14 vs 15) never match. */
export function titleScore(aTitle: Set<string>, aModels: Set<string>, bTitle: Set<string>, bModels: Set<string>): number {
  if (!aTitle.size || !bTitle.size) return 0;
  if (aModels.size && bModels.size) {
    const shared = [...aModels].filter((m) => bModels.has(m)).length;
    if (shared === 0) return 0;
    if (shared < Math.min(aModels.size, bModels.size)) return 0;
  }
  const shared = [...aTitle].filter((t) => bTitle.has(t)).length;
  const dice = (2 * shared) / (aTitle.size + bTitle.size);
  const contain = shared / Math.min(aTitle.size, bTitle.size);
  if (dice >= 0.8) return dice;
  if (contain >= 0.9 && shared >= 3) return contain * 0.9;
  return 0;
}

export function matchCatalog(idx: Index, p: Found): Match | null {
  for (const c of [...(p.skus ?? []), ...(p.barcodes ?? [])]) {
    const hit = code(c).length >= 4 ? idx.codes.get(code(c)) : undefined;
    if (hit) return { reason: `Same SKU/barcode (${c})`, title: hit.title };
  }
  const t = tokens(p.title);
  const models = modelsOf(t);
  let best: { score: number; item: CatalogItem } | null = null;
  for (const e of idx.entries) {
    const score = titleScore(t, models, e.tokens, e.models);
    if (score > 0 && (!best || score > best.score)) best = { score, item: e.item };
  }
  return best ? { reason: `Similar name (${Math.round(best.score * 100)}%)`, title: best.item.title } : null;
}
