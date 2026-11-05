// The SEO checklist. Plain rules, no AI. A score here means "how many checklist items this product passes",
// NOT how Google will rank it. Titles of 30-60 characters etc. are common guidance, not a ranking guarantee.

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type SeoImage = { id: string; alt: string; url: string };
export type SeoProduct = {
  id: string;
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  tags: string[];
  status: string;
  /** Description as plain text (tags removed) */
  descText: string;
  /** The SEO title / meta description saved on the product ("" = not set, Shopify then uses the product title / description) */
  seoTitle: string;
  seoDescription: string;
  images: SeoImage[];
};

export type Issue = {
  rule: string;
  severity: Severity;
  message: string;
  fix: string;
  /** which image the issue is about (alt text rules) */
  target?: string;
};

export type Rule = {
  id: string;
  name: string;
  description: string;
  severity: Severity;
  /** points taken off the score of 100 when the check fails */
  impact: number;
  /** "csv": can be fixed by filling the exported CSV; "manual": needs a person in Shopify */
  fixable: "csv" | "manual";
};

export const LIMITS = { titleMin: 30, titleMax: 60, descMin: 70, descMax: 160, altMax: 125, thinWords: 30, handleMax: 70 } as const;

export const RULES: Rule[] = [
  { id: "seo-title-missing", name: "SEO title not set", description: "No SEO title is saved, so search results show only the plain product title.", severity: "high", impact: 12, fixable: "csv" },
  { id: "seo-title-short", name: "SEO title too short", description: `The SEO title is under ${LIMITS.titleMin} characters.`, severity: "medium", impact: 5, fixable: "csv" },
  { id: "seo-title-long", name: "SEO title too long", description: `The SEO title is over ${LIMITS.titleMax} characters and may be cut off in search results.`, severity: "medium", impact: 5, fixable: "csv" },
  { id: "seo-desc-missing", name: "Meta description not set", description: "No meta description is saved.", severity: "high", impact: 12, fixable: "csv" },
  { id: "seo-desc-short", name: "Meta description too short", description: `The meta description is under ${LIMITS.descMin} characters.`, severity: "medium", impact: 5, fixable: "csv" },
  { id: "seo-desc-long", name: "Meta description too long", description: `The meta description is over ${LIMITS.descMax} characters and may be cut off.`, severity: "medium", impact: 5, fixable: "csv" },
  { id: "title-duplicate", name: "Same title as another product", description: "Two or more products use exactly the same SEO title (or product title when none is set).", severity: "high", impact: 8, fixable: "csv" },
  { id: "desc-duplicate", name: "Same meta description as another product", description: "Two or more products use exactly the same meta description.", severity: "medium", impact: 6, fixable: "csv" },
  { id: "description-missing", name: "Product description empty", description: "The product has no description text.", severity: "high", impact: 10, fixable: "manual" },
  { id: "description-thin", name: "Product description very short", description: `The description has fewer than ${LIMITS.thinWords} words.`, severity: "low", impact: 3, fixable: "manual" },
  { id: "images-none", name: "No product image", description: "The product has no images.", severity: "medium", impact: 6, fixable: "manual" },
  { id: "alt-missing", name: "Image ALT text missing", description: "One or more images have no ALT text.", severity: "high", impact: 10, fixable: "csv" },
  { id: "alt-duplicate", name: "Same ALT text on several images", description: "Several images of one product share the same ALT text.", severity: "low", impact: 3, fixable: "csv" },
  { id: "handle-poor", name: "Product URL (handle) looks untidy", description: `The handle contains "copy-of" or "untitled", ends with a number, or is over ${LIMITS.handleMax} characters.`, severity: "low", impact: 2, fixable: "manual" },
];

const BY_ID = new Map(RULES.map((r) => [r.id, r]));
export const ruleById = (id: string) => BY_ID.get(id);

/** Lower case, no punctuation, single spaces: two texts are "the same" when this matches exactly. */
export const normalize = (s: string) =>
  s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** The text search engines would show: the SEO title if set, otherwise the product title. */
const effectiveTitle = (p: SeoProduct) => p.seoTitle.trim() || p.title.trim();

export type Duplicates = { titles: Map<string, number>; descs: Map<string, number> };

export function duplicateIndex(products: SeoProduct[]): Duplicates {
  const titles = new Map<string, number>();
  const descs = new Map<string, number>();
  for (const p of products) {
    const t = normalize(effectiveTitle(p));
    if (t) titles.set(t, (titles.get(t) ?? 0) + 1);
    const d = normalize(p.seoDescription);
    if (d) descs.set(d, (descs.get(d) ?? 0) + 1);
  }
  return { titles, descs };
}

