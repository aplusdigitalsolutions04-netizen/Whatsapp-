import { test, after } from "node:test";
import assert from "node:assert/strict";
import prisma from "../app/db.server.ts";
import { auditProduct, duplicateIndex, normalize, poorHandle, RULES, type SeoProduct } from "../app/lib/seo/rules.ts";
import { cleanText, parseCsv, planChanges, toCsv, CsvError, type LiveProduct } from "../app/lib/seo/csv.ts";
import { getTask } from "../app/lib/progress.server.ts";
import { applyStep, batchProgress, exportCsv, previewCsv, retryFailed, startRun, startScan, undoStep } from "../app/lib/seo/seo-store.server.ts";

const SHOP = "seo-test.invalid";
const LONG = "A fast and reliable laser printer for the home office with duplex printing, wireless setup, and a low cost per page for everyday documents. It prints sharp black text quickly, connects to phones and laptops, and comes with a one year warranty from the brand.";

after(async () => {
  await prisma.seoBatch.deleteMany({ where: { shop: SHOP } });
  await prisma.seoProduct.deleteMany({ where: { shop: SHOP } });
  await prisma.seoScan.deleteMany({ where: { shop: SHOP } });
  await prisma.$disconnect();
});

const product = (o: Partial<SeoProduct> = {}): SeoProduct => ({
  id: "gid://shopify/Product/1", title: "HP LaserJet Pro Printer", handle: "hp-laserjet-pro-printer", vendor: "HP", productType: "Printer", tags: [], status: "ACTIVE",
  descText: LONG,
  seoTitle: "HP LaserJet Pro Printer | Fast Home Office Laser", seoDescription: "Buy the HP LaserJet Pro printer: fast duplex printing, wireless setup and a low cost per page. Free delivery across India.",
  images: [{ id: "gid://shopify/MediaImage/1", alt: "HP LaserJet Pro Printer front view", url: "https://cdn.shopify.com/a.jpg" }], ...o,
});
const rules = (p: SeoProduct, all: SeoProduct[] = [p]) => auditProduct(p, duplicateIndex(all)).issues.map((i) => i.rule).sort();

test("a well-filled product passes every check", () => {
  const a = auditProduct(product(), duplicateIndex([product()]));
  assert.deepEqual(a.issues, []);
  assert.equal(a.score, 100);
});

test("each rule fires on exactly its problem", () => {
  assert.deepEqual(rules(product({ seoTitle: "", seoDescription: "" })), ["seo-desc-missing", "seo-title-missing"]);
  assert.deepEqual(rules(product({ seoTitle: "Printer" })), ["seo-title-short"]);
  assert.deepEqual(rules(product({ seoTitle: "x".repeat(61) })), ["seo-title-long"]);
  assert.deepEqual(rules(product({ seoDescription: "Short text." })), ["seo-desc-short"]);
  assert.deepEqual(rules(product({ seoDescription: "y".repeat(161) })), ["seo-desc-long"]);
  assert.deepEqual(rules(product({ descText: "" })), ["description-missing"]);
  assert.deepEqual(rules(product({ descText: "Good printer for office." })), ["description-thin"]);
  assert.deepEqual(rules(product({ images: [] })), ["images-none"]);
  assert.deepEqual(rules(product({ images: [{ id: "m1", alt: "", url: "" }, { id: "m2", alt: "front", url: "" }] })), ["alt-missing"]);
  assert.deepEqual(rules(product({ images: [{ id: "m1", alt: "Front view", url: "" }, { id: "m2", alt: "front  VIEW!", url: "" }] })), ["alt-duplicate"]);
  assert.deepEqual(rules(product({ handle: "copy-of-hp-printer" })), ["handle-poor"]);
  assert.ok(poorHandle("printer-2") && poorHandle("untitled-product") && !poorHandle("hp-printer"));
});

test("duplicates need an exact match after tidying; a shared word is not a duplicate", () => {
  const a = product({ id: "a", seoTitle: "HP LaserJet Pro Printer | Fast Home Office Laser" });
  const b = product({ id: "b", seoTitle: "hp laserjet pro printer - fast home office laser!" });
  const c = product({ id: "c", seoTitle: "HP Printer Ink Cartridge Black Original 805" });
  assert.ok(rules(a, [a, b, c]).includes("title-duplicate"));
  assert.ok(!rules(c, [a, b, c]).includes("title-duplicate"), "only a shared word with the others");
  assert.ok(rules(a, [a, b, c]).includes("desc-duplicate"), "same description text");
  assert.equal(normalize("  Hello,   WORLD! "), "hello world");
});

