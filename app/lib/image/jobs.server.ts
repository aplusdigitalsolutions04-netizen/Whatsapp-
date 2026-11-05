import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import prisma from "../../db.server.ts";
import { pool, type Task, type TaskResult } from "./pool.server.ts";
import { LIMITS, normalizeOptions, type ImageOptions } from "./settings.ts";

export const IMAGE_DIR = path.resolve(process.env.IMAGE_EDITOR_DIR || ".image-editor");

const g = globalThis as unknown as { __imageRecovered?: boolean };

// ---------- helpers ----------
const safeSeg = (s: string) => s.normalize("NFC").replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/^[. ]+|[. ]+$/g, "").slice(0, 80) || "image";

/** The real file type from the first bytes (the name and the declared type are not trusted). */
export function detectType(b: Buffer): "jpg" | "png" | "webp" | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

export const jobDir = (jobId: string) => path.join(IMAGE_DIR, jobId);
export const itemPaths = (jobId: string, itemId: string, ext: string) => ({
  input: path.join(jobDir(jobId), "in", `${itemId}.${ext}`),
  outBase: path.join(jobDir(jobId), "out", itemId),
  thumb: path.join(jobDir(jobId), "thumb", `${itemId}.webp`),
  orig: path.join(jobDir(jobId), "orig", `${itemId}.webp`),
});

/** The file name of a result inside the ZIP: original name + suffix + new extension. */
export function resultName(original: string, suffix: string, ext: string) {
  const base = safeSeg(original.replace(/\.[^.]+$/, ""));
  return `${base}${suffix}.${ext}`;
}

// ---------- worker setting ----------
export async function getWorkers(shop: string): Promise<number> {
  const row = await prisma.imageSettings.findUnique({ where: { shop } });
  return Math.min(LIMITS.maxWorkers, Math.max(1, row?.workers ?? 2));
}

/** Saves the worker count and applies it to the running pool immediately. */
export async function setWorkers(shop: string, n: number): Promise<number> {
  const workers = Math.min(LIMITS.maxWorkers, Math.max(1, Math.round(n) || 1));
  await prisma.imageSettings.upsert({ where: { shop }, create: { shop, workers }, update: { workers } });
  pool.setWorkers(workers);
  return workers;
}

// ---------- jobs ----------
export async function createJob(shop: string, name: string, options: unknown, kind: "upload" | "store" = "upload") {
  const id = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  const opts = normalizeOptions(options);
  mkdirSync(jobDir(id), { recursive: true });
  await prisma.imageJob.create({ data: { id, shop, kind, name: (name.trim() || "Image batch").slice(0, 80), settings: JSON.stringify(opts) } });
  return { id, options: opts };
}

async function ownJob(shop: string, jobId: string) {
  const job = await prisma.imageJob.findFirst({ where: { id: jobId, shop } });
  if (!job) throw new Error("Batch not found.");
  return job;
}

/** Stores one uploaded photo. Rejects anything that is not a real JPG, PNG or WebP within the limits. */
export async function addUpload(shop: string, jobId: string, file: { name: string; bytes: Buffer; folder?: string }) {
  const job = await ownJob(shop, jobId);
  if (job.status === "running") throw new Error("This batch is already running.");
  if (file.bytes.length === 0) throw new Error("The file is empty.");
  if (file.bytes.length > LIMITS.maxFileBytes) throw new Error(`The file is larger than ${LIMITS.maxFileBytes / 1024 / 1024} MB.`);
  const ext = detectType(file.bytes);
  if (!ext) throw new Error("Only JPG, PNG and WebP photos are supported.");
  if ((await prisma.imageItem.count({ where: { jobId } })) >= LIMITS.maxFiles) throw new Error(`A batch can hold up to ${LIMITS.maxFiles} photos.`);

  const item = await prisma.imageItem.create({
    data: { jobId, shop, name: safeSeg(file.name), folder: file.folder ? safeSeg(file.folder.split(/[\\/]/)[0]) : "", ext, inBytes: file.bytes.length },
  });
  const p = itemPaths(jobId, item.id, ext);
  mkdirSync(path.dirname(p.input), { recursive: true });
  writeFileSync(p.input, file.bytes);
  await prisma.imageJob.update({ where: { id: jobId }, data: { total: { increment: 1 } } });
  return item.id;
}

/** Stores one downloaded Shopify product photo in a "store" batch (real file type checked, same limits as uploads). */
export async function addStoreItem(shop: string, jobId: string, f: { bytes: Buffer; productId: string; productTitle: string; mediaId: string; srcUrl: string }) {
  const job = await ownJob(shop, jobId);
  if (job.kind !== "store") throw new Error("This batch is not made from Shopify products.");
  const ext = detectType(f.bytes);
  if (!ext) throw new Error("The product image is not a JPG, PNG or WebP file.");
  if (f.bytes.length > LIMITS.maxFileBytes) throw new Error(`The image is larger than ${LIMITS.maxFileBytes / 1024 / 1024} MB.`);
  const item = await prisma.imageItem.create({
    data: {
      jobId, shop, ext, inBytes: f.bytes.length, name: `${safeSeg(f.productTitle).slice(0, 50)} ${f.mediaId.split("/").pop()}.${ext}`,
      productId: f.productId, productTitle: f.productTitle.slice(0, 200), mediaId: f.mediaId, srcUrl: f.srcUrl,
    },
  });
  const p = itemPaths(jobId, item.id, ext);
  mkdirSync(path.dirname(p.input), { recursive: true });
  writeFileSync(p.input, f.bytes);
  await prisma.imageJob.update({ where: { id: jobId }, data: { total: { increment: 1 } } });
  return item.id;
}

