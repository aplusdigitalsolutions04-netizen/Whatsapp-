export type TrackingInfo = {
  company?: string | null;
  number?: string | null;
  url?: string | null;
};

const SAFE_NUMBER = /^[A-Za-z0-9-]{6,30}$/;

/**
 * Prefer the exact Shopify tracking URL. Only when it is absent do we build
 * an official courier URL, and only for couriers whose format we know.
 */
export function resolveTrackingUrl(t: TrackingInfo): string | null {
  if (t.url) {
    try {
      const u = new URL(t.url);
      if (u.protocol === "https:" || u.protocol === "http:") return u.toString();
    } catch {
      /* fall through */
    }
  }
  if (t.number && SAFE_NUMBER.test(t.number) && /delhivery/i.test(t.company ?? "")) {
    return `https://www.delhivery.com/track/package/${encodeURIComponent(t.number)}`;
  }
  return null;
}
