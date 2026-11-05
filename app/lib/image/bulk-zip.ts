import { unzipSync } from "fflate";

// Reads the bulk-upload ZIP in the browser: one folder per SKU, files named by position (1.jpg, 2.png ...).

export type ZipImage = { position: number; ext: "jpg" | "png" | "webp"; name: string; data: Uint8Array };
export type ZipFolder = { sku: string; images: ZipImage[] };
export type ZipProblem = { path: string; reason: string };
export type ParsedZip = { folders: ZipFolder[]; problems: ZipProblem[] };

const EXT: Record<string, ZipImage["ext"]> = { jpg: "jpg", jpeg: "jpg", png: "png", webp: "webp" };
const junk = (path: string) => path.split("/").some((p) => p.startsWith(".") || p === "__MACOSX" || p.toLowerCase() === "thumbs.db" || p.toLowerCase() === "desktop.ini");

export function parseZip(bytes: Uint8Array): ParsedZip {
  const problems: ZipProblem[] = [];
  const files = unzipSync(bytes, {
    filter: (f) => {
      const path = f.name.replace(/\\/g, "/");
      if (path.endsWith("/") || junk(path)) return false;
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      if (!EXT[ext]) { problems.push({ path, reason: "Not a JPG, PNG or WebP image." }); return false; }
      return true;
    },
  });

  const bySku = new Map<string, { sku: string; images: ZipImage[] }>();
  for (const [raw, data] of Object.entries(files)) {
    const path = raw.replace(/\\/g, "/");
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2) { problems.push({ path, reason: "This image is not inside a SKU folder." }); continue; }
    const file = parts[parts.length - 1];
    const sku = parts[parts.length - 2].trim(); // a wrapper folder around everything is fine: the SKU is the folder next to the file
    const dot = file.lastIndexOf(".");
    const stem = file.slice(0, dot).trim();
    const ext = EXT[file.slice(dot + 1).toLowerCase()];
    if (!/^\d{1,3}$/.test(stem) || Number(stem) < 1) { problems.push({ path, reason: "The file name must be a position number like 1.jpg, 2.jpg." }); continue; }
    const folder = bySku.get(sku.toLowerCase()) ?? { sku, images: [] };
    const position = Number(stem);
    if (folder.images.some((i) => i.position === position)) { problems.push({ path, reason: `Position ${position} is used twice in this folder.` }); continue; }
    folder.images.push({ position, ext, name: file, data });
    bySku.set(sku.toLowerCase(), folder);
  }
  const folders = [...bySku.values()].map((f) => ({ sku: f.sku, images: f.images.sort((a, b) => a.position - b.position) })).sort((a, b) => a.sku.localeCompare(b.sku, undefined, { numeric: true }));
  return { folders, problems };
}
