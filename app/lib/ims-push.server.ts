/* eslint-disable @typescript-eslint/no-explicit-any */
import prisma from "../db.server";
import { buildImsPayload, IMS_ORDER_FIELDS, imsPayloadProblem, imsUrlProblem, MAX_ATTEMPTS, retryDelayMs, type ImsEvent } from "./ims-push";
import { logEvent } from "./log.server";
import { orderNameMatches, parseOrderRef } from "./order-ref";
import { decryptSecret, encryptSecret } from "./secret.server";
import { gql, type GqlRunner } from "./shopify-data.server";

// Sends Shopify orders to the shop's IMS portal: every new order at once, every change (status, tracking, cancel) after a short wait,
// and on request all the old orders in small batches. Everything goes through the ImsPush table (the "outbox"), so a stopped server,
// a slow IMS or a wrong key never loses an order: it is tried again later, and the page shows what is stuck and why.

const BATCH = 10; // orders per round (the IMS asked for 10-20 at a time)
const TICK_MS = 10_000;
const CHANGE_DELAY_MS = 20_000; // Shopify sends several "updated" events for one change; wait and send the final state once
const TIMEOUT_MS = 15_000;

type Fetch = typeof fetch;
const g = globalThis as unknown as { __imsWorker?: { timer: NodeJS.Timeout | null; running: boolean } };
const worker = (g.__imsWorker ??= { timer: null, running: false });

// ---------- settings ----------

export async function getImsConfig(shop: string) {
  const c = await prisma.imsConfig.findUnique({ where: { shop } });
  return { enabled: !!c?.enabled, url: c?.url ?? "", hasKey: !!c?.keyEnc, keyHint: c?.keyHint ?? "", lastOkAt: c?.lastOkAt ?? null, lastError: c?.lastError ?? null };
}

/** Saves the address, the key (only when a new one is typed; the old one stays otherwise) and the on/off switch. */
export async function saveImsConfig(shop: string, input: { url: string; key?: string; enabled: boolean }): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = input.url.trim();
  const key = (input.key ?? "").trim();
  const old = await prisma.imsConfig.findUnique({ where: { shop } });
  if (input.enabled || url) {
    const bad = imsUrlProblem(url);
    if (bad) return { ok: false, error: bad };
  }
  if (input.enabled && !key && !old?.keyEnc) return { ok: false, error: "Paste the API key the IMS team gave you." };
  if (key && key.length < 8) return { ok: false, error: "That API key looks too short." };
  const keyData = key ? { keyEnc: encryptSecret(key), keyHint: key.slice(-4) } : {};
  await prisma.imsConfig.upsert({
    where: { shop },
    create: { shop, enabled: input.enabled, url, ...keyData },
    update: { enabled: input.enabled, url, ...keyData, ...(input.enabled ? { lastError: null } : {}) },
  });
  return { ok: true };
}

// ---------- the outbox ----------

const idOf = (gid: string) => gid.split("/").pop() ?? gid;
export const orderGidFor = (id: string | number) => `gid://shopify/Order/${id}`;

/**
 * Puts an order in the outbox (when the IMS is switched on). A newer change of an order that is still waiting just updates its row:
 * an unsent "created" stays "created", a cancel always wins. An order already sent is queued again with the new event.
 */
export async function enqueueImsPush(shop: string, gid: string, event: ImsEvent, opts: { delayMs?: number; orderName?: string | null } = {}): Promise<boolean> {
  const cfg = await prisma.imsConfig.findUnique({ where: { shop }, select: { enabled: true, url: true, keyEnc: true } });
  if (!cfg?.enabled || !cfg.url || !cfg.keyEnc) return false;
  const next = new Date(Date.now() + (opts.delayMs ?? (event === "order.created" ? 0 : CHANGE_DELAY_MS)));
  const row = await prisma.imsPush.findUnique({ where: { shop_orderGid: { shop, orderGid: gid } } });
  const keepCreated = row?.status === "pending" && row.event === "order.created" && event === "order.updated";
  const data = { event: keepCreated ? "order.created" : event, status: "pending", attempts: 0, lastError: null, nextAttemptAt: next, ...(opts.orderName ? { orderName: opts.orderName } : {}) };
  await prisma.imsPush.upsert({ where: { shop_orderGid: { shop, orderGid: gid } }, create: { shop, orderGid: gid, ...data }, update: data });
  return true;
}

