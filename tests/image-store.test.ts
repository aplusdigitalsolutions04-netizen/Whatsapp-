/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const TMP = mkdtempSync(path.join(os.tmpdir(), "image-store-test-"));
process.env.IMAGE_EDITOR_DIR = TMP;

const { default: prisma } = await import("../app/db.server.ts");
const { pool } = await import("../app/lib/image/pool.server.ts");
const jobs = await import("../app/lib/image/jobs.server.ts");
const store = await import("../app/lib/image/store-jobs.server.ts");
const shop = await import("../app/lib/image/shopify-images.server.ts");
const { DEFAULT_OPTIONS } = await import("../app/lib/image/settings.ts");

const SHOP = "image-store-test.invalid";

after(async () => {
  await pool.shutdown();
  await prisma.imageJob.deleteMany({ where: { shop: SHOP } });
  await prisma.imageBackup.deleteMany({ where: { shop: SHOP } });
  await prisma.activityLog.deleteMany({ where: { shop: SHOP } });
  await prisma.$disconnect();
  rmSync(TMP, { recursive: true, force: true });
});

const jpeg = (hue: number) => sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 200 - hue, g: 100 + hue, b: 60 } } }).jpeg().toBuffer();
const plain = { ...DEFAULT_OPTIONS, removeBg: false, trim: false, shadow: "none" as const, width: 600, height: 600 };
const GID = (kind: string, n: number) => `gid://shopify/${kind}/${n}`;

/** A scripted stand-in for Shopify: records every call so the tests can check what would have been sent. */
function fakeShopify(opts: { originals?: Record<string, Buffer>; failStage?: boolean; failUpload?: boolean; fileUpdateError?: boolean; finalStatus?: string; stuck?: boolean } = {}) {
  const calls: { op: string; vars?: any }[] = [];
  const uploads: { url: string; fields: Record<string, string>; bytes: Buffer }[] = [];
  let polls = 0;
  const gql = async (q: string, vars?: any) => {
    if (q.includes("stagedUploadsCreate")) {
      calls.push({ op: "stage", vars });
      if (opts.failStage) return { stagedUploadsCreate: { stagedTargets: [], userErrors: [{ field: ["input"], message: "bad file" }] } };
      return { stagedUploadsCreate: { stagedTargets: [{ url: "https://upload.example/target", resourceUrl: `https://staged.example/${calls.length}.jpg`, parameters: [{ name: "key", value: "tmp/abc" }] }], userErrors: [] } };
    }
    if (q.includes("fileUpdate")) {
      calls.push({ op: "fileUpdate", vars });
      if (opts.fileUpdateError) return { fileUpdate: { files: [], userErrors: [{ message: "File is locked", code: "X" }] } };
      return { fileUpdate: { files: [{ id: vars.files[0].id, fileStatus: "UPLOADED" }], userErrors: [] } };
    }
    if (q.includes("ImageStatus")) {
      calls.push({ op: "status", vars });
      polls++;
      if (opts.stuck) return { node: { id: vars.id, fileStatus: "PROCESSING" } };
      return { node: { id: vars.id, fileStatus: polls % 2 ? "PROCESSING" : (opts.finalStatus ?? "READY"), image: { url: "https://cdn.shopify.com/new.jpg?v=2" } } };
    }
    if (q.includes("StoreProducts")) {
      calls.push({ op: "products", vars });
      return {
        products: {
          nodes: [
            { id: GID("Product", 1), title: "HP Printer", status: "ACTIVE", featuredMedia: { id: GID("MediaImage", 12) }, media: { nodes: [
              { id: GID("MediaImage", 11), alt: "front", mediaContentType: "IMAGE", status: "READY", image: { url: "https://cdn.shopify.com/a.jpg", width: 1200, height: 900 }, thumb: { url: "https://cdn.shopify.com/a.jpg?width=320" } },
              { id: GID("MediaImage", 12), alt: "", mediaContentType: "IMAGE", status: "READY", image: { url: "https://cdn.shopify.com/b.jpg", width: 800, height: 800 }, thumb: { url: "https://cdn.shopify.com/b.jpg?width=320" } },
              { id: GID("Video", 13), alt: "", mediaContentType: "VIDEO" },
            ] } },
            { id: GID("Product", 2), title: "No photo yet", status: "DRAFT", featuredMedia: null, media: { nodes: [] } },
          ],
          pageInfo: { hasNextPage: true, endCursor: "CUR1" },
        },
      };
    }
    throw new Error(`unexpected query ${q.slice(0, 40)}`);
  };
  const fetchFn = (async (url: string, init?: any) => {
    if (init?.method === "POST") {
      calls.push({ op: "upload", vars: { url } });
      if (opts.failUpload) return new Response("denied", { status: 403 });
      const fields: Record<string, string> = {};
      let bytes = Buffer.alloc(0);
      for (const [k, v] of (init.body as FormData).entries()) {
        if (typeof v === "string") fields[k] = v;
        else bytes = Buffer.from(await (v as Blob).arrayBuffer());
      }
      uploads.push({ url, fields, bytes });
      return new Response(null, { status: 204 });
    }
    const body = opts.originals?.[url];
    if (!body) return new Response("nope", { status: 404 });
    return new Response(new Uint8Array(body), { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(body.length) } });
  }) as unknown as typeof fetch;
  const ctx = { shop: SHOP, gql, fetch: fetchFn, sleep: async () => undefined, timeoutMs: 300 };
  return { ctx, calls, uploads };
}

