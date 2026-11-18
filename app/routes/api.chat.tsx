import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { resolveShop } from "../lib/settings.server";
import { readWebMessages, sendWebMessage, webChatConfig } from "../lib/web-chat.server";

// The JAZZ chat box on the website talks to this route.
//   GET  /api/chat?config=1            -> { enabled, whatsapp }   (should the icon be shown, and which WhatsApp number)
//   GET  /api/chat?sid=<id>&after=<iso> -> new messages of this visitor's chat
//   POST /api/chat { sid, text, name? } -> the visitor writes; JAZZ answers
// Not behind the Shopify login (visitors are not Shopify users). Visitors only ever see their own chat: the session id is a
// long random value kept in their browser. Admin test chats come through /app (the widget there sends test: true).

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const ipOf = (request: Request) => request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = await resolveShop();
  if (!shop) return json({ enabled: false, whatsapp: "", messages: [] });
  if (url.searchParams.get("config")) return json(await webChatConfig(shop));
  const cfg = await webChatConfig(shop);
  const sid = url.searchParams.get("sid") ?? "";
  const res = await readWebMessages(shop, sid, url.searchParams.get("after"));
  return json({ enabled: cfg.enabled, ...res });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const shop = await resolveShop();
  if (!shop) return json({ ok: false, error: "Chat is not available right now." }, 503);
  let body: { sid?: unknown; text?: unknown; name?: unknown } | null;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Bad request" }, 400);
  }
  const r = await sendWebMessage({ shop, sid: String(body?.sid ?? ""), text: String(body?.text ?? ""), name: body?.name ? String(body.name) : undefined, ip: ipOf(request), test: false });
  return r.ok ? json({ ok: true }) : json({ ok: false, error: r.error }, r.status);
};
