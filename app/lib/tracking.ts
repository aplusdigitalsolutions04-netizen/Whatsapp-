export type TrackingInfo = {
  company?: string | null;
  number?: string | null;
  url?: string | null;
};

const SAFE_NUMBER = /^[A-Za-z0-9-]{6,30}$/;

/** Opens Delhivery's tracking page with the tracking id already filled in. */
export const delhiveryUrl = (number: string) => `https://www.delhivery.com/track-v2/package/${encodeURIComponent(number)}`;

/**
 * Delhivery shipments always get the direct Delhivery link (the tracking id is part of the address, so the page opens
 * already filled in). For other couriers the exact Shopify tracking URL is used; nothing is guessed for unknown couriers.
 */
export function resolveTrackingUrl(t: TrackingInfo): string | null {
  const isDelhivery = /delhivery/i.test(t.company ?? "") || /(^|\.)delhivery\.com/i.test(hostOf(t.url));
  if (isDelhivery && t.number && SAFE_NUMBER.test(t.number)) return delhiveryUrl(t.number);
  if (t.url) {
    try {
      const u = new URL(t.url);
      if (u.protocol === "https:" || u.protocol === "http:") return u.toString();
    } catch {
      /* fall through */
    }
  }
  return null;
}

function hostOf(url?: string | null): string {
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
  }
}
