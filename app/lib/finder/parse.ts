/* eslint-disable @typescript-eslint/no-explicit-any */
// Pure HTML/price parsing for the Product Scrapper (no network, no database): easy to test.
import * as cheerio from "cheerio";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const PRODUCT_HINT = /\/(p|dp|product|products|item|pd|buy)\//i;
const OUT_OF_STOCK = /out of stock|sold out|currently unavailable|notify me when available/i;
const CURRENCY: Record<string, string> = { INR: "₹", USD: "$", EUR: "€", GBP: "£", AUD: "A$", CAD: "C$" };

export type Candidate = { title: string; link: string };
export type Detail = { title: string; brand: string; price: string; comparePrice: string; inStock: boolean | null; images: string[] };

export const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** First number inside a price string, or null. */
export function num(s: unknown): number | null {
  const m = String(s ?? "").match(/\d[\d,]*\.?\d*/);
  return m ? Number(m[0].replace(/,/g, "")) : null;
}

export function money(value: unknown, currency = ""): string {
  const n = num(value);
  if (n === null) return "";
  const sym = CURRENCY[currency] ?? (currency ? `${currency} ` : "");
  return `${sym}${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** Link without query string and fragment: the same product keeps the same key between runs. */
export function linkKey(link: string): string {
  try {
    const u = new URL(link);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return link.toLowerCase();
  }
}

export function jsonLdProducts($: cheerio.CheerioAPI): any[] {
  const found: any[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    let data: any;
    try {
      data = JSON.parse($(el).text() || "");
    } catch {
      return;
    }
    const stack = [data];
    while (stack.length) {
      const d = stack.pop();
      if (Array.isArray(d)) stack.push(...d);
      else if (d && typeof d === "object") {
        const t = Array.isArray(d["@type"]) ? d["@type"] : [d["@type"]];
        if (t.includes("Product") || t.includes("ProductGroup")) found.push(d);
        for (const v of Object.values(d)) if (v && typeof v === "object") stack.push(v);
      }
    }
  });
  return found;
}

const abs = (href: string, base: string) => {
  try {
    return new URL(href, base).toString();
  } catch {
    return "";
  }
};

export function listingAmazon(html: string, base: string): Candidate[] {
  const $ = cheerio.load(html);
  const out: Candidate[] = [];
  $('div[data-component-type="s-search-result"]').each((_, c) => {
    const a = $(c).find("h2 a").first().length ? $(c).find("h2 a").first() : $(c).find("a.a-link-normal[href*='/dp/']").first();
    const href = a.attr("href");
    if (!href) return;
    const m = href.match(/\/dp\/([A-Z0-9]{10})/);
    const h2 = $(c).find("h2").first();
    out.push({ title: (h2.length ? h2 : a).text().replace(/\s+/g, " ").trim(), link: m ? abs(`/dp/${m[1]}`, base) : abs(href, base) });
  });
  return out;
}

export function listingGeneric(html: string, base: string): Candidate[] {
  const $ = cheerio.load(html);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const d of jsonLdProducts($)) {
    if (d.url) {
      const link = abs(d.url, base);
      seen.add(link);
      out.push({ title: d.name ?? "", link });
    }
  }
  $("a[href]").each((_, el) => {
    const link = abs($(el).attr("href") ?? "", base).split("#")[0];
    if (!link || seen.has(link)) return;
    let path = "";
    try {
      path = new URL(link).pathname;
    } catch {
      return;
    }
    if (!PRODUCT_HINT.test(path)) return;
    const title = $(el).attr("title") || $(el).text().replace(/\s+/g, " ").trim() || $(el).find("img").attr("alt") || "";
    if (title.length < 8) return;
    seen.add(link);
    out.push({ title, link });
  });
  return out;
}

const upgradeImage = (url: string) =>
  url.replace(/\._[A-Z0-9_,]+_\./, ".").replace(/\/image\/\d+\/\d+\//, "/image/832/832/");

function strikePrice($: cheerio.CheerioAPI): string {
  const sel = "del, s, strike, [class*=compare], [class*=old-price], [class*=oldprice], [class*=was-price], [class*=mrp], [class*=original-price]";
  for (const el of $(sel).toArray()) {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (num(t) !== null) return t;
  }
  return "";
}

/** Reads one product page (JSON-LD first, then Amazon/Flipkart specifics). */
export function parseDetail(html: string, url: string): Detail {
  const $ = cheerio.load(html);
  const host = new URL(url).hostname;
  const d: Detail = { title: "", brand: "", price: "", comparePrice: "", inStock: null, images: [] };

  const ld = jsonLdProducts($);
  if (ld.length) {
    let p = ld[0];
    if (p.hasVariant) p = { ...p, ...(Array.isArray(p.hasVariant) ? p.hasVariant[0] : p.hasVariant) };
    d.title = p.name ?? "";
    d.brand = typeof p.brand === "object" ? (p.brand?.name ?? "") : (p.brand ?? "");
    const imgs = Array.isArray(p.image) ? p.image : p.image ? [p.image] : [];
    d.images = imgs.map((i: any) => (typeof i === "object" ? i?.url : i)).filter(Boolean);
    let offers = p.offers ?? {};
    if (Array.isArray(offers)) offers = offers[0] ?? {};
    if (offers && typeof offers === "object") {
      const cur = offers.priceCurrency ?? "";
      d.price = money(offers.price ?? offers.lowPrice, cur);
      const avail = String(offers.availability ?? "");
      if (avail) d.inStock = /(InStock|LimitedAvailability|PreOrder|OnlineOnly)$/.test(avail);
      const spec = Array.isArray(offers.priceSpecification) ? offers.priceSpecification : offers.priceSpecification ? [offers.priceSpecification] : [];
      for (const s of spec) if (s && String(s.priceType ?? "").includes("ListPrice")) d.comparePrice = money(s.price, cur);
    }
  }

  const og = $('meta[property="og:image"]').attr("content");
  if (og) d.images.push(og);
  if (!d.title) d.title = $('meta[property="og:title"]').attr("content") || $("h1").first().text().replace(/\s+/g, " ").trim();

  $("[class*=gallery] img, [class*=product-image] img, [class*=slider] img, [class*=thumb] img").each((_, el) => {
    const e = $(el);
    let src = e.attr("data-zoom-image") || e.attr("data-src") || e.attr("src") || "";
    if (!src || src.startsWith("data:")) {
      const srcset = (e.attr("srcset") ?? "").split(",").pop()?.trim().split(" ")[0] ?? "";
      src = srcset || src;
    }
    if (src && !src.startsWith("data:")) d.images.push(abs(src, url));
  });

  if (host.includes("amazon.")) {
    const t = $("#productTitle").text().replace(/\s+/g, " ").trim();
    if (t) d.title = t;
    const price = $("#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen").first().text().trim() || $(".a-price .a-offscreen").first().text().trim();
    if (price) d.price = price;
    const was = $("#corePrice_feature_div .a-price.a-text-price .a-offscreen").first().text().trim() || $(".basisPrice .a-offscreen").first().text().trim();
    if (was) d.comparePrice = was;
    const avText = $("#availability").text().replace(/\s+/g, " ").trim();
    d.inStock = $("#add-to-cart-button, #buy-now-button").length > 0 || (/in stock/i.test(avText) && !OUT_OF_STOCK.test(avText));
    const byline = $("#bylineInfo").text().replace(/\s+/g, " ").trim();
    if (byline) d.brand = byline.replace(/^(Visit the |Brand:\s*)|( Store)$/g, "").trim();
    const hi = [...html.matchAll(/"hiRes":"(https:[^"]+)"/g)].map((m) => m[1]);
    const large = hi.length ? hi : [...html.matchAll(/"large":"(https:[^"]+)"/g)].map((m) => m[1]);
    const land = $("#landingImage");
    d.images = large.length ? large : land.length ? [land.attr("data-old-hires") || land.attr("src") || ""].filter(Boolean) : d.images;
  } else if (host.includes("flipkart.")) {
    d.images = d.images.concat([...html.matchAll(/https:\/\/rukminim\d?\.flixcart\.com\/image\/[^"'\s\\]+/g)].map((m) => m[0]));
  }

  if (!d.comparePrice) d.comparePrice = strikePrice($);
  const cp = num(d.comparePrice);
  const pr = num(d.price);
  if (cp !== null && pr !== null && cp <= pr) d.comparePrice = "";
  if (d.inStock === null) d.inStock = !OUT_OF_STOCK.test($.root().text().replace(/\s+/g, " ").slice(0, 60000));

  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of d.images) {
    if (!raw || typeof raw !== "string") continue;
    const u = upgradeImage(abs(raw, url));
    const key = u.split("?")[0];
    if (u && !seen.has(key)) {
      seen.add(key);
      clean.push(u);
    }
  }
  d.images = clean;
  return d;
}

/** Search-page URLs for the supported sites. */
export const SITES: Record<string, string> = {
  amazon: "https://www.amazon.in/s?k={query}&page={page}",
  flipkart: "https://www.flipkart.com/search?q={query}&page={page}",
};
