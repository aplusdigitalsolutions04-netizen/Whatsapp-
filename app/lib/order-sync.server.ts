/* eslint-disable @typescript-eslint/no-explicit-any */
import prisma from "../db.server";
import { logEvent } from "./log.server";
import { mapShopifyOrder, ORDER_SHEET_FIELDS } from "./order-map";
import { upsertOrder } from "./order-store.server";
import { resolveShop } from "./settings.server";
import { scheduleSheetPush } from "./google-sheets.server";
import { gql } from "./shopify-data.server";
import { endTask, startTask, updateTask } from "./progress.server";

const PAGE = 50;
const OVERLAP_MS = 10 * 60_000; // re-read the last 10 minutes each run so nothing slips between runs
const INTERVAL_MS = 5 * 60_000;

const g = globalThis as unknown as { __orderSync?: { running: Set<string>; timer: NodeJS.Timeout | null } };
const state = (g.__orderSync ??= { running: new Set(), timer: null });

export const orderGid = (id: string | number) => `gid://shopify/Order/${id}`;

/** Syncs one order by its Shopify GID (used by webhooks). Safe to call repeatedly and concurrently. */
export async function syncOrderById(shop: string, gid: string) {
  const data = await gql(shop, `query($id: ID!) { order(id: $id) { ${ORDER_SHEET_FIELDS} } }`, { id: gid });
  if (!data.order) return "missing" as const;
  const r = await upsertOrder(shop, mapShopifyOrder(data.order));
  if (r !== "skipped") scheduleSheetPush(shop); // keep the Google Sheet in step with the webhook
  return r;
}

const ORDERS_TOTAL = `query OrdersTotal($q: String) { ordersCount(query: $q, limit: null) { count } }`;

/** How many orders a sync will read (null when Shopify cannot say). */
async function countOrders(shop: string, since: Date | null): Promise<number | null> {
  try {
    const data: any = await gql(shop, ORDERS_TOTAL, { q: since ? `updated_at:>=${since.toISOString()}` : null });
    const n = Number(data.ordersCount?.count);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

type Result = { fetched: number; created: number; updated: number; skipped: number; failed: number };

/**
 * Pulls orders page by page (cursor pagination; throttling/5xx are retried inside gql()).
 * `since` limits to orders updated at/after that time; omit it for the full history.
 * One bad order is logged and skipped, it never stops the run or touches other rows.
 */
export async function syncOrders(shop: string, opts: { since?: Date | null; onProgress?: (fetched: number) => void } = {}): Promise<Result> {
  const out: Result = { fetched: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
  const q = opts.since ? `updated_at:>=${opts.since.toISOString()}` : null;
  let after: string | null = null;
  for (;;) {
    const data: any = await gql(
      shop,
      `query($first: Int!, $after: String, $q: String) {
        orders(first: $first, after: $after, sortKey: UPDATED_AT, query: $q) {
          nodes { ${ORDER_SHEET_FIELDS} } pageInfo { hasNextPage endCursor }
        } }`,
      { first: PAGE, after, q },
    );
    for (const node of data.orders?.nodes ?? []) {
      out.fetched++;
      try {
        out[await upsertOrder(shop, mapShopifyOrder(node))]++;
      } catch (e) {
        out.failed++;
        await logEvent({ shop, source: "shopify", level: "error", event: "order_sync_failed", detail: `${node?.name}: ${(e as Error).message}` });
      }
    }
    opts.onProgress?.(out.fetched);
    const info = data.orders?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) break;
    after = info.endCursor;
  }
  return out;
}

/** One reconciliation run: full history the first time, then only what changed since the last good run. */
export async function runSync(shop: string, mode: "auto" | "full" = "auto"): Promise<Result | null> {
  if (state.running.has(shop)) return null; // a run is already in progress in this process
  state.running.add(shop);
  startTask(shop, "sync", mode === "full" ? "Reading your full order history from Shopify" : "Checking Shopify for new and changed orders");
  const started = new Date();
  try {
    const st = await prisma.orderSyncState.findUnique({ where: { shop } });
    const full = mode === "full" || !st?.lastFullSyncAt;
    const since = full ? null : new Date((st?.lastSyncAt ?? started).getTime() - OVERLAP_MS);
    if (full) updateTask(shop, "sync", { label: "Reading your full order history from Shopify" });
    // How many orders to expect, so the bar can show a real percentage. If Shopify cannot tell, the bar just keeps counting.
    void countOrders(shop, since).then((n) => n != null && updateTask(shop, "sync", { total: n }));
    const r = await syncOrders(shop, { since, onProgress: (n) => updateTask(shop, "sync", { done: n }) });
    await prisma.orderSyncState.upsert({
      where: { shop },
      create: { shop, lastSyncAt: started, lastFullSyncAt: full ? started : null, lastCount: r.fetched, lastError: null },
      update: { lastSyncAt: started, ...(full ? { lastFullSyncAt: started } : {}), lastCount: r.fetched, lastError: null },
    });
    if (r.created + r.updated > 0 || full) scheduleSheetPush(shop, 2_000);
    await logEvent({
      shop, source: "shopify", event: full ? "order_sync_full" : "order_sync",
      detail: `${r.fetched} fetched, ${r.created} new, ${r.updated} updated, ${r.failed} failed`,
    });
    return r;
  } catch (e) {
    // The sync cursor is not advanced, so the next run re-reads the same window; stored rows stay untouched.
    const msg = (e as Error).message;
    await prisma.orderSyncState.upsert({
      where: { shop },
      create: { shop, lastError: msg.slice(0, 300) },
      update: { lastError: msg.slice(0, 300) },
    });
    await logEvent({ shop, source: "shopify", level: "error", event: "order_sync_error", detail: msg });
    endTask(shop, "sync", msg.slice(0, 200));
    return null;
  } finally {
    endTask(shop, "sync"); // no-op when the error branch above already ended it with a message
    state.running.delete(shop);
  }
}

/** Starts the periodic reconciliation (covers missed webhooks and old orders). One timer per process. */
export function startOrderSync() {
  if (state.timer) return;
  const tick = async () => {
    try {
      const shop = await resolveShop();
      if (shop) await runSync(shop);
    } catch {
      /* logged inside runSync; the timer must never die */
    }
  };
  setTimeout(tick, 15_000);
  state.timer = setInterval(tick, INTERVAL_MS);
  state.timer.unref?.();
}
