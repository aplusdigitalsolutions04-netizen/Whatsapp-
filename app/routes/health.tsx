import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import prisma from "../db.server";

// GET /health: used by Docker / uptime monitors. Not behind the Shopify login and returns no private data.
// "assets" is the number of built browser files found next to the server; 0 means the page would load without styles/scripts.
function assetCount() {
  const dir = path.join(process.cwd(), "build", "client", "assets");
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

export const loader = async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ ok: true, assets: assetCount() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[health] database check failed:", error);
    return Response.json({ ok: false, problem: "database" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
};
