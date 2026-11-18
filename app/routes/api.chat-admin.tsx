import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { readWebMessages, sendWebMessage } from "../lib/web-chat.server";

// The JAZZ icon inside the ShopPilot admin: the store owner can try the chat even when the website icon is switched off.
// These chats are marked as test chats and show in Live Inbox under Website.

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  return json(await readWebMessages(session.shop, url.searchParams.get("sid") ?? "", url.searchParams.get("after")));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  let body: { sid?: string; text?: string } = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Bad request" }, 400);
  }
  const r = await sendWebMessage({ shop: session.shop, sid: String(body.sid ?? ""), text: String(body.text ?? ""), test: true });
  return r.ok ? json({ ok: true }) : json({ ok: false, error: r.error }, r.status);
};
