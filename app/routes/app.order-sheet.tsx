import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useFetcher, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { ExternalLink, Plus, RefreshCw, Sheet, X } from "lucide-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { SHEET_STATUSES, type SheetStatus } from "../lib/order-map";
import { loadOrderSheet } from "../lib/order-sheet-data.server";
import { encryptSecret } from "../lib/secret.server";
import { appsScriptCode, isScriptUrl, parseServiceAccount, spreadsheetIdFrom } from "../lib/google-sheet-format";
import { callScript, prepareSheet, pushOrders, scheduleSheetPush, scriptToken } from "../lib/google-sheets.server";
import { runSync } from "../lib/order-sync.server";
import { useAutoRefresh } from "../components/useAutoRefresh";
import { Badge, Banner, Card, Page } from "../components/ui";
import { ProgressBar } from "../components/ProgressBar";
import { getTask, startTask } from "../lib/progress.server";

const YESNO = ["Yes", "No", "Pending"];
const CALL_STATUS = ["Connected", "Not Picked", "Busy", "Switched Off", "Wrong Number", "Call Back Later"];
const FINAL = ["Confirmed", "Cancelled", "On Hold", "Reschedule", "Pending"];

// Columns live in the exact order requested. `kind` drives the editor; `src` says who owns the value.
type Col = { key: string; label: string; kind: "text" | "date" | "number" | "select" | "readonly" | "status"; opts?: string[]; src: "manual" | "shopify"; w?: number };
const COLS: Col[] = [
  { key: "callDate", label: "Call Date", kind: "date", src: "manual", w: 118 },
  { key: "employeeName", label: "Employee Name", kind: "text", src: "manual", w: 130 },
  { key: "orderName", label: "Order ID", kind: "text", src: "shopify", w: 90 },
  { key: "orderDate", label: "Order Date", kind: "date", src: "shopify", w: 118 },
  { key: "customerName", label: "Customer Name", kind: "text", src: "shopify", w: 150 },
  { key: "productName", label: "Product Name", kind: "text", src: "shopify", w: 240 },
  { key: "qty", label: "Qty", kind: "number", src: "shopify", w: 60 },
  { key: "amount", label: "Order Amount", kind: "number", src: "shopify", w: 110 },
  { key: "paymentType", label: "Payment Type", kind: "text", src: "shopify", w: 110 },
  { key: "primaryMobile", label: "Primary Mobile", kind: "text", src: "shopify", w: 130 },
  { key: "altMobile", label: "Alternate Mobile", kind: "text", src: "manual", w: 130 },
  { key: "fullAddress", label: "Full Address", kind: "text", src: "shopify", w: 280 },
  { key: "landmark", label: "Landmark", kind: "text", src: "manual", w: 140 },
  { key: "city", label: "City", kind: "text", src: "shopify", w: 110 },
  { key: "state", label: "State", kind: "text", src: "shopify", w: 110 },
  { key: "pinCode", label: "PIN Code", kind: "text", src: "shopify", w: 90 },
  { key: "addressConfirmed", label: "Address Confirmed", kind: "select", opts: YESNO, src: "manual", w: 120 },
  { key: "codConfirmed", label: "COD Amount Confirmed", kind: "select", opts: YESNO, src: "manual", w: 130 },
  { key: "deliveryAvailable", label: "Delivery Available", kind: "select", opts: YESNO, src: "manual", w: 120 },
  { key: "customerWants", label: "Customer Wants Order", kind: "select", opts: YESNO, src: "manual", w: 130 },
  { key: "callStatus", label: "Call Status", kind: "select", opts: CALL_STATUS, src: "manual", w: 130 },
  { key: "finalDecision", label: "Final Decision", kind: "select", opts: FINAL, src: "manual", w: 120 },
  { key: "remarks", label: "Remarks", kind: "status", src: "shopify", w: 190 },
  { key: "employeeRemark", label: "Employee Remark", kind: "text", src: "manual", w: 220 },
  { key: "dispatchDate", label: "Dispatch Date", kind: "date", src: "manual", w: 118 },
  { key: "awb", label: "AWB/Tracking No.", kind: "text", src: "manual", w: 150 },
  { key: "deliveryCharges", label: "Delivery Charges", kind: "number", src: "manual", w: 110 },
];

