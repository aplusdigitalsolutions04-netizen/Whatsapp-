import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, Bot, CheckCircle2, ClipboardList, MessagesSquare, Minus, PackageSearch,
  Phone, ScanSearch, ShoppingBag, Smartphone, Users, WandSparkles, type LucideIcon,
} from "lucide-react";
import { authenticate } from "../shopify.server";
import { loadDashboardData } from "../lib/dashboard-data.server";
import { activeProvider, bridgeStatus } from "../lib/bridge.server";
import { testShopifyConnection } from "../lib/shopify-data.server";
import { whatsappConfig } from "../lib/whatsapp.server";
import { pool } from "../lib/image/pool.server";
import { useAutoRefresh } from "../components/useAutoRefresh";
import { Donut, Spark, StackedBars } from "../components/charts";
import { imsConfig } from "../lib/order-sources";
import { Badge, Card, Page } from "../components/ui";

const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T) => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const asked = Number(new URL(request.url).searchParams.get("range"));
  const range = [7, 14, 30].includes(asked) ? asked : 14;

  const [data, shopify] = await Promise.all([
    loadDashboardData(shop, range),
    withTimeout(testShopifyConnection(shop), 6000, { ok: false as const, error: "Shopify did not answer in time" }),
  ]);
  const provider = activeProvider();
  const bridge = bridgeStatus();
  const wa = whatsappConfig();
  const whatsapp = {
    provider,
    ready: provider === "qr" ? bridge.state === "connected" : wa.accessToken && wa.phoneNumberId && wa.verifyToken && wa.appSecret,
    number: provider === "qr" ? bridge.number : null,
  };
  const imsLinked = {
    lookup: imsConfig() !== null,
    send: (process.env.IMS_API_KEY ?? "").length >= 24 && provider === "qr",
  };
  return { shop, data, imsLinked, imagePool: pool.stats(), shopify: shopify.ok ? { ok: true as const } : { ok: false as const, error: shopify.error }, whatsapp };
};