/** "Send old orders": every order the app has read from Shopify goes to the outbox; the worker sends them 10 at a time. Returns how many. */
export async function enqueueAllOrders(shop: string): Promise<number> {
  const rows = await prisma.orderSheet.findMany({ where: { shop, isManual: false }, select: { shopifyOrderId: true, orderName: true }, orderBy: { orderDate: "asc" } });
  const now = new Date();
  // upsert (SQLite cannot skip duplicates in createMany): an order already in the outbox is simply queued again, never duplicated
  for (let i = 0; i < rows.length; i += 200) {
    await prisma.$transaction(
      rows.slice(i, i + 200).map((r) => {
        const orderGid = orderGidFor(r.shopifyOrderId);
        const data = { event: "order.created", status: "pending", attempts: 0, lastError: null, nextAttemptAt: now, orderName: r.orderName };
        return prisma.imsPush.upsert({ where: { shop_orderGid: { shop, orderGid } }, create: { shop, orderGid, ...data }, update: data });
      }),
    );
  }
  return rows.length;
}

/** Sends one order the person names ("#W1219" / "1219"): to test the connection with a real order. */
export async function enqueueOneOrder(shop: string, typed: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const ref = parseOrderRef(typed);
  if (!ref) return { ok: false, error: "Type an order number like #W1219." };
  const rows = await prisma.orderSheet.findMany({ where: { shop, isManual: false, orderName: { contains: ref.digits } }, select: { shopifyOrderId: true, orderName: true }, take: 20 });
  const hit = rows.find((r) => r.orderName && orderNameMatches(r.orderName, ref));
  if (!hit) return { ok: false, error: `Order ${typed} is not in the Order Update sheet yet.` };
  const ok = await enqueueImsPush(shop, orderGidFor(hit.shopifyOrderId), "order.created", { delayMs: 0, orderName: hit.orderName });
  return ok ? { ok: true, name: hit.orderName! } : { ok: false, error: "Switch the IMS connection on and save the address and key first." };
}

export async function retryFailedImsPushes(shop: string): Promise<number> {
  const r = await prisma.imsPush.updateMany({ where: { shop, status: "failed" }, data: { status: "pending", attempts: 0, lastError: null, nextAttemptAt: new Date() } });
  return r.count;
}

export async function imsStatus(shop: string) {
  const [cfg, groups, failed, last] = await Promise.all([
    getImsConfig(shop),
    prisma.imsPush.groupBy({ by: ["status"], where: { shop }, _count: { _all: true } }),
    prisma.imsPush.findMany({ where: { shop, status: "failed" }, orderBy: { updatedAt: "desc" }, take: 10 }),
    prisma.imsPush.findFirst({ where: { shop, status: "sent" }, orderBy: { sentAt: "desc" }, select: { sentAt: true } }),
  ]);
  const n = (s: string) => groups.find((x) => x.status === s)?._count._all ?? 0;
  return {
    cfg,
    pending: n("pending"),
    sent: n("sent"),
    failed: n("failed"),
    lastSentAt: last?.sentAt ?? null,
    failedList: failed.map((f) => ({ name: f.orderName ?? idOf(f.orderGid), event: f.event, error: f.lastError ?? "", attempts: f.attempts })),
  };
}

// ---------- sending ----------

type Row = { id: string; shop: string; orderGid: string; event: string; attempts: number };
type Deps = { fetchFn?: Fetch; run?: GqlRunner; now?: Date };

