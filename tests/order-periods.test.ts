import { test } from "node:test";
import assert from "node:assert/strict";
import { addPeriod, bucketOrders, dayParam, earliestStart, parseDay, periodLabel, rollingWindows, startOf } from "../app/lib/order-periods.ts";

const d = (y: number, m: number, day: number, h = 12) => new Date(y, m - 1, day, h);

test("weeks start on Monday, months and years on the 1st", () => {
  assert.equal(dayParam(startOf(d(2026, 11, 4), "week")), "2026-11-02"); // Wednesday -> Monday
  assert.equal(dayParam(startOf(d(2026, 11, 8), "week")), "2026-11-02"); // Sunday still belongs to that week
  assert.equal(dayParam(startOf(d(2026, 11, 9), "week")), "2026-11-09");
  assert.equal(dayParam(startOf(d(2026, 1, 1), "week")), "2025-12-29"); // across the year
  assert.equal(dayParam(startOf(d(2026, 11, 19), "month")), "2026-11-01");
  assert.equal(dayParam(startOf(d(2026, 11, 19), "year")), "2026-01-01");
  assert.equal(dayParam(addPeriod(d(2026, 1, 31), "month")), "2026-03-03", "plain date arithmetic, not month names");
});

test("labels are readable and do not depend on the browser's locale", () => {
  const now = d(2026, 11, 4);
  assert.equal(periodLabel(d(2026, 11, 2), "week", now), "02 Nov – 08 Nov");
  assert.equal(periodLabel(d(2026, 12, 28), "week", now), "28 Dec – 03 Jan 2027");
  assert.equal(periodLabel(d(2026, 11, 4), "day", now), "Wed 04 Nov");
  assert.equal(periodLabel(d(2025, 11, 4), "day", now), "Tue 04 Nov 2025");
  assert.equal(periodLabel(d(2026, 11, 1), "month", now), "Nov 2026");
  assert.equal(periodLabel(d(2026, 1, 1), "year", now), "2026");
});

test("counters per period: each order is counted once, in the period of its order date", () => {
  const now = d(2026, 11, 4); // Wednesday
  const orders = [
    { orderDate: d(2026, 11, 3), status: "Unfulfilled" }, // this week
    { orderDate: d(2026, 11, 2, 0), status: "Delivered" }, // Monday 00:xx, this week
    { orderDate: d(2026, 11, 1, 23), status: "Cancelled" }, // Sunday night: last week
    { orderDate: d(2026, 10, 28), status: "RTO" }, // last week
    { orderDate: d(2026, 10, 27), status: "Fulfilled" }, // last week (Tuesday)
    { orderDate: d(2026, 10, 19), status: "Delivered" }, // two weeks ago
    { orderDate: d(2025, 1, 1), status: "Delivered" }, // far outside 12 weeks
    { orderDate: null, status: "Delivered" }, // no date: never counted in a period
  ];
  const weeks = bucketOrders(orders, "week", 12, now);
  assert.equal(weeks.length, 12);
  assert.equal(weeks[0].current, true);
  assert.equal(weeks[0].key, "2026-11-02");
  assert.deepEqual([weeks[0].total, weeks[0].Delivered, weeks[0].Unfulfilled, weeks[0].Cancelled, weeks[0].RTO], [2, 1, 1, 0, 0]);
  assert.deepEqual([weeks[1].total, weeks[1].Cancelled, weeks[1].RTO, weeks[1].Fulfilled, weeks[1].Delivered], [3, 1, 1, 1, 0]);
  assert.deepEqual([weeks[2].total, weeks[2].Delivered], [1, 1]);
  assert.equal(weeks.reduce((n, w) => n + w.total, 0), 6, "orders outside the window or without a date are left out");

  const months = bucketOrders(orders, "month", 12, now);
  assert.equal(months[0].label, "Nov 2026");
  assert.equal(months[0].total, 3);
  assert.equal(months[1].total, 3); // October
  const years = bucketOrders(orders, "year", 5, now);
  assert.deepEqual(years.map((y) => [y.label, y.total]), [["2026", 6], ["2025", 1], ["2024", 0], ["2023", 0], ["2022", 0]]);
  const days = bucketOrders(orders, "day", 14, now);
  assert.equal(days[0].label, "Wed 04 Nov");
  assert.equal(days.find((x) => x.key === "2026-11-03")!.total, 1);
});

test("window start and day parsing", () => {
  const now = d(2026, 11, 4);
  assert.equal(dayParam(earliestStart("week", 12, now)), "2026-08-17");
  assert.equal(dayParam(earliestStart("day", 14, now)), "2026-10-22");
  assert.equal(parseDay("2026-02-30")?.getMonth(), 2, "an impossible date rolls over, it never throws");
  assert.equal(parseDay("nope"), null);
  assert.equal(parseDay(null), null);
});

test("rolling 7-day windows end today and never depend on the weekday", () => {
  const now = d(2026, 11, 4, 9); // Wednesday morning
  const orders = [
    { orderDate: d(2026, 11, 4, 23), status: "Unfulfilled" }, // later today
    { orderDate: d(2026, 10, 29, 0), status: "Delivered" }, // first moment of the 7-day window
    { orderDate: d(2026, 10, 28, 23), status: "Cancelled" }, // one hour before the window: previous 7 days
    { orderDate: d(2026, 10, 22, 0), status: "RTO" }, // first moment of the previous window
    { orderDate: d(2026, 11, 5, 1), status: "Delivered" }, // tomorrow: not counted yet
  ];
  const w = rollingWindows(orders, 4, now);
  assert.deepEqual(w.map((x) => x.label), ["29 Oct – 04 Nov", "22 Oct – 28 Oct", "15 Oct – 21 Oct", "08 Oct – 14 Oct"]);
  assert.deepEqual(w.map((x) => x.total), [2, 2, 0, 0]);
  assert.equal(w[0].Delivered, 1);
  assert.equal(w[0].Unfulfilled, 1);
  assert.deepEqual([w[1].Cancelled, w[1].RTO], [1, 1]);
  // the same orders viewed on a Sunday: the window still ends that day
  assert.equal(rollingWindows([], 1, d(2026, 11, 8))[0].label, "02 Nov – 08 Nov");
  assert.equal(rollingWindows([], 1, d(2026, 11, 9))[0].label, "03 Nov – 09 Nov");
});
