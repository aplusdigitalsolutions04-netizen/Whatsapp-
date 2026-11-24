// Live Inbox search, pure parts (no database): what a typed text means, how a match is ranked, and the snippet shown for it.

/** Digits to look for in a phone number, or null when the text is not a phone number. "+91 98765 43210", "09876543210" and "9876543210" all give "9876543210". */
export function phoneNeedle(q: string): string | null {
  const digits = String(q ?? "").replace(/\D/g, "");
  if (digits.length < 6) return null; // order numbers are shorter than phone numbers; 5 digits or less would match far too many chats
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** The last 10 digits of a phone number (Indian numbers with or without +91 / 0): used to compare a chat's number with an order's number. */
export const last10 = (phone: string | null | undefined): string => String(phone ?? "").replace(/\D/g, "").slice(-10);

export type MatchKind = "order" | "phone" | "name" | "message";

/** Higher = shown higher. An order or number match beats a name, a name beats a word inside a message. */
export const MATCH_SCORE: Record<MatchKind, number> = { order: 100, phone: 80, name: 60, message: 40 };

/** About 70 characters of `body` around the first place `q` appears, with "…" where it was cut. Falls back to the start of the message. */
export function snippetAround(body: string, q: string, width = 70): string {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0 || text.length <= width) return text.slice(0, width) + (text.length > width ? "…" : "");
  const start = Math.max(0, at - Math.floor((width - q.length) / 3));
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** Splits `text` into parts so the matches of `q` can be highlighted: [{ text, hit }]. Case does not matter. */
export function highlightParts(text: string, q: string): { text: string; hit: boolean }[] {
  const needle = String(q ?? "").trim();
  if (!needle) return [{ text, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(n, from);
    if (at < 0) break;
    if (at > from) out.push({ text: text.slice(from, at), hit: false });
    out.push({ text: text.slice(at, at + n.length), hit: true });
    from = at + n.length;
  }
  if (from < text.length) out.push({ text: text.slice(from), hit: false });
  return out.length ? out : [{ text, hit: false }];
}
