// Talks to Shopify for the SEO feature: read products with their SEO fields and image ALT text, and write them back.
// The connection is injected (`ctx.gql`), so this file needs no login and can be tested with a fake.
import type { Ctx } from "../image/shopify-images.server.ts";
import type { SeoProduct } from "./rules.ts";

export type ScannedProduct = SeoProduct & { thumb: string };

const PRODUCTS = `query SeoProducts($first: Int!, $after: String) {
  products(first: $first, after: $after, sortKey: ID) {
    nodes {
      id title handle vendor productType tags status description
      seo { title description }
      featuredMedia { preview { image { url(transform: { maxWidth: 160, maxHeight: 160 }) } } }
      media(first: 25) { nodes { id alt mediaContentType ... on MediaImage { image { url } } } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const LIVE = `query SeoLive($id: ID!) {
  product(id: $id) { id title seo { title description } }
}`;

const LIVE_ALT = `query SeoAlt($id: ID!) {
  node(id: $id) { ... on MediaImage { id alt } }
}`;

const SET_SEO = `mutation SeoUpdate($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id seo { title description } }
    userErrors { field message }
  }
}`;

const SET_ALT = `mutation SeoAlt($files: [FileUpdateInput!]!) {
  fileUpdate(files: $files) {
    files { id ... on MediaImage { alt } }
    userErrors { field message code }
  }
}`;

const COUNT = `query SeoCount { productsCount(limit: null) { count } }`;

/** How many products the store has (0 when Shopify cannot say). */
export async function countProducts(ctx: Ctx): Promise<number> {
  try {
    const n = Number((await ctx.gql(COUNT)).productsCount?.count);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

const msg = (errors: { message: string }[] | undefined) => (errors ?? []).map((e) => e.message).join("; ");

/** One page of products (25 at a time keeps each request well under Shopify's query cost limit). */
export async function fetchProductsPage(ctx: Ctx, after: string | null) {
  const data = await ctx.gql(PRODUCTS, { first: 25, after });
  const products: ScannedProduct[] = (data.products?.nodes ?? []).map((p: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
    id: p.id,
    title: p.title ?? "",
    handle: p.handle ?? "",
    vendor: p.vendor ?? "",
    productType: p.productType ?? "",
    tags: p.tags ?? [],
    status: p.status ?? "ACTIVE",
    descText: String(p.description ?? "").trim(),
    seoTitle: String(p.seo?.title ?? "").trim(),
    seoDescription: String(p.seo?.description ?? "").trim(),
    thumb: p.featuredMedia?.preview?.image?.url ?? "",
    images: (p.media?.nodes ?? [])
      .filter((m: any) => m.mediaContentType === "IMAGE") // eslint-disable-line @typescript-eslint/no-explicit-any
      .map((m: any) => ({ id: m.id, alt: String(m.alt ?? "").trim(), url: m.image?.url ?? "" })), // eslint-disable-line @typescript-eslint/no-explicit-any
  }));
  return { products, hasNext: Boolean(data.products?.pageInfo?.hasNextPage), endCursor: (data.products?.pageInfo?.endCursor ?? null) as string | null };
}

/** The SEO fields as they are in Shopify right now (null = the product no longer exists). */
export async function liveSeo(ctx: Ctx, productId: string): Promise<{ seoTitle: string; seoDescription: string } | null> {
  const p = (await ctx.gql(LIVE, { id: productId })).product;
  if (!p) return null;
  return { seoTitle: String(p.seo?.title ?? "").trim(), seoDescription: String(p.seo?.description ?? "").trim() };
}

export async function liveAlt(ctx: Ctx, mediaId: string): Promise<string | null> {
  const n = (await ctx.gql(LIVE_ALT, { id: mediaId })).node;
  return n && typeof n.alt !== "undefined" ? String(n.alt ?? "").trim() : null;
}

const LIVE_ALTS = `query SeoAlts($ids: [ID!]!) {
  nodes(ids: $ids) { ... on MediaImage { id alt } }
}`;

const SET_ALTS = `mutation SeoAltMany($files: [FileUpdateInput!]!) {
  fileUpdate(files: $files) {
    files { id ... on MediaImage { alt } }
    userErrors { field message code }
  }
}`;

/** ALT texts of many images in one request (an image that no longer exists is simply missing from the answer). */
export async function liveAlts(ctx: Ctx, mediaIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!mediaIds.length) return out;
  const data = await ctx.gql(LIVE_ALTS, { ids: mediaIds });
  for (const n of data.nodes ?? []) if (n?.id) out.set(n.id, String(n.alt ?? "").trim());
  return out;
}

/** Writes many ALT texts in one request. Throws if Shopify refuses any of them (the caller then retries one by one to find which). */
export async function setAlts(ctx: Ctx, files: { id: string; alt: string }[]) {
  if (!files.length) return;
  const data = await ctx.gql(SET_ALTS, { files });
  const err = msg(data.fileUpdate?.userErrors);
  if (err) throw new Error(err);
}

/** Writes both SEO fields together (an empty one is sent as null = "not set"). */
export async function setProductSeo(ctx: Ctx, productId: string, seoTitle: string, seoDescription: string) {
  const data = await ctx.gql(SET_SEO, { product: { id: productId, seo: { title: seoTitle || null, description: seoDescription || null } } });
  const err = msg(data.productUpdate?.userErrors);
  if (err) throw new Error(err);
}

export async function setAlt(ctx: Ctx, mediaId: string, alt: string) {
  const data = await ctx.gql(SET_ALT, { files: [{ id: mediaId, alt }] });
  const err = msg(data.fileUpdate?.userErrors);
  if (err) throw new Error(err);
}
