import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { allowedWidgetOrigin } from "../lib/web-chat-origin";
import { readWebMessages, sendWebMessage, webChatConfig, widgetShop } from "../lib/web-chat.server";

// The JAZZ chat box on the website talks to this route.
//   GET  /api/chat?config=1            -> { enabled, whatsapp }   (should the icon be shown, and which WhatsApp number)
//   GET  /api/chat?sid=<id>&after=<iso> -> new messages of this visitor's chat
//   POST /api/chat { sid, text, name? } -> the visitor writes; JAZZ answers
// Not behind the Shopify login (visitors are not Shopify users). Visitors only ever see their own chat: the session id is a
// long random value kept in their browser. Admin test chats come through /app (the widget there sends test: true).
// The store website (wery.in) lives on another domain, so allowed websites get CORS headers (see web-chat-origin.ts).
// The POST is sent as text/plain (a "simple" request), so the browser needs no preflight; the body is still JSON.

const headersFor = (request: Request): HeadersInit => {
  const h: Record<string, string> = { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin" };
  const origin = allowedWidgetOrigin(request.headers.get("origin"));
  if (origin) h["Access-Control-Allow-Origin"] = origin;
  return h;
};
const json = (request: Request, data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...headersFor(request), ...extra } });

const ipOf = (request: Request) => request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = await widgetShop();
  if (!shop) return json(request, { enabled: false, whatsapp: "", messages: [] });
  // the icon asks this on every page view of the store: browsers may keep the answer for 30 s (switching the icon off takes at most that long)
  if (url.searchParams.get("config")) return json(request, await webChatConfig(shop), 200, { "Cache-Control": "public, max-age=30" });
  const cfg = await webChatConfig(shop);
  const sid = url.searchParams.get("sid") ?? "";
  const res = await readWebMessages(shop, sid, url.searchParams.get("after"));
  return json(request, { enabled: cfg.enabled, ...res });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    // Only reached by a browser that insists on a preflight; answer it for the allowed websites.
    const origin = allowedWidgetOrigin(request.headers.get("origin"));
    return new Response(null, {
      status: 204,
      headers: origin ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400", Vary: "Origin" } : {},
    });
  }
  if (request.method !== "POST") return json(request, { ok: false, error: "Method not allowed" }, 405);
  const shop = await widgetShop();
  if (!shop) return json(request, { ok: false, error: "Chat is not available right now." }, 503);
  let body: { sid?: unknown; text?: unknown; name?: unknown } | null;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json(request, { ok: false, error: "Bad request" }, 400);
  }
  const r = await sendWebMessage({ shop, sid: String(body?.sid ?? ""), text: String(body?.text ?? ""), name: body?.name ? String(body.name) : undefined, ip: ipOf(request), test: false });
  return r.ok ? json(request, { ok: true }) : json(request, { ok: false, error: r.error }, r.status);
};