async function until(cond: () => Promise<boolean> | boolean, ms = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error("timed out waiting");
}

test("product list: only real images, the main image is marked, the search is cleaned", async () => {
  const { ctx, calls } = fakeShopify();
  const r = await shop.listStoreProducts(ctx, { q: 'printer" OR (x:*', after: null });
  assert.equal(r.products.length, 2);
  assert.deepEqual(r.products[0].images.map((i) => [i.id, i.main]), [[GID("MediaImage", 11), false], [GID("MediaImage", 12), true]]);
  assert.equal(r.products[1].images.length, 0);
  assert.equal(r.hasNext, true);
  assert.equal(r.endCursor, "CUR1");
  const q = calls[0].vars.q as string;
  assert.ok(!/["()\\]/.test(q.replace(/^title:\*|\* OR sku:.*/g, "")), `search syntax characters are stripped: ${q}`);
  assert.equal(shop.canEditImages(["read_products"]), false);
  assert.equal(shop.canEditImages(["read_products", "write_files"]), true);
});

test("only Shopify's own image servers are downloaded from", async () => {
  const bytes = await jpeg(1);
  const { ctx } = fakeShopify({ originals: { "https://cdn.shopify.com/ok.jpg": bytes } });
  assert.equal(shop.isShopifyImageUrl("https://cdn.shopify.com/s/files/x.jpg"), true);
  for (const bad of ["http://cdn.shopify.com/x.jpg", "https://evil.example.com/x.jpg", "https://cdn.shopify.com.evil.io/x.jpg", "file:///etc/passwd", "nonsense"]) {
    assert.equal(shop.isShopifyImageUrl(bad), false, bad);
  }
  assert.equal((await shop.downloadImage(ctx, "https://cdn.shopify.com/ok.jpg")).length, bytes.length);
  await assert.rejects(shop.downloadImage(ctx, "https://evil.example.com/x.jpg"), /not hosted by Shopify/);
  await assert.rejects(shop.downloadImage(ctx, "https://cdn.shopify.com/missing.jpg"), /HTTP 404/);
});

test("replacing an image: upload, attach to the SAME media id, wait until Shopify is done", async () => {
  const f = fakeShopify();
  const bytes = await jpeg(5);
  const r = await shop.replaceImage(f.ctx, GID("MediaImage", 11), bytes, "jpg", "edited.jpg");
  assert.equal(r.url, "https://cdn.shopify.com/new.jpg?v=2");
  const ops = f.calls.map((c) => c.op);
  assert.deepEqual(ops.slice(0, 3), ["stage", "upload", "fileUpdate"]);
  assert.ok(ops.filter((o) => o === "status").length >= 2, "it polls until the file is READY");
  assert.equal(f.calls[0].vars.input[0].resource, "PRODUCT_IMAGE");
  assert.equal(f.calls[0].vars.input[0].mimeType, "image/jpeg");
  assert.equal(f.uploads[0].fields.key, "tmp/abc");
  assert.ok(f.uploads[0].bytes.equals(bytes), "the exact edited bytes were uploaded");
  const update = f.calls.find((c) => c.op === "fileUpdate")!.vars.files[0];
  assert.equal(update.id, GID("MediaImage", 11), "the existing image is updated, so position, alt text and variant links stay");
  assert.match(update.originalSource, /^https:\/\/staged\.example\//);
});

test("replacing an image: every failure is reported, nothing is silently ignored", async () => {
  const bytes = await jpeg(5);
  await assert.rejects(shop.replaceImage(fakeShopify({ failStage: true }).ctx, GID("MediaImage", 1), bytes, "jpg"), /did not accept the upload: bad file/);
  await assert.rejects(shop.replaceImage(fakeShopify({ failUpload: true }).ctx, GID("MediaImage", 1), bytes, "jpg"), /failed \(HTTP 403\)/);
  await assert.rejects(shop.replaceImage(fakeShopify({ fileUpdateError: true }).ctx, GID("MediaImage", 1), bytes, "jpg"), /refused the change: File is locked/);
  await assert.rejects(shop.replaceImage(fakeShopify({ finalStatus: "FAILED" }).ctx, GID("MediaImage", 1), bytes, "jpg"), /could not process/);
  await assert.rejects(shop.replaceImage(fakeShopify({ stuck: true }).ctx, GID("MediaImage", 1), bytes, "jpg"), /still processing/);
  await assert.rejects(shop.stageUpload(fakeShopify().ctx, bytes, "x.gif", "gif"), /Unsupported image type/);
});

test("edit, apply with backup, edit again, restore the true original", async () => {
  const original = await jpeg(10);
  const url = "https://cdn.shopify.com/o1.jpg";
  const f = fakeShopify({ originals: { [url]: original } });
  const media = GID("MediaImage", 501);
  const refs = [
    { productId: GID("Product", 7), productTitle: "Blue Mug", mediaId: media, url },
    { productId: GID("Product", 7), productTitle: "Blue Mug", mediaId: media, url }, // the same image twice counts once
    { productId: "not-an-id", productTitle: "x", mediaId: GID("MediaImage", 502), url },
    { productId: GID("Product", 7), productTitle: "Blue Mug", mediaId: GID("MediaImage", 503), url: "https://cdn.shopify.com/gone.jpg" }, // download fails
  ];
  const made = await store.createStoreJob(f.ctx, "Mug photos", plain, refs);
  assert.equal(made.added, 1);
  assert.equal(made.failed.length, 1);
  const job = await prisma.imageJob.findUniqueOrThrow({ where: { id: made.id } });
  assert.equal(job.kind, "store");
  assert.equal(job.total, 1);
  const item0 = await prisma.imageItem.findFirstOrThrow({ where: { jobId: made.id } });
  assert.deepEqual([item0.mediaId, item0.productTitle, item0.applyStatus], [media, "Blue Mug", ""]);

  await jobs.setWorkers(SHOP, 1);
  await jobs.startJob(SHOP, made.id);
  await until(async () => (await prisma.imageJob.findUniqueOrThrow({ where: { id: made.id } })).status === "done");
  const done = await prisma.imageItem.findFirstOrThrow({ where: { jobId: made.id } });
  assert.equal(done.status, "done");
  assert.match(done.outName ?? "", /\.jpg$/, "the edited photo keeps the Shopify image's file type");

  // nothing has touched Shopify yet: the edit is only a preview
  assert.equal(f.calls.filter((c) => c.op === "fileUpdate").length, 0);
  assert.equal(await prisma.imageBackup.count({ where: { shop: SHOP } }), 0);

  // apply
  assert.equal(await store.applyItems(f.ctx, made.id), 1);
  await until(async () => (await prisma.imageItem.findUniqueOrThrow({ where: { id: done.id } })).applyStatus === "applied");
  const applied = await prisma.imageItem.findUniqueOrThrow({ where: { id: done.id } });
  assert.equal(applied.newUrl, "https://cdn.shopify.com/new.jpg?v=2");
  const backup = await prisma.imageBackup.findUniqueOrThrow({ where: { shop_mediaId: { shop: SHOP, mediaId: media } } });
  assert.ok(readFileSync(path.join(TMP, backup.file)).equals(original), "the backup is the untouched original");
  const firstUpload = f.uploads[0].bytes;
  assert.ok(!firstUpload.equals(original), "what went to Shopify is the edited photo");
  assert.equal(f.calls.find((c) => c.op === "fileUpdate")!.vars.files[0].id, media);
  await assert.rejects(store.applyItems(f.ctx, made.id), /no finished edits/, "an applied edit is not applied twice");

  // a second edit of the same image must not overwrite the first backup
  const edited = await jpeg(80);
  const url2 = "https://cdn.shopify.com/o2.jpg";
  const f2 = fakeShopify({ originals: { [url2]: edited } });
  const second = await store.createStoreJob(f2.ctx, "Again", plain, [{ productId: GID("Product", 7), productTitle: "Blue Mug", mediaId: media, url: url2 }]);
  await jobs.startJob(SHOP, second.id);
  await until(async () => (await prisma.imageJob.findUniqueOrThrow({ where: { id: second.id } })).status === "done");
  await store.applyItems(f2.ctx, second.id);
  await until(async () => (await prisma.imageItem.findFirstOrThrow({ where: { jobId: second.id } })).applyStatus === "applied");
  const backup2 = await prisma.imageBackup.findUniqueOrThrow({ where: { shop_mediaId: { shop: SHOP, mediaId: media } } });
  assert.equal(backup2.id, backup.id);
  assert.ok(readFileSync(path.join(TMP, backup2.file)).equals(original), "the first backup is still the true original");

  // restore
  const f3 = fakeShopify();
  const back = await store.restoreOriginal(f3.ctx, media);
  assert.equal(back.productTitle, "Blue Mug");
  assert.ok(f3.uploads[0].bytes.equals(original), "the original bytes were uploaded again");
  assert.equal(f3.calls.find((c) => c.op === "fileUpdate")!.vars.files[0].id, media);
  assert.ok((await prisma.imageBackup.findUniqueOrThrow({ where: { id: backup.id } })).restoredAt);
  assert.equal((await prisma.imageItem.findUniqueOrThrow({ where: { id: done.id } })).applyStatus, "restored");
  await assert.rejects(store.restoreOriginal(f3.ctx, GID("MediaImage", 999)), /no saved original/);

  // deleting the batches keeps the backup
  await jobs.deleteJob(SHOP, made.id);
  await jobs.deleteJob(SHOP, second.id);
  assert.ok(existsSync(path.join(TMP, backup.file)), "a backup outlives its batch");
});

test("a failed apply is reported on that photo and the backup is still kept", async () => {
  const original = await jpeg(33);
  const url = "https://cdn.shopify.com/o9.jpg";
  const ok = fakeShopify({ originals: { [url]: original } });
  const media = GID("MediaImage", 777);
  const made = await store.createStoreJob(ok.ctx, "Will fail", plain, [{ productId: GID("Product", 9), productTitle: "Lamp", mediaId: media, url }]);
  await jobs.startJob(SHOP, made.id);
  await until(async () => (await prisma.imageJob.findUniqueOrThrow({ where: { id: made.id } })).status === "done");

  const bad = fakeShopify({ fileUpdateError: true });
  await store.applyItems(bad.ctx, made.id);
  await until(async () => (await prisma.imageItem.findFirstOrThrow({ where: { jobId: made.id } })).applyStatus === "failed");
  const it = await prisma.imageItem.findFirstOrThrow({ where: { jobId: made.id } });
  assert.match(it.applyError ?? "", /refused the change/);
  assert.ok(await prisma.imageBackup.findUnique({ where: { shop_mediaId: { shop: SHOP, mediaId: media } } }), "the original was saved before the attempt");

  // pressing Apply again retries it
  await store.applyItems(ok.ctx, made.id);
  await until(async () => (await prisma.imageItem.findFirstOrThrow({ where: { jobId: made.id } })).applyStatus === "applied");
  const log = await prisma.activityLog.findMany({ where: { shop: SHOP, event: { in: ["image_apply_failed", "image_applied"] } } });
  assert.ok(log.some((l) => l.event === "image_apply_failed" && l.level === "error"));
});
