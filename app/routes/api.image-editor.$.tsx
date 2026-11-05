import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Zip, ZipPassThrough } from "fflate";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { verifyImageSignature } from "../lib/media.server";
import { addUpload, createJob, deleteJob, itemPaths, retryFailed, setWorkers, startJob, stopJob } from "../lib/image/jobs.server";
import { LIMITS } from "../lib/image/settings";
import { applyItems, createStoreJob, restoreOriginal } from "../lib/image/store-jobs.server";
import { lookupSkus, uploadProductImages, sniffImage, MAX_IMAGES_PER_PRODUCT, type Mode } from "../lib/image/bulk-upload.server";
import { shopifyCtx } from "../lib/image/shopify-ctx.server";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const SEG = /^[\w.-]+$/;
const MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

const disposition = (name: string) => `attachment; filename="${name.replace(/[^\w.\- ]+/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;

/** Signed downloads: photos, one result, or the whole batch as a ZIP (streamed, one file in memory at a time). */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const parts = (params["*"] ?? "").split("/").map(decodeURIComponent);
  if (!parts.every((p) => SEG.test(p)) || !verifyImageSignature(parts.join("/"), url.searchParams.get("exp"), url.searchParams.get("sig"))) {
    return new Response("Forbidden", { status: 403 });
  }
  const [kind, jobId, a, b] = parts;

  if (kind === "file" && jobId && a && b) {
    // a = thumb | orig | result, b = item id
    const item = await prisma.imageItem.findFirst({ where: { id: b, jobId } });
    if (!item) return new Response("Not found", { status: 404 });
    const p = itemPaths(jobId, item.id, item.ext);
    const ext = item.outName ? path.extname(item.outName).slice(1).toLowerCase() : "";
    const file = a === "thumb" ? p.thumb : a === "orig" ? p.orig : a === "result" && ext ? `${p.outBase}.${ext}` : null;
    if (!file || !existsSync(file)) return new Response("Not found", { status: 404 });
    const type = a === "result" ? MIME[ext] : "image/webp";
    if (!type) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(await readFile(file)), {
      headers: { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600", ...(url.searchParams.get("dl") ? { "Content-Disposition": disposition(item.outName ?? item.name) } : {}) },
    });
  }

  if (kind === "zip" && jobId) {
    const job = await prisma.imageJob.findUnique({ where: { id: jobId } });
    if (!job) return new Response("Not found", { status: 404 });
    const items = await prisma.imageItem.findMany({ where: { jobId, status: "done" }, orderBy: { createdAt: "asc" } });
    const used = new Set<string>();
    const files = items
      .map((it) => {
        const ext = path.extname(it.outName ?? "").slice(1).toLowerCase();
        if (!it.outName || !ext) return null;
        const dir = JSON.parse(job.settings || "{}").keepFolders !== false && it.folder ? `${it.folder}/` : "";
        let name = `${dir}${it.outName}`;
        for (let n = 2; used.has(name.toLowerCase()); n++) name = `${dir}${it.outName.replace(/(\.[^.]+)$/, ` (${n})$1`)}`;
        used.add(name.toLowerCase());
        return { name, file: `${itemPaths(jobId, it.id, it.ext).outBase}.${ext}` };
      })
      .filter((f): f is { name: string; file: string } => Boolean(f && existsSync(f.file)));
    if (files.length === 0) return new Response("No finished photos", { status: 404 });

    let i = 0;
    let ended = false;
    let zip: Zip;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        zip = new Zip((err, chunk, final) => {
          if (err) controller.error(err);
          else {
            controller.enqueue(chunk);
            if (final) controller.close();
          }
        });
      },
      async pull() {
        if (i < files.length) {
          const f = files[i++];
          const entry = new ZipPassThrough(f.name); // photos are already compressed: store them
          zip.add(entry);
          entry.push(new Uint8Array(await readFile(f.file)), true);
        } else if (!ended) {
          ended = true;
          zip.end();
        }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/zip", "Content-Disposition": disposition(`${job.name || "images"}.zip`), "Cache-Control": "no-store" } });
  }
  return new Response("Not found", { status: 404 });
};

/** Authenticated actions: create a batch, upload one photo at a time, start/stop/retry/delete, change the worker count. */
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const [op, jobId] = (params["*"] ?? "").split("/");
  try {
    if (op === "create") {
      const body = await request.json().catch(() => ({}));
      const r = await createJob(shop, String(body?.name ?? ""), body?.options);
      return json(r);
    }
    if (op === "store-create") {
      const body = await request.json().catch(() => ({}));
      const images = Array.isArray(body?.images) ? body.images.map((i: Record<string, unknown>) => ({ productId: String(i?.productId ?? ""), productTitle: String(i?.productTitle ?? "").slice(0, 200), mediaId: String(i?.mediaId ?? ""), url: String(i?.url ?? "") })) : [];
      return json(await createStoreJob(shopifyCtx(shop), String(body?.name ?? "") || "Store products", body?.options, images));
    }
    if (op === "bulk-check") {
      const body = await request.json().catch(() => ({}));
      const skus = Array.isArray(body?.skus) ? body.skus.map((x: unknown) => String(x)).slice(0, 500) : [];
      return json({ matches: await lookupSkus(shopifyCtx(shop), skus) });
    }
    if (op === "bulk-product") {
      const form = await request.formData();
      const productId = String(form.get("productId") ?? "");
      const sku = String(form.get("sku") ?? "image").replace(/[^\w.-]+/g, "_").slice(0, 60) || "image";
      const mode: Mode = form.get("mode") === "replace" ? "replace" : "append";
      const images = [];
      for (const [key, value] of form.entries()) {
        const m = /^image-(\d{1,3})$/.exec(key);
        if (!m || !(value instanceof File) || images.length >= MAX_IMAGES_PER_PRODUCT) continue;
        const bytes = Buffer.from(await value.arrayBuffer());
        const ext = sniffImage(bytes);
        images.push({ position: Number(m[1]), bytes, ext: ext ?? ("jpg" as const) });
      }
      const result = await uploadProductImages(shopifyCtx(shop), productId, mode, images, sku);
      await prisma.activityLog.create({ data: { shop, source: "shopify", event: result.failed.length ? "image_bulk_partial" : "image_bulk_uploaded", level: result.failed.length ? "error" : "info", detail: `${sku}: ${result.added} added, ${result.failed.length} failed${result.removed ? `, ${result.removed} old removed` : ""}`.slice(0, 400) } }).catch(() => undefined);
      return json(result);
    }
    if (op === "restore") {
      const body = await request.json().catch(() => ({}));
      return json(await restoreOriginal(shopifyCtx(shop), String(body?.mediaId ?? "")));
    }
    if (op === "workers") {
      const body = await request.json().catch(() => ({}));
      return json({ workers: await setWorkers(shop, Number(body?.workers)) });
    }
    if (!jobId || !SEG.test(jobId)) return json({ error: "Batch id missing." }, 400);
    if (op === "upload") {
      if (Number(request.headers.get("content-length") ?? 0) > LIMITS.maxFileBytes + 1024 * 1024) return json({ error: "The file is too large." }, 413);
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return json({ error: "No file received." }, 400);
      const id = await addUpload(shop, jobId, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()), folder: String(form.get("folder") ?? "") });
      return json({ id });
    }
    if (op === "apply") {
      const body = await request.json().catch(() => ({}));
      const ids = Array.isArray(body?.itemIds) ? body.itemIds.map(String).filter((x: string) => SEG.test(x)) : undefined;
      return json({ applying: await applyItems(shopifyCtx(shop), jobId, ids) });
    }
    if (op === "start") return json({ queued: await startJob(shop, jobId) });
    if (op === "stop") return json(await stopJob(shop, jobId).then(() => ({ ok: true })));
    if (op === "retry") return json({ queued: await retryFailed(shop, jobId) });
    if (op === "delete") return json(await deleteJob(shop, jobId).then(() => ({ ok: true })));
    return json({ error: "Unknown action." }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
};
