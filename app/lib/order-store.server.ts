import prisma from "../db.server.ts";
import { SHEET_STATUSES, type MappedOrder, type SheetStatus } from "./order-map.ts";

/**
 * Writes the Shopify-managed columns of one order. One row per (shop, shopifyOrderId): the unique index
 * makes duplicates impossible, and the create/update race between a webhook and the scheduled sync is
 * settled by the database, not by application checks. Manual (employee) columns are never in `data`,
 * so they survive every sync. An older snapshot never overwrites a newer one.
 */
export async function upsertOrder(shop: string, m: MappedOrder): Promise<"created" | "updated" | "skipped"> {
  const { shopifyOrderId, ...fields } = m;
  const data = { ...fields, syncedAt: new Date() };
  const stale = m.shopifyUpdatedAt
    ? { OR: [{ shopifyUpdatedAt: null }, { shopifyUpdatedAt: { lte: m.shopifyUpdatedAt } }] }
    : {};
  try {
    await prisma.orderSheet.create({ data: { shop, shopifyOrderId, ...data } });
    return "created";
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e; // anything but "already exists" is a real failure
  }
  const r = await prisma.orderSheet.updateMany({ where: { shop, shopifyOrderId, ...stale }, data });
  return r.count ? "updated" : "skipped";
}

/** Counters for the dashboard: every order sits in exactly one status bucket, so nothing is counted twice. */
export async function statusCounts(where: Record<string, unknown>): Promise<Record<SheetStatus | "total", number>> {
  const rows = await prisma.orderSheet.groupBy({ by: ["status"], where, _count: { _all: true } });
  const by = Object.fromEntries(SHEET_STATUSES.map((s) => [s, 0])) as Record<SheetStatus, number>;
  for (const r of rows) by[r.status as SheetStatus] = r._count._all;
  return { total: Object.values(by).reduce((a, b) => a + b, 0), ...by };
}
