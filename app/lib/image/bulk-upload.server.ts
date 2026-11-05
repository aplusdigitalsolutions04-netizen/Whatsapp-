import { stageUpload, type Ctx } from "./shopify-images.server.ts";

// Bulk upload: a ZIP with one folder per SKU (SKU/1.jpg, SKU/2.jpg ...) goes onto the matching products,
// in the order of the file numbers. The Shopify connection is injected so this file can be tested with a fake.

export type SkuMatch = { sku: string; state: "found" | "missing" | "ambiguous"; productId: string; title: string; imageCount: number };
export type Mode = "append" | "replace";
export type BulkImage = { position: number; bytes: Buffer; ext: "jpg" | "png" | "webp" };

const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGES_PER_PRODUCT = 30;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;

const LOOKUP = `query BulkSku($q: String!) {
  products(first: 50, query: $q) {
    nodes { id title mediaCount { count } variants(first: 100) { nodes { sku } } }
  }
}`;
const MEDIA = `query ProductMedia($id: ID!) {
  product(id: $id) { id title media(first: 250) { nodes { id status mediaContentType } } }
}`;
const ADD = `mutation AddMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
  productUpdate(product: $product, media: $media) {
    product { id media(first: 250) { nodes { id status } } }
    userErrors { field message }
  }
}`;
const POLL = `query MediaState($ids: [ID!]!) { nodes(ids: $ids) { ... on MediaImage { id status } } }`;
const DROP = `mutation DropMedia($files: [FileUpdateInput!]!) {
  fileUpdate(files: $files) { files { id } userErrors { field message code } }
}`;

const quote = (s: string) => `"${s.replace(/["\\]/g, " ").trim()}"`;
const msg = (errors: { message: string }[] | undefined) => (errors ?? []).map((e) => e.message).join("; ");
const sleepOf = (ctx: Ctx) => ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

/** Finds the product behind each SKU. A SKU must match exactly one product (matching ignores upper/lower case). */
export async function lookupSkus(ctx: Ctx, skus: string[]): Promise<SkuMatch[]> {
  const unique = [...new Set(skus.map((s) => s.trim()).filter(Boolean))].slice(0, 500);
  const found = new Map<string, { id: string; title: string; imageCount: number }[]>();
  for (let i = 0; i < unique.length; i += 8) {
    const batch = unique.slice(i, i + 8);
    const data = await ctx.gql(LOOKUP, { q: batch.map((s) => `sku:${quote(s)}`).join(" OR ") });
    for (const p of data.products?.nodes ?? []) {
      for (const v of p.variants?.nodes ?? []) {
        const key = String(v.sku ?? "").trim().toLowerCase();
        if (!key) continue;
        const list = found.get(key) ?? [];
        if (!list.some((x) => x.id === p.id)) list.push({ id: p.id, title: p.title, imageCount: p.mediaCount?.count ?? 0 });
        found.set(key, list);
      }
    }
  }
  return unique.map((sku) => {
    const list = found.get(sku.toLowerCase()) ?? [];
    if (list.length === 0) return { sku, state: "missing", productId: "", title: "", imageCount: 0 };
    if (list.length > 1) return { sku, state: "ambiguous", productId: "", title: list.map((p) => p.title).join(" / "), imageCount: 0 };
    return { sku, state: "found", productId: list[0].id, title: list[0].title, imageCount: list[0].imageCount };
  });
}

/** What the file really is (the file name can lie). */
export function sniffImage(b: Buffer): "jpg" | "png" | "webp" | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

export type ProductResult = { productId: string; title: string; added: number; failed: { position: number; error: string }[]; removed: number };

/**
 * Puts the images on one product. Images are added one at a time in the order of their numbers, so the gallery order
 * matches the file numbers. "replace" removes the product's old images only after at least one new image is ready,
 * so a failure never leaves a product without pictures.
 */
export async function uploadProductImages(ctx: Ctx, productId: string, mode: Mode, images: BulkImage[], label = "image"): Promise<ProductResult> {
  if (!PRODUCT_GID.test(productId)) throw new Error("Invalid product.");
  const list = [...images].sort((a, b) => a.position - b.position);
  if (list.length === 0) throw new Error("No images to upload.");
  if (list.length > MAX_IMAGES_PER_PRODUCT) throw new Error(`Too many images for one product (maximum ${MAX_IMAGES_PER_PRODUCT}).`);

  const before = (await ctx.gql(MEDIA, { id: productId })).product;
  if (!before) throw new Error("The product no longer exists in Shopify.");
  const title: string = before.title ?? "";
  const old: string[] = (before.media?.nodes ?? []).filter((m: { mediaContentType: string }) => m.mediaContentType === "IMAGE").map((m: { id: string }) => m.id);
  const known = new Set<string>((before.media?.nodes ?? []).map((m: { id: string }) => m.id));

  const failed: { position: number; error: string }[] = [];
  const created: { position: number; id: string }[] = [];
  for (const img of list) {
    try {
      if (img.bytes.length > MAX_BYTES) throw new Error("The image is larger than 25 MB.");
      if (sniffImage(img.bytes) !== img.ext) throw new Error("The file is not a valid JPG, PNG or WebP image.");
      const resourceUrl = await stageUpload(ctx, img.bytes, `${label}-${img.position}.${img.ext}`, img.ext);
      const data = await ctx.gql(ADD, { product: { id: productId }, media: [{ originalSource: resourceUrl, alt: title.slice(0, 250), mediaContentType: "IMAGE" }] });
      const err = msg(data.productUpdate?.userErrors);
      if (err) throw new Error(`Shopify refused the image: ${err}`);
      const fresh = (data.productUpdate?.product?.media?.nodes ?? []).find((m: { id: string }) => !known.has(m.id));
      if (!fresh) throw new Error("Shopify did not return the new image.");
      known.add(fresh.id);
      created.push({ position: img.position, id: fresh.id });
    } catch (e) {
      failed.push({ position: img.position, error: (e as Error).message });
    }
  }

  // wait until Shopify has processed the new images
  const ready = new Set<string>();
  const pending = new Set(created.map((c) => c.id));
  const deadline = Date.now() + (ctx.timeoutMs ?? 90_000);
  let wait = 800;
  while (pending.size > 0 && Date.now() < deadline) {
    await sleepOf(ctx)(wait);
    wait = Math.min(3000, wait + 400);
    const nodes = (await ctx.gql(POLL, { ids: [...pending] })).nodes ?? [];
    for (const n of nodes) {
      if (!n) continue;
      if (n.status === "READY") { ready.add(n.id); pending.delete(n.id); }
      else if (n.status === "FAILED") pending.delete(n.id);
    }
    for (const id of [...pending]) if (!nodes.some((n: { id?: string } | null) => n?.id === id)) pending.delete(id); // gone
  }
  for (const c of created) if (!ready.has(c.id)) failed.push({ position: c.position, error: "Shopify could not process this image." });

  let removed = 0;
  if (mode === "replace" && ready.size > 0 && old.length > 0) {
    const data = await ctx.gql(DROP, { files: old.map((id) => ({ id, referencesToRemove: [productId] })) });
    const err = msg(data.fileUpdate?.userErrors);
    if (err) failed.push({ position: 0, error: `The new images were added, but the old ones could not be removed: ${err}` });
    else removed = old.length;
  }
  return { productId, title, added: ready.size, failed: failed.sort((a, b) => a.position - b.position), removed };
}
