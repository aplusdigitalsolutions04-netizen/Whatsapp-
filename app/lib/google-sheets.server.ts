/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHmac, createSign } from "node:crypto";
import prisma from "../db.server";
import { logEvent } from "./log.server";
import {
  COUNTER_COLORS, COUNTER_LABELS, counterFormulas, dataRange, FIRST_DATA_ROW, HEADER_ROW, REMARKS_COL, rowToValues, SHEET_HEADERS,
  WEEKLY_COLS_PER_WEEK, WEEKLY_FIRST_COL, WEEKLY_WEEKS, weeklyCounters, weeklyGrid,
} from "./google-sheet-format";
import { decryptSecret } from "./secret.server";
import { endTask, startTask, updateTask } from "./progress.server";

const API = "https://sheets.googleapis.com/v4/spreadsheets";
const TAB = "Order Calling Sheet";
const CHUNK = 1000;
const DEBOUNCE_MS = 15_000;

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const g = globalThis as unknown as {
  __gsheet?: { tokens: Map<string, { token: string; exp: number }>; timers: Map<string, NodeJS.Timeout>; running: Set<string>; again: Set<string> };
};
const mem = (g.__gsheet ??= { tokens: new Map(), timers: new Map(), running: new Set(), again: new Set() });

/** Service-account access token (JWT bearer flow), cached for ~50 minutes. */
export async function accessToken(email: string, privateKey: string): Promise<string> {
  const hit = mem.tokens.get(email);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const sig = createSign("RSA-SHA256").update(`${head}.${claim}`).sign(privateKey);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${b64url(sig)}` }),
    signal: AbortSignal.timeout(15_000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Google sign-in failed: ${j.error_description ?? j.error ?? res.status}`);
  mem.tokens.set(email, { token: j.access_token, exp: Date.now() + 50 * 60_000 });
  return j.access_token;
}

/** Sheets REST call with retry on rate limits (429) and 5xx. */
async function api(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}/${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (res.ok) return j;
    last = `${res.status}: ${j.error?.message ?? "request failed"}`;
    if (res.status === 403 || res.status === 404) throw new SheetAccessError(last);
    if (res.status !== 429 && res.status < 500) break;
    await sleep(1500 * (attempt + 1));
  }
  throw new Error(`Google Sheets ${last}`);
}

export class SheetAccessError extends Error {}

/** Per-shop secret baked into the pasted Apps Script; recomputed on demand, never stored in the clear. */
export function scriptToken(shop: string): string {
  const seed = process.env.SECRETS_KEY || process.env.SHOPIFY_API_SECRET;
  if (!seed) throw new Error("Set SECRETS_KEY (or SHOPIFY_API_SECRET) first");
  return createHmac("sha256", seed).update(`gsheet-script:${shop}`).digest("hex").slice(0, 32);
}

/** Calls the customer's Apps Script web app. It answers with JSON; anything else means it isn't deployed for "Anyone". */
export async function callScript(url: string, token: string, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ token, ...payload }),
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error("The Apps Script didn't answer. Deploy it as a Web app with access set to 'Anyone', then paste the new link.");
  }
  if (!j.ok) throw new Error(`Apps Script: ${j.error ?? "failed"}`);
  return j;
}

const rgb = (hex: string) => ({
  red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255,
});

/** Makes sure the data tab exists. Returns its sheet id and the file title. */
async function ensureTabs(token: string, id: string) {
  const meta = await api(token, `${id}?fields=properties.title,sheets(properties,conditionalFormats)`);
  const tabs: { sheetId: number; title: string; rules: number }[] = (meta.sheets ?? []).map((s: any) => ({ ...s.properties, rules: (s.conditionalFormats ?? []).length }));
  let data = tabs.find((t) => t.title === TAB);
  if (!data) {
    const r = await api(token, `${id}:batchUpdate`, {
      method: "POST",
      body: { requests: [{ addSheet: { properties: { title: TAB, gridProperties: { columnCount: 27 } } } }] },
    });
    data = { ...r.replies[0].addSheet.properties, rules: 0 };
  }
  return { title: String(meta.properties?.title ?? ""), dataId: data!.sheetId, rules: data!.rules };
}

