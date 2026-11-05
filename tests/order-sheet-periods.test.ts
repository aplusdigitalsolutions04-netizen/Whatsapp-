import { test, after } from "node:test";
import assert from "node:assert/strict";
import prisma from "../app/db.server.ts";
import { loadOrderSheet } from "../app/lib/order-sheet-data.server.ts";
import { addPeriod, dayParam, startOf } from "../app/lib/order-periods.ts";

const SHOP = "order-periods-test.invalid";

after(async () => {
  await prisma.orderSheet.deleteMany({ where: { shop: SHOP } });
  await prisma.$disconnect();
});

const url = (qs = "") => new URL(`http://localhost/app/order-sheet${qs}`);

test("Order Update: counters by day, week, month and year, and the date filter", async () => {
  const now = new Date();
  const thisMonday = startOf(now, "week");
  const at = (start: Date, plusDays: number) => { const d = addPeriod(start, "day", plusDays); d.setHours(12); return d; };
  let n = 0;
  const order = (status: string, when: Date) =>
    prisma.orderSheet.create({ data: { shop: SHOP, shopifyOrderId: `p${++n}`, orderName: `#${n}`, status, orderDate: when, customerName: "Asha" } });

  await order("Unfulfilled", at(thisMonday, 0));
  await order("Delivered", at(thisMonday, 0));
  await order("Cancelled", at(thisMonday, -3)); // last week
  await order("RTO", at(thisMonday, -9)); // two weeks ago
  await order("Delivered", at(thisMonday, -400)); // more than a year ago

  const weekly = await loadOrderSheet(SHOP, url());
  assert.equal(weekly.kind, "week", "weekly is the default view");
  assert.equal(weekly.periods.length, 12);
  assert.equal(weekly.periods[0].current, true);
  assert.deepEqual([weekly.periods[0].total, weekly.periods[0].Delivered, weekly.periods[0].Unfulfilled], [2, 1, 1]);
  assert.deepEqual([weekly.periods[1].total, weekly.periods[1].Cancelled], [1, 1]);
  assert.deepEqual([weekly.periods[2].total, weekly.periods[2].RTO], [1, 1]);
  assert.equal(weekly.counts.total, 5, "the all-time counters still cover every order");
  assert.equal(weekly.periods.reduce((x, p) => x + p.total, 0), 4, "the old order is outside the 12 weeks");

  const years = await loadOrderSheet(SHOP, url("?period=year"));
  assert.equal(years.kind, "year");
  assert.equal(years.periods.length, 5);
  assert.equal(years.periods.reduce((x, p) => x + p.total, 0), 5);

  assert.equal((await loadOrderSheet(SHOP, url("?period=day"))).periods.length, 14);
  assert.equal((await loadOrderSheet(SHOP, url("?period=month"))).periods.length, 12);
  assert.equal((await loadOrderSheet(SHOP, url("?period=nonsense"))).kind, "week", "unknown values fall back safely");

  // clicking a week lists only that week's orders and its counters
  const cur = weekly.periods[0];
  assert.equal(cur.from, dayParam(thisMonday));
  const filtered = await loadOrderSheet(SHOP, url(`?from=${cur.from}&to=${cur.to}`));
  assert.equal(filtered.listed, 2);
  assert.equal(filtered.counts.total, 2);
  assert.equal(filtered.counts.Delivered, 1);
  assert.equal(filtered.rows.length, 2);
  const status = await loadOrderSheet(SHOP, url(`?from=${cur.from}&to=${cur.to}&status=Delivered`));
  assert.equal(status.listed, 1);
  assert.equal(status.counts.total, 2, "the status chip does not change the counters");
  const bad = await loadOrderSheet(SHOP, url("?from=garbage&to=2026-13-99"));
  assert.equal(typeof bad.listed, "number", "bad dates never crash the page");
});