const taskFor = (jobId: string, itemId: string, ext: string, options: ImageOptions, keepType = false): Task => {
  const p = itemPaths(jobId, itemId, ext);
  return {
    id: itemId, jobId, inPath: p.input, outBase: p.outBase, thumbPath: p.thumb, origPath: p.orig, options,
    ...(keepType ? { forceExt: ext as "jpg" | "png" | "webp" } : {}),
  };
};

/** Queues every waiting photo of the batch. Also used to resume a stopped batch. */
export async function startJob(shop: string, jobId: string) {
  const job = await ownJob(shop, jobId);
  const options = normalizeOptions(JSON.parse(job.settings || "{}"));
  const items = await prisma.imageItem.findMany({ where: { jobId, status: "queued" }, select: { id: true, ext: true } });
  if (items.length === 0) throw new Error("There are no waiting photos in this batch.");
  await prisma.imageJob.update({ where: { id: jobId }, data: { status: "running", startedAt: job.startedAt ?? new Date(), finishedAt: null } });
  pool.setWorkers(await getWorkers(shop));
  pool.submit(items.map((i) => taskFor(jobId, i.id, i.ext, options, job.kind === "store")));
  return items.length;
}

/** Stops handing out photos. Photos already being processed finish; the rest stay waiting so the batch can resume. */
export async function stopJob(shop: string, jobId: string) {
  await ownJob(shop, jobId);
  pool.cancelJob(jobId);
  await prisma.imageJob.update({ where: { id: jobId }, data: { status: "stopped" } });
}

export async function retryFailed(shop: string, jobId: string) {
  await ownJob(shop, jobId);
  const r = await prisma.imageItem.updateMany({ where: { jobId, status: "error" }, data: { status: "queued", error: null, finishedAt: null } });
  if (r.count === 0) throw new Error("No failed photos to retry.");
  return startJob(shop, jobId);
}

export async function deleteJob(shop: string, jobId: string) {
  await ownJob(shop, jobId);
  pool.cancelJob(jobId);
  await prisma.imageJob.delete({ where: { id: jobId } });
  if (/^[\w-]+$/.test(jobId)) rmSync(jobDir(jobId), { recursive: true, force: true });
}

/**
 * After a server restart nothing is running any more: batches that were mid-way become "stopped" with their
 * unfinished photos waiting, so the owner can press Resume.
 */
export async function recoverInterrupted() {
  if (g.__imageRecovered) return;
  g.__imageRecovered = true;
  const jobs = await prisma.imageJob.findMany({ where: { status: { in: ["running", "queued"] } }, select: { id: true } });
  for (const j of jobs) {
    await prisma.imageItem.updateMany({ where: { jobId: j.id, status: "running" }, data: { status: "queued" } });
    await prisma.imageJob.update({ where: { id: j.id }, data: { status: "stopped" } });
  }
  // an "Apply to Shopify" that was cut short by the restart can simply be pressed again
  await prisma.imageItem.updateMany({ where: { applyStatus: "applying" }, data: { applyStatus: "" } });
}

// ---------- pool callbacks ----------
async function finishIfDone(jobId: string) {
  const open = await prisma.imageItem.count({ where: { jobId, status: { in: ["queued", "running"] } } });
  if (open > 0) return;
  const job = await prisma.imageJob.findUnique({ where: { id: jobId }, select: { status: true } });
  if (job && job.status === "running") await prisma.imageJob.update({ where: { id: jobId }, data: { status: "done", finishedAt: new Date() } });
}

pool.onStart = (task: Task) => {
  // only a waiting photo becomes "running": a fast photo may already be finished when this write lands
  void prisma.imageItem.updateMany({ where: { id: task.id, status: "queued" }, data: { status: "running" } }).catch(() => undefined);
};

pool.onResult = (task: Task, r: TaskResult) => {
  void (async () => {
    try {
      const item = await prisma.imageItem.findUnique({ where: { id: task.id }, select: { name: true } });
      if (!item) return; // the batch was deleted while this photo was being processed
      if (r.ok) {
        await prisma.imageItem.update({
          where: { id: task.id },
          data: {
            status: "done", error: null, note: r.note || null, outBytes: r.outBytes, width: r.width, height: r.height, ms: r.ms,
            outName: resultName(item.name, task.options.suffix, r.ext), finishedAt: new Date(),
          },
        });
      } else {
        await prisma.imageItem.update({ where: { id: task.id }, data: { status: "error", error: r.error, finishedAt: new Date() } });
      }
      await finishIfDone(task.jobId);
    } catch {
      /* the database row may be gone (deleted batch): nothing to record */
    }
  })();
};