// Writable fields. Shopify-owned columns are only writable on rows added by hand (a sync would overwrite them otherwise).
const MANUAL_FIELDS = new Set(COLS.filter((c) => c.src === "manual").map((c) => c.key));
const ROW_FIELDS = new Set(["orderName", "orderDate", "customerName", "productName", "qty", "amount", "paymentType", "primaryMobile", "fullAddress", "city", "state", "pinCode"]);
const DATE_FIELDS = new Set(["callDate", "dispatchDate", "orderDate"]);
const NUM_FIELDS = new Set(["amount", "deliveryCharges", "qty"]);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const data = await loadOrderSheet(session.shop, new URL(request.url));
  return { ...data, script: appsScriptCode(scriptToken(session.shop)), tasks: [getTask(session.shop, "sync"), getTask(session.shop, "sheet")].filter((t): t is NonNullable<typeof t> => t !== null) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "sync" || intent === "full") {
    void runSync(shop, intent === "full" ? "full" : "auto"); // runs in the background; the page auto-refreshes
    return { ok: true, message: intent === "full" ? "Full history sync started." : "Sync started." };
  }
  if (intent === "gs-connect-script") {
    const url = String(form.get("scriptUrl") ?? "").trim();
    if (!isScriptUrl(url)) return { ok: false, message: "Paste the Web app link Google gave after Deploy (it starts with https://script.google.com/macros/s/ and ends with /exec)." };
    try {
      const pong = await callScript(url, scriptToken(shop), { action: "ping" });
      const data = { spreadsheetId: spreadsheetIdFrom(String(pong.url ?? "")) ?? "apps-script", spreadsheetTitle: String(pong.title ?? ""), saEmail: "apps-script", saKeyEnc: encryptSecret("apps-script"), mode: "script", scriptUrl: url, enabled: true, formatted: false, lastError: null };
      await prisma.googleSheetConfig.upsert({ where: { shop }, create: { shop, ...data }, update: data });
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    startTask(shop, "sheet", "Loading your orders into Google Sheet");
    void pushOrders(shop);
    return { ok: true, message: "Google Sheet connected. Loading your orders into it now…" };
  }
  if (intent === "gs-connect") {
    const sa = parseServiceAccount(String(form.get("key") ?? ""));
    const id = spreadsheetIdFrom(String(form.get("url") ?? ""));
    if (!sa) return { ok: false, message: "That doesn't look like a Google service-account key (the .json file). Paste its full contents." };
    if (!id) return { ok: false, message: "Paste the Google Sheet link (or its ID)." };
    try {
      const t = await prepareSheet(sa.email, sa.privateKey, id);
      const data = { spreadsheetId: id, spreadsheetTitle: t.title, saEmail: sa.email, saKeyEnc: encryptSecret(sa.privateKey), enabled: true, formatted: false, lastError: null };
      await prisma.googleSheetConfig.upsert({ where: { shop }, create: { shop, ...data }, update: data });
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    startTask(shop, "sheet", "Loading your orders into Google Sheet");
    void pushOrders(shop); // first load runs in the background
    return { ok: true, message: "Google Sheet connected. Loading your orders into it now…" };
  }
  if (intent === "gs-push") {
    startTask(shop, "sheet", "Sending orders to Google Sheet");
    void pushOrders(shop);
    return { ok: true, message: "Sending orders to Google Sheet…" };
  }
  if (intent === "gs-disconnect") {
    await prisma.googleSheetConfig.deleteMany({ where: { shop } });
    return { ok: true, message: "Google Sheet disconnected. Your sheet keeps its last data; nothing more is sent." };
  }
  if (intent === "add") {
    await prisma.orderSheet.create({
      data: { shop, shopifyOrderId: `manual-${crypto.randomUUID()}`, isManual: true, orderDate: new Date(), callDate: new Date(), status: "Unfulfilled", remarks: "Unfulfilled" },
    });
    scheduleSheetPush(shop);
    return { ok: true, message: "Row added at the top." };
  }

  const id = String(form.get("id") ?? "");
  const row = await prisma.orderSheet.findFirst({ where: { id, shop } });
  if (!row) return { ok: false, message: "Order not found." };

  if (intent === "delete") {
    if (!row.isManual) return { ok: false, message: "Shopify orders can't be deleted; they sync from your store." };
    await prisma.orderSheet.delete({ where: { id } });
    scheduleSheetPush(shop);
    return { ok: true, message: "Row deleted." };
  }

  if (intent === "edit") {
    const field = String(form.get("field") ?? "");
    const raw = String(form.get("value") ?? "").trim().slice(0, 1000);
    // Only the status of hand-added rows is editable (Shopify rows get it from Shopify).
    if (field === "remarks") {
      if (!row.isManual || !SHEET_STATUSES.includes(raw as SheetStatus)) return { ok: false, message: "Status is managed by Shopify." };
      await prisma.orderSheet.update({ where: { id }, data: { status: raw, remarks: raw } });
      scheduleSheetPush(shop);
      return { ok: true };
    }
    if (!MANUAL_FIELDS.has(field) && !(row.isManual && ROW_FIELDS.has(field))) return { ok: false, message: "This column comes from Shopify and can't be edited." };

    let value: string | number | Date | null = raw || null;
    if (value && DATE_FIELDS.has(field)) {
      const d = new Date(`${raw}T12:00:00Z`);
      if (Number.isNaN(d.getTime())) return { ok: false, message: "Invalid date." };
      value = d;
    } else if (value && NUM_FIELDS.has(field)) {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return { ok: false, message: "Enter a valid number." };
      value = field === "qty" ? Math.round(n) : n;
    }
    if (field === "qty" && value === null) value = 0;
    // Editing an auto-filled column on a Shopify row (alt mobile, dispatch date, AWB, charges) stores the employee's own value.
    await prisma.orderSheet.update({ where: { id }, data: { [field]: value } });
    scheduleSheetPush(shop);
    return { ok: true };
  }
  return { ok: false, message: "Unknown action." };
};

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never");
const money = (n: number | string | null) => (n == null || n === "" ? "" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 }));

