/* eslint-disable @typescript-eslint/no-explicit-any */
// Billing Data: the details an accountant needs for an invoice, taken from Shopify orders. Pure functions (no Shopify, no database),
// so the page can build the CSV in the browser and the tests can check every rule.

export const BILLING_FIELDS = `
  id name createdAt email phone note
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  customAttributes { key value }
  customer { firstName lastName }
  shippingAddress { name firstName lastName company address1 address2 city province zip country phone }
  billingAddress { name firstName lastName company address1 address2 city province zip country phone }
  lineItems(first: 100) { nodes {
    title variantTitle quantity
    discountedUnitPriceSet { shopMoney { amount currencyCode } }
    taxLines { title rate ratePercentage priceSet { shopMoney { amount } } }
  } }
`;

/** Orders handled at once. */
export const MAX_BILLING_ORDERS = 100;

/** One row of the sheet = one item of an order (an order with 3 items gives 3 rows that repeat the order details). */
export type BillingRow = {
  orderId: string;
  orderDate: string;
  customerName: string;
  phone: string;
  email: string;
  address: string;
  hasGst: string;
  gstNumber: string;
  companyName: string;
  itemName: string;
  quantity: number;
  price: string;
  gstPercent: string;
  gstAmount: string;
  /** The whole order's total (items, tax and shipping), the same on every row of that order. */
  totalAmount: string;
};

export const BILLING_COLUMNS: { key: keyof BillingRow; label: string }[] = [
  { key: "orderId", label: "Order ID" },
  { key: "orderDate", label: "Order Date" },
  { key: "customerName", label: "Customer Full Name" },
  { key: "phone", label: "Phone No" },
  { key: "email", label: "Email" },
  { key: "address", label: "Address" },
  { key: "hasGst", label: "Has GST" },
  { key: "gstNumber", label: "GST Number" },
  { key: "companyName", label: "Company Name" },
  { key: "itemName", label: "Item Name" },
  { key: "quantity", label: "Quantity" },
  { key: "price", label: "Price (per item)" },
  { key: "gstPercent", label: "GST %" },
  { key: "gstAmount", label: "GST Amount" },
  { key: "totalAmount", label: "Total Amount" },
];

// ---------- order ids typed by the person ----------

