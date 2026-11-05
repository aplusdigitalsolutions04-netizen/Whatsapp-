/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appsScriptCode, counterFormulas, COUNTER_LABELS, FIRST_DATA_ROW, HEADER_ROW, isScriptUrl, SHEET_HEADERS, weeklyCounters, weeklyGrid } from "../app/lib/google-sheet-format.ts";

// Runs the generated Apps Script against a tiny fake of Google's SpreadsheetApp to prove it parses and behaves.
function run(payload: unknown) {
  const writes: { rows?: unknown[][]; formats: string[]; ranges: unknown[][]; formulas?: unknown; sets: { at: unknown[]; values: unknown }[]; merges: unknown[][] } = { formats: [], ranges: [], sets: [], merges: [] };
  let last: unknown[] = [];
  const range: any = new Proxy({}, {
    get: (_t, name: string) => (...args: unknown[]) => {
      if (name === "setValues") { writes.rows = args[0] as unknown[][]; writes.sets.push({ at: last, values: args[0] }); }
      if (name === "merge") writes.merges.push(last);
      if (name === "setFormulas") writes.formulas = args[0];
      if (name === "setNumberFormat") writes.formats.push(String(args[0]));
      return range;
    },
  });
  const sheet: any = {
    getRange: (...a: unknown[]) => (writes.ranges.push(a), (last = a), range), setFrozenRows() {}, getLastRow: () => 1, getConditionalFormatRules: () => [1], getMaxRows: () => 10,
    setConditionalFormatRules() {}, autoResizeColumns() {},
  };
  const book: any = { getName: () => "My Orders", getUrl: () => "https://docs.google.com/spreadsheets/d/ABCDEFGHIJKLMNOPQRSTUV/edit", getSheetByName: () => sheet, insertSheet: () => sheet };
  const text = (s: string) => ({ setMimeType: () => JSON.parse(s) });
  const env = { SpreadsheetApp: { getActiveSpreadsheet: () => book, newConditionalFormatRule: () => range }, ContentService: { createTextOutput: text, MimeType: { JSON: 1 } } };
  const doPost = new Function(...Object.keys(env), `${appsScriptCode("tok123")}\nreturn doPost;`)(...Object.values(env));
  return { out: doPost({ postData: { contents: JSON.stringify(payload) } }), writes };
}

test("apps script: rejects a wrong token, answers ping, writes rows as plain text", () => {
  assert.deepEqual(run({ token: "nope", action: "ping" }).out, { ok: false, error: "Wrong token" });
  const ping = run({ token: "tok123", action: "ping" }).out;
  assert.equal(ping.ok, true);
  assert.equal(ping.title, "My Orders");
  const rows = [["", "Ravi", "#1001", "2026-11-01", "Asha", "HP Printer", 2, 2998, "COD", "+919822222222"]];
  const w = run({ token: "tok123", action: "write", tab: "Order Calling Sheet", headers: [...SHEET_HEADERS], rows });
  assert.deepEqual(w.out, { ok: true, rows: 1 });
  assert.deepEqual(w.writes.rows, rows);
  assert.ok(w.writes.formats.includes("@")); // text format first, so "+91…" and "=…" are never turned into numbers/formulas
});

test("apps script url must be Google's own /exec address", () => {
  assert.equal(isScriptUrl("https://script.google.com/macros/s/AKfycbxAbC_123-xyz/exec"), true);
  assert.equal(isScriptUrl("https://script.google.com/a/macros/mycompany.com/s/AKfycbxAbC/exec"), true);
  assert.equal(isScriptUrl("https://evil.example.com/macros/s/abc/exec"), false);
  assert.equal(isScriptUrl("http://script.google.com/macros/s/abc/exec"), false);
  assert.equal(isScriptUrl("https://script.google.com/macros/s/abc/dev"), false);
});

