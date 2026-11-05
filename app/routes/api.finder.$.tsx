import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { LoaderFunctionArgs } from "react-router";
import { zipSync } from "fflate";
import prisma from "../db.server";
import { verifyFinderSignature } from "../lib/media.server";
import { FINDER_DIR } from "../lib/finder/runner.server";

// Product Scrapper downloads (photos, ZIP, CSV) through short-lived signed links: <img>/<a> send no session header.
// eslint-disable-next-line no-control-regex
const SAFE = /^[^\\/:*?"<>|\x00-\x1f]+$/;
const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif" };

const inside = (p: string) => path.resolve(p).startsWith(FINDER_DIR + path.sep);
const csvCell = (v: unknown) => {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // never let a product title run as a spreadsheet formula
  return `"${s.replace(/"/g, '""')}"`;
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const splat = params["*"] ?? "";
  const parts = splat.split("/").map(decodeURIComponent);
  if (!parts.every((p) => SAFE.test(p) && p !== "." && p !== "..") || !verifyFinderSignature(parts.join("/"), url.searchParams.get("exp"), url.searchParams.get("sig"))) {
    return new Response("Forbidden", { status: 403 });
  }
  const [kind, runId, folder, name] = parts;

  if (kind === "file" && runId && folder && name) {
    const file = path.join(FINDER_DIR, runId, folder, name);
    const type = MIME[path.extname(name).toLowerCase()];
    if (!inside(file) || !type || !existsSync(file)) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(readFileSync(file)), { headers: { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600" } });
  }

  if (kind === "zip" && runId) {
    const run = await prisma.finderRun.findUnique({ where: { id: runId }, include: { products: { where: { isNew: true }, select: { folder: true } } } });
    if (!run) return new Response("Not found", { status: 404 });
    const folders = folder ? [folder] : run.products.map((p) => p.folder).filter(Boolean);
    const files: Record<string, Uint8Array> = {};
    for (const f of folders) {
      const dir = path.join(FINDER_DIR, runId, f);
      if (!inside(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) continue;
      for (const n of readdirSync(dir)) files[`${f}/${n}`] = new Uint8Array(readFileSync(path.join(dir, n)));
    }
    if (!Object.keys(files).length) return new Response("No images", { status: 404 });
    return new Response(new Uint8Array(zipSync(files, { level: 0 })), {
      headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${(folder ?? runId).replace(/[^\w.\- ]+/g, "_")}.zip"` },
    });
  }

  if (kind === "csv" && runId) {
    const items = await prisma.finderProduct.findMany({ where: { runId, isNew: true }, orderBy: { createdAt: "asc" } });
    const head = ["Title", "Brand", "Price", "Compare price", "Discount %", "Link", "Images"];
    const lines = [head.map(csvCell).join(",")];
    for (const p of items) lines.push([p.title, p.brand, p.price, p.comparePrice, p.discount || "", p.link, p.imageCount].map(csvCell).join(","));
    return new Response(String.fromCharCode(0xfeff) + lines.join("\r\n"), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="products-${runId}.csv"` } });
  }
  return new Response("Not found", { status: 404 });
};