test("the score is a checklist result: points are taken off per failed check and never go below 0", () => {
  const worst = product({ seoTitle: "", seoDescription: "", descText: "", images: [{ id: "m", alt: "", url: "" }], handle: "copy-of-x-1" });
  const a = auditProduct(worst, duplicateIndex([worst]));
  assert.equal(a.score, 100 - 12 - 12 - 10 - 10 - 2);
  assert.equal(a.errors, 4);
  assert.equal(a.warnings, 1);
  assert.ok(RULES.every((r) => r.impact > 0 && r.id && r.name && r.description));
});

test("CSV: quotes, commas, line breaks, BOM and Excel formula safety", () => {
  const rows = [["a", 'He said "hi", ok', "line1\nline2"], ["=SUM(1)", "-5% off", "plain"]];
  const text = toCsv(rows);
  assert.ok(text.startsWith("﻿"));
  assert.ok(text.includes("'=SUM(1)") && text.includes("'-5% off"), "cells starting with = or - are neutralised");
  assert.deepEqual(parseCsv(text)[0], rows[0]);
  assert.equal(cleanText(parseCsv(text)[1][0]), "=SUM(1)", "the protective quote is removed again on import");
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n\r\n"), [["a", "b"], ["1", "2"]]);
});

const live = (): Map<string, LiveProduct> =>
  new Map([["P1", { id: "P1", title: "Printer", seoTitle: "", seoDescription: "Old description for the printer", images: new Map([["M1", ""], ["M2", "Front"], ["M3", ""]]) }]]);
const head = "type,id,product_id,current_seo_title,new_seo_title,current_seo_description,new_seo_description,current_alt,new_alt\n";

test("import plan accepts valid values and refuses unsafe ones, saying why", () => {
  const csv = head + [
    "product,P1,P1,,HP LaserJet Pro Printer | Home Office,Old description for the printer,,,",
    "image,M1,P1,,,,,,HP LaserJet Pro Printer front view",
    "image,M2,P1,,,,,Front,Front",
    "product,P9,P9,,Some title that is long enough to pass,,,,",
    "image,M3,P1,,,,,,<b>Bold</b> photo",
  ].join("\n");
  const plan = planChanges(parseCsv(csv), live());
  assert.deepEqual(plan.changes.map((c) => [c.kind, c.after]), [["seoTitle", "HP LaserJet Pro Printer | Home Office"], ["alt", "HP LaserJet Pro Printer front view"]]);
  assert.equal(plan.unchanged, 1, "an unchanged ALT is not a change");
  assert.equal(plan.skipped.length, 2);
  assert.match(plan.skipped[0].reason, /not found in your store/);
  assert.match(plan.skipped[1].reason, /contains < or >/);
});

test("import plan never overwrites a value that changed after the export", () => {
  const stale = head + "product,P1,P1,,New title for the printer here,,Different old text,,\n";
  const plan = planChanges(parseCsv(stale.replace(",,Different old text,,", ",,,,")), live());
  assert.equal(plan.changes.length, 1);
  const p2 = planChanges(parseCsv(head + "product,P1,P1,,,Some other old text,A brand new meta description that is long enough to be good.,,\n"), live());
  assert.equal(p2.changes.length, 0);
  assert.match(p2.skipped[0].reason, /changed in Shopify after this file was downloaded/);
});

test("a file that is not our export, or has no new_ columns, is refused clearly", () => {
  assert.throws(() => planChanges(parseCsv("name,price\nx,1\n"), live()), CsvError);
  assert.throws(() => planChanges(parseCsv("type,id\nproduct,P1\n"), live()), /new_seo_title/);
});

// ---------- the whole round trip against a fake Shopify ----------