export function poorHandle(h: string): boolean {
  return /(^|-)copy-of(-|$)/.test(h) || /(^|-)untitled(-|$)/.test(h) || /-\d+$/.test(h) || h.length > LIMITS.handleMax;
}

export type Audit = { issues: Issue[]; score: number; errors: number; warnings: number };

/** Checks one product. `dups` is built once from all products (duplicates need the whole list). */
export function auditProduct(p: SeoProduct, dups: Duplicates): Audit {
  const issues: Issue[] = [];
  const add = (rule: string, message: string, fix: string, target?: string) => {
    const r = BY_ID.get(rule)!;
    issues.push({ rule, severity: r.severity, message, fix, target });
  };

  const st = p.seoTitle.trim();
  if (!st) add("seo-title-missing", "No SEO title is set.", "Write a title with the product name and a key detail (brand, type).");
  else if (st.length < LIMITS.titleMin) add("seo-title-short", `SEO title is ${st.length} characters (under ${LIMITS.titleMin}).`, "Add the brand or product type so it describes the product.");
  else if (st.length > LIMITS.titleMax) add("seo-title-long", `SEO title is ${st.length} characters (over ${LIMITS.titleMax}).`, "Shorten it; keep the product name first.");

  const sd = p.seoDescription.trim();
  if (!sd) add("seo-desc-missing", "No meta description is set.", "Write 1-2 sentences about the product.");
  else if (sd.length < LIMITS.descMin) add("seo-desc-short", `Meta description is ${sd.length} characters (under ${LIMITS.descMin}).`, "Add what the product is and who it is for.");
  else if (sd.length > LIMITS.descMax) add("seo-desc-long", `Meta description is ${sd.length} characters (over ${LIMITS.descMax}).`, "Shorten it to the most useful sentence.");

  const nt = normalize(effectiveTitle(p));
  const sameTitle = nt ? (dups.titles.get(nt) ?? 0) : 0;
  if (sameTitle > 1) add("title-duplicate", `${sameTitle - 1} other product${sameTitle > 2 ? "s use" : " uses"} the same title.`, "Make each title different, e.g. add the model, size or colour.");
  const nd = normalize(p.seoDescription);
  const sameDesc = nd ? (dups.descs.get(nd) ?? 0) : 0;
  if (sameDesc > 1) add("desc-duplicate", `${sameDesc - 1} other product${sameDesc > 2 ? "s use" : " uses"} the same meta description.`, "Describe what is specific to this product.");

  const words = wordCount(p.descText);
  if (words === 0) add("description-missing", "The product description is empty.", "Add a description in Shopify (features, size, use).");
  else if (words < LIMITS.thinWords) add("description-thin", `The description has only ${words} words.`, "Add more detail about the product in Shopify.");

  if (p.images.length === 0) add("images-none", "The product has no image.", "Add at least one clear product photo.");
  const noAlt = p.images.filter((i) => !i.alt.trim());
  if (noAlt.length) {
    add("alt-missing", `${noAlt.length} of ${p.images.length} image${p.images.length > 1 ? "s have" : " has"} no ALT text.`, "Describe what the photo shows, e.g. product name and view.");
  }
  const altCount = new Map<string, number>();
  for (const i of p.images) {
    const a = normalize(i.alt);
    if (a) altCount.set(a, (altCount.get(a) ?? 0) + 1);
  }
  const dupAlt = [...altCount.values()].filter((n) => n > 1).length;
  if (dupAlt) add("alt-duplicate", `${dupAlt} ALT text${dupAlt > 1 ? "s are" : " is"} used on more than one image.`, "Give each photo its own ALT text (front view, side view...).");

  if (poorHandle(p.handle)) add("handle-poor", `The URL handle "${p.handle}" looks untidy.`, "Change the handle in Shopify; add a redirect from the old URL.");

  let score = 100;
  for (const i of issues) score -= BY_ID.get(i.rule)!.impact;
  const errors = issues.filter((i) => i.severity === "critical" || i.severity === "high").length;
  return { issues, score: Math.max(0, score), errors, warnings: issues.length - errors };
}

/** Image ids that have an ALT problem, for the CSV export. */
export function altProblemImages(p: SeoProduct): SeoImage[] {
  const seen = new Map<string, number>();
  for (const i of p.images) {
    const a = normalize(i.alt);
    if (a) seen.set(a, (seen.get(a) ?? 0) + 1);
  }
  return p.images.filter((i) => !i.alt.trim() || (seen.get(normalize(i.alt)) ?? 0) > 1);
}
