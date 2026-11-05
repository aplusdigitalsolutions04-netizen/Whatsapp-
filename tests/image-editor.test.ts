import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

// The batch folder must be chosen before the job module is loaded.
const TMP = mkdtempSync(path.join(os.tmpdir(), "image-editor-test-"));
process.env.IMAGE_EDITOR_DIR = TMP;

const { default: prisma } = await import("../app/db.server.ts");
const { pool } = await import("../app/lib/image/pool.server.ts");
const jobs = await import("../app/lib/image/jobs.server.ts");
const { DEFAULT_OPTIONS, LIMITS, effectiveFormat, normalizeOptions, workerAdvice } = await import("../app/lib/image/settings.ts");

const SHOP = "image-editor-test.invalid";

after(async () => {
  await pool.shutdown();
  await prisma.imageJob.deleteMany({ where: { shop: SHOP } });
  await prisma.imageSettings.deleteMany({ where: { shop: SHOP } });
  await prisma.$disconnect();
  rmSync(TMP, { recursive: true, force: true });
});

const photo = (w = 900, h = 600, hue = 0) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 200 - hue, g: 120 + hue, b: 90 } } }).jpeg().toBuffer();

const plain = { ...DEFAULT_OPTIONS, removeBg: false, trim: false, shadow: "none" as const, width: 500, height: 500, suffix: "_web" };

async function until(cond: () => Promise<boolean> | boolean, ms = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error("timed out waiting");
}

test("settings: untrusted input is clamped and whitelisted", () => {
  const o = normalizeOptions({ width: 99999, height: -5, padding: 500, format: "exe", color: "red", suffix: "a/b..\\c d!", quality: "x", removeBg: "false", evil: 1 });
  assert.equal(o.width, 4000);
  assert.equal(o.height, 64);
  assert.equal(o.padding, 40);
  assert.equal(o.format, DEFAULT_OPTIONS.format);
  assert.equal(o.color, DEFAULT_OPTIONS.color);
  assert.equal(o.suffix, "ab..cd");
  assert.equal(o.quality, DEFAULT_OPTIONS.quality);
  assert.equal(o.removeBg, false);
  assert.ok(!("evil" in o));
  assert.equal(effectiveFormat({ ...DEFAULT_OPTIONS, background: "transparent", format: "jpg" }), "png");
});

test("worker advice: AI background removal wants few workers, plain resizing scales", () => {
  const ai = workerAdvice(12, 6, true);
  const plainAdvice = workerAdvice(12, 6, false);
  assert.ok(ai.recommended <= 2);
  assert.equal(plainAdvice.recommended, 6);
  assert.equal(plainAdvice.max, LIMITS.maxWorkers);
  assert.equal(workerAdvice(2, 0.5, false).recommended, 1);
});

test("uploads: only real JPG/PNG/WebP content is accepted, never by name alone", async () => {
  const { id } = await jobs.createJob(SHOP, "uploads", plain);
  assert.equal(jobs.detectType(Buffer.from("MZ not an image at all....")), null);
  await assert.rejects(jobs.addUpload(SHOP, id, { name: "evil.jpg", bytes: Buffer.from("<?php echo 1; ?> this is a script file") }), /Only JPG, PNG and WebP/);
  await assert.rejects(jobs.addUpload(SHOP, id, { name: "empty.jpg", bytes: Buffer.alloc(0) }), /empty/);
  await assert.rejects(jobs.addUpload("someone-else.invalid", id, { name: "x.jpg", bytes: await photo() }), /not found/);
  const itemId = await jobs.addUpload(SHOP, id, { name: "../../etc/pass wd.jpg", bytes: await photo(), folder: "../Shoes/inner" });
  const item = await prisma.imageItem.findUniqueOrThrow({ where: { id: itemId } });
  assert.ok(!item.name.includes("/") && !item.name.includes("\\"), "path parts are removed from the stored name");
  assert.match(item.folder, /^[^./\\]+$/, "a folder name can never climb out of the batch folder");
  assert.ok(existsSync(jobs.itemPaths(id, itemId, "jpg").input));
});

