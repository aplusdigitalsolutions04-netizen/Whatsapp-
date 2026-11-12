/* eslint-disable @typescript-eslint/no-explicit-any */
import { isIP } from "node:net";
import { htmlToPlain, listingAmazon, listingGeneric, money, norm, num, parseDetail, SITES, UA, type Candidate } from "./parse";

export type ScrapedProduct = {
  title: string; brand: string; price: string; comparePrice: string; link: string; images: string[];
  skus?: string[]; barcodes?: string[];
  /** Plain-text description and the maker's model name, when the page has them. */
  description?: string; model?: string;
};
export type Ctx = {
  log: (msg: string) => void;
  checked: (n: number) => void;
  /** Returns true when the product was kept and counts toward the limit. */
  emit: (p: ScrapedProduct) => Promise<boolean>;
  stopped: () => boolean;
};
export type Params = { mode: string; site: string; category: string; brand: string; limit: number; pages: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Only public http(s) sites: no localhost, no private network addresses. */
export function assertPublicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("That website address is not valid.");
  }
  const h = u.hostname.toLowerCase();
  const privateV4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
  if (!/^https?:$/.test(u.protocol) || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || (isIP(h) && (privateV4.test(h) || h === "::1" || h.startsWith("fc") || h.startsWith("fd")))) {
    throw new Error("Only public websites can be scraped.");
  }
  return u;
}

async function getJson(url: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

// ---------------------------------------------------------------------------
// Shopify store: the public /products.json feed, no browser needed
// ---------------------------------------------------------------------------
export async function scrapeShopify(site: string, category: string, brand: string, limit: number, ctx: Ctx) {
  const base = assertPublicUrl(site).origin;
  let currency = "";
  try {
    currency = (await getJson(`${base}/meta.json`)).json.currency ?? "";
  } catch {
    /* currency is optional */
  }
  const words = norm(category).split(" ").filter(Boolean);
  let seen = 0;
  let found = 0;
  for (let page = 1; found < limit && page <= 40 && !ctx.stopped(); page++) {
    const { status, json } = await getJson(`${base}/products.json?limit=250&page=${page}`);
    if (status !== 200) throw new Error(`Could not read ${base}/products.json (HTTP ${status}). This does not look like a Shopify store.`);
    const items: any[] = json.products ?? [];
    if (!items.length) break;
    for (const p of items) {
      if (found >= limit || ctx.stopped()) break;
      const tags = Array.isArray(p.tags) ? p.tags.join(" ") : String(p.tags ?? "");
      const blob = norm([p.title, p.vendor, p.product_type, tags].join(" "));
      if (brand && !blob.includes(norm(brand))) continue;
      if (words.length && !words.every((w) => blob.includes(w))) continue;
      ctx.checked(++seen);
      const available = (p.variants ?? []).filter((v: any) => v.available);
      if (!available.length) continue; // out of stock
      const v = available.reduce((a: any, b: any) => (Number(b.price) < Number(a.price) ? b : a));
      const ok = await ctx.emit({
        title: p.title, brand: p.vendor ?? "", price: money(v.price, currency),
        comparePrice: num(v.compare_at_price) ? money(v.compare_at_price, currency) : "",
        link: `${base}/products/${p.handle}`, images: (p.images ?? []).map((i: any) => i.src),
        skus: (p.variants ?? []).map((x: any) => x.sku).filter(Boolean),
        barcodes: (p.variants ?? []).map((x: any) => x.barcode).filter(Boolean),
        description: htmlToPlain(p.body_html),
        model: (p.variants ?? []).map((x: any) => String(x.sku ?? "").trim()).find(Boolean) ?? "",
      });
      if (ok) found++;
    }
    ctx.log(`Scanned page ${page}: ${found} new in-stock products so far`);
  }
}

// ---------------------------------------------------------------------------
// Amazon.in, Flipkart and any other site. Uses a real browser (Chrome/Edge) when the server has one; hosting servers
// usually do not, so it falls back to plain web requests (some sites block those with a robot check).
// ---------------------------------------------------------------------------
type Loaded = { html: string; title: string };
type PageSource = { kind: "browser" | "http"; load: (url: string, scroll?: boolean) => Promise<Loaded>; close: () => Promise<void> };

async function launchBrowser() {
  if (process.env.FINDER_NO_BROWSER === "1") return null;
  let chromium: any;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    return null; // package not installed: fall back to plain web requests
  }
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      /* try the next browser */
    }
  }
  try {
    return await chromium.launch({ headless: true }); // Playwright's own Chromium, if it was installed
  } catch {
    return null;
  }
}

async function browserSource(browser: NonNullable<Awaited<ReturnType<typeof launchBrowser>>>): Promise<PageSource> {
  const page = await (await browser.newContext({ userAgent: UA, locale: "en-IN" })).newPage();
  return {
    kind: "browser",
    async load(url, scroll) {
      assertPublicUrl(url);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(scroll ? 2500 : 1500);
      if (scroll) {
        for (let i = 0; i < 6; i++) {
          await page.mouse.wheel(0, 2500);
          await page.waitForTimeout(400);
        }
      }
      return { html: await page.content(), title: await page.title() };
    },
    close: () => browser.close().catch(() => undefined),
  };
}

