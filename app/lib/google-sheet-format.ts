// Pure helpers for the Google Sheet mirror (no network, no database): easy to test.
import { rollingWindows, type OrderLite } from "./order-periods.ts";

/** The 27 columns, in the exact order of the calling sheet. */
export const SHEET_HEADERS = [
  "Call Date", "Employee Name", "Order ID", "Order Date", "Customer Name", "Product Name", "Qty", "Order Amount",
  "Payment Type", "Primary Mobile", "Alternate Mobile", "Full Address", "Landmark", "City", "State", "PIN Code",
  "Address Confirmed", "COD Amount Confirmed", "Delivery Available", "Customer Wants Order", "Call Status",
  "Final Decision", "Remarks", "Employee Remark", "Dispatch Date", "AWB/Tracking No.", "Delivery Charges",
] as const;

/** Column letter of "Remarks" (23rd), used by the colour rules and the summary formulas. */
export const REMARKS_COL = "W";

export type SheetRow = {
  callDate: Date | null; employeeName: string | null; orderName: string | null; orderDate: Date | null; customerName: string | null;
  productName: string | null; qty: number; amount: number | null; paymentType: string | null; primaryMobile: string | null;
  altMobile: string | null; altMobileShopify: string | null; fullAddress: string | null; landmark: string | null;
  city: string | null; state: string | null; pinCode: string | null; addressConfirmed: string | null; codConfirmed: string | null;
  deliveryAvailable: string | null; customerWants: string | null; callStatus: string | null; finalDecision: string | null;
  remarks: string | null; status: string; isManual: boolean; employeeRemark: string | null;
  dispatchDate: Date | null; dispatchDateShopify: Date | null; awb: string | null; trackingNo: string | null;
  deliveryCharges: number | null; shippingCharge: number | null;
};

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
const text = (s: string | null | undefined) => s ?? "";

/** One calling-sheet row as cell values. Employee values win over Shopify's where both exist. */
export function rowToValues(r: SheetRow): (string | number)[] {
  return [
    day(r.callDate), text(r.employeeName), text(r.orderName), day(r.orderDate), text(r.customerName), text(r.productName),
    r.qty ?? 0, r.amount ?? "", text(r.paymentType), text(r.primaryMobile), text(r.altMobile ?? r.altMobileShopify),
    text(r.fullAddress), text(r.landmark), text(r.city), text(r.state), text(r.pinCode),
    text(r.addressConfirmed), text(r.codConfirmed), text(r.deliveryAvailable), text(r.customerWants), text(r.callStatus),
    text(r.finalDecision), r.isManual ? r.status : text(r.remarks), text(r.employeeRemark),
    day(r.dispatchDate ?? r.dispatchDateShopify), text(r.awb ?? r.trackingNo), r.deliveryCharges ?? r.shippingCharge ?? "",
  ];
}

/** Accepts a full Google Sheets URL or a bare spreadsheet id. */
export function spreadsheetIdFrom(input: string): string | null {
  const s = input.trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : null;
}

/** Validates a pasted service-account key file (JSON) and returns only what we need. */
export function parseServiceAccount(raw: string): { email: string; privateKey: string } | null {
  try {
    const j = JSON.parse(raw);
    if (j?.type !== "service_account" || typeof j.client_email !== "string" || typeof j.private_key !== "string") return null;
    if (!j.private_key.includes("BEGIN PRIVATE KEY")) return null;
    return { email: j.client_email, privateKey: j.private_key };
  } catch {
    return null;
  }
}

/** A1 range for the data rows, e.g. 'Order Calling Sheet'!A2:AA1001 */
export const dataRange = (tab: string, from: number, to: number) => `'${tab.replace(/'/g, "''")}'!A${from}:AA${to}`;

/** Sheet layout: counters in rows 1-2, one blank row, headers in row 4, data from row 5. */
export const HEADER_ROW = 4;
export const FIRST_DATA_ROW = 5;

export const COUNTER_LABELS = ["Total Orders", "Delivered", "Unfulfilled", "Cancelled", "RTO (Returns)"] as const;