function fakeShopify(initial: { id: string; title: string; seoTitle?: string; seoDescription?: string; images: { id: string; alt: string }[] }[]) {
  const store = new Map(initial.map((p) => [p.id, { ...p, seoTitle: p.seoTitle ?? "", seoDescription: p.seoDescription ?? "", images: p.images.map((i) => ({ ...i })) }]));
  const calls: string[] = [];
  const gql = async (query: string, v: Record<string, unknown> = {}) => {
    const q = query.trim();
    const isMutation = q.startsWith("mutation");
    if (!isMutation && q.includes("SeoCount")) return { productsCount: { count: store.size } };
    if (!isMutation && q.includes("SeoProducts")) {
      return {
        products: {
          nodes: [...store.values()].map((p) => ({
            id: p.id, title: p.title, handle: p.title.toLowerCase().replace(/\W+/g, "-"), vendor: "HP", productType: "Printer", tags: [], status: "ACTIVE",
            description: LONG,
            seo: { title: p.seoTitle || null, description: p.seoDescription || null }, featuredMedia: null,
            media: { nodes: p.images.map((i) => ({ id: i.id, alt: i.alt || null, mediaContentType: "IMAGE", image: { url: "https://cdn.shopify.com/x.jpg" } })) },
          })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    }
    if (!isMutation && q.includes("SeoLive")) {
      const p = store.get(String(v.id));
      return { product: p ? { id: p.id, title: p.title, seo: { title: p.seoTitle || null, description: p.seoDescription || null } } : null };
    }
    if (!isMutation && q.includes("SeoAlts")) {
      const all = [...store.values()].flatMap((p) => p.images);
      calls.push("read-alts");
      return { nodes: (v.ids as string[]).map((id) => all.find((i) => i.id === id)).map((i) => (i ? { id: i.id, alt: i.alt || null } : null)) };
    }
    if (!isMutation && q.includes("SeoAlt")) {
      const img = [...store.values()].flatMap((p) => p.images).find((i) => i.id === v.id);
      return { node: img ? { id: img.id, alt: img.alt || null } : null };
    }
    if (isMutation && q.includes("productUpdate")) {
      const input = v.product as { id: string; seo: { title: string | null; description: string | null } };
      const p = store.get(input.id)!;
      p.seoTitle = input.seo.title ?? "";
      p.seoDescription = input.seo.description ?? "";
      calls.push(`seo:${input.id}`);
      return { productUpdate: { product: { id: p.id }, userErrors: [] } };
    }
    if (isMutation && q.includes("fileUpdate")) {
      const files = v.files as { id: string; alt: string }[];
      calls.push(`file-update x${files.length}`);
      for (const f of files) {
        const img = [...store.values()].flatMap((p) => p.images).find((i) => i.id === f.id)!;
        img.alt = f.alt;
      }
      return { fileUpdate: { files: files.map((f) => ({ id: f.id })), userErrors: [] } };
    }
    throw new Error("unexpected query");
  };
  return { store, calls, ctx: { shop: SHOP, gql } };
}

test("scan, export, upload, apply and undo: Shopify only changes after Apply, and Undo restores the old values", async () => {
  const sh = fakeShopify([
    { id: "gid://shopify/Product/1", title: "HP LaserJet Pro", images: [{ id: "gid://shopify/MediaImage/11", alt: "" }, { id: "gid://shopify/MediaImage/12", alt: "Side view" }] },
    { id: "gid://shopify/Product/2", title: "HP Ink Cartridge", seoTitle: "HP Ink Cartridge Black Original 805 | Genuine", seoDescription: "Original HP 805 black ink cartridge for DeskJet printers. Sharp text, genuine quality and fast delivery.", images: [{ id: "gid://shopify/MediaImage/21", alt: "Cartridge" }] },
  ]);

  const scan = await startScan(SHOP, sh.ctx);
  await scan.done;
  assert.equal((await prisma.seoScan.findUnique({ where: { id: scan.id } }))?.status, "done");
  const prog = getTask(SHOP, "seoscan");
  assert.deepEqual([prog?.running, prog?.done, prog?.total], [false, 2, 2], "the scan reports 2 of 2 products to the progress bar");
  const rows = await prisma.seoProduct.findMany({ where: { shop: SHOP }, orderBy: { title: "asc" } });
  assert.equal(rows.length, 2);
  assert.ok(rows[1].score < rows[0].score, "the product with problems scores lower");

  // export: only products with problems, plus an image row for the image without ALT
  const exp = await exportCsv(SHOP);
  assert.equal(exp.products, 1);
  assert.equal(exp.images, 1);
  const table = parseCsv(exp.csv);
  const H = table[0];
  const fill = (row: string[], col: string, value: string) => {
    row[H.indexOf(col)] = value;
  };
  const productRow = table.find((r) => r[0] === "product")!;
  const imageRow = table.find((r) => r[0] === "image")!;
  fill(productRow, "new_seo_title", "HP LaserJet Pro Printer | Fast Home Office Laser");
  fill(productRow, "new_seo_description", "Buy the HP LaserJet Pro printer: fast duplex printing, wireless setup and a low cost per page. Free delivery across India.");
  fill(imageRow, "new_alt", "HP LaserJet Pro Printer front view");
  const uploaded = toCsv(table);

  const pv = await previewCsv(SHOP, uploaded, "round-trip.csv");
  assert.equal(pv.total, 3);
  assert.deepEqual([pv.counts.seoTitle, pv.counts.seoDescription, pv.counts.alt], [1, 1, 1]);
  assert.equal(sh.calls.length, 0, "the preview wrote nothing to Shopify");
  assert.equal(sh.store.get("gid://shopify/Product/1")!.seoTitle, "");

  // someone edits the title in Shopify between preview and apply: that value must not be overwritten
  sh.store.get("gid://shopify/Product/1")!.seoTitle = "Edited by a person meanwhile";
  const p = await applyStep(SHOP, sh.ctx, pv.batchId!);
  assert.equal(p.status, "done");
  assert.deepEqual([p.applied, p.failed, p.pending], [2, 1, 0]);
  assert.equal(sh.store.get("gid://shopify/Product/1")!.seoTitle, "Edited by a person meanwhile");
  assert.match(sh.store.get("gid://shopify/Product/1")!.seoDescription, /^Buy the HP LaserJet Pro printer/);
  assert.equal(sh.store.get("gid://shopify/Product/1")!.images[0].alt, "HP LaserJet Pro Printer front view");
  assert.equal(sh.store.get("gid://shopify/Product/1")!.images[1].alt, "Side view", "other images are untouched");

  // the stored scan result is updated, so the score rises without another scan
  const after1 = await prisma.seoProduct.findFirst({ where: { shop: SHOP, productId: "gid://shopify/Product/1" } });
  assert.match(after1!.seoDescription, /^Buy the HP/);

  // undo puts the old values back
  const u = await undoStep(SHOP, sh.ctx, pv.batchId!);
  assert.equal(u.status, "restored");
  assert.equal(u.restored, 2);
  assert.equal(sh.store.get("gid://shopify/Product/1")!.seoDescription, "");
  assert.equal(sh.store.get("gid://shopify/Product/1")!.images[0].alt, "");
  assert.equal(sh.store.get("gid://shopify/Product/1")!.seoTitle, "Edited by a person meanwhile", "the person's own edit stays");
  assert.deepEqual((await batchProgress(SHOP, pv.batchId!))?.failed, 1);

  // an undone batch cannot be applied again by accident
  await retryFailed(SHOP, pv.batchId!);
  await assert.rejects(applyStep(SHOP, sh.ctx, pv.batchId!), /already undone/);
});

test("the CSV download link is signed: it works for its own shop only and cannot be tampered with", async () => {
  process.env.SECRETS_KEY ??= "test-signing-key-test-signing-key-1234";
  const { signedSeoUrl, verifySeoSignature } = await import("../app/lib/media.server.ts");
  const url = new URL("http://x" + signedSeoUrl("export/problems/shop-a.myshopify.com"));
  const exp = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  assert.ok(verifySeoSignature("export/problems/shop-a.myshopify.com", exp, sig));
  assert.ok(!verifySeoSignature("export/problems/shop-b.myshopify.com", exp, sig), "another shop's name is refused");
  assert.ok(!verifySeoSignature("export/all/shop-a.myshopify.com", exp, sig), "another file is refused");
  assert.ok(!verifySeoSignature("export/problems/shop-a.myshopify.com", String(Number(exp) - 100_000_000), sig), "an expired link is refused");
});

test("a whole batch runs on the server in the background, reports progress, writes all ALT texts in one request, and a second start is ignored", async () => {
  const images = Array.from({ length: 40 }, (_, i) => ({ id: `gid://shopify/MediaImage/9${i}`, alt: "" }));
  const sh = fakeShopify([{ id: "gid://shopify/Product/9", title: "Many photos", images }]);
  await (await startScan(SHOP, sh.ctx)).done;

  const table = parseCsv((await exportCsv(SHOP)).csv);
  const H = table[0];
  const rows = table.filter((r) => r[0] === "image" && r[H.indexOf("product_id")] === "gid://shopify/Product/9");
  assert.equal(rows.length, 40);
  rows.forEach((r, i) => {
    r[H.indexOf("new_alt")] = `Many photos view ${i + 1}`;
  });
  const pv = await previewCsv(SHOP, toCsv(table), "many.csv");
  assert.equal(pv.counts.alt, 40);

  const first = await startRun(SHOP, sh.ctx, pv.batchId!, "apply");
  const second = await startRun(SHOP, sh.ctx, pv.batchId!, "apply");
  assert.equal(first.started, true);
  assert.equal(second.started, false, "pressing Apply twice does not run it twice");
  assert.equal((await batchProgress(SHOP, pv.batchId!))?.running, true);
  await first.done;

  const p = (await batchProgress(SHOP, pv.batchId!))!;
  assert.deepEqual([p.status, p.total, p.applied, p.failed, p.pending, p.running], ["done", 40, 40, 0, 0, false]);
  assert.equal(sh.store.get("gid://shopify/Product/9")!.images[39].alt, "Many photos view 40");
  assert.ok(sh.calls.filter((c) => c.startsWith("file-update")).length <= 2, "ALT texts are sent in groups, not one request per image");

  const back = await startRun(SHOP, sh.ctx, pv.batchId!, "undo");
  await back.done;
  const u = (await batchProgress(SHOP, pv.batchId!))!;
  assert.deepEqual([u.status, u.restored, u.applied], ["restored", 40, 0]);
  assert.equal(sh.store.get("gid://shopify/Product/9")!.images[0].alt, "");
});