/** Plain HTTP page loader. Every redirect target is checked too, so a page can never send us to a private address. */
function httpSource(): PageSource {
  return {
    kind: "http",
    async load(start) {
      let url = start;
      for (let hop = 0; hop < 5; hop++) {
        assertPublicUrl(url);
        const res = await fetch(url, {
          headers: { "user-agent": UA, "accept-language": "en-IN,en;q=0.9", accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
        });
        const next = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && next) {
          url = new URL(next, url).toString();
          continue;
        }
        const html = await res.text();
        const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
        if (res.status === 403 || res.status === 429 || res.status === 503) return { html: "robot check", title: `HTTP ${res.status}` };
        return { html, title };
      }
      throw new Error("Too many redirects.");
    },
    close: async () => undefined,
  };
}

const BLOCKED = /captcha|robot check|enter the characters|are you a human|access denied|unusual traffic/i;

export async function scrapeBrowser(searchUrl: string, brand: string, limit: number, pages: number, ctx: Ctx) {
  assertPublicUrl(searchUrl.replace("{query}", "x").replace("{page}", "1"));
  const browser = await launchBrowser();
  const source = browser ? await browserSource(browser) : httpSource();
  if (source.kind === "http") ctx.log("No browser on this server, so pages are read with plain web requests. Amazon and Flipkart often block this; the Shopify store option always works.");
  try {
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    let blocked = false;
    for (let n = 1; n <= pages && !ctx.stopped(); n++) {
      let url = searchUrl.replace("{page}", String(n));
      if (n > 1 && !searchUrl.includes("{page}")) url += `${url.includes("?") ? "&" : "?"}page=${n}`;
      ctx.log(`Loading search page ${n}`);
      const { html, title } = await source.load(url, true);
      // A tiny page instead of results is the site's bot check (Amazon answers servers with a ~1 KB script page).
      if (BLOCKED.test(title + " " + html.slice(0, 3000)) || (source.kind === "http" && html.length < 5000)) {
        blocked = true;
        ctx.log("The website showed a robot check, so it stopped. Try again later, or use another website.");
        break;
      }
      const u = new URL(url);
      const base = `${u.protocol}//${u.host}`;
      const items = u.host.includes("amazon.") ? listingAmazon(html, base) : listingGeneric(html, base);
      let added = 0;
      for (const it of items) {
        if (seen.has(it.link) || (brand && !norm(it.title).includes(norm(brand)))) continue;
        seen.add(it.link);
        candidates.push(it);
        added++;
      }
      ctx.log(`Search page ${n}: ${added} new candidates`);
      if (added === 0 || candidates.length >= limit * 5) break;
    }
    if (!candidates.length) {
      throw new Error(
        blocked
          ? "The website blocked this server with a robot check. Amazon and Flipkart often block hosting servers: use the Shopify store option, or run the scrapper on a computer with Google Chrome."
          : source.kind === "http"
            ? "No products could be read without a browser. This site needs a real browser: use the Shopify store option, or run the scrapper on a computer with Google Chrome."
            : "No products were found on that search page.",
      );
    }

    let found = 0;
    for (let i = 0; i < candidates.length && found < limit && !ctx.stopped(); i++) {
      const c = candidates[i];
      ctx.checked(i + 1);
      ctx.log(`Checking ${i + 1}/${candidates.length}: ${c.title.slice(0, 60)}`);
      let d;
      try {
        d = parseDetail((await source.load(c.link)).html, c.link);
      } catch (e) {
        ctx.log(`Skipped (page error): ${String((e as Error).message).slice(0, 80)}`);
        continue;
      }
      if (!d.inStock || !d.images.length) continue;
      if (await ctx.emit({ title: d.title || c.title, brand: d.brand || brand, price: d.price, comparePrice: d.comparePrice, link: c.link, images: d.images, description: d.description, model: d.model })) found++;
      await sleep(300);
    }
  } finally {
    await source.close();
  }
}

export async function runScrape(p: Params, ctx: Ctx) {
  const query = encodeURIComponent(`${p.brand} ${p.category}`.trim()).replace(/%20/g, "+");
  if (p.mode === "shopify") {
    if (!p.site) throw new Error("Enter the Shopify store URL.");
    return scrapeShopify(p.site, p.category, p.brand, p.limit, ctx);
  }
  let url: string;
  if (SITES[p.mode]) url = SITES[p.mode].replace("{query}", query);
  else {
    if (!p.site) throw new Error("Enter the website URL.");
    url = p.site.includes("{query}") ? p.site.replace("{query}", query) : `${p.site.replace(/\/$/, "")}/search?q=${query}`;
  }
  return scrapeBrowser(url, p.brand, p.limit, p.pages, ctx);
}

