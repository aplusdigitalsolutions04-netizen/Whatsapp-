/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { lookupSkus, sniffImage, uploadProductImages } from "../app/lib/image/bulk-upload.server.ts";
import { parseZip } from "../app/lib/image/bulk-zip.ts";

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 2)]);
const P = (n: number) => `gid://shopify/Product/${n}`;

/** A small stand-in for Shopify's product media: records the order images were added in. */
function fake(opts: { product?: any; failOnPosition?: number; dropError?: boolean; failedStatusFor?: number } = {}) {
  const media: { id: string; status: string; mediaContentType: string }[] = (opts.product?.media ?? []).map((id: string) => ({ id, status: "READY", mediaContentType: "IMAGE" }));
  const added: string[] = [];
  const dropped: any[] = [];
  let seq = 100;
  let staged = 0;
  const gql = async (q: string, v?: any) => {
    if (q.includes("BulkSku")) {
      return { products: { nodes: opts.product?.lookup ?? [] } };
    }
    if (q.includes("ProductMedia")) return { product: { id: v.id, title: "Blue Mug", media: { nodes: [...media] } } };
    if (q.includes("stagedUploadsCreate")) {
      staged++;
      return { stagedUploadsCreate: { stagedTargets: [{ url: "https://upload.example/t", resourceUrl: `https://staged.example/${staged}`, parameters: [] }], userErrors: [] } };
    }
    if (q.includes("AddMedia")) {
      const url = v.media[0].originalSource as string;
      const idx = Number(url.split("/").pop());
      if (opts.failOnPosition && idx === opts.failOnPosition) return { productUpdate: { product: null, userErrors: [{ message: "Image rejected" }] } };
      const id = `gid://shopify/MediaImage/${seq++}`;
      added.push(id);
      media.push({ id, status: "UPLOADED", mediaContentType: "IMAGE" });
      return { productUpdate: { product: { id: v.product.id, media: { nodes: [...media] } }, userErrors: [] } };
    }
    if (q.includes("MediaState")) {
      return { nodes: v.ids.map((id: string) => ({ id, status: opts.failedStatusFor && id.endsWith(String(opts.failedStatusFor)) ? "FAILED" : "READY" })) };
    }
    if (q.includes("DropMedia")) {
      dropped.push(...v.files);
      return opts.dropError ? { fileUpdate: { files: [], userErrors: [{ message: "locked" }] } } : { fileUpdate: { files: v.files.map((f: any) => ({ id: f.id })), userErrors: [] } };
    }
    throw new Error("unexpected " + q.slice(0, 30));
  };
  const fetchFn = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
  return { ctx: { shop: "x.invalid", gql, fetch: fetchFn, sleep: async () => undefined, timeoutMs: 200 }, added, dropped };
}

test("SKU lookup: exact match ignoring case, missing and shared SKUs are told apart", async () => {
  const f = fake({
    product: {
      lookup: [
        { id: P(1), title: "Mug", mediaCount: { count: 2 }, variants: { nodes: [{ sku: "mug-red" }, { sku: "MUG-BLUE" }] } },
        { id: P(2), title: "Cup A", mediaCount: { count: 0 }, variants: { nodes: [{ sku: "SHARED" }] } },
        { id: P(3), title: "Cup B", mediaCount: { count: 1 }, variants: { nodes: [{ sku: "shared" }, { sku: "MUG-RED-XL" }] } },
      ],
    },
  });
  const r = await lookupSkus(f.ctx, ["MUG-RED", "mug-blue", "SHARED", "NOPE", "MUG-RED"]);
  assert.deepEqual(r.map((x) => [x.sku, x.state, x.productId]), [["MUG-RED", "found", P(1)], ["mug-blue", "found", P(1)], ["SHARED", "ambiguous", ""], ["NOPE", "missing", ""]]);
  assert.equal(r[0].imageCount, 2, "a longer SKU like MUG-RED-XL is not mistaken for MUG-RED");
});

test("file type is checked from the bytes, not the name", () => {
  assert.equal(sniffImage(JPG), "jpg");
  assert.equal(sniffImage(PNG), "png");
  assert.equal(sniffImage(Buffer.from("GIF89a-not-allowed-here")), null);
});

test("append keeps old images and adds new ones in position order", async () => {
  const f = fake({ product: { media: ["gid://shopify/MediaImage/1", "gid://shopify/MediaImage/2"] } });
  const r = await uploadProductImages(f.ctx, P(1), "append", [
    { position: 3, bytes: JPG, ext: "jpg" }, { position: 1, bytes: PNG, ext: "png" }, { position: 2, bytes: JPG, ext: "jpg" },
  ], "SKU-1");
  assert.equal(r.added, 3);
  assert.equal(r.failed.length, 0);
  assert.equal(r.removed, 0);
  assert.equal(f.dropped.length, 0, "old images are kept");
  assert.equal(f.added.length, 3);
});

