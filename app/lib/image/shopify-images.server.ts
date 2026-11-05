// Talks to Shopify about product images: list products and their photos, download an original, and REPLACE a photo in place.
// The Shopify connection is injected (`ctx.gql`) so this file has no dependency on the app's auth and can be tested with a fake.

export type Gql = (query: string, variables?: Record<string, unknown>) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type Ctx = { shop: string; gql: Gql; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; /** how long to wait for Shopify to process an image (default 90 s) */ timeoutMs?: number };

export type StoreImage = { id: string; alt: string; url: string; thumb: string; width: number; height: number; main: boolean; ready: boolean };
export type StoreProduct = { id: string; title: string; status: string; images: StoreImage[] };

const MAX_BYTES = 25 * 1024 * 1024;
const MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

const PRODUCTS = `query StoreProducts($first: Int!, $after: String, $q: String) {
  products(first: $first, after: $after, query: $q, sortKey: UPDATED_AT, reverse: true) {
    nodes {
      id title status featuredMedia { id }
      media(first: 30) {
        nodes {
          id alt mediaContentType
          ... on MediaImage { status image { url width height } thumb: image { url(transform: { maxWidth: 320, maxHeight: 320 }) } }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const STAGE = `mutation StageImage($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

const REPLACE = `mutation ReplaceImage($files: [FileUpdateInput!]!) {
  fileUpdate(files: $files) {
    files { id fileStatus }
    userErrors { field message code }
  }
}`;

const STATUS = `query ImageStatus($id: ID!) {
  node(id: $id) { ... on MediaImage { id status fileStatus image { url } } }
}`;

const SCOPES = `query Scopes { currentAppInstallation { accessScopes { handle } } }`;

/** Search words are passed to Shopify's product search; strip characters that change its syntax. */
const cleanQuery = (q: string) => q.replace(/["\\:()*]/g, " ").trim().slice(0, 80);

export async function listStoreProducts(ctx: Ctx, opts: { q?: string; after?: string | null; first?: number } = {}) {
  const q = cleanQuery(opts.q ?? "");
  const data = await ctx.gql(PRODUCTS, { first: Math.min(30, Math.max(1, opts.first ?? 18)), after: opts.after ?? null, q: q ? `title:*${q}* OR sku:${q}` : null });
  const products: StoreProduct[] = (data.products?.nodes ?? []).map((p: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const mainId = p.featuredMedia?.id ?? null;
    const images: StoreImage[] = (p.media?.nodes ?? [])
      .filter((m: any) => m.mediaContentType === "IMAGE" && m.image?.url) // eslint-disable-line @typescript-eslint/no-explicit-any
      .map((m: any, i: number) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
        id: m.id, alt: m.alt ?? "", url: m.image.url, thumb: m.thumb?.url ?? m.image.url, width: m.image.width ?? 0, height: m.image.height ?? 0,
        main: mainId ? m.id === mainId : i === 0, ready: (m.status ?? "READY") === "READY",
      }));
    return { id: p.id, title: p.title, status: p.status, images };
  });
  return { products, hasNext: Boolean(data.products?.pageInfo?.hasNextPage), endCursor: (data.products?.pageInfo?.endCursor ?? null) as string | null };
}

/** Which permissions the app has. Editing product photos needs write_files (and write_products). */
export async function grantedScopes(ctx: Ctx): Promise<string[]> {
  const data = await ctx.gql(SCOPES);
  return (data.currentAppInstallation?.accessScopes ?? []).map((s: { handle: string }) => s.handle);
}
export const canEditImages = (scopes: string[]) => scopes.includes("write_files");

/** Only Shopify's own image servers are downloaded from (the URL comes from Shopify, but never trust a URL blindly). */
export function isShopifyImageUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && (u.hostname === "cdn.shopify.com" || u.hostname.endsWith(".shopifycdn.com") || u.hostname.endsWith(".shopifycdn.net"));
  } catch {
    return false;
  }
}

export async function downloadImage(ctx: Ctx, url: string): Promise<Buffer> {
  if (!isShopifyImageUrl(url)) throw new Error("That image is not hosted by Shopify, so it was not downloaded.");
  const res = await (ctx.fetch ?? fetch)(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Could not download the image (HTTP ${res.status}).`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw new Error("The image is larger than 25 MB.");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("The image is larger than 25 MB.");
  return buf;
}

const msg = (errors: { message: string }[] | undefined) => (errors ?? []).map((e) => e.message).join("; ");

/** Step 1 of an upload: send the bytes to Shopify's temporary storage. Returns the address to attach them from. */
export async function stageUpload(ctx: Ctx, bytes: Buffer, filename: string, ext: string): Promise<string> {
  const mimeType = MIME[ext];
  if (!mimeType) throw new Error("Unsupported image type.");
  const data = await ctx.gql(STAGE, { input: [{ filename, mimeType, httpMethod: "POST", resource: "PRODUCT_IMAGE", fileSize: String(bytes.length) }] });
  const err = msg(data.stagedUploadsCreate?.userErrors);
  const target = data.stagedUploadsCreate?.stagedTargets?.[0];
  if (err || !target?.url || !target?.resourceUrl) throw new Error(`Shopify did not accept the upload${err ? `: ${err}` : "."}`);
  const form = new FormData();
  for (const p of target.parameters as { name: string; value: string }[]) form.append(p.name, p.value);
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
  const res = await (ctx.fetch ?? fetch)(target.url, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Uploading the image to Shopify failed (HTTP ${res.status}).`);
  return target.resourceUrl as string;
}

/**
 * Step 2: put the uploaded file into the EXISTING product image. The image keeps its id, so its position in the
 * gallery, its alt text and every variant that uses it stay exactly as they are. Waits until Shopify finishes processing.
 */
export async function replaceMedia(ctx: Ctx, mediaId: string, resourceUrl: string): Promise<{ url: string }> {
  const data = await ctx.gql(REPLACE, { files: [{ id: mediaId, originalSource: resourceUrl }] });
  const err = msg(data.fileUpdate?.userErrors);
  if (err) throw new Error(`Shopify refused the change: ${err}`);
  const sleep = ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (ctx.timeoutMs ?? 90_000);
  let wait = 800;
  while (Date.now() < deadline) {
    await sleep(wait);
    wait = Math.min(3000, wait + 400);
    const s = (await ctx.gql(STATUS, { id: mediaId })).node;
    if (!s) throw new Error("The image no longer exists in Shopify.");
    const state = s.fileStatus ?? s.status;
    if (state === "READY") return { url: s.image?.url ?? "" };
    if (state === "FAILED") throw new Error("Shopify could not process the new image.");
  }
  throw new Error("Shopify is still processing the image. Check the product in a minute; press Apply again only if it did not change.");
}

/** Replaces a product image with `bytes` (upload + attach). */
export async function replaceImage(ctx: Ctx, mediaId: string, bytes: Buffer, ext: string, filename = `image.${ext}`) {
  const resourceUrl = await stageUpload(ctx, bytes, filename, ext);
  return replaceMedia(ctx, mediaId, resourceUrl);
}
