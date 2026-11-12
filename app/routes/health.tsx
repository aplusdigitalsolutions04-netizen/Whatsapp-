/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import prisma from "../db.server";

// GET /health: used by Docker / uptime monitors. Not behind the Shopify login and returns no private data.
// "assets" is the number of built browser files found next to the server; 0 means the page would load without styles/scripts.
function assetCount() {
  const dir = path.join(process.cwd(), "build", "client", "assets");
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

/** Can the Image Editor library load on this server? (Hosting servers sometimes lack its native files.) */
async function imageLibrary() {
  try {
    const m: any = await import("sharp");
    const sharp = m.default ?? m;
    let backgroundRemoval = true;
    try {
      createRequire(import.meta.url).resolve("@imgly/background-removal-node");
    } catch {
      backgroundRemoval = false;
    }
    return { ok: true, version: String(sharp.versions?.sharp ?? "?"), backgroundRemoval };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e).split("\n")[0].slice(0, 300) };
  }
}

export const loader = async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ ok: true, assets: assetCount(), image: await imageLibrary() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[health] database check failed:", error);
    return Response.json({ ok: false, problem: "database" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
};
