// Another bot answering us (a business auto-reply, a chatbot, our own message echoed back) must never get a reply from JAZZ:
// two bots would talk to each other forever. Pure helpers (no database); the database part is in bot-detect.server.ts.

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();

// Things a customer never writes but automatic replies always do.
const AUTO_PATTERNS: [RegExp, string][] = [
  [/\b(auto[- ]?(reply|response|responder|generated)|automated (message|reply|response|assistant|greeting)|this is an automated|automatic (reply|response|message))\b/i, "says it is an automatic reply"],
  [/\b(i am|i'm|this is|you are chatting with|you're chatting with|chatting with)\s+(a |an |your |our |the )?((virtual|digital|ai|automated)\s+assistant|chat ?bot|bot)\b/i, "says it is a bot"],
  [/\b(thank(s| you) for (contacting|messaging|reaching out|getting in touch|your (message|enquiry|inquiry)))\b[\s\S]{0,160}\b(we will|we'll|will get back|get back to you|respond|reply|shortly|soon|as soon as)\b/i, "'thanks for contacting us, we will get back' style reply"],
  [/\bwe(?: are|'re) (?:currently |right now )?(?:closed|away|unavailable|offline|not available)\b/i, "away message"],
  [/\b(out of office|outside (of )?(our |the )?(business|working|office|store) hours|our (business|working|office|store) hours (are|is)|will (reply|respond|get back) (to you )?(during|within|on) )/i, "away / business hours message"],
  [/\b(do not reply|don't reply|please do not respond|no-?reply)\b/i, "says do not reply"],
  [/\b(please |kindly )?(press|select|choose|reply with|type) (option |number |the number )?(1|one)\b[\s\S]{0,80}\b(2|two)\b/i, "a numbered menu from another bot"],
  [/(स्वचालित (संदेश|उत्तर|जवाब)|ऑटो ?(रिप्लाई|जवाब))/, "automatic reply (Hindi)"],
];

/**
 * Why this message looks like it came from a bot, or null when it looks like a person.
 * `recentOut` = what JAZZ sent this customer lately, `recentIn` = what the customer sent before this message.
 */
export function looksAutomated(text: string, recentOut: string[] = [], recentIn: string[] = []): string | null {
  const raw = String(text ?? "").trim();
  if (raw.length < 12) return null; // "yes", "ok", "laptop": always a person
  for (const [re, why] of AUTO_PATTERNS) if (re.test(raw)) return why;
  const n = norm(raw);
  if (n.length >= 15 && recentOut.some((o) => norm(o) === n)) return "repeats a message JAZZ sent (an echo)";
  // The same long text three times is a machine; a person does not retype a paragraph again and again.
  if (n.length >= 60 && recentIn.filter((i) => norm(i) === n).length >= 2) return "the same long message again and again";
  return null;
}

/** Bot replies in the last few minutes that make a conversation look like a loop. */
// A product answer with a photo is two messages, so a quick human chat is at most about one reply every 20 seconds.
export const LOOP_LIMIT = 14;
export const LOOP_WINDOW_MS = 2 * 60_000;