/** Live formulas for the five counters (cells A2:E2). They read the Remarks column of the data rows. */
export function counterFormulas(): string[] {
  const w = `${REMARKS_COL}${FIRST_DATA_ROW}:${REMARKS_COL}`;
  const c = (p: string) => `COUNTIF(${w},"${p}")`;
  return [
    `=COUNTA(C${FIRST_DATA_ROW}:C)`,
    `=${c("Delivered*")}`,
    `=${c("Unfulfilled*")}+${c("Partially*")}+${c("On hold*")}+${c("Scheduled*")}`,
    `=${c("Cancelled*")}`,
    `=${c("RTO*")}`,
  ];
}

/** Counter card colours, same palette as the status row colours. */
export const COUNTER_COLORS = ["#EDE5D8", "#DCECF5", "#FDEED6", "#F7D9D5", "#EADCEE"] as const;

/** 7-day counters sit to the right of the all-time ones, rows 1-3: a date label, the five names, the five numbers. */
export const WEEKLY_WEEKS = 4;
export const WEEKLY_FIRST_COL = 7; // G
export const WEEKLY_COLS_PER_WEEK = 5;
export const WEEK_NAMES = ["Total", "Delivered", "Unfulfilled", "Cancelled", "RTO"] as const;

export type WeeklyCell = { label: string; counts: [number, number, number, number, number] };

/** The latest 7-day windows ending today (the last 7 days first), counted from each order's order date. */
export function weeklyCounters(orders: OrderLite[], now: Date = new Date(), weeks: number = WEEKLY_WEEKS): WeeklyCell[] {
  return rollingWindows(orders, weeks, now).map((w, i) => ({
    label: `${i === 0 ? "Last 7 days · " : i === 1 ? "Previous 7 days · " : ""}${w.label}`,
    counts: [w.total, w.Delivered, w.Unfulfilled, w.Cancelled, w.RTO],
  }));
}

/** The weekly block as a 3-row grid for cells G1 onward (service-account mode writes it as plain values). */
export function weeklyGrid(cells: WeeklyCell[]): (string | number)[][] {
  const row1: (string | number)[] = [];
  const row2: (string | number)[] = [];
  const row3: (string | number)[] = [];
  for (const c of cells) {
    row1.push(c.label, "", "", "", "");
    row2.push(...WEEK_NAMES);
    row3.push(...c.counts);
  }
  return [row1, row2, row3];
}

/** Only accept the Apps Script web-app address Google gives after "Deploy". */
export const isScriptUrl = (u: string) => /^https:\/\/script\.google\.com\/(a\/macros\/[\w.-]+\/|macros\/)s\/[\w-]+\/exec$/.test(u.trim());

/**
 * Code the customer pastes into Extensions > Apps Script of their own sheet. The shared token is the only
 * thing that lets the app write, so a leaked web-app link alone can't change the sheet.
 */