test("a batch runs on several workers, saves results, and reports bad photos honestly", async () => {
  const { id } = await jobs.createJob(SHOP, "batch", plain);
  for (let i = 0; i < 8; i++) await jobs.addUpload(SHOP, id, { name: `shoe ${i}.jpg`, bytes: await photo(900, 600, i * 10), folder: i < 4 ? "Shoes" : "" });
  const png = await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 10, g: 20, b: 200, alpha: 0.5 } } }).png().toBuffer();
  await jobs.addUpload(SHOP, id, { name: "logo.png", bytes: png });
  // a valid JPEG signature followed by garbage passes the upload check but cannot be decoded
  const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
  const brokenId = await jobs.addUpload(SHOP, id, { name: "broken.jpg", bytes: broken });

  await jobs.setWorkers(SHOP, 3);
  assert.equal(await jobs.startJob(SHOP, id), 10);
  await until(async () => (await prisma.imageJob.findUniqueOrThrow({ where: { id } })).status === "done");

  const items = await prisma.imageItem.findMany({ where: { jobId: id } });
  assert.equal(items.filter((i) => i.status === "done").length, 9);
  const bad = items.find((i) => i.id === brokenId)!;
  assert.equal(bad.status, "error");
  assert.match(bad.error ?? "", /not a readable image/);
  const good = items.find((i) => i.name.startsWith("shoe 0"))!;
  assert.equal(good.outName, "shoe 0_web.jpg");
  assert.equal([good.width, good.height].join("x"), "500x500");
  assert.ok(good.outBytes > 0 && good.ms > 0);
  assert.ok(existsSync(`${jobs.itemPaths(id, good.id, "jpg").outBase}.jpg`));
  assert.ok(existsSync(jobs.itemPaths(id, good.id, "jpg").thumb));
  assert.ok(existsSync(jobs.itemPaths(id, good.id, "jpg").orig));

  // the failed photo can be retried (it fails again, honestly, instead of vanishing)
  assert.equal(await jobs.retryFailed(SHOP, id), 1);
  await until(async () => (await prisma.imageJob.findUniqueOrThrow({ where: { id } })).status === "done");
  assert.equal((await prisma.imageItem.findUniqueOrThrow({ where: { id: brokenId } })).status, "error");
});

test("the worker count can be raised and lowered while a batch is running", async () => {
  const { id } = await jobs.createJob(SHOP, "live", plain);
  const bytes = await photo(3000, 2000);
  for (let i = 0; i < 24; i++) await jobs.addUpload(SHOP, id, { name: `big ${i}.jpg`, bytes });
  await jobs.setWorkers(SHOP, 1);
  await jobs.startJob(SHOP, id);
  await until(() => pool.stats().busy >= 1);
  assert.equal(pool.stats().target, 1);

  await jobs.setWorkers(SHOP, 5);
  let peak = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 6000 && peak < 4) {
    peak = Math.max(peak, pool.stats().busy);
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.ok(peak >= 4, `expected several workers busy at once, saw ${peak}`);

  await jobs.setWorkers(SHOP, 2);
  await until(async () => (await prisma.imageJob.findUniqueOrThrow({ where: { id } })).status === "done");
  assert.equal((await prisma.imageItem.count({ where: { jobId: id, status: "done" } })), 24);
  assert.ok(pool.stats().alive <= 2, "extra workers retire once the target is lowered");
});

test("stopping keeps the waiting photos so the batch can resume", async () => {
  const { id } = await jobs.createJob(SHOP, "stop", plain);
  const bytes = await photo(3000, 2000);
  for (let i = 0; i < 14; i++) await jobs.addUpload(SHOP, id, { name: `p ${i}.jpg`, bytes });
  await jobs.setWorkers(SHOP, 1);
  await jobs.startJob(SHOP, id);
  await until(async () => (await prisma.imageItem.count({ where: { jobId: id, status: "done" } })) >= 1);
  await jobs.stopJob(SHOP, id);
  await until(() => pool.stats().busy === 0);
  await new Promise((r) => setTimeout(r, 300));
  const done = await prisma.imageItem.count({ where: { jobId: id, status: "done" } });
  const waiting = await prisma.imageItem.count({ where: { jobId: id, status: "queued" } });
  assert.equal((await prisma.imageJob.findUniqueOrThrow({ where: { id } })).status, "stopped");
  assert.ok(waiting > 0 && done + waiting === 14, `done ${done} + waiting ${waiting}`);

  await jobs.startJob(SHOP, id);
  await until(async () => (await prisma.imageJob.findUniqueOrThrow({ where: { id } })).status === "done");
  assert.equal(await prisma.imageItem.count({ where: { jobId: id, status: "done" } }), 14);
});

test("deleting a batch removes its files and rows", async () => {
  const { id } = await jobs.createJob(SHOP, "delete", plain);
  const itemId = await jobs.addUpload(SHOP, id, { name: "a.jpg", bytes: await photo() });
  const input = jobs.itemPaths(id, itemId, "jpg").input;
  assert.ok(existsSync(input));
  await jobs.deleteJob(SHOP, id);
  assert.ok(!existsSync(input));
  assert.equal(await prisma.imageJob.count({ where: { id } }), 0);
  assert.equal(await prisma.imageItem.count({ where: { jobId: id } }), 0);
});