/** One-time look and feel: counter cards, header style, frozen rows, status colours that follow the Remarks column. */
async function format(token: string, id: string, dataId: number, oldRules: number) {
  const rules: [string, string][] = [
    ["^Cancelled", "#F7D9D5"], ["^RTO", "#EADCEE"], ["^Delivered", "#DCECF5"], ["^Fulfilled", "#E4F2E1"],
    ["^(Unfulfilled|Partially|On hold|Scheduled)", "#FDEED6"],
  ];
  const range = { sheetId: dataId, startRowIndex: FIRST_DATA_ROW - 1, startColumnIndex: 0, endColumnIndex: 27 };
  await api(token, `${id}:batchUpdate`, {
    method: "POST",
    body: {
      requests: [
        // drop rules from an older layout so colours never land on the wrong rows
        ...Array.from({ length: oldRules }, () => ({ deleteConditionalFormatRule: { sheetId: dataId, index: 0 } })),
        { updateSheetProperties: { properties: { sheetId: dataId, gridProperties: { frozenRowCount: HEADER_ROW } }, fields: "gridProperties.frozenRowCount" } },
        { repeatCell: { range: { sheetId: dataId, startRowIndex: 0, endRowIndex: 1, endColumnIndex: 5 }, cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 10, foregroundColor: rgb("#66584C") } } }, fields: "userEnteredFormat.textFormat" } },
        { repeatCell: { range: { sheetId: dataId, startRowIndex: 1, endRowIndex: 2, endColumnIndex: 5 }, cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 18, foregroundColor: rgb("#38291F") }, horizontalAlignment: "LEFT" } }, fields: "userEnteredFormat(textFormat,horizontalAlignment)" } },
        ...COUNTER_COLORS.map((c, i) => ({ repeatCell: { range: { sheetId: dataId, startRowIndex: 0, endRowIndex: 2, startColumnIndex: i, endColumnIndex: i + 1 }, cell: { userEnteredFormat: { backgroundColor: rgb(c) } }, fields: "userEnteredFormat.backgroundColor" } })),
        { repeatCell: { range: { sheetId: dataId, startRowIndex: HEADER_ROW - 1, endRowIndex: HEADER_ROW }, cell: { userEnteredFormat: { backgroundColor: rgb("#EDE5D8"), textFormat: { bold: true, foregroundColor: rgb("#38291F") } } }, fields: "userEnteredFormat(backgroundColor,textFormat)" } },
        ...rules.map(([re, color], index) => ({
          addConditionalFormatRule: { index, rule: { ranges: [range], booleanRule: { condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=REGEXMATCH($${REMARKS_COL}${FIRST_DATA_ROW},"${re}")` }] }, format: { backgroundColor: rgb(color) } } } },
        })),
        // 7-day counters: merged date label, small names, big numbers, same colours as the all-time cards
        ...Array.from({ length: WEEKLY_WEEKS }, (_, w) => {
          const c0 = WEEKLY_FIRST_COL - 1 + w * WEEKLY_COLS_PER_WEEK;
          return { mergeCells: { range: { sheetId: dataId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: c0, endColumnIndex: c0 + WEEKLY_COLS_PER_WEEK }, mergeType: "MERGE_ALL" } };
        }),
        ...Array.from({ length: WEEKLY_WEEKS }, (_, w) => {
          const c0 = WEEKLY_FIRST_COL - 1 + w * WEEKLY_COLS_PER_WEEK;
          const rng = (r0: number, r1: number) => ({ sheetId: dataId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c0 + WEEKLY_COLS_PER_WEEK });
          return { repeatCell: { range: rng(0, 1), cell: { userEnteredFormat: { backgroundColor: rgb("#EDE5D8"), horizontalAlignment: "CENTER", textFormat: { bold: true, fontSize: 10, foregroundColor: rgb("#38291F") } } }, fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)" } };
        }),
        ...Array.from({ length: WEEKLY_WEEKS * WEEKLY_COLS_PER_WEEK }, (_, k) => {
          const c = WEEKLY_FIRST_COL - 1 + k;
          const color = rgb(COUNTER_COLORS[k % WEEKLY_COLS_PER_WEEK]);
          return [
            { repeatCell: { range: { sheetId: dataId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { backgroundColor: color, horizontalAlignment: "CENTER", textFormat: { fontSize: 9, foregroundColor: rgb("#66584C") } } }, fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)" } },
            { repeatCell: { range: { sheetId: dataId, startRowIndex: 2, endRowIndex: 3, startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { backgroundColor: color, horizontalAlignment: "CENTER", textFormat: { bold: true, fontSize: 14, foregroundColor: rgb("#38291F") } } }, fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)" } },
          ];
        }).flat(),
        { autoResizeDimensions: { dimensions: { sheetId: dataId, dimension: "COLUMNS", startIndex: 0, endIndex: 27 } } },
      ],
    },
  });
}

/** Verifies access to the sheet and prepares it. Throws SheetAccessError with a friendly hint if it isn't shared. */
export async function prepareSheet(email: string, privateKey: string, spreadsheetId: string) {
  const token = await accessToken(email, privateKey);
  try {
    return await ensureTabs(token, spreadsheetId);
  } catch (e) {
    if (e instanceof SheetAccessError) {
      throw new SheetAccessError(`Can't open that sheet. Share it with ${email} as Editor, and make sure the Google Sheets API is enabled. (${e.message})`);
    }
    throw e;
  }
}

/** Rewrites the data tab from the database (the app is the source of truth). Returns the number of rows written. */
export async function pushOrders(shop: string): Promise<number | null> {
  const cfg = await prisma.googleSheetConfig.findUnique({ where: { shop } });
  if (!cfg || !cfg.enabled) {
    if (!mem.running.has(shop)) endTask(shop, "sheet");
    return null;
  }
  if (mem.running.has(shop)) {
    mem.again.add(shop); // changed during a push: run once more right after
    return null;
  }
  mem.running.add(shop);
  startTask(shop, "sheet", "Sending orders to Google Sheet");
  try {
    if (cfg.mode === "script" && cfg.scriptUrl) {
      const all = await prisma.orderSheet.findMany({ where: { shop }, orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }] });
      updateTask(shop, "sheet", { label: `Sending ${all.length.toLocaleString()} orders to Google Sheet` });
      await callScript(cfg.scriptUrl, scriptToken(shop), {
        action: "write", tab: TAB, headers: [...SHEET_HEADERS], rows: all.map((r) => rowToValues(r)),
        weekly: weeklyCounters(all).map((w) => [w.label, ...w.counts]),
      });
      await prisma.googleSheetConfig.update({ where: { shop }, data: { lastPushAt: new Date(), lastPushRows: all.length, lastError: null, formatted: true } });
      await logEvent({ shop, source: "shopify", event: "sheet_push", detail: `${all.length} rows (script)` });
      return all.length;
    }
    const key = decryptSecret(cfg.saKeyEnc);
    if (!key) throw new Error("Stored Google key can't be decrypted. Disconnect and connect again.");
    const token = await accessToken(cfg.saEmail, key);
    const tabs = await ensureTabs(token, cfg.spreadsheetId);
    const rows = await prisma.orderSheet.findMany({ where: { shop }, orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }] });
    const values = rows.map((r) => rowToValues(r));
    updateTask(shop, "sheet", { label: `Sending ${values.length.toLocaleString()} orders to Google Sheet` });

    const sid = cfg.spreadsheetId;
    const enc = encodeURIComponent;
    // Counters (live formulas) on top, header in row 4, orders from row 5.
    await api(token, `${sid}/values/${enc(`'${TAB}'!A1:E2`)}?valueInputOption=USER_ENTERED`, { method: "PUT", body: { values: [[...COUNTER_LABELS], counterFormulas()] } });
    await api(token, `${sid}/values/${enc(`'${TAB}'!A3:AA3`)}:clear`, { method: "POST", body: {} });
    // Last-7-days counters (and the 7-day windows before) to the right of the all-time ones
    await api(token, `${sid}/values/${enc(`'${TAB}'!G1:Z3`)}?valueInputOption=RAW`, { method: "PUT", body: { values: weeklyGrid(weeklyCounters(rows)) } });
    await api(token, `${sid}/values/${enc(dataRange(TAB, HEADER_ROW, HEADER_ROW))}?valueInputOption=RAW`, { method: "PUT", body: { values: [[...SHEET_HEADERS]] } });
    // Clear only our 27 columns (anything to the right, e.g. the team's own notes, is left alone), then write in chunks.
    await api(token, `${sid}/values/${enc(`'${TAB}'!A${FIRST_DATA_ROW}:AA`)}:clear`, { method: "POST", body: {} });
    for (let i = 0; i < values.length; i += CHUNK) {
      const slice = values.slice(i, i + CHUNK);
      await api(token, `${sid}/values/${enc(dataRange(TAB, FIRST_DATA_ROW + i, FIRST_DATA_ROW + i + slice.length - 1))}?valueInputOption=RAW`, { method: "PUT", body: { values: slice } });
      updateTask(shop, "sheet", { total: values.length, done: i + slice.length }); // the bar becomes a real percentage once rows start going out
    }
    if (!cfg.formatted) await format(token, sid, tabs.dataId, tabs.rules);
    await prisma.googleSheetConfig.update({
      where: { shop },
      data: { lastPushAt: new Date(), lastPushRows: values.length, lastError: null, formatted: true, spreadsheetTitle: tabs.title || cfg.spreadsheetTitle },
    });
    await logEvent({ shop, source: "shopify", event: "sheet_push", detail: `${values.length} rows` });
    return values.length;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await prisma.googleSheetConfig.update({ where: { shop }, data: { lastError: msg } }).catch(() => undefined);
    await logEvent({ shop, source: "shopify", level: "error", event: "sheet_push_failed", detail: msg });
    endTask(shop, "sheet", msg.slice(0, 200));
    return null;
  } finally {
    endTask(shop, "sheet"); // no-op when the error branch above already ended it with a message
    mem.running.delete(shop);
    if (mem.again.delete(shop)) scheduleSheetPush(shop);
  }
}

/** Debounced "something changed": many webhooks in a burst become one push shortly after. */
export function scheduleSheetPush(shop: string, delay = DEBOUNCE_MS) {
  if (mem.timers.has(shop)) return;
  const t = setTimeout(() => {
    mem.timers.delete(shop);
    void pushOrders(shop);
  }, delay);
  t.unref?.();
  mem.timers.set(shop, t);
}