test("sheet layout: counters on top, headers in row 4, data from row 5", () => {
  assert.equal(HEADER_ROW, 4);
  assert.equal(FIRST_DATA_ROW, 5);
  assert.deepEqual([...COUNTER_LABELS], ["Total Orders", "Delivered", "Unfulfilled", "Cancelled", "RTO (Returns)"]);
  const f = counterFormulas();
  assert.equal(f.length, 5);
  assert.equal(f[0], "=COUNTA(C5:C)");
  assert.ok(f[2].includes('"Unfulfilled*"') && f[2].includes('"Partially*"'));
  const w = run({ token: "tok123", action: "write", tab: "T", headers: [...SHEET_HEADERS], rows: [["a"], ["b"]] });
  assert.deepEqual(w.writes.formulas, [f]);
  const hit = (r: number, c: number, h: number, wd: number) => w.writes.ranges.some((x) => x.join() === [r, c, h, wd].join());
  assert.ok(hit(2, 1, 1, 5), "counters in row 2");
  assert.ok(hit(4, 1, 1, 27), "header in row 4");
  assert.ok(hit(5, 1, 2, 27), "orders start at row 5");
});

test("7-day counters: the last 7 days first, to the right of the all-time counters", () => {
  const now = new Date(2026, 10, 4, 12); // Wed 4 Nov 2026
  const at = (m: number, day: number) => new Date(2026, m - 1, day, 12);
  const weeks = weeklyCounters([
    { orderDate: at(11, 4), status: "Unfulfilled" }, { orderDate: at(10, 29), status: "Delivered" }, { orderDate: at(10, 28), status: "Cancelled" }, // 29 Oct - 4 Nov
    { orderDate: at(10, 22), status: "RTO" }, // 22 - 28 Oct
    { orderDate: at(10, 21), status: "Delivered" }, // 15 - 21 Oct
    { orderDate: at(9, 1), status: "Delivered" }, // too old for the four windows
  ], now);
  assert.equal(weeks.length, 4);
  assert.equal(weeks[0].label, "Last 7 days · 29 Oct – 04 Nov");
  assert.equal(weeks[1].label, "Previous 7 days · 22 Oct – 28 Oct");
  assert.equal(weeks[2].label, "15 Oct – 21 Oct");
  assert.deepEqual(weeks.map((w) => w.counts), [[2, 1, 1, 0, 0], [2, 0, 0, 1, 1], [1, 1, 0, 0, 0], [0, 0, 0, 0, 0]]);

  const grid = weeklyGrid(weeks);
  assert.equal(grid.length, 3);
  assert.equal(grid[0].length, 20);
  assert.equal(grid[0][0], "Last 7 days · 29 Oct – 04 Nov");
  assert.equal(grid[0][5], "Previous 7 days · 22 Oct – 28 Oct");
  assert.deepEqual(grid[1].slice(0, 5), ["Total", "Delivered", "Unfulfilled", "Cancelled", "RTO"]);
  assert.deepEqual(grid[2].slice(0, 5), [2, 1, 1, 0, 0]);

  const w = run({ token: "tok123", action: "write", tab: "T", headers: [...SHEET_HEADERS], rows: [["a"]], weekly: weeks.map((x) => [x.label, ...x.counts]) });
  assert.equal(w.out.ok, true);
  const at2 = (r: number, c: number, h: number, wd: number) => w.writes.sets.find((x) => x.at.join() === [r, c, h, wd].join());
  assert.deepEqual(at2(3, 7, 1, 5)?.values, [[2, 1, 1, 0, 0]], "the last 7 days' numbers sit in G3:K3");
  assert.deepEqual(at2(3, 12, 1, 5)?.values, [[2, 0, 0, 1, 1]], "the 7 days before sit in L3:P3");
  assert.deepEqual(at2(2, 7, 1, 5)?.values, [["Total", "Delivered", "Unfulfilled", "Cancelled", "RTO"]]);
  assert.equal(w.writes.merges.length, 4, "one merged label cell per week");
  assert.ok(w.writes.ranges.some((r) => r.join() === [4, 1, 1, 27].join()), "the header row is still row 4");
  assert.ok(w.writes.ranges.some((r) => r.join() === [5, 1, 1, 27].join()), "orders still start at row 5");
});
