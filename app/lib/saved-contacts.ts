import { normalizePhone, samePhone } from "./phone";

/**
 * Saved contacts (people in the owner's phone book: family, friends, suppliers) are not customers, so the bot stays silent
 * for them. A saved contact can still use the bot on purpose by starting the message with one of these characters.
 */
export const WAKE_CHARS = ["!", "#", "$"] as const;

// Anybody (a customer without an order too) can wake JAZZ by starting the message with its name: "jazz", "hey jazz", "hi jazz", "hello jazz",
// "ok jazz" ... Only at the START, so a sentence that merely mentions the word ("is the jazz printer good?") does not wake it.
const WAKE_WORD = /^\s*(?:(?:hey+|hi+|hello+|hlo|helo|ok|okay|oye|arre|are|namaste|namaskar|dear)[\s,.!:-]+)?jazz(?![\w'’])[\s,.!:;-]*/i;

/** The message without the wake word ("hey jazz, track my order" -> "track my order"; "hey jazz" alone -> ""), or null when it does not start with one. */
export function stripWakeWord(text: string): string | null {
  const m = String(text ?? "").match(WAKE_WORD);
  return m ? text.slice(m[0].length).trim() : null;
}

/** `reply: false` means: do not answer. Otherwise `text` is the message without the wake character / wake word. */
export function applyWakeRule(text: string, isSaved: boolean): { reply: boolean; text: string } {
  const t = text.trim();
  const first = t.charAt(0);
  if (isSaved && first && (WAKE_CHARS as readonly string[]).includes(first)) return { reply: true, text: t.slice(1).trim() || "hi" };
  const word = stripWakeWord(t);
  if (word !== null) return { reply: true, text: word || "hi" };
  return isSaved ? { reply: false, text } : { reply: true, text };
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
