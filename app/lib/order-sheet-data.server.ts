import prisma from "../db.server.ts";
import { SHEET_STATUSES, type SheetStatus } from "./order-map.ts";
import { addPeriod, bucketOrders, dayParam, earliestStart, parseDay, PERIOD_COUNT, PERIOD_KINDS, type PeriodKind } from "./order-periods.ts";
import { statusCounts } from "./order-store.server.ts";

const PAGE_SIZE = 50;

/** Everything the Order Update page needs: rows, counters, the counters by period, filters. */
export async function loadOrderSheet(shop: string, url: URL) {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 60);
  const status = SHEET_STATUSES.includes(url.searchParams.get("status") as SheetStatus) ? (url.searchParams.get("status") as SheetStatus) : "";
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const kind: PeriodKind = PERIOD_KINDS.includes(url.searchParams.get("period") as PeriodKind) ? (url.searchParams.get("period") as PeriodKind) : "week";
  const from = parseDay(url.searchParams.get("from"));
  const to = parseDay(url.searchParams.get("to"));

  const base: Record<string, unknown> = { shop };
  // an optional date range (set by clicking a period below): orders placed from the first day to the end of the last day
  if (from || to) base.orderDate = { ...(from ? { gte: from } : {}), ...(to ? { lt: addPeriod(to, "day") } : {}) };
  if (q) {
    base.OR = ["orderName", "customerName", "primaryMobile", "altMobile", "productName", "awb", "trackingNo", "employeeName", "city"].map((f) => ({ [f]: { contains: q } }));
  }
  const where = status ? { ...base, status } : base;

  const [rows, listed, counts, sync, everything, gs, windowOrders] = await Promise.all([
    prisma.orderSheet.findMany({ where, orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }], take: PAGE_SIZE, skip: (page - 1) * PAGE_SIZE }),
    prisma.orderSheet.count({ where }),
    statusCounts(base),
    prisma.orderSyncState.findUnique({ where: { shop } }),
    prisma.orderSheet.count({ where: { shop } }),
    prisma.googleSheetConfig.findUnique({ where: { shop } }),
    prisma.orderSheet.findMany({ where: { shop, orderDate: { gte: earliestStart(kind) } }, select: { orderDate: true, status: true }, take: 100_000 }),
  ]);

  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    kind, from: from ? dayParam(from) : "", to: to ? dayParam(to) : "",
    periods: bucketOrders(windowOrders, kind, PERIOD_COUNT[kind]).map((r) => ({
      key: r.key, label: r.label, current: r.current, total: r.total, Delivered: r.Delivered, Unfulfilled: r.Unfulfilled, Fulfilled: r.Fulfilled,
      Cancelled: r.Cancelled, RTO: r.RTO, from: dayParam(r.start), to: dayParam(addPeriod(r.end, "day", -1)),
    })),
    q, status, page, listed, pages: Math.max(1, Math.ceil(listed / PAGE_SIZE)), counts, everything,
    gsheet: gs && {
      mode: gs.mode, id: gs.spreadsheetId, url: gs.scriptUrl, title: gs.spreadsheetTitle, email: gs.saEmail, enabled: gs.enabled,
      lastPushAt: iso(gs.lastPushAt), rows: gs.lastPushRows, lastError: gs.lastError,
    },
    sync: sync && { lastSyncAt: iso(sync.lastSyncAt), lastFullSyncAt: iso(sync.lastFullSyncAt), lastError: sync.lastError, lastCount: sync.lastCount },
    rows: rows.map((r) => ({
      id: r.id, isManual: r.isManual, status: r.status,
      v: {
        callDate: iso(r.callDate), employeeName: r.employeeName, orderName: r.orderName, orderDate: iso(r.orderDate), customerName: r.customerName,
        productName: r.productName, qty: r.qty, amount: r.amount, paymentType: r.paymentType, primaryMobile: r.primaryMobile,
        altMobile: r.altMobile ?? r.altMobileShopify, fullAddress: r.fullAddress, landmark: r.landmark, city: r.city, state: r.state, pinCode: r.pinCode,
        addressConfirmed: r.addressConfirmed, codConfirmed: r.codConfirmed, deliveryAvailable: r.deliveryAvailable, customerWants: r.customerWants,
        callStatus: r.callStatus, finalDecision: r.finalDecision, remarks: r.isManual ? r.status : r.remarks, employeeRemark: r.employeeRemark,
        dispatchDate: iso(r.dispatchDate ?? r.dispatchDateShopify), awb: r.awb ?? r.trackingNo, deliveryCharges: r.deliveryCharges ?? r.shippingCharge,
      } as Record<string, string | number | null>,
    })),
  };
}

