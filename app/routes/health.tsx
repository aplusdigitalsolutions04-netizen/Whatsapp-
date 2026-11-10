import prisma from "../db.server";

// GET /health: used by Docker / uptime monitors. Not behind the Shopify login and returns no private data.
export const loader = async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[health] database check failed:", error);
    return Response.json({ ok: false, problem: "database" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
};
