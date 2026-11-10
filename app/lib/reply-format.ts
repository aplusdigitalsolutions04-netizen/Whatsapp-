// One formatting layer for every WhatsApp answer: short intro, numbered points, one clear next step.
// Customers read these on a phone, so there are no long paragraphs and nothing is repeated.

/** Cuts to `max` characters on a word boundary, adding "…" only when something was removed. */
export function clip(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.4 ?cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/** "1. one\n2. two" (continues from `start`). Empty entries are skipped and the numbering stays gapless. */
export function numbered(items: (string | null | undefined | false)[], start = 1): string {
  return items
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x, i) => `${start + i}. ${x}`)
    .join("\n");
}

/**
 * intro + numbered points + optional note + next step, separated by blank lines.
 * Anything empty is left out, so callers never have to special-case missing data.
 */
export function compose(parts: { intro?: string; points?: (string | null | undefined | false)[]; note?: string; next?: string }): string {
  const body = parts.points ? numbered(parts.points) : "";
  return [parts.intro, body, parts.note, parts.next]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Date as the customer reads it: "12 Nov 2026". Fixed locale so the server's settings never change the output. */
export function shortDate(iso: string | null | undefined, locale = "en-IN"): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

/** "SOME_STATUS" -> "Some Status". */
export const titleCase = (s: string | null | undefined): string =>
  s ? s.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "";