function Cell({ row, col }: { row: { id: string; isManual: boolean; v: Record<string, string | number | null> }; col: Col }) {
  const f = useFetcher();
  const raw = row.v[col.key];
  const editable = col.kind !== "readonly" && (col.key === "remarks" ? row.isManual : col.src === "manual" || row.isManual);
  const save = (value: string) => {
    const before = col.kind === "date" ? day(raw as string | null) : String(raw ?? "");
    if (value.trim() === before) return;
    f.submit({ intent: "edit", id: row.id, field: col.key, value }, { method: "post" });
  };

  if (!editable) {
    const text = col.kind === "date" ? day(raw as string | null) : col.key === "amount" ? money(raw) : String(raw ?? "");
    return <span className="os-ro" title={text}>{text}</span>;
  }
  const key = `${row.id}-${col.key}-${raw ?? ""}`;
  if (col.kind === "select" || col.kind === "status") {
    const opts = col.kind === "status" ? [...SHEET_STATUSES] : col.opts!;
    const cur = String(raw ?? "");
    return (
      <select key={key} className="os-in" defaultValue={cur} onChange={(e) => save(e.target.value)} aria-label={col.label}>
        {!cur && <option value="" />}
        {!opts.includes(cur) && cur && <option value={cur}>{cur}</option>}
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return (
    <input
      key={key}
      className="os-in"
      type={col.kind === "date" ? "date" : col.kind === "number" ? "number" : "text"}
      step={col.kind === "number" ? "any" : undefined}
      min={col.kind === "number" ? 0 : undefined}
      defaultValue={col.kind === "date" ? day(raw as string | null) : String(raw ?? "")}
      onBlur={(e) => save(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      aria-label={col.label}
    />
  );
}

export default function OrderSheet() {
  const d = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  useAutoRefresh(d.tasks.some((t) => t.running) ? 1500 : 20000);

  const link = (patch: Record<string, string>) => {
    const p = new URLSearchParams({ q: d.q, status: d.status, page: String(d.page), period: d.kind, from: d.from, to: d.to, ...patch });
    for (const [k, v] of [...p]) if (!v || (k === "page" && v === "1") || (k === "period" && v === "week")) p.delete(k);
    return `?${p.toString()}`;
  };
  const cards: [string, number, string][] = [
    ["Total Orders", d.counts.total, ""],
    ["Delivered", d.counts.Delivered, "Delivered"],
    ["Unfulfilled", d.counts.Unfulfilled, "Unfulfilled"],
    ["Cancelled", d.counts.Cancelled, "Cancelled"],
    ["RTO (Returns)", d.counts.RTO, "RTO"],
  ];
  const fulfilledOnly = d.counts.Fulfilled;

  return (
    <Page
      title="Order Update"
      subtitle="Order calling sheet: Shopify orders sync automatically; call details and employee remarks stay yours."
      actions={
        <>
          <Form method="post"><button name="intent" value="add" className="ghost" disabled={busy}><Plus size={14} style={{ verticalAlign: -2 }} /> Add row</button></Form>
          <Form method="post"><button name="intent" value="sync" disabled={busy}><RefreshCw size={14} style={{ verticalAlign: -2 }} /> Sync now</button></Form>
          <Form method="post" onSubmit={(e) => { if (!window.confirm("Re-read the complete order history from Shopify? Your call details and remarks are not touched.")) e.preventDefault(); }}>
            <button name="intent" value="full" className="ghost" disabled={busy}>Full resync</button>
          </Form>
        </>
      }
    >
      {result && "message" in result && result.message && <Banner tone={result.ok ? "success" : "critical"}>{result.message}</Banner>}
      {d.tasks.length > 0 && (
        <div className="pbar-box" aria-live="polite">
          {d.tasks.map((t) => (
            <ProgressBar
              key={t.id}
              label={t.running ? t.label : t.error ? `Failed: ${t.error}` : `${t.label}: done`}
              done={t.done}
              total={t.total}
              running={t.running}
              tone={t.error ? "bad" : t.running ? undefined : "ok"}
              detail={t.running && t.id === "sync" ? "You can keep working; the orders appear here as they are read." : undefined}
            />
          ))}
        </div>
      )}
      {d.sync?.lastError && <Banner tone="critical">Last sync failed: {d.sync.lastError}. Existing rows are untouched; it retries automatically every 5 minutes.</Banner>}
      {d.everything === 0 && !d.sync?.lastSyncAt && <Banner tone="info">First sync is running. Your Shopify orders will appear here in a moment.</Banner>}

      <Card
        title="Google Sheet"
        action={d.gsheet ? <Badge tone={d.gsheet.lastError ? "critical" : "success"}>{d.gsheet.lastError ? "Needs attention" : "Connected"}</Badge> : <Badge tone="warning">Not connected</Badge>}
      >
        {d.gsheet ? (
          <>
            <p className="o-p">
              <Sheet size={14} style={{ verticalAlign: -2 }} />{" "}
              {d.gsheet.id.length > 20 ? (
                <a href={`https://docs.google.com/spreadsheets/d/${d.gsheet.id}/edit`} target="_blank" rel="noreferrer noopener">
                  {d.gsheet.title || "Open Google Sheet"} <ExternalLink size={12} style={{ verticalAlign: -1 }} />
                </a>
              ) : (
                <b>{d.gsheet.title || "Google Sheet"}</b>
              )}
              {" · "}
              {d.gsheet.lastPushAt ? <>last update {when(d.gsheet.lastPushAt)}, {d.gsheet.rows.toLocaleString()} orders</> : "first load in progress…"}
            </p>
            <p className="o-muted" style={{ margin: "0 0 10px" }}>
              Every new order, Shopify change and edit made here is sent to the sheet automatically (within about 15 seconds). Please edit in this app: the sheet is overwritten with the app&apos;s data on each update.
            </p>
            {d.gsheet.lastError && <Banner tone="critical">{d.gsheet.lastError}</Banner>}
            <div className="o-row">
              <Form method="post"><button name="intent" value="gs-push" disabled={busy}>Send to Google Sheet now</button></Form>
              <Form method="post" onSubmit={(e) => { if (!window.confirm("Disconnect the Google Sheet? Nothing is deleted from the sheet.")) e.preventDefault(); }}>
                <button name="intent" value="gs-disconnect" className="danger" disabled={busy}>Disconnect</button>
              </Form>
            </div>
          </>
        ) : (
          <>
            <p className="o-p"><b>Easy way (recommended):</b> no Google Cloud, no key file. You paste a small script into your own sheet.</p>
            <ol className="o-p" style={{ paddingLeft: 18, margin: "0 0 12px" }}>
              <li>Open your Google Sheet. Click <b>Extensions → Apps Script</b>.</li>
              <li>Delete everything in the editor, paste the script below, then press <b>Ctrl+S</b>.</li>
              <li>Click <b>Deploy → New deployment</b>. Gear icon → <b>Web app</b>. Set <b>Execute as: Me</b> and <b>Who has access: Anyone</b>. Click <b>Deploy</b>, then <b>Authorize access</b> and allow it.</li>
              <li>Copy the <b>Web app URL</b> and paste it in the box below.</li>
            </ol>
            <label className="o-field"><span>Script to paste into Apps Script</span>
              <textarea readOnly rows={5} value={d.script} spellCheck={false} onFocus={(e) => e.target.select()} style={{ fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12 }} />
            </label>
            <Form method="post">
              <label className="o-field"><span>Web app URL</span>
                <input name="scriptUrl" placeholder="https://script.google.com/macros/s/…/exec" style={{ width: "100%" }} autoComplete="off" required />
              </label>
              <button name="intent" value="gs-connect-script" disabled={busy}>Connect Google Sheet</button>
            </Form>
            <details style={{ marginTop: 16 }}>
              <summary>Other way: service account key (Google Cloud)</summary>
              <Form method="post" style={{ marginTop: 10 }}>
                <ol className="o-p" style={{ paddingLeft: 18, margin: "0 0 12px" }}>
                  <li>In Google Cloud, enable the <b>Google Sheets API</b>, create a <b>Service Account</b> and download its <b>JSON key</b>.</li>
                  <li>Share your Google Sheet with the service account&apos;s email (the <code>client_email</code> in the JSON) as <b>Editor</b>.</li>
                  <li>Paste the sheet link and the JSON key below.</li>
                </ol>
                <label className="o-field"><span>Google Sheet link</span>
                  <input name="url" placeholder="https://docs.google.com/spreadsheets/d/…" style={{ width: "100%" }} autoComplete="off" required />
                </label>
                <label className="o-field"><span>Service account JSON key (stored encrypted, never shown again)</span>
                  <textarea name="key" rows={4} placeholder='{ "type": "service_account", "client_email": "…", "private_key": "…" }' autoComplete="off" spellCheck={false} required />
                </label>
                <button name="intent" value="gs-connect" disabled={busy}>Connect with key</button>
              </Form>
            </details>
          </>
        )}
      </Card>

      <div className="d-kpis os-kpis">
        {cards.map(([label, n, st]) => (
          <Link key={label} to={link({ status: st === d.status ? "" : st, page: "1" })} className={`d-kpi os-kpi ${st ? `st-${st}` : ""}${st && st === d.status ? " on" : ""}`} preventScrollReset>
            <div className="d-kpi-label">{label}</div>
            <div className="d-kpi-value">{n.toLocaleString()}</div>
          </Link>
        ))}
      </div>
      <p className="o-muted os-note">
        {d.from || d.to ? <>Counts are for orders placed {d.from ? `from ${d.from} ` : ""}{d.to ? `to ${d.to}` : ""}{d.q ? ` matching “${d.q}”` : ""}.</> : d.q ? <>Counts are for orders matching “{d.q}”.</> : <>Counts cover all {d.counts.total.toLocaleString()} synced orders.</>}{" "}
        Each order is in one status only. Fulfilled but not yet delivered: {fulfilledOnly}.
        {d.sync?.lastSyncAt && <> Last sync {when(d.sync.lastSyncAt)}.</>}
      </p>

      <Card
        title={`Counters by ${d.kind}`}
        action={
          <div className="d-range" role="group" aria-label="Group counters by">
            {([["day", "Daily"], ["week", "Weekly"], ["month", "Monthly"], ["year", "Yearly"]] as const).map(([k, label]) => (
              <Link key={k} to={link({ period: k, page: "1" })} className={d.kind === k ? "on" : ""} preventScrollReset>{label}</Link>
            ))}
          </div>
        }
      >
        <p className="o-muted os-note" style={{ margin: "0 0 10px" }}>
          Orders are grouped by the date they were placed. The status is each order&apos;s status right now.{d.kind === "week" ? " Weeks run Monday to Sunday." : ""} Click a row to list just those orders.
        </p>
        <div className="os-scroll">
          <table className="os-periods">
            <thead>
              <tr><th>{d.kind === "day" ? "Day" : d.kind === "week" ? "Week" : d.kind === "month" ? "Month" : "Year"}</th><th>Total Orders</th><th>Delivered</th><th>Unfulfilled</th><th>Cancelled</th><th>RTO</th></tr>
            </thead>
            <tbody>
              {d.periods.map((r) => {
                const on = d.from === r.from && d.to === r.to;
                return (
                  <tr key={r.key} className={`${r.current ? "cur" : ""}${on ? " on" : ""}`}>
                    <td><Link to={link({ from: on ? "" : r.from, to: on ? "" : r.to, status: "", page: "1" })} preventScrollReset>{r.label}</Link>{r.current && <span className="os-now">now</span>}</td>
                    <td><b>{r.total}</b></td>
                    <td className="c-Delivered">{r.Delivered}</td>
                    <td className="c-Unfulfilled">{r.Unfulfilled}</td>
                    <td className="c-Cancelled">{r.Cancelled}</td>
                    <td className="c-RTO">{r.RTO}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="os-bar">
        <Form method="get" className="o-row">
          <input name="q" defaultValue={d.q} placeholder="Search order, name, mobile, product, AWB" aria-label="Search orders" style={{ width: 300 }} />
          {d.status && <input type="hidden" name="status" value={d.status} />}
          {d.kind !== "week" && <input type="hidden" name="period" value={d.kind} />}
          {d.from && <input type="hidden" name="from" value={d.from} />}
          {d.to && <input type="hidden" name="to" value={d.to} />}
          <button className="ghost">Search</button>
          {(d.q || d.status || d.from || d.to) && <Link to={link({ q: "", status: "", from: "", to: "", page: "1" })}>Clear</Link>}
        </Form>
        <div className="os-legend">
          {SHEET_STATUSES.map((s) => <span key={s}><i className={`st-${s}`} />{s}</span>)}
        </div>
      </div>

      <div className="os-wrap" role="region" aria-label="Order calling sheet">
        <table className="os">
          <thead>
            <tr>
              {COLS.map((c) => <th key={c.key} style={{ minWidth: c.w }}>{c.label}</th>)}
              <th aria-label="Row actions" style={{ minWidth: 36 }} />
            </tr>
          </thead>
          <tbody>
            {d.rows.length === 0 && (
              <tr><td colSpan={COLS.length + 1} className="d-empty">No orders to show.</td></tr>
            )}
            {d.rows.map((r) => (
              <tr key={r.id} className={`os-row st-${r.status}`}>
                {COLS.map((c) => (
                  <td key={c.key}><Cell row={r} col={c} /></td>
                ))}
                <td>
                  {r.isManual && (
                    <Form method="post" onSubmit={(e) => { if (!window.confirm("Delete this row?")) e.preventDefault(); }}>
                      <input type="hidden" name="id" value={r.id} />
                      <button name="intent" value="delete" className="o-icon" aria-label="Delete row" title="Delete row"><X size={14} /></button>
                    </Form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {d.pages > 1 && (
        <div className="o-row" style={{ marginTop: 12, justifyContent: "space-between" }}>
          <span className="o-muted">Page {d.page} of {d.pages} · {d.listed.toLocaleString()} orders</span>
          <div className="o-row">
            {d.page > 1 && <Link to={link({ page: String(d.page - 1) })}>← Newer</Link>}
            {d.page < d.pages && <Link to={link({ page: String(d.page + 1) })}>Older →</Link>}
          </div>
        </div>
      )}
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
