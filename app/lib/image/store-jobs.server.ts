import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import prisma from "../../db.server.ts";
import { addStoreItem, IMAGE_DIR, itemPaths, createJob } from "./jobs.server.ts";
import { LIMITS } from "./settings.ts";
import { downloadImage, replaceImage, type Ctx } from "./shopify-images.server.ts";

// Edit the photos of products that are already listed in Shopify, then put the result back into the SAME product image.
// Safety: before an image is replaced for the first time, its untouched original is saved (ImageBackup) and can be restored.

const g = globalThis as unknown as { __imageApplying?: Set<string> };
const applying = (g.__imageApplying ??= new Set<string>());

const log = (shop: string, event: string, detail: string, level: "info" | "error" = "info") =>
  prisma.activityLog.create({ data: { shop, source: "shopify", event, level, detail: detail.slice(0, 400) } }).catch(() => undefined);

export type StoreImageRef = { productId: string; productTitle: string; mediaId: string; url: string };
const GID = /^gid:\/\/shopify\/(Product|MediaImage)\/\d+$/;

/** Creates a batch from product photos: downloads every original (4 at a time) and queues it like an uploaded photo. */
export async function createStoreJob(ctx: Ctx, name: string, options: unknown, images: StoreImageRef[]) {
  const refs = images.slice(0, LIMITS.maxFiles).filter((i) => GID.test(i.productId) && GID.test(i.mediaId));
  const seen = new Set<string>();
  const unique = refs.filter((r) => (seen.has(r.mediaId) ? false : (seen.add(r.mediaId), true)));
  if (unique.length === 0) throw new Error("Choose at least one product image.");
  const { id } = await createJob(ctx.shop, name, options, "store");
  const failed: { mediaId: string; error: string }[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, unique.length) }, async () => {
      while (next < unique.length) {
        const ref = unique[next++];
        try {
          const bytes = await downloadImage(ctx, ref.url);
          await addStoreItem(ctx.shop, id, { bytes, productId: ref.productId, productTitle: ref.productTitle, mediaId: ref.mediaId, srcUrl: ref.url });
        } catch (e) {
          failed.push({ mediaId: ref.mediaId, error: (e as Error).message });
        }
      }
    }),
  );
  const added = unique.length - failed.length;
  if (added === 0) {
    await prisma.imageJob.delete({ where: { id } }).catch(() => undefined);
    throw new Error(failed[0]?.error ?? "No image could be downloaded.");
  }
  return { id, added, failed };
}

const backupDir = (shop: string) => path.join(IMAGE_DIR, "backups", shop.replace(/[^\w.-]/g, "_"));

/** Saves the untouched original of this image, once. Later edits never replace the first backup. */
export async function ensureBackup(shop: string, item: { jobId: string; id: string; ext: string; mediaId: string; productId: string; productTitle: string | null; srcUrl: string | null; inBytes: number }) {
  const existing = await prisma.imageBackup.findUnique({ where: { shop_mediaId: { shop, mediaId: item.mediaId } } });
  if (existing && existsSync(path.join(IMAGE_DIR, existing.file))) return existing;
  const src = itemPaths(item.jobId, item.id, item.ext).input;
  if (!existsSync(src)) throw new Error("The original photo is no longer on this computer, so it cannot be backed up. Nothing was changed.");
  const dir = backupDir(shop);
  mkdirSync(dir, { recursive: true });
  const rel = path.join("backups", shop.replace(/[^\w.-]/g, "_"), `${item.mediaId.split("/").pop()}.${item.ext}`);
  copyFileSync(src, path.join(IMAGE_DIR, rel));
  const data = { shop, mediaId: item.mediaId, productId: item.productId, productTitle: item.productTitle ?? "", originalUrl: item.srcUrl ?? "", ext: item.ext, file: rel, bytes: item.inBytes };
  return existing
    ? prisma.imageBackup.update({ where: { id: existing.id }, data: { file: rel, ext: item.ext, bytes: item.inBytes } })
    : prisma.imageBackup.create({ data });
}

