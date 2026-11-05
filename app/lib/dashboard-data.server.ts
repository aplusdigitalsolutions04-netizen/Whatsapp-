// Dashboard numbers, all computed from the app's own tables (no dummy values). Database only: no Shopify or WhatsApp calls.
import prisma from "../db.server.ts";

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
/** Local calendar day, e.g. "2026-11-03" (same clock as the server the owner runs). */
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const pct = (cur: number, prev: number) => (prev === 0 ? (cur === 0 ? 0 : 100) : Math.round(((cur - prev) / prev) * 100));
const rate = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

export type Period = { value: number; prev: number; change: number };
const period = (value: number, prev: number): Period => ({ value, prev, change: pct(value, prev) });

export async function loadDashboardData(shop: string, range: number, now = Date.now()) {
  const since = new Date(now - range * DAY);
  const prevSince = new Date(now - 2 * range * DAY);
  const conv = { shop };

  const [
    messages, enquiries, logs, humanOpen, botOpen, closed, waiting, failedEvents, errors24,
    orderGroups, payGroups, ordersWindow, uncalled, uncalledList, callGroups, syncState, sheet, lastRun, settings, recent,
    imageItems, imageFailedOpen, imageJobs, imageWorkers,
    newChatsCur, newChatsPrev, cityGroups, imageApplied, imageRestored, imageBackups, faqCount, faqOn, quickLanguages,
  ] = await Promise.all([
    prisma.message.findMany({
      where: { createdAt: { gte: prevSince }, conversation: conv },
      select: { createdAt: true, direction: true, sender: true, status: true, conversationId: true },
      take: 100_000,
    }),
    prisma.productEnquiry.findMany({ where: { shop, createdAt: { gte: prevSince } }, select: { createdAt: true, found: true, query: true }, take: 50_000 }),
    prisma.activityLog.findMany({
      where: {
        createdAt: { gte: prevSince },
        event: { in: ["order_retrieved", "handoff", "verification_failed", "faq_answered", "ai_answered", "ims_send", "order_lookup_failed", "recommendation_sent"] },
        OR: [{ shop }, { shop: null }],
      },
      select: { createdAt: true, event: true, detail: true },
      take: 100_000,
    }),
    prisma.conversation.count({ where: { ...conv, status: "open", mode: "human" } }),
    prisma.conversation.count({ where: { ...conv, status: "open", mode: "bot" } }),
    prisma.conversation.count({ where: { ...conv, status: "closed" } }),
    prisma.conversation.findMany({
      where: { ...conv, status: "open", mode: "human" }, orderBy: { lastInboundAt: "desc" }, take: 5,
      include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
    }),
    prisma.webhookEvent.count({ where: { status: "failed" } }),
    prisma.activityLog.count({ where: { level: "error", createdAt: { gte: new Date(now - DAY) } } }),
    prisma.orderSheet.groupBy({ by: ["status"], where: { shop }, _count: { _all: true } }),
    prisma.orderSheet.groupBy({ by: ["paymentType"], where: { shop, paymentType: { not: null } }, _count: { _all: true } }),
    prisma.orderSheet.findMany({ where: { shop, orderDate: { gte: prevSince } }, select: { orderDate: true, amount: true, currency: true }, take: 100_000 }),
    prisma.orderSheet.count({ where: { shop, status: "Unfulfilled", callStatus: null } }),
    prisma.orderSheet.findMany({
      where: { shop, status: "Unfulfilled", callStatus: null }, orderBy: { orderDate: "asc" }, take: 5,
      select: { id: true, orderName: true, customerName: true, amount: true, currency: true, orderDate: true, paymentType: true, city: true },
    }),
    prisma.orderSheet.groupBy({ by: ["callStatus"], where: { shop, status: "Unfulfilled" }, _count: { _all: true } }),
    prisma.orderSyncState.findUnique({ where: { shop } }),
    prisma.googleSheetConfig.findUnique({ where: { shop } }),
    prisma.finderRun.findFirst({ where: { shop }, orderBy: { createdAt: "desc" }, include: { _count: { select: { products: { where: { isNew: true } } } } } }),
    prisma.botSettings.findUnique({ where: { shop } }),
    prisma.activityLog.findMany({ orderBy: { createdAt: "desc" }, take: 8 }),
    prisma.imageItem.findMany({
      where: { shop, finishedAt: { gte: prevSince }, status: { in: ["done", "error"] } },
      select: { finishedAt: true, status: true, inBytes: true, outBytes: true, ms: true },
      take: 100_000,
    }),
    prisma.imageItem.count({ where: { shop, status: "error" } }),
    prisma.imageJob.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, name: true, status: true, total: true, createdAt: true, kind: true } }),
    prisma.imageSettings.findUnique({ where: { shop } }),
    prisma.conversation.count({ where: { ...conv, createdAt: { gte: since } } }),
    prisma.conversation.count({ where: { ...conv, createdAt: { gte: prevSince, lt: since } } }),
    prisma.orderSheet.groupBy({ by: ["city"], where: { shop, city: { not: null }, orderDate: { gte: since } }, _count: { _all: true }, orderBy: { _count: { city: "desc" } }, take: 5 }),
    prisma.imageItem.count({ where: { shop, applyStatus: "applied" } }),
    prisma.imageItem.count({ where: { shop, applyStatus: "restored" } }),
    prisma.imageBackup.count({ where: { shop, restoredAt: null } }),
    prisma.faq.count({ where: { shop } }),
    prisma.faq.count({ where: { shop, enabled: true } }),
    prisma.conversation.groupBy({ by: ["lang"], where: { ...conv, lastMessageAt: { gte: since } }, _count: { _all: true } }),
  ]);

  // ---- day buckets for the current period (oldest first) ----
  const days: string[] = [];
  for (let i = range - 1; i >= 0; i--) days.push(dayKey(new Date(now - i * DAY)));
  const idx = new Map(days.map((d, i) => [d, i]));
  const perDay = days.map((d) => ({ day: d, incoming: 0, outgoing: 0, found: 0, missing: 0, orders: 0, revenue: 0 }));
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));

  const cur = { in: 0, out: 0, bot: 0, agent: 0, delivered: 0, failed: 0, contacts: new Set<string>() };
  const prev = { in: 0, out: 0, bot: 0, agent: 0, contacts: new Set<string>() };
  for (const m of messages) {
    const inCur = m.createdAt >= since;
    const b = inCur ? cur : prev;
    if (m.direction === "in") {
      b.in++;
      b.contacts.add(m.conversationId);
    } else {
      b.out++;
      if (m.sender === "bot") b.bot++;
      if (m.sender === "agent") b.agent++;
      if (inCur && (m.status === "delivered" || m.status === "read")) cur.delivered++;
      if (inCur && m.status === "failed") cur.failed++;
    }
    if (!inCur) continue;
    const i = idx.get(dayKey(m.createdAt));
    if (i !== undefined) perDay[i][m.direction === "in" ? "incoming" : "outgoing"]++;
    if (m.direction === "in") hours[m.createdAt.getHours()].count++;
  }

  // ---- product enquiries ----
  const enq = { cur: 0, prev: 0, found: 0 };
  const queries = new Map<string, { query: string; count: number; found: number }>();
  for (const e of enquiries) {
    if (e.createdAt < since) {
      enq.prev++;
      continue;
    }
    enq.cur++;
    if (e.found) enq.found++;
    const i = idx.get(dayKey(e.createdAt));
    if (i !== undefined) perDay[i][e.found ? "found" : "missing"]++;
    const key = e.query.trim().toLowerCase();
    const q = queries.get(key) ?? { query: e.query.trim(), count: 0, found: 0 };
    q.count++;
    if (e.found) q.found++;
    queries.set(key, q);
  }
  const wanted = [...queries.values()].sort((a, b) => b.count - a.count);
  const unavailable = wanted.filter((q) => q.found === 0).slice(0, 6);

  // ---- bot activity events ----
  const ev = { cur: {} as Record<string, number>, prev: {} as Record<string, number> };
  for (const l of logs) {
    const b = l.createdAt >= since ? ev.cur : ev.prev;
    b[l.event] = (b[l.event] ?? 0) + 1;
  }

  // ---- orders ----
  const statusMap: Record<string, number> = { Unfulfilled: 0, Fulfilled: 0, Delivered: 0, Cancelled: 0, RTO: 0 };
  for (const g of orderGroups) statusMap[g.status] = g._count._all;
  const orderTotal = Object.values(statusMap).reduce((a, b) => a + b, 0);
  let winCur = 0;
  let winPrev = 0;
  let value = 0;
  let valuePrev = 0;
  const currencies = new Set<string>();
  for (const o of ordersWindow) {
    if (!o.orderDate) continue;
    if (o.orderDate >= since) {
      winCur++;
      value += o.amount ?? 0;
      if (o.currency) currencies.add(o.currency);
      const i = idx.get(dayKey(o.orderDate));
      if (i !== undefined) {
        perDay[i].orders++;
        perDay[i].revenue += Math.round(o.amount ?? 0);
      }
    } else {
      winPrev++;
      valuePrev += o.amount ?? 0;
    }
  }

  // ---- where the bot's work comes from (Shopify vs IMS lookups, FAQ, AI, hand-offs) ----
  const lookups = { shopify: 0, ims: 0, failed: 0, sent: 0, sentPrev: 0, recs: 0 };
  for (const l of logs) {
    const now_ = l.createdAt >= since;
    if (l.event === "order_retrieved" && now_) lookups[(l.detail ?? "").includes("(ims)") ? "ims" : "shopify"]++;
    else if (l.event === "order_lookup_failed" && now_) lookups.failed++;
    else if (l.event === "ims_send") lookups[now_ ? "sent" : "sentPrev"]++;
    else if (l.event === "recommendation_sent" && now_) lookups.recs++;
  }

  // ---- Image Editor ----
  const img = { cur: { done: 0, failed: 0, inB: 0, outB: 0, ms: 0 }, prev: { done: 0 } };
  const imgDays = days.map((d) => ({ day: d, done: 0, failed: 0 }));
  for (const it of imageItems) {
    if (!it.finishedAt) continue;
    if (it.finishedAt < since) {
      if (it.status === "done") img.prev.done++;
      continue;
    }
    const i = idx.get(dayKey(it.finishedAt));
    if (it.status === "done") {
      img.cur.done++;
      img.cur.inB += it.inBytes;
      img.cur.outB += it.outBytes;
      img.cur.ms += it.ms;
      if (i !== undefined) imgDays[i].done++;
    } else {
      img.cur.failed++;
      if (i !== undefined) imgDays[i].failed++;
    }
  }
  const openJob = imageJobs.find((j) => j.status === "running") ?? imageJobs.find((j) => j.status === "stopped") ?? null;
  const openCounts = openJob ? await prisma.imageItem.groupBy({ by: ["status"], where: { jobId: openJob.id }, _count: { _all: true } }) : [];
  const oc = (st: string) => openCounts.find((c) => c.status === st)?._count._all ?? 0;

  return {
    range,
    days: perDay,
    hours,
    kpi: {
      customers: period(cur.contacts.size, prev.contacts.size),
      received: period(cur.in, prev.in),
      replies: period(cur.out, prev.out),
      automation: { value: rate(cur.bot, cur.bot + cur.agent), prev: rate(prev.bot, prev.bot + prev.agent), bot: cur.bot, agent: cur.agent },
      deliveryRate: rate(cur.delivered, cur.out),
      enquiries: { ...period(enq.cur, enq.prev), found: enq.found, availability: rate(enq.found, enq.cur) },
      ordersShared: period(ev.cur.order_retrieved ?? 0, ev.prev.order_retrieved ?? 0),
      handoffs: period(ev.cur.handoff ?? 0, ev.prev.handoff ?? 0),
      newOrders: { ...period(winCur, winPrev), amount: Math.round(value), currency: currencies.size === 1 ? [...currencies][0] : null },
      newChats: period(newChatsCur, newChatsPrev),
      revenue: { ...period(Math.round(value), Math.round(valuePrev)), currency: currencies.size === 1 ? [...currencies][0] : null },
      avgOrder: winCur ? Math.round(value / winCur) : 0,
      faqAnswers: ev.cur.faq_answered ?? 0,
      aiAnswers: ev.cur.ai_answered ?? 0,
      verifyFailed: ev.cur.verification_failed ?? 0,
    },
    conversations: { human: humanOpen, bot: botOpen, closed },
    waiting: waiting.map((c) => ({
      id: c.id, name: c.customerName || c.phone, phone: c.phone, reason: c.handoffReason, at: (c.lastInboundAt ?? c.lastMessageAt).toISOString(),
      preview: (c.messages[0]?.body || (c.messages[0]?.mediaKind ? `📎 ${c.messages[0].mediaKind}` : "")).slice(0, 90),
    })),
    orders: {
      total: orderTotal, status: statusMap,
      payment: payGroups.map((g) => ({ type: g.paymentType ?? "Other", count: g._count._all })),
      uncalled,
      uncalledList: uncalledList.map((o) => ({
        id: o.id, name: o.orderName, customer: o.customerName, amount: o.amount, currency: o.currency, city: o.city, payment: o.paymentType,
        at: o.orderDate ? o.orderDate.toISOString() : null,
      })),
      cities: cityGroups.map((g) => ({ city: g.city ?? "", count: g._count._all })),
      rtoRate: rate(statusMap.RTO, orderTotal),
      cancelRate: rate(statusMap.Cancelled, orderTotal),
      deliveredRate: rate(statusMap.Delivered, orderTotal),
      calls: callGroups.map((g) => ({ status: g.callStatus ?? "Not called yet", count: g._count._all })).sort((a, b) => b.count - a.count),
    },
    products: { wanted: wanted.slice(0, 6), unavailable },
    bot: {
      answers: [
        { label: "Order lookups", value: lookups.shopify + lookups.ims, to: "/app/logs" },
        { label: "Product enquiries", value: enq.cur, to: "/app/enquiries" },
        { label: "Auto replies (FAQ)", value: ev.cur.faq_answered ?? 0, to: "/app/quick-replies" },
        { label: "AI answers", value: ev.cur.ai_answered ?? 0, to: "/app/settings" },
        { label: "Handed to a human", value: ev.cur.handoff ?? 0, to: "/app/conversations?filter=human" },
      ],
      recommendations: lookups.recs,
      faqTotal: faqCount,
      faqEnabled: faqOn,
      languages: quickLanguages.map((g) => ({ lang: g.lang, count: g._count._all })),
    },
    ims: { lookupsShopify: lookups.shopify, lookupsIms: lookups.ims, lookupFailures: lookups.failed, sent: period(lookups.sent, lookups.sentPrev) },
    pending: { imageFailed: imageFailedOpen, imageStopped: imageJobs.filter((j) => j.status === "stopped").length, failedMessages: cur.failed, failedEvents, errors24, uncalled, waitingHuman: humanOpen, unavailableAsked: unavailable.length },
    system: {
      botEnabled: settings?.enabled ?? true,
      aiEnabled: settings?.aiEnabled ?? false,
      sync: syncState && { lastSyncAt: syncState.lastSyncAt?.toISOString() ?? null, lastError: syncState.lastError },
      sheet: sheet && { title: sheet.spreadsheetTitle, lastPushAt: sheet.lastPushAt?.toISOString() ?? null, rows: sheet.lastPushRows, lastError: sheet.lastError },
      finder: lastRun && { id: lastRun.id, status: lastRun.status, category: lastRun.category, found: lastRun._count.products, skipped: lastRun.skippedInStore, at: lastRun.createdAt.toISOString() },
    },
    images: {
      done: period(img.cur.done, img.prev.done),
      failed: img.cur.failed,
      savedPercent: img.cur.inB > 0 ? Math.max(0, Math.round((1 - img.cur.outB / img.cur.inB) * 100)) : 0,
      avgSeconds: img.cur.done ? Math.round((img.cur.ms / img.cur.done / 1000) * 10) / 10 : 0,
      batches: imageJobs.filter((j) => j.createdAt >= since).length,
      everUsed: imageJobs.length > 0,
      failedOpen: imageFailedOpen,
      stoppedBatches: imageJobs.filter((j) => j.status === "stopped").length,
      savedWorkers: imageWorkers?.workers ?? 2,
      applied: imageApplied,
      restored: imageRestored,
      backups: imageBackups,
      storeBatches: imageJobs.filter((j) => j.kind === "store").length,
      days: imgDays,
      active: openJob && { id: openJob.id, name: openJob.name, status: openJob.status, total: openJob.total, done: oc("done"), failed: oc("error"), waiting: oc("queued") + oc("running") },
    },
    recent: recent.map((r) => ({ id: r.id, level: r.level, source: r.source, event: r.event, detail: r.detail, at: r.createdAt.toISOString() })),
  };
}

export type DashboardData = Awaited<ReturnType<typeof loadDashboardData>>;
