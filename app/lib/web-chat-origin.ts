// Which websites may show the JAZZ chat box and talk to /api/chat from the visitor's browser (CORS).
// The chat needs no login or cookies (the visitor only holds a random session id), so this only decides which pages may read the answers.

const BUILT_IN = ["wery.in"]; // the store website; also covers www.wery.in and any subdomain

/** Hosts allowed for this app: the built-in store domain, any *.myshopify.com store, and WIDGET_ALLOWED_ORIGINS (comma separated hosts or origins). */
export function allowedWidgetHosts(env: Record<string, string | undefined> = process.env): string[] {
  const extra = (env.WIDGET_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);
  const shop = (env.SHOPIFY_STORE_DOMAIN ?? "").trim().toLowerCase();
  return [...BUILT_IN, ...extra, ...(shop ? [shop] : [])];
}

/** The Origin header value to echo back in Access-Control-Allow-Origin, or null when that website is not allowed. */
export function allowedWidgetOrigin(origin: string | null | undefined, env: Record<string, string | undefined> = process.env): string | null {
  if (!origin) return null;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))) return null;
  const host = u.hostname.toLowerCase();
  if (host.endsWith(".myshopify.com")) return u.origin;
  return allowedWidgetHosts(env).some((h) => host === h || host.endsWith(`.${h}`)) ? u.origin : null;
}