/** Order ids typed or pasted in any way: one per line, or separated by commas, spaces or semicolons. Duplicates are dropped, order is kept. */
export function parseOrderIds(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of String(text ?? "").split(/[\s,;|]+/)) {
    const t = raw.trim().replace(/^[#]+/, "#");
    if (!t || t === "#") continue;
    const key = t.toUpperCase().replace(/^#/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

// ---------- GST ----------

// A GSTIN is 15 characters: 2 digits (state), 5 letters + 4 digits + 1 letter (PAN), entity number, "Z", check character.
const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/i;
const GST_KEY = /gst|vat|tax[\s_-]*(id|no|number)/i;
const COMPANY_KEY = /company|business|firm|organi[sz]ation/i;

const YES = /^(yes|y|true|haan|han|ha|हाँ|हां)$/i;
const NO = /^(no|n|false|nahi|nahin|na|नहीं)$/i;

/**
 * The customer's GST details. A checkout often has a "GST: Yes / No" question AND a separate field for the number, so a Yes/No answer is
 * never taken as the number:
 *  1. a real GSTIN (15 characters) found in any checkout field, the order note or the address company line;
 *  2. otherwise the value of a GST field that is not a Yes/No answer.
 * `hasGst` is "Yes" when a number was found or the customer answered Yes, "No" when they answered No, "" when nothing was asked.
 */
export function extractGst(o: any): { hasGst: string; gstNumber: string; companyName: string } {
  const attrs: { key: string; value: string }[] = (o?.customAttributes ?? []).map((a: any) => ({ key: String(a?.key ?? ""), value: String(a?.value ?? "").trim() }));
  let gstNumber = "";
  let answer = "";

  const hay = [...attrs.filter((a) => GST_KEY.test(a.key)).map((a) => a.value), o?.note, ...attrs.map((a) => a.value), o?.billingAddress?.company, o?.shippingAddress?.company].map((s) => String(s ?? ""));
  for (const h of hay) {
    const m = h.match(GSTIN);
    if (m) {
      gstNumber = m[0].toUpperCase();
      break;
    }
  }
  for (const a of attrs) {
    if (!GST_KEY.test(a.key) || !a.value) continue;
    if (YES.test(a.value)) answer ||= "Yes";
    else if (NO.test(a.value)) answer ||= "No";
    else if (!gstNumber) {
      const cleaned = a.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      if (cleaned.length >= 5) gstNumber = cleaned; // a number typed in the wrong format is still shown, as typed
    }
  }
  const companyAttr = attrs.find((a) => COMPANY_KEY.test(a.key) && a.value)?.value;
  const companyName = String(o?.billingAddress?.company || o?.shippingAddress?.company || companyAttr || "").trim();
  return { hasGst: gstNumber ? "Yes" : answer, gstNumber, companyName };
}

// ---------- one order -> rows ----------

/**
 * Indian numbers as the 10 digits (+91 and 91 removed): Excel shows those in full and keeps them as typed. Other countries keep their own form.
 * A leading + is avoided on purpose: Excel would read it as a formula.
 */
export function plainPhone(p: string): string {
  const digits = p.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return p.trim();
}

const money = (a: any): number => {
  const n = Number(a?.shopMoney?.amount ?? a?.amount);
  return Number.isFinite(n) ? n : 0;
};
const fixed = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

const addressLine = (a: any): string => [a?.address1, a?.address2, a?.city, a?.province, a?.zip, a?.country].map((s) => String(s ?? "").trim()).filter(Boolean).join(", ");
const fullName = (a: any): string => String(a?.name || [a?.firstName, a?.lastName].filter(Boolean).join(" ") || "").trim();

/** "13 Nov 2026" in India time, because the store's orders are read in IST. */
export function billingDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

export function orderToRows(o: any): BillingRow[] {
  const ship = o?.shippingAddress ?? null;
  const bill = o?.billingAddress ?? null;
  const customerName = fullName(ship) || [o?.customer?.firstName, o?.customer?.lastName].filter(Boolean).join(" ") || fullName(bill);
  const phone = plainPhone([o?.phone, ship?.phone, bill?.phone].map((s) => String(s ?? "").trim()).find(Boolean) ?? "");
  const gst = extractGst(o);
  const base = {
    orderId: String(o?.name ?? ""),
    orderDate: billingDate(o?.createdAt),
    customerName,
    phone,
    email: String(o?.email ?? "").trim(),
    address: addressLine(ship) || addressLine(bill),
    hasGst: gst.hasGst,
    gstNumber: gst.gstNumber,
    companyName: gst.companyName,
    totalAmount: o?.currentTotalPriceSet ? fixed(money(o.currentTotalPriceSet)) : "",
  };
  const items: any[] = o?.lineItems?.nodes ?? [];
  if (!items.length) return [{ ...base, itemName: "", quantity: 0, price: "", gstPercent: "", gstAmount: "" }];
  return items.map((l) => {
    const taxes: any[] = l?.taxLines ?? [];
    const pct = taxes.reduce((n, t) => n + (Number(t?.ratePercentage) || (Number(t?.rate) || 0) * 100), 0);
    const amount = taxes.reduce((n, t) => n + money(t?.priceSet), 0);
    return {
      ...base,
      itemName: [l?.title, l?.variantTitle && l.variantTitle !== "Default Title" ? `(${l.variantTitle})` : ""].filter(Boolean).join(" "),
      quantity: Number(l?.quantity) || 0,
      price: fixed(money(l?.discountedUnitPriceSet)),
      gstPercent: taxes.length ? String(Math.round(pct * 100) / 100) : "",
      gstAmount: taxes.length ? fixed(amount) : "",
    };
  });
}

// ---------- CSV ----------

/** A cell that starts with = + - @ would be run as a formula by Excel. A leading ' makes it plain text. */
const safe = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The CSV text, ready for Excel and Google Sheets (BOM so Hindi names read correctly). */
export function billingCsv(rows: BillingRow[]): string {
  const head = BILLING_COLUMNS.map((c) => cell(c.label)).join(",");
  const body = rows.map((r) => BILLING_COLUMNS.map((c) => cell(safe(String(r[c.key] ?? "")))).join(","));
  return String.fromCharCode(0xfeff) + [head, ...body].join("\r\n") + "\r\n";
}