/** One order to the IMS. Returns "sent", "retry" (try again later) or "failed" (never going to work; the reason is stored). */
async function sendRow(row: Row, cfg: { url: string; key: string }, deps: Deps): Promise<{ result: "sent" | "retry" | "failed"; error?: string; name?: string }> {
  const run = deps.run ?? gql;
  const doFetch = deps.fetchFn ?? fetch;
  let node: any;
  try {
    const data = await run(row.shop, `query($id: ID!) { order(id: $id) { ${IMS_ORDER_FIELDS} } }`, { id: row.orderGid });
    node = data.order;
  } catch (e) {
    return { result: "retry", error: `Could not read the order from Shopify: ${(e as Error).message}`.slice(0, 300) };
  }
  if (!node) return { result: "failed", error: "The order no longer exists in Shopify." };

  const payload = buildImsPayload(node, node.cancelledAt ? "order.cancelled" : (row.event as ImsEvent), row.shop);
  const problem = imsPayloadProblem(payload);
  if (problem) return { result: "failed", error: problem, name: payload.orderNumber };

  try {
    const res = await doFetch(cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": cfg.key },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 200 || res.status === 201) return { result: "sent", name: payload.orderNumber };
    const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    const hint = res.status === 401 || res.status === 403 ? " (the API key was not accepted)" : "";
    return { result: "retry", error: `The IMS answered HTTP ${res.status}${hint}${body ? `: ${body}` : ""}`, name: payload.orderNumber };
  } catch (e) {
    const m = (e as Error).name === "TimeoutError" ? "The IMS did not answer in 15 seconds" : `Could not reach the IMS: ${(e as Error).message}`;
    return { result: "retry", error: m.slice(0, 300), name: payload.orderNumber };
  }
}

/** One round: sends up to 10 due orders. Safe to call often; two rounds never overlap. Returns what happened (used by the tests). */
export async function processImsQueue(deps: Deps = {}): Promise<{ sent: number; retry: number; failed: number }> {
  const out = { sent: 0, retry: 0, failed: 0 };
  if (worker.running) return out;
  worker.running = true;
  try {
    const now = deps.now ?? new Date();
    // only shops that have the IMS switched on: the waiting orders of a switched-off shop must not take the places in the batch
    const on = (await prisma.imsConfig.findMany({ where: { enabled: true }, select: { shop: true } })).map((c) => c.shop);
    if (!on.length) return out;
    const due = await prisma.imsPush.findMany({ where: { shop: { in: on }, status: "pending", nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: "asc" }, take: BATCH });
    const cfgs = new Map<string, { url: string; key: string } | null>();
    for (const row of due) {
      if (!cfgs.has(row.shop)) {
        const c = await prisma.imsConfig.findUnique({ where: { shop: row.shop } });
        const key = c?.enabled && c.url && c.keyEnc ? decryptSecret(c.keyEnc) : null;
        cfgs.set(row.shop, key && c ? { url: c.url, key } : null);
        if (c?.enabled && c.keyEnc && !key) await prisma.imsConfig.update({ where: { shop: row.shop }, data: { lastError: "The saved IMS key cannot be read. Paste the key again and save." } });
      }
      const cfg = cfgs.get(row.shop);
      if (!cfg) continue; // switched off (or no key): the orders wait in the outbox
      const r = await sendRow(row, cfg, deps);
      // `updatedAt` must still be what we read: if the order changed again while it was being sent, the row was put back to "pending"
      // with the newer event, and that newer change must not be marked as sent by this (older) send.
      const same = { id: row.id, updatedAt: row.updatedAt };
      if (r.result === "sent") {
        out.sent++;
        await prisma.imsPush.updateMany({ where: same, data: { status: "sent", sentAt: new Date(), lastError: null, attempts: row.attempts + 1, ...(r.name ? { orderName: r.name } : {}) } });
        await prisma.imsConfig.update({ where: { shop: row.shop }, data: { lastOkAt: new Date(), lastError: null } }).catch(() => undefined);
        continue;
      }
      const attempts = row.attempts + 1;
      const giveUp = r.result === "failed" || attempts >= MAX_ATTEMPTS;
      out[giveUp ? "failed" : "retry"]++;
      await prisma.imsPush.updateMany({
        where: same,
        data: { status: giveUp ? "failed" : "pending", attempts, lastError: r.error ?? null, nextAttemptAt: new Date(Date.now() + retryDelayMs(attempts)), ...(r.name ? { orderName: r.name } : {}) },
      });
      await prisma.imsConfig.update({ where: { shop: row.shop }, data: { lastError: (r.error ?? "").slice(0, 300) } }).catch(() => undefined);
      if (giveUp || attempts === 1) await logEvent({ shop: row.shop, source: "shopify", level: giveUp ? "error" : "info", event: giveUp ? "ims_push_failed" : "ims_push_retry", detail: `${r.name ?? idOf(row.orderGid)}: ${r.error}` });
    }
  } finally {
    worker.running = false;
  }
  return out;
}

/** Starts the background sender (one per process). */
export function startImsWorker() {
  if (worker.timer) return;
  worker.timer = setInterval(() => void processImsQueue().catch(() => undefined), TICK_MS);
  worker.timer.unref?.();
}
