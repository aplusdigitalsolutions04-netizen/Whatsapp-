// CSV reading/writing and the import plan. Pure functions: no database, no Shopify, so they are fully testable.
// Export: one row per product, plus one row per image that has an ALT problem.
// Import: the person fills the "new_*" columns (with any tool they like); we check every value and build a list of changes.

const BOM = String.fromCharCode(0xfeff);

export const COLUMNS = [
  "type", "id", "product_id", "handle", "title", "vendor", "product_type", "tags", "description", "problems",
  "current_seo_title", "new_seo_title", "current_seo_description", "new_seo_description", "current_alt", "new_alt", "image_url",
] as const;

export const MAX = { seoTitle: 255, seoDescription: 320, alt: 512 } as const;
export const ADVISE = { titleMin: 30, titleMax: 60, descMin: 70, descMax: 160, altMax: 125 } as const;

// ---------- CSV text ----------

/** A cell that starts with = + - @ would be run as a formula by Excel. A leading ' makes it plain text. */
const safe = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const unsafe = (v: string) => (/^'[=+\-@]/.test(v) ? v.slice(1) : v);

const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCsv(rows: string[][]): string {
  // BOM so Excel opens non-English text (Hindi) correctly
  return BOM + rows.map((r) => r.map((c) => cell(safe(c))).join(",")).join("\r\n") + "\r\n";
}

/** RFC 4180 reader: quoted cells, doubled quotes, line breaks inside cells, BOM, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"' && cur === "") quoted = true;
    else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cur);
      cur = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

// ---------- values ----------

/** Single spaces, no control characters, no surrounding spaces. */
export const cleanText = (s: string) =>
  Array.from(unsafe(s), (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch)).join("").replace(/\s+/g, " ").trim();

const sameText = (a: string, b: string) => cleanText(a) === cleanText(b);

// ---------- import plan ----------

export type Kind = "seoTitle" | "seoDescription" | "alt";

export type LiveProduct = { id: string; title: string; seoTitle: string; seoDescription: string; images: Map<string, string> };

export type Change = { kind: Kind; productId: string; productTitle: string; mediaId: string | null; before: string; after: string; warn: string | null; line: number };
export type Skipped = { line: number; id: string; reason: string };
export type Plan = { changes: Change[]; skipped: Skipped[]; unchanged: number; rows: number };

export class CsvError extends Error {}

export function planChanges(table: string[][], live: Map<string, LiveProduct>): Plan {
  if (table.length < 2) throw new CsvError("The file has no rows.");
  const head = table[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => head.indexOf(name);
  if (col("type") < 0 || col("id") < 0) throw new CsvError("This is not a file exported from this page (the columns \"type\" and \"id\" are missing). Download the CSV again and fill only the new_* columns.");
  const has = (name: string) => col(name) >= 0;
  if (!has("new_seo_title") && !has("new_seo_description") && !has("new_alt")) throw new CsvError("The columns new_seo_title, new_seo_description and new_alt are missing.");
  const get = (r: string[], name: string) => (has(name) ? (r[col(name)] ?? "") : "");

  const plan: Plan = { changes: [], skipped: [], unchanged: 0, rows: table.length - 1 };
  const seen = new Set<string>();

  for (let i = 1; i < table.length; i++) {
    const r = table[i];
    const line = i + 1;
    const type = get(r, "type").trim().toLowerCase();
    const id = get(r, "id").trim();
    const skip = (reason: string) => plan.skipped.push({ line, id, reason });

    const wantsTitle = cleanText(get(r, "new_seo_title")) !== "";
    const wantsDesc = cleanText(get(r, "new_seo_description")) !== "";
    const wantsAlt = cleanText(get(r, "new_alt")) !== "";
    if (!wantsTitle && !wantsDesc && !wantsAlt) continue; // empty = leave as it is

    if (type !== "product" && type !== "image") {
      skip('The "type" column must be product or image.');
      continue;
    }
    if (seen.has(`${type}:${id}`)) {
      skip("This id appears more than once; only the first row is used.");
      continue;
    }
    seen.add(`${type}:${id}`);

    const productId = type === "product" ? id : get(r, "product_id").trim();
    const p = live.get(productId);
    if (!p) {
      skip("This product was not found in your store (was it deleted, or is the id changed?).");
      continue;
    }

    const consider = (kind: Kind, newRaw: string, currentRaw: string, liveValue: string, mediaId: string | null, max: number, lo: number, hi: number) => {
      const after = cleanText(newRaw);
      if (!after) return;
      if (/[<>]/.test(after)) return skip(`${label(kind)} contains < or >, which is not allowed (no HTML).`);
      if (after.length > max) return skip(`${label(kind)} is ${after.length} characters; the most Shopify accepts here is ${max}.`);
      if (sameText(after, liveValue)) {
        plan.unchanged++;
        return;
      }
      // The file shows what the value was when it was exported. If it is different now, someone changed it since: do not overwrite.
      if (currentRaw !== "" || liveValue !== "") {
        if (!sameText(currentRaw, liveValue)) return skip(`${label(kind)} was changed in Shopify after this file was downloaded. Download a fresh file.`);
      }
      let warn: string | null = null;
      if (after.length < lo) warn = `${after.length} characters (advice: at least ${lo})`;
      else if (after.length > hi) warn = `${after.length} characters (advice: at most ${hi})`;
      plan.changes.push({ kind, productId: p.id, productTitle: p.title, mediaId, before: liveValue, after, warn, line });
    };

    if (type === "product") {
      consider("seoTitle", get(r, "new_seo_title"), get(r, "current_seo_title"), p.seoTitle, null, MAX.seoTitle, ADVISE.titleMin, ADVISE.titleMax);
      consider("seoDescription", get(r, "new_seo_description"), get(r, "current_seo_description"), p.seoDescription, null, MAX.seoDescription, ADVISE.descMin, ADVISE.descMax);
      if (wantsAlt) skip("new_alt belongs on an image row, not on a product row.");
    } else {
      if (!p.images.has(id)) {
        skip("This image was not found on that product.");
        continue;
      }
      consider("alt", get(r, "new_alt"), get(r, "current_alt"), p.images.get(id) ?? "", id, MAX.alt, 1, ADVISE.altMax);
      if (wantsTitle || wantsDesc) skip("new_seo_title and new_seo_description belong on a product row, not on an image row.");
    }
  }
  return plan;
}

const label = (k: Kind) => (k === "seoTitle" ? "The SEO title" : k === "seoDescription" ? "The meta description" : "The ALT text");
