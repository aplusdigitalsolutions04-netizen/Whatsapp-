import { normalizePhone, samePhone } from "./phone";

/**
 * Saved contacts (people in the owner's phone book: family, friends, suppliers) are not customers, so the bot stays silent
 * for them. A saved contact can still use the bot on purpose by starting the message with one of these characters.
 */
export const WAKE_CHARS = ["!", "#", "$"] as const;

/** `reply: false` means: do not answer. Otherwise `text` is the message without the wake character. */
export function applyWakeRule(text: string, isSaved: boolean): { reply: boolean; text: string } {
  if (!isSaved) return { reply: true, text };
  const t = text.trim();
  const first = t.charAt(0);
  if (first && (WAKE_CHARS as readonly string[]).includes(first)) return { reply: true, text: t.slice(1).trim() || "hi" };
  return { reply: false, text };
}

/** One number per line (or separated by commas / spaces) to a clean list of +91... numbers. */
export function parseNumberList(raw: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const part of String(raw ?? "").split(/[\n,;]+/)) {
    const p = normalizePhone(part.trim());
    if (p) out.add(p);
  }
  return [...out];
}

export const inList = (phone: string, list: string[]) => list.some((n) => samePhone(n, phone));