/** Applies the finished edits to Shopify in the background (two at a time). Safe to press twice: a batch is applied once at a time. */
export async function applyItems(ctx: Ctx, jobId: string, itemIds?: string[]) {
  const job = await prisma.imageJob.findFirst({ where: { id: jobId, shop: ctx.shop } });
  if (!job || job.kind !== "store") throw new Error("This batch is not made from Shopify products.");
  if (applying.has(jobId)) throw new Error("This batch is already being applied.");
  const items = await prisma.imageItem.findMany({
    where: { jobId, status: "done", applyStatus: { in: ["", "failed", "restored"] }, mediaId: { not: null }, ...(itemIds?.length ? { id: { in: itemIds } } : {}) },
    select: { id: true },
  });
  if (items.length === 0) throw new Error("There are no finished edits to apply.");
  await prisma.imageItem.updateMany({ where: { id: { in: items.map((i) => i.id) } }, data: { applyStatus: "applying", applyError: null } });

  applying.add(jobId);
  void (async () => {
    let next = 0;
    const lane = async () => {
      while (next < items.length) {
        const { id } = items[next++];
        await applyOne(ctx, id);
      }
    };
    try {
      await Promise.all([lane(), lane()]);
    } finally {
      applying.delete(jobId);
    }
  })();
  return items.length;
}

export async function applyOne(ctx: Ctx, itemId: string) {
  const item = await prisma.imageItem.findUnique({ where: { id: itemId } });
  if (!item || !item.mediaId || !item.productId || !item.outName) return;
  try {
    await ensureBackup(ctx.shop, { jobId: item.jobId, id: item.id, ext: item.ext, mediaId: item.mediaId, productId: item.productId, productTitle: item.productTitle, srcUrl: item.srcUrl, inBytes: item.inBytes });
    const outExt = path.extname(item.outName).slice(1).toLowerCase();
    if (outExt !== item.ext) throw new Error("The edited photo has a different file type than the Shopify image, so it was not applied.");
    const file = `${itemPaths(item.jobId, item.id, item.ext).outBase}.${outExt}`;
    if (!existsSync(file)) throw new Error("The edited photo is missing on this computer.");
    const r = await replaceImage(ctx, item.mediaId, readFileSync(file), outExt, item.outName);
    await prisma.imageItem.update({ where: { id: item.id }, data: { applyStatus: "applied", appliedAt: new Date(), newUrl: r.url || null, applyError: null } });
    await log(ctx.shop, "image_applied", `${item.productTitle ?? item.productId}: ${item.name}`);
  } catch (e) {
    const message = (e as Error).message;
    await prisma.imageItem.update({ where: { id: item.id }, data: { applyStatus: "failed", applyError: message.slice(0, 300) } }).catch(() => undefined);
    await log(ctx.shop, "image_apply_failed", `${item.productTitle ?? ""}: ${message}`, "error");
  }
}

/** Puts the saved original back into the product image. */
export async function restoreOriginal(ctx: Ctx, mediaId: string) {
  const b = await prisma.imageBackup.findUnique({ where: { shop_mediaId: { shop: ctx.shop, mediaId } } });
  const file = b ? path.join(IMAGE_DIR, b.file) : "";
  if (!b || !existsSync(file)) throw new Error("There is no saved original for this image.");
  await replaceImage(ctx, mediaId, readFileSync(file), b.ext, `original.${b.ext}`);
  await prisma.imageBackup.update({ where: { id: b.id }, data: { restoredAt: new Date() } });
  await prisma.imageItem.updateMany({ where: { shop: ctx.shop, mediaId, applyStatus: "applied" }, data: { applyStatus: "restored" } });
  await log(ctx.shop, "image_restored", `${b.productTitle || b.productId}`);
  return { productTitle: b.productTitle };
}

export const backupsFor = (shop: string, mediaIds: string[]) =>
  prisma.imageBackup.findMany({ where: { shop, mediaId: { in: mediaIds } }, select: { mediaId: true, createdAt: true, restoredAt: true } });

/** Writes a file inside the backups folder (used by tests to simulate an existing backup). */
export const _writeBackupFile = (rel: string, bytes: Buffer) => {
  mkdirSync(path.dirname(path.join(IMAGE_DIR, rel)), { recursive: true });
  writeFileSync(path.join(IMAGE_DIR, rel), bytes);
};