test("replace removes only the old images, and only after new ones are ready", async () => {
  const f = fake({ product: { media: ["gid://shopify/MediaImage/1", "gid://shopify/MediaImage/2"] } });
  const r = await uploadProductImages(f.ctx, P(1), "replace", [{ position: 1, bytes: JPG, ext: "jpg" }, { position: 2, bytes: JPG, ext: "jpg" }]);
  assert.equal(r.added, 2);
  assert.equal(r.removed, 2);
  assert.deepEqual(f.dropped.map((d) => d.id), ["gid://shopify/MediaImage/1", "gid://shopify/MediaImage/2"]);
  assert.ok(f.dropped.every((d) => d.referencesToRemove[0] === P(1)));

  const none = fake({ product: { media: ["gid://shopify/MediaImage/1"] }, failOnPosition: 1 });
  const bad = await uploadProductImages(none.ctx, P(1), "replace", [{ position: 1, bytes: JPG, ext: "jpg" }]);
  assert.equal(bad.added, 0);
  assert.equal(bad.removed, 0);
  assert.equal(none.dropped.length, 0, "if nothing new was added, the old images are NOT removed");
});

test("failures are counted per image with the reason", async () => {
  const f = fake({ failOnPosition: 2 });
  const r = await uploadProductImages(f.ctx, P(1), "append", [
    { position: 1, bytes: JPG, ext: "jpg" }, { position: 2, bytes: JPG, ext: "jpg" }, { position: 3, bytes: Buffer.from("not an image at all, just text"), ext: "jpg" }, { position: 4, bytes: PNG, ext: "jpg" },
  ]);
  assert.equal(r.added, 1);
  assert.deepEqual(r.failed.map((x) => x.position), [2, 3, 4]);
  assert.match(r.failed[0].error, /Image rejected/);
  assert.match(r.failed[1].error, /not a valid/);
  assert.match(r.failed[2].error, /not a valid/, "a PNG named .jpg is refused");

  const proc = fake({ failedStatusFor: 100 });
  const p = await uploadProductImages(proc.ctx, P(1), "append", [{ position: 1, bytes: JPG, ext: "jpg" }]);
  assert.equal(p.added, 0);
  assert.match(p.failed[0].error, /could not process/);

  const drop = fake({ product: { media: ["gid://shopify/MediaImage/1"] }, dropError: true });
  const d = await uploadProductImages(drop.ctx, P(1), "replace", [{ position: 1, bytes: JPG, ext: "jpg" }]);
  assert.equal(d.added, 1);
  assert.match(d.failed[0].error, /old ones could not be removed: locked/);
  await assert.rejects(uploadProductImages(f.ctx, "bad-id", "append", [{ position: 1, bytes: JPG, ext: "jpg" }]), /Invalid product/);
});

test("ZIP: SKU folders, numbered files, wrapper folder, junk and mistakes", () => {
  const b = (s: string) => new Uint8Array(Buffer.from(s));
  const zip = zipSync({
    "products/SKU-10/2.png": b("b"), "products/SKU-10/1.JPG": b("a"), "products/SKU-10/3.webp": b("c"),
    "products/sku-2/1.jpeg": b("d"),
    "products/SKU-10/cover.jpg": b("bad name"),
    "products/SKU-10/1.png": b("same position twice"),
    "products/SKU-10/notes.txt": b("text"),
    "stray.jpg": b("no folder"),
    "__MACOSX/products/SKU-10/1.jpg": b("mac"),
    "products/SKU-10/.DS_Store": b("junk"),
    "products/SKU-10/0.jpg": b("zero"),
  });
  const r = parseZip(zip);
  assert.deepEqual(r.folders.map((f) => [f.sku, f.images.map((i) => i.position + i.ext)]), [["sku-2", ["1jpg"]], ["SKU-10", ["1jpg", "2png", "3webp"]]]);
  const reasons = r.problems.map((p) => p.path.split("/").pop() + ": " + p.reason);
  assert.ok(reasons.some((x) => x.startsWith("cover.jpg") && /position number/.test(x)));
  assert.ok(reasons.some((x) => x.startsWith("1.png") && /used twice/.test(x)));
  assert.ok(reasons.some((x) => x.startsWith("notes.txt")));
  assert.ok(reasons.some((x) => x.startsWith("stray.jpg") && /not inside a SKU folder/.test(x)));
  assert.ok(reasons.some((x) => x.startsWith("0.jpg")));
  assert.ok(!reasons.some((x) => x.includes("DS_Store") || x.includes("MACOSX")), "junk files are ignored silently");
});