export function appsScriptCode(token: string): string {
  const labels = JSON.stringify([...COUNTER_LABELS]);
  const colors = JSON.stringify([...COUNTER_COLORS]);
  const formulas = JSON.stringify(counterFormulas());
  return [
    "// Orderly: receives orders from your app and writes them into this sheet.",
    "// Layout: all-time counters in rows 1-2 (A:E), last-7-days counters in rows 1-3 (G onward), headers in row 4, orders from row 5.",
    `var TOKEN = '${token}';`,
    `var LABELS = ${labels};`,
    `var COLORS = ${colors};`,
    `var FORMULAS = ${formulas};`,
    `var WEEK_NAMES = ${JSON.stringify([...WEEK_NAMES])};`,
    "",
    "function doPost(e) {",
    "  try {",
    "    var d = JSON.parse(e.postData.contents);",
    "    if (d.token !== TOKEN) return out({ ok: false, error: 'Wrong token' });",
    "    var ss = SpreadsheetApp.getActiveSpreadsheet();",
    "    if (d.action === 'ping') return out({ ok: true, title: ss.getName(), url: ss.getUrl() });",
    "",
    "    var sh = ss.getSheetByName(d.tab) || ss.insertSheet(d.tab);",
    "    var cols = d.headers.length;",
    "",
    "    // Counters on top (live formulas over the Remarks column)",
    "    sh.getRange(1, 1, 3, cols).breakApart();",
    "    sh.getRange(1, 1, 3, cols).clear();",
    "    sh.getRange(1, 1, 1, LABELS.length).setValues([LABELS]).setFontWeight('bold').setFontSize(10).setFontColor('#66584C');",
    "    sh.getRange(2, 1, 1, LABELS.length).setFormulas([FORMULAS]).setFontWeight('bold').setFontSize(18).setFontColor('#38291F').setHorizontalAlignment('left');",
    "    for (var i = 0; i < COLORS.length; i++) sh.getRange(1, i + 1, 2, 1).setBackground(COLORS[i]);",
    "",
    "    // 7-day counters (last 7 days first) to the right of the all-time ones: label, names, numbers",
    "    var weeks = d.weekly || [];",
    "    for (var w = 0; w < weeks.length; w++) {",
    "      var c0 = 7 + w * 5;",
    "      var lab = sh.getRange(1, c0, 1, 5);",
    "      lab.merge();",
    "      lab.setValue(weeks[w][0]).setFontWeight('bold').setFontSize(10).setBackground('#EDE5D8').setFontColor('#38291F').setHorizontalAlignment('center');",
    "      sh.getRange(2, c0, 1, 5).setValues([WEEK_NAMES]).setFontSize(9).setFontColor('#66584C').setHorizontalAlignment('center').setBackgrounds([COLORS]);",
    "      sh.getRange(3, c0, 1, 5).setValues([weeks[w].slice(1)]).setFontWeight('bold').setFontSize(14).setFontColor('#38291F').setHorizontalAlignment('center').setBackgrounds([COLORS]);",
    "    }",
    "",
    "    // Header row",
    "    sh.getRange(4, 1, 1, cols).setNumberFormat('@').setValues([d.headers])",
    "      .setFontWeight('bold').setBackground('#EDE5D8').setFontColor('#38291F');",
    "    sh.setFrozenRows(4);",
    "",
    "    // Orders",
    "    var last = sh.getLastRow();",
    "    if (last >= 5) sh.getRange(5, 1, last - 4, cols).clearContent();",
    "    if (d.rows.length) {",
    "      var body = sh.getRange(5, 1, d.rows.length, cols);",
    "      body.setNumberFormat('@'); // keep phone numbers and text exactly as sent",
    "      sh.getRange(5, 7, d.rows.length, 2).setNumberFormat('General'); // Qty, Order Amount",
    "      sh.getRange(5, 27, d.rows.length, 1).setNumberFormat('General'); // Delivery Charges",
    "      body.setValues(d.rows);",
    "    }",
    "    addColours(sh, cols);",
    "    return out({ ok: true, rows: d.rows.length });",
    "  } catch (err) {",
    "    return out({ ok: false, error: String(err) });",
    "  }",
    "}",
    "",
    "function addColours(sh, cols) {",
    "  var range = sh.getRange(5, 1, Math.max(sh.getMaxRows() - 4, 1), cols);",
    "  var defs = [['^Cancelled', '#F7D9D5'], ['^RTO', '#EADCEE'], ['^Delivered', '#DCECF5'],",
    "              ['^Fulfilled', '#E4F2E1'], ['^(Unfulfilled|Partially|On hold|Scheduled)', '#FDEED6']];",
    "  var rules = defs.map(function (x) {",
    "    return SpreadsheetApp.newConditionalFormatRule()",
    "      .whenFormulaSatisfied('=REGEXMATCH($W5,\"' + x[0] + '\")').setBackground(x[1]).setRanges([range]).build();",
    "  });",
    "  sh.setConditionalFormatRules(rules);",
    "  sh.autoResizeColumns(1, cols);",
    "}",
    "",
    "function out(obj) {",
    "  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);",
    "}",
    "",
  ].join("\n");
}
