// Order counters grouped by day, week, month or year. Pure (no I/O): used by the Order Update page, the Google Sheet and tests.
// Orders are grouped by their ORDER DATE; the status is the order's status right now.
// Weeks start on Monday. Everything uses the clock of the machine that runs the app.

export type PeriodKind = "day" | "week" | "month" | "year";
export const PERIOD_KINDS: PeriodKind[] = ["day", "week", "month", "year"];
/** How many periods the app shows for each choice (latest first). */
export const PERIOD_COUNT: Record<PeriodKind, number> = { day: 14, week: 12, month: 12, year: 5 };

export type OrderLite = { orderDate: Date | null; status: string };
export type PeriodRow = {
  key: string;
  label: string;
  start: Date;
  /** exclusive */
  end: Date;
  current: boolean;
  total: number;
  Delivered: number;
  Unfulfilled: number;
  Fulfilled: number;
  Cancelled: number;
  RTO: number;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");

export const dayParam = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDay = (s: string | null): Date | null => {
  const m = String(s ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
};

export function startOf(d: Date, kind: PeriodKind): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (kind === "week") x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // back to Monday
  if (kind === "month") x.setDate(1);
  if (kind === "year") {
    x.setMonth(0);
    x.setDate(1);
  }
  return x;
}

export function addPeriod(start: Date, kind: PeriodKind, n = 1): Date {
  const x = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  if (kind === "day") x.setDate(x.getDate() + n);
  else if (kind === "week") x.setDate(x.getDate() + 7 * n);
  else if (kind === "month") x.setMonth(x.getMonth() + n);
  else x.setFullYear(x.getFullYear() + n);
  return x;
}

const dm = (d: Date) => `${pad(d.getDate())} ${MONTHS[d.getMonth()]}`;

export function periodLabel(start: Date, kind: PeriodKind, now: Date = new Date()): string {
  const sameYear = start.getFullYear() === now.getFullYear();
  if (kind === "day") return `${DAYS[start.getDay()]} ${dm(start)}${sameYear ? "" : ` ${start.getFullYear()}`}`;
  if (kind === "week") {
    const last = addPeriod(start, "day", 6); // Sunday
    return `${dm(start)} – ${dm(last)}${start.getFullYear() === last.getFullYear() && sameYear ? "" : ` ${last.getFullYear()}`}`;
  }
  if (kind === "month") return `${MONTHS[start.getMonth()]} ${start.getFullYear()}`;
  return String(start.getFullYear());
}

/** The latest `n` periods (current one first) with the five counters filled from `orders`. */
export function bucketOrders(orders: OrderLite[], kind: PeriodKind, n: number = PERIOD_COUNT[kind], now: Date = new Date()): PeriodRow[] {
  const currentStart = startOf(now, kind);
  const rows: PeriodRow[] = [];
  const byKey = new Map<string, PeriodRow>();
  for (let i = 0; i < n; i++) {
    const start = addPeriod(currentStart, kind, -i);
    const row: PeriodRow = {
      key: dayParam(start), label: periodLabel(start, kind, now), start, end: addPeriod(start, kind, 1), current: i === 0,
      total: 0, Delivered: 0, Unfulfilled: 0, Fulfilled: 0, Cancelled: 0, RTO: 0,
    };
    rows.push(row);
    byKey.set(row.key, row);
  }
  for (const o of orders) {
    if (!o.orderDate) continue;
    const row = byKey.get(dayParam(startOf(o.orderDate, kind)));
    if (!row) continue;
    row.total++;
    if (o.status in row) (row as unknown as Record<string, number>)[o.status]++;
  }
  return rows;
}

/** Oldest order date worth loading for the chosen view. */
export const earliestStart = (kind: PeriodKind, n: number = PERIOD_COUNT[kind], now: Date = new Date()) => addPeriod(startOf(now, kind), kind, -(n - 1));

/**
 * Rolling 7-day windows that end today: the last 7 days (today included), the 7 days before that, and so on.
 * Unlike calendar weeks they never start on a fixed weekday, so "last 7 days" always means the 7 days up to now.
 */
export function rollingWindows(orders: OrderLite[], n: number, now: Date = new Date()): PeriodRow[] {
  const today = startOf(now, "day");
  const rows: PeriodRow[] = [];
  for (let i = 0; i < n; i++) {
    const end = addPeriod(today, "day", 1 - 7 * i); // exclusive: tomorrow, then a week earlier, ...
    const start = addPeriod(end, "day", -7);
    const last = addPeriod(end, "day", -1);
    const year = start.getFullYear() === last.getFullYear() && last.getFullYear() === now.getFullYear() ? "" : ` ${last.getFullYear()}`;
    rows.push({
      key: dayParam(start), label: `${dm(start)} – ${dm(last)}${year}`, start, end, current: i === 0,
      total: 0, Delivered: 0, Unfulfilled: 0, Fulfilled: 0, Cancelled: 0, RTO: 0,
    });
  }
  for (const o of orders) {
    if (!o.orderDate) continue;
    const row = rows.find((r) => o.orderDate! >= r.start && o.orderDate! < r.end);
    if (!row) continue;
    row.total++;
    if (o.status in row) (row as unknown as Record<string, number>)[o.status]++;
  }
  return rows;
}