// ---------- helpers ----------
const ago = (iso: string | null) => {
  if (!iso) return "never";
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const money = (n: number | null, cur: string | null) =>
  n == null ? "" : new Intl.NumberFormat("en-IN", cur ? { style: "currency", currency: cur, maximumFractionDigits: 0 } : { maximumFractionDigits: 0 }).format(n);

function Delta({ v, suffix = "%", invert = false }: { v: number; suffix?: string; invert?: boolean }) {
  const good = invert ? v < 0 : v > 0;
  const bad = invert ? v > 0 : v < 0;
  const Icon = v > 0 ? ArrowUpRight : v < 0 ? ArrowDownRight : Minus;
  return (
    <span className={`db-delta ${good ? "up" : bad ? "down" : "flat"}`}>
      <Icon size={11} />
      {Math.abs(v)}{suffix}
    </span>
  );
}

function Kpi({ icon: Icon, label, value, foot, hue }: { icon: LucideIcon; label: string; value: React.ReactNode; foot: React.ReactNode; hue: string }) {
  return (
    <div className={`db-kpi ${hue}`}>
      <span className="db-kpi-ico"><Icon size={18} /></span>
      <div className="db-kpi-label">{label}</div>
      <div className="db-kpi-value">{value}</div>
      <div className="db-kpi-foot">{foot}</div>
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = { Unfulfilled: "#e0963a", Fulfilled: "#5b9a63", Delivered: "#3f7fa8", Cancelled: "#c4584d", RTO: "#8a5a9a" };
const PAY_COLOR = ["#80664f", "#a58e78", "#d8c7b2", "#c2a98c"];

const GUIDE: { to: string; icon: LucideIcon; title: string; text: string }[] = [
  { to: "/app/conversations", icon: MessagesSquare, title: "Live Inbox", text: "All WhatsApp chats. The bot replies; you can take over any chat." },
  { to: "/app/enquiries", icon: PackageSearch, title: "Product Enquiries", text: "Which number asked for which product, and whether you had it." },
  { to: "/app/order-sheet", icon: ClipboardList, title: "Order Update", text: "Calling sheet for Shopify orders, synced live and mirrored to Google Sheet." },
  { to: "/app/product-scrapper", icon: ScanSearch, title: "Product Scrapper", text: "Finds new in-stock products on other sites, skipping what you already sell." },
  { to: "/app/image-editor", icon: WandSparkles, title: "Image Editor", text: "Bulk product photos: remove backgrounds, resize, compress. You choose how many workers." },
  { to: "/app/quick-replies", icon: Bot, title: "Auto Replies", text: "Ready answers for common questions in English, Hindi and Hinglish." },
  { to: "/app/settings", icon: Smartphone, title: "Bot Settings", text: "Switch the bot on or off, edit its messages, add optional AI." },
];

export default function Dashboard() {
  const { data: d, shopify, whatsapp, imagePool, imsLinked } = useLoaderData<typeof loader>();
  useAutoRefresh(20000);
  const k = d.kpi;

  // What needs the owner's attention right now (each item links to where it is fixed).
  type Todo = { tone: "bad" | "warn"; title: string; text: string; to: string };
  const todo: Todo[] = [];
  if (!whatsapp.ready) todo.push({ tone: "bad", title: "WhatsApp is not connected", text: "The bot cannot reply to customers until it is linked.", to: whatsapp.provider === "qr" ? "/app/whatsapp-web" : "/app/integrations" });
  if (!shopify.ok) todo.push({ tone: "bad", title: "Shopify connection problem", text: shopify.error ?? "Check the Shopify connection.", to: "/app/integrations" });
  if (!d.system.botEnabled) todo.push({ tone: "warn", title: "Automated replies are off", text: "Customers get no bot answers while this is off.", to: "/app/settings" });
  if (d.pending.waitingHuman > 0) todo.push({ tone: "warn", title: `${d.pending.waitingHuman} chat${d.pending.waitingHuman > 1 ? "s" : ""} waiting for you`, text: "Customers handed over to a human.", to: "/app/conversations?filter=human" });
  if (d.pending.uncalled > 0) todo.push({ tone: "warn", title: `${d.pending.uncalled} unfulfilled order${d.pending.uncalled > 1 ? "s" : ""} not called yet`, text: "No call status has been filled for them.", to: "/app/order-sheet?status=Unfulfilled" });
  if (d.pending.unavailableAsked > 0) todo.push({ tone: "warn", title: `Customers asked for ${d.pending.unavailableAsked} product${d.pending.unavailableAsked > 1 ? "s" : ""} you don't have`, text: "See which ones in Product Enquiries.", to: "/app/enquiries?filter=missing" });
  if (d.pending.imageFailed > 0) todo.push({ tone: "warn", title: `${d.pending.imageFailed} photo${d.pending.imageFailed > 1 ? "s" : ""} failed in Image Editor`, text: "Open the batch and press Retry.", to: "/app/image-editor?show=failed" });
  if (d.pending.imageStopped > 0) todo.push({ tone: "warn", title: `${d.pending.imageStopped} image batch${d.pending.imageStopped > 1 ? "es are" : " is"} stopped`, text: "Press Resume to finish the waiting photos.", to: "/app/image-editor" });
  if (d.pending.failedMessages > 0) todo.push({ tone: "bad", title: `${d.pending.failedMessages} message${d.pending.failedMessages > 1 ? "s" : ""} failed to send`, text: "In the selected period.", to: "/app/logs" });
  if (d.pending.failedEvents > 0) todo.push({ tone: "bad", title: `${d.pending.failedEvents} incoming event${d.pending.failedEvents > 1 ? "s" : ""} failed`, text: "Open Activity Logs and press Retry.", to: "/app/logs" });
  if (d.system.sync?.lastError) todo.push({ tone: "bad", title: "Order sync is failing", text: d.system.sync.lastError, to: "/app/order-sheet" });
  if (d.system.sheet?.lastError) todo.push({ tone: "bad", title: "Google Sheet update failed", text: d.system.sheet.lastError, to: "/app/order-sheet" });

  const days = d.days as unknown as Record<string, number | string>[];
  const dayLabel = (x: Record<string, number | string>) => String(x.day).slice(5).replace("-", "/");
  const every = d.range > 14 ? 3 : d.range > 7 ? 2 : 1;
  const hours = d.hours as unknown as Record<string, number | string>[];
  const peak = d.hours.reduce((a, b) => (b.count > a.count ? b : a), d.hours[0]);
  const orderSegments = Object.entries(d.orders.status).map(([label, value]) => ({ label, value, color: STATUS_COLOR[label] }));
  const callMax = Math.max(1, ...d.orders.calls.map((c) => c.count));
  const cur = k.revenue.currency;
  const ser = (key: "orders" | "revenue" | "incoming" | "outgoing") => d.days.map((x) => x[key]);

  const pulse = [
    { label: "Revenue", value: cur ? money(k.revenue.value, cur) : k.revenue.value.toLocaleString(), change: k.revenue.change, foot: `${k.avgOrder ? `${money(k.avgOrder, cur)} per order` : "No orders yet"}`, series: ser("revenue"), color: "#367b49" },
    { label: "Orders", value: k.newOrders.value.toLocaleString(), change: k.newOrders.change, foot: `${d.orders.deliveredRate}% delivered · ${d.orders.rtoRate}% returned`, series: ser("orders"), color: "#bd7620" },
    { label: "Customer messages", value: k.received.value.toLocaleString(), change: k.received.change, foot: `${k.newChats.value} new chats · ${k.customers.value} customers`, series: ser("incoming"), color: "#4f84b3" },
    { label: "Handled by bot", value: `${k.automation.value}%`, change: k.automation.value - k.automation.prev, foot: `${k.handoffs.value} handed to a human`, series: ser("outgoing"), color: "#6d4f96" },
  ];

  const tone = (bad: boolean, warn = false) => (bad ? "bad" : warn ? "warn" : "ok");
  const imsOn = imsLinked.lookup || imsLinked.send;
  type Mod = { to: string; icon: LucideIcon; title: string; state: string; tone: string; nums: [string, string][] };
  const modules: Mod[] = [
    { to: "/app/conversations", icon: MessagesSquare, title: "Live Inbox", state: d.pending.waitingHuman ? `${d.pending.waitingHuman} waiting for you` : "No chat waiting", tone: tone(false, d.pending.waitingHuman > 0),
      nums: [[String(d.conversations.bot), "with bot"], [String(d.conversations.human), "with you"]] },
    { to: "/app/settings", icon: Bot, title: "WhatsApp Bot", state: !whatsapp.ready ? "WhatsApp offline" : d.system.botEnabled ? "Replying automatically" : "Replies are off", tone: tone(!whatsapp.ready, !d.system.botEnabled),
      nums: [[`${k.automation.value}%`, "by bot"], [String(d.bot.faqEnabled), "auto replies"]] },
    { to: "/app/enquiries", icon: PackageSearch, title: "Product Enquiries", state: `${k.enquiries.availability}% were in stock`, tone: tone(false, d.pending.unavailableAsked > 0),
      nums: [[String(k.enquiries.value), "asked"], [String(d.pending.unavailableAsked), "missing"]] },
    { to: "/app/order-sheet", icon: ClipboardList, title: "Order Update", state: d.system.sync?.lastError ? "Sync failing" : `Synced ${ago(d.system.sync?.lastSyncAt ?? null)}`, tone: tone(!!d.system.sync?.lastError, !d.system.sync?.lastSyncAt),
      nums: [[String(d.orders.total), "orders"], [String(d.pending.uncalled), "to call"]] },
    { to: "/app/image-editor", icon: WandSparkles, title: "Image Editor", state: d.images.active ? `Batch ${d.images.active.status}` : "Idle", tone: tone(d.pending.imageFailed > 0, d.pending.imageStopped > 0),
      nums: [[String(d.images.done.value), "photos"], [String(d.images.applied), "in store"]] },
    { to: "/app/product-scrapper", icon: ScanSearch, title: "Product Scrapper", state: d.system.finder ? `Last run ${ago(d.system.finder.at)}` : "Not used yet", tone: d.system.finder?.status === "error" ? "bad" : "ok",
      nums: [[String(d.system.finder?.found ?? 0), "new found"], [String(d.system.finder?.skipped ?? 0), "in store"]] },
    { to: "/app/integrations", icon: Smartphone, title: "IMS link", state: imsOn ? [imsLinked.lookup && "orders", imsLinked.send && "messages"].filter(Boolean).join(" + ") + " connected" : "Not set up", tone: imsOn ? (d.ims.lookupFailures ? "warn" : "ok") : "mute",
      nums: [[String(d.ims.lookupsIms), "IMS orders"], [String(d.ims.sent.value), "sent by IMS"]] },
    { to: "/app/order-sheet", icon: ShoppingBag, title: "Google Sheet", state: d.system.sheet ? (d.system.sheet.lastError ? "Update failed" : `Updated ${ago(d.system.sheet.lastPushAt)}`) : "Not connected", tone: d.system.sheet ? tone(!!d.system.sheet.lastError) : "mute",
      nums: [[String(d.system.sheet?.rows ?? 0), "rows sent"]] },
  ];

  return (
    <Page
      title="Dashboard"
      subtitle="A live view of your WhatsApp bot, your orders and what customers are asking for."
      actions={
        <div className="d-range" role="group" aria-label="Period">
          {[7, 14, 30].map((r) => (
            <Link key={r} to={`?range=${r}`} className={d.range === r ? "on" : ""} preventScrollReset>Last {r} days</Link>
          ))}
        </div>
      }
    >
      {/* needs attention */}
      <section className={`db-attn ${todo.length ? "" : "ok"}`} aria-label="Needs attention">
        <div className="db-attn-head">
          {todo.length ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}
          <b>{todo.length ? `Needs your attention (${todo.length})` : "All clear"}</b>
          {!todo.length && <span>Nothing is waiting for you right now.</span>}
        </div>
        {todo.length > 0 && (
          <ul>
            {todo.map((t) => (
              <li key={t.title}>
                <Link to={t.to} className={t.tone}>
                  <span className="db-dot" />
                  <span className="db-attn-main"><b>{t.title}</b><span>{t.text}</span></span>
                  <ArrowRight size={14} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* system status */}
      <div className="db-status">
        <span className={`db-chip ${whatsapp.ready ? "ok" : "bad"}`}><Smartphone size={13} /> WhatsApp {whatsapp.ready ? `connected${whatsapp.number ? ` (+${whatsapp.number})` : ""}` : "offline"}</span>
        <span className={`db-chip ${shopify.ok ? "ok" : "bad"}`}><ShoppingBag size={13} /> Shopify {shopify.ok ? "connected" : "problem"}</span>
        <span className={`db-chip ${d.system.botEnabled ? "ok" : "warn"}`}><Bot size={13} /> Bot {d.system.botEnabled ? "on" : "off"}{d.system.aiEnabled ? " · AI on" : ""}</span>
        <span className={`db-chip ${d.system.sync?.lastError ? "bad" : d.system.sync?.lastSyncAt ? "ok" : "warn"}`}><ClipboardList size={13} /> Orders synced {ago(d.system.sync?.lastSyncAt ?? null)}</span>
        <span className={`db-chip ${d.system.sheet ? (d.system.sheet.lastError ? "bad" : "ok") : "mute"}`}>
          {d.system.sheet ? `Google Sheet updated ${ago(d.system.sheet.lastPushAt)}` : "Google Sheet not connected"}
        </span>
      </div>

      {/* headline numbers */}
      <div className="db-pulse">
        {pulse.map((p) => (
          <div key={p.label} className="db-pulse-item">
            <div className="db-pulse-top">
              <span>{p.label}</span>
              <Delta v={p.change} />
            </div>
            <b>{p.value}</b>
            <small>{p.foot}</small>
            <Spark values={p.series} color={p.color} />
          </div>
        ))}
      </div>

      {/* every feature at a glance */}
      <section className="db-modules" aria-label="Features">
        {modules.map((m) => {
          const Icon = m.icon;
          return (
            <Link key={m.to} to={m.to} className="db-mod">
              <span className="db-mod-ico"><Icon size={17} /></span>
              <span className="db-mod-main">
                <span className="db-mod-title"><b>{m.title}</b><i className={`db-pip ${m.tone}`} title={m.state} /></span>
                <span className="db-mod-state">{m.state}</span>
                <span className="db-mod-nums">
                  {m.nums.map(([n, l]) => <span key={l}><b>{n}</b>{l}</span>)}
                </span>
              </span>
            </Link>
          );
        })}
      </section>

      {/* KPIs */}
      <div className="db-kpis">
        <Kpi icon={Users} hue="k1" label="Customers who wrote" value={k.customers.value.toLocaleString()}
          foot={<><Delta v={k.customers.change} /> vs previous {d.range} days</>} />
        <Kpi icon={MessagesSquare} hue="k2" label="Messages received" value={k.received.value.toLocaleString()}
          foot={<><Delta v={k.received.change} /> {k.replies.value.toLocaleString()} replies sent</>} />
        <Kpi icon={Bot} hue="k3" label="Answered by the bot" value={`${k.automation.value}%`}
          foot={<>{k.automation.bot} bot vs {k.automation.agent} human replies</>} />
        <Kpi icon={PackageSearch} hue="k4" label="Product enquiries" value={k.enquiries.value.toLocaleString()}
          foot={<><Delta v={k.enquiries.change} /> {k.enquiries.availability}% were in stock</>} />
        <Kpi icon={Phone} hue="k5" label="Order lookups by bot" value={k.ordersShared.value.toLocaleString()}
          foot={<><Delta v={k.ordersShared.change} /> {k.verifyFailed} failed verification</>} />
        <Kpi icon={WandSparkles} hue="k7" label="Photos processed" value={d.images.done.value.toLocaleString()}
          foot={<><Delta v={d.images.done.change} /> {d.images.savedPercent ? `files ${d.images.savedPercent}% smaller` : "in Image Editor"}</>} />
        <Kpi icon={ShoppingBag} hue="k6" label="New orders" value={k.newOrders.value.toLocaleString()}
          foot={<><Delta v={k.newOrders.change} /> {k.newOrders.currency ? `worth ${money(k.newOrders.amount, k.newOrders.currency)}` : "in this period"}</>} />
      </div>

      {/* messages + demand */}
      <div className="db-row two">
        <Card title="Customer messages per day" action={<div className="db-legend"><span><i style={{ background: "#80664f" }} />Received</span><span><i style={{ background: "#d8c7b2" }} />Sent</span></div>}>
          <StackedBars data={days} every={every} label={dayLabel}
            series={[{ key: "incoming", label: "Received", color: "#80664f" }, { key: "outgoing", label: "Sent", color: "#d8c7b2" }]} />
        </Card>
        <Card title="What customers ask for" action={<div className="db-legend"><span><i style={{ background: "#5b9a63" }} />You had it</span><span><i style={{ background: "#c4584d" }} />Unavailable</span></div>}>
          <StackedBars data={days} every={every} label={dayLabel}
            series={[{ key: "found", label: "You had it", color: "#5b9a63" }, { key: "missing", label: "Unavailable", color: "#c4584d" }]} />
        </Card>
      </div>

      {/* sales + bot performance */}
      <div className="db-row two">
        <Card title="Orders and sales per day" action={<div className="db-legend"><span><i style={{ background: "#bd7620" }} />Orders</span>{cur && <span>Sales {money(k.revenue.value, cur)}</span>}</div>}>
          <StackedBars data={days} every={every} label={(x) => `${dayLabel(x)} · ${cur ? money(Number(x.revenue), cur) : x.revenue}`}
            series={[{ key: "orders", label: "Orders", color: "#bd7620" }]} />
          {d.orders.cities.length > 0 && (
            <p className="db-note">Top cities: {d.orders.cities.map((c) => `${c.city} (${c.count})`).join(" · ")}</p>
          )}
        </Card>
        <Card title="What the bot did" action={<Link to="/app/quick-replies">Auto replies</Link>}>
          <ul className="db-bars">
            {d.bot.answers.map((a) => (
              <li key={a.label}>
                <div><Link to={a.to}>{a.label}</Link><b>{a.value.toLocaleString()}</b></div>
                <em><i style={{ width: `${Math.round((a.value / Math.max(1, ...d.bot.answers.map((x) => x.value))) * 100)}%`, background: a.label === "Handed to a human" ? "#e0963a" : "#80664f" }} /></em>
              </li>
            ))}
          </ul>
          <p className="db-note">
            {d.bot.faqEnabled} of {d.bot.faqTotal} auto replies on · {d.bot.recommendations} product suggestions sent
            {d.bot.languages.length ? ` · chats in ${d.bot.languages.map((l) => `${l.lang === "hi" ? "Hindi" : "English"} ${l.count}`).join(", ")}` : ""}
          </p>
        </Card>
      </div>

      {/* IMS */}
      <Card title="IMS connection" action={<Link to="/app/settings">Bot settings</Link>}>
        <div className="db-ims">
          <div>
            <span className={`db-chip ${imsLinked.lookup ? "ok" : "mute"}`}>{imsLinked.lookup ? "Order search in IMS: on" : "Order search in IMS: off"}</span>
            <span className={`db-chip ${imsLinked.send ? "ok" : "mute"}`}>{imsLinked.send ? "Messages from IMS: on" : "Messages from IMS: off"}</span>
          </div>
          <ul className="db-facts">
            <li><span>Orders found in Shopify</span><b>{d.ims.lookupsShopify}</b></li>
            <li><span>Orders found in IMS</span><b>{d.ims.lookupsIms}</b></li>
            <li><span>Lookups that failed</span><b>{d.ims.lookupFailures}</b></li>
            <li><span>Messages sent by IMS</span><b>{d.ims.sent.value} <Delta v={d.ims.sent.change} /></b></li>
          </ul>
          {!imsLinked.lookup && <p className="db-note" style={{ border: 0, margin: 0, paddingTop: 0 }}>To search orders in the IMS too, set IMS_BASE_URL and IMS_LOOKUP_KEY in the .env file (see docs/ims-integration.md).</p>}
        </div>
      </Card>

      {/* hours + conversations */}
      <div className="db-row two">
        <Card title="When customers write" action={<span className="o-muted">{peak.count ? `Busiest around ${String(peak.hour).padStart(2, "0")}:00` : ""}</span>}>
          <StackedBars data={hours} every={3} height={170} label={(x) => `${String(x.hour).padStart(2, "0")}:00`} series={[{ key: "count", label: "Messages", color: "#a58e78" }]} />
        </Card>
        <Card title="Conversations right now" action={<Link to="/app/conversations">Open inbox</Link>}>
          <div className="db-donut">
            <Donut centerLabel="open + closed" segments={[
              { label: "Bot is handling", value: d.conversations.bot, color: "#80664f" },
              { label: "Waiting for a human", value: d.conversations.human, color: "#e0963a" },
              { label: "Closed", value: d.conversations.closed, color: "#d8c7b2" },
            ]} />
            <ul className="db-keys">
              <li><i style={{ background: "#80664f" }} />Bot is handling<b>{d.conversations.bot}</b></li>
              <li><i style={{ background: "#e0963a" }} />Waiting for a human<b>{d.conversations.human}</b></li>
              <li><i style={{ background: "#d8c7b2" }} />Closed<b>{d.conversations.closed}</b></li>
            </ul>
          </div>
        </Card>
      </div>

      {/* orders */}
      <Card title={`Orders (${d.orders.total.toLocaleString()} synced from Shopify)`} action={<Link to="/app/order-sheet">Open order sheet</Link>}>
        {d.orders.total === 0 ? (
          <p className="db-empty">No orders synced yet. They appear here after the first Shopify sync.</p>
        ) : (
          <>
            <div className="db-seg" role="img" aria-label="Order status split">
              {orderSegments.filter((s) => s.value > 0).map((s) => (
                <i key={s.label} style={{ flex: s.value, background: s.color }} title={`${s.label}: ${s.value}`} />
              ))}
            </div>
            <ul className="db-seg-keys">
              {orderSegments.map((s) => (
                <li key={s.label}><Link to={`/app/order-sheet?status=${s.label}`}><i style={{ background: s.color }} />{s.label}<b>{s.value}</b></Link></li>
              ))}
            </ul>
            <div className="db-row three inner">
              <div>
                <h4>How customers pay</h4>
                {d.orders.payment.length === 0 ? <p className="db-empty">No payment data yet.</p> : (
                  <div className="db-donut small">
                    <Donut centerLabel="orders" segments={d.orders.payment.map((p, i) => ({ label: p.type, value: p.count, color: PAY_COLOR[i % PAY_COLOR.length] }))} />
                    <ul className="db-keys">
                      {d.orders.payment.map((p, i) => <li key={p.type}><i style={{ background: PAY_COLOR[i % PAY_COLOR.length] }} />{p.type}<b>{p.count}</b></li>)}
                    </ul>
                  </div>
                )}
              </div>
              <div>
                <h4>Calling progress (unfulfilled orders)</h4>
                {d.orders.calls.length === 0 ? <p className="db-empty">No unfulfilled orders.</p> : (
                  <ul className="db-bars">
                    {d.orders.calls.map((c) => (
                      <li key={c.status}>
                        <div><span>{c.status}</span><b>{c.count}</b></div>
                        <em><i style={{ width: `${Math.round((c.count / callMax) * 100)}%`, background: c.status === "Not called yet" ? "#e0963a" : "#80664f" }} /></em>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h4>Oldest orders not called yet</h4>
                {d.orders.uncalledList.length === 0 ? <p className="db-empty">Every unfulfilled order has a call status.</p> : (
                  <ul className="db-list">
                    {d.orders.uncalledList.map((o) => (
                      <li key={o.id}>
                        <Link to="/app/order-sheet?status=Unfulfilled">
                          <span className="db-list-main"><b>{o.name} · {o.customer ?? "Customer"}</b><span>{[o.city, o.payment].filter(Boolean).join(" · ") || "—"}</span></span>
                          <span className="db-list-side">{o.amount != null ? money(o.amount, o.currency) : ""}<small>{ago(o.at)}</small></span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        )}
      </Card>

      {/* image editor */}
      <Card title="Image Editor" action={<Link to="/app/image-editor">Open Image Editor</Link>}>
        {!d.images.everUsed ? (
          <p className="db-empty">No photos processed yet. Drop a folder of product photos into Image Editor: backgrounds removed, resized and compressed in bulk.</p>
        ) : (
          <div className="db-img">
            <div>
              <h4>Photos processed per day</h4>
              <StackedBars data={d.images.days as unknown as Record<string, number | string>[]} every={every} label={dayLabel} height={170}
                series={[{ key: "done", label: "Done", color: "#80664f" }, { key: "failed", label: "Failed", color: "#c4584d" }]} />
            </div>
            <div className="db-img-side">
              <h4>Batch status</h4>
              {d.images.active ? (
                <>
                  <p className="db-img-name"><b>{d.images.active.name}</b> <Badge tone={d.images.active.status === "running" ? "info" : "warning"}>{d.images.active.status}</Badge></p>
                  <div className="db-img-bar"><i style={{ width: `${d.images.active.total ? Math.round(((d.images.active.done + d.images.active.failed) / d.images.active.total) * 100) : 0}%` }} /></div>
                  <p className="db-note" style={{ border: 0, margin: "6px 0 0", paddingTop: 0 }}>{d.images.active.done} done · {d.images.active.waiting} waiting · {d.images.active.failed} failed of {d.images.active.total}</p>
                </>
              ) : <p className="db-empty">No batch is running.</p>}
              <ul className="db-facts">
                <li><span>Workers</span><b>{imagePool.target} set · {imagePool.busy} busy</b></li>
                <li><span>Speed now</span><b>{imagePool.perMinute} photos / min</b></li>
                <li><span>Avg per photo</span><b>{d.images.avgSeconds ? `${d.images.avgSeconds}s` : "-"}</b></li>
                <li><span>Batches in period</span><b>{d.images.batches}</b></li>
                <li><span>Applied to Shopify</span><b>{d.images.applied}</b></li>
                <li><span>Restorable backups</span><b>{d.images.backups}</b></li>
                <li><span>Failed in period</span><b>{d.images.failed}</b></li>
              </ul>
            </div>
          </div>
        )}
      </Card>

      {/* people + products */}
      <div className="db-row three">
        <Card title="Waiting for you" action={<Link to="/app/conversations?filter=human">View all</Link>}>
          {d.waiting.length === 0 ? <p className="db-empty">No chat needs a human right now.</p> : (
            <ul className="db-list">
              {d.waiting.map((c) => (
                <li key={c.id}>
                  <Link to={`/app/conversations?c=${c.id}`}>
                    <span className="db-list-main"><b>{c.name}</b><span>{c.reason || c.preview || "—"}</span></span>
                    <span className="db-list-side"><small>{ago(c.at)}</small></span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Most requested products" action={<Link to="/app/enquiries">All enquiries</Link>}>
          {d.products.wanted.length === 0 ? <p className="db-empty">No product enquiries in this period.</p> : (
            <ul className="db-list">
              {d.products.wanted.map((p) => (
                <li key={p.query}>
                  <Link to={`/app/enquiries?q=${encodeURIComponent(p.query)}`}>
                    <span className="db-list-main"><b>{p.query}</b><span>{p.found ? `${p.found} of ${p.count} times in stock` : "Never in stock"}</span></span>
                    <span className="db-list-side"><Badge tone={p.found ? "success" : "critical"}>{p.count}×</Badge></span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Asked for, but you don't have" action={<Link to="/app/product-scrapper">Find them</Link>}>
          {d.products.unavailable.length === 0 ? <p className="db-empty">Everything customers asked for was available.</p> : (
            <ul className="db-list">
              {d.products.unavailable.map((p) => (
                <li key={p.query}>
                  <Link to="/app/product-scrapper">
                    <span className="db-list-main"><b>{p.query}</b><span>Candidate to source and add</span></span>
                    <span className="db-list-side"><Badge tone="warning">{p.count}×</Badge></span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {d.system.finder && (
            <p className="db-note">
              Last sourcing run: <b>{d.system.finder.category}</b> · {d.system.finder.found} new, {d.system.finder.skipped} already in store ({d.system.finder.status}, {ago(d.system.finder.at)})
            </p>
          )}
        </Card>
      </div>

      {/* activity */}
      <Card title="Recent activity" action={<Link to="/app/logs">All logs</Link>}>
        {d.recent.length === 0 ? <p className="db-empty">No activity yet.</p> : (
          <ul className="db-activity">
            {d.recent.map((r) => (
              <li key={r.id} className={r.level === "error" ? "err" : ""}>
                <span className="db-dot" />
                <b>{r.event.replace(/_/g, " ")}</b>
                <span className="db-act-detail">{r.detail || r.source}</span>
                <time>{ago(r.at)}</time>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <details className="db-guide">
        <summary>What each part of Orderly does</summary>
        <div className="db-guide-grid">
          {GUIDE.map((g) => {
            const Icon = g.icon;
            return (
              <Link to={g.to} key={g.to} className="db-guide-item">
                <span><Icon size={16} /></span>
                <div><b>{g.title}</b><p>{g.text}</p></div>
              </Link>
            );
          })}
        </div>
      </details>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
