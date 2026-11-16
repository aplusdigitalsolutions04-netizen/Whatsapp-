// Order confirmation chat: after "your order is confirmed", JAZZ asks "do you want this order?", then shows the delivery
// number and address and asks "is this correct?". Pure helpers (no database, no network).

const YES = new Set([
  "yes", "y", "yep", "yup", "yeah", "ya", "yaa", "ok", "okay", "okk", "k", "sure", "confirm", "confirmed", "correct", "right", "done", "agree",
  "haan", "han", "haa", "ha", "hanji", "haanji", "ji", "theek", "thik", "sahi", "bilkul", "pakka", "kar", "karo", "chalega", "lena", "lunga", "lungi",
  "हाँ", "हां", "हा", "जी", "ठीक", "सही", "बिलकुल", "पक्का", "👍", "✅", "👌", "🙏",
  "si", "sí", "oui", "ja", "sim", "evet", "iya", "ya", "da", "ano", "claro", "vale", "d'accord", "genau",
]);
const NO = new Set([
  "no", "n", "nope", "nah", "not", "dont", "don't", "cancel", "cancelled", "wrong", "incorrect", "change", "edit", "stop", "refuse",
  "nahi", "nahin", "nai", "na", "mat", "galat", "badlo", "badal", "rehne", "raheendo", "nahi-chahiye",
  "नहीं", "नही", "ना", "मत", "गलत", "रद्द", "बदलो", "❌", "👎",
  "non", "nein", "não", "nao", "hayır", "hayir", "tidak", "nee", "nej", "nie", "jamás",
]);

/** Reads a short reply as YES or NO. Anything longer or mixed (a real question) returns null so the normal bot can answer it. */
export function parseYesNo(text: string): "yes" | "no" | null {
  const cleaned = String(text ?? "").toLowerCase().replace(/[.,!?;:()"'“”‘’]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const tokens = cleaned.split(" ");
  if (tokens.length > 4) return null;
  const hasNo = tokens.some((t) => NO.has(t));
  const hasYes = tokens.some((t) => YES.has(t));
  if (hasNo) return "no"; // "ok but wrong address" is a no
  if (hasYes) return "yes";
  if (cleaned.startsWith("theek hai") || cleaned.startsWith("thik hai") || cleaned.startsWith("sahi hai")) return "yes";
  return null;
}

export type ConfirmDetails = { orderName: string; customerName?: string | null; phone: string; address: string };

export const askOrderText = (orderName: string) =>
  `Please confirm your order ${orderName}. 📝\nDo you want to take this order?\n\nReply YES to confirm ✅\nReply NO if you do not want it ❌`;

export function askAddressText(d: ConfirmDetails) {
  const rows = [
    d.customerName ? `Name: ${d.customerName}` : null,
    `Mobile number: ${d.phone}`,
    `Address: ${d.address || "(no address on the order)"}`,
  ].filter(Boolean).map((r, i) => `${i + 1}. ${r}`);
  return `Thank you! 🙏 Please confirm your delivery details for ${d.orderName}:\n\n${rows.join("\n")}\n\nIs everything correct?\nReply YES to confirm ✅\nReply NO to change something ✏️`;
}

export const confirmedText = (orderName: string) =>
  `Thank you! Your order ${orderName} is confirmed. ✅\nI will message you as soon as it is dispatched. 📦`;

export const declinedText = (orderName: string) =>
  `No problem. I am connecting you with our team to sort out ${orderName}. 🙏\nSomeone will reply here shortly.`;

/** Name written in the Order Calling Sheet's "Employee Name" column when JAZZ did the confirmation. */
export const BOT_EMPLOYEE = "JAZZ";

export type SheetFill = { customerWants?: string; addressConfirmed?: string; callStatus?: string; finalDecision?: string; employeeRemark: string };

/**
 * What the customer's answer means for the Order Calling Sheet (the columns an employee fills after calling).
 * prev = where the chat was (asked | address), next = where it is now (address | confirmed | declined).
 */
export function sheetFill(prev: string, next: string, note = ""): SheetFill | null {
  const withNote = (t: string) => (note ? `${t}. Customer note: “${note}”` : t);
  if (next === "address") return { customerWants: "Yes", employeeRemark: withNote("JAZZ: customer said YES to the order on WhatsApp, waiting for the address check") };
  if (next === "review") {
    return { employeeRemark: note ? `JAZZ: customer replied “${note}” on WhatsApp, chat sent to an agent to check` : "JAZZ: customer asked for a change on WhatsApp, chat sent to an agent to check" };
  }
  if (next === "confirmed") {
    return {
      customerWants: "Yes", addressConfirmed: "Yes", callStatus: "Connected", finalDecision: "Confirmed",
      employeeRemark: withNote("JAZZ: customer confirmed the order, mobile number and address on WhatsApp"),
    };
  }
  if (next === "declined" && prev === "address") {
    return { customerWants: "Yes", addressConfirmed: "No", employeeRemark: "JAZZ: customer said the address / number is wrong on WhatsApp, chat sent to an agent" };
  }
  if (next === "declined") return { customerWants: "No", employeeRemark: "JAZZ: customer said NO to the order on WhatsApp, chat sent to an agent" };
  return null;
}

/** An employee's entry is never overwritten: only empty cells (or a select still on "Pending") are filled. */
export const blank = (v: string | null | undefined) => !v || !v.trim() || v.trim().toLowerCase() === "pending";

// ---- reading a whole reply, not only "yes" / "no" ----
// "yes please deliver in the evening" is a YES with a note. "yes but the address is wrong" is NOT a clean yes: an agent must look.
const CHANGE = new Set(["change", "edit", "wrong", "incorrect", "galat", "badlo", "badal", "badalna", "badalni", "update", "different", "alag", "instead", "correction", "naya", "new", "बदलो", "गलत"]);
const CONDITION = new Set(["but", "however", "lekin", "magar", "par", "parantu", "only", "unless", "agar", "if", "wait", "hold", "बस", "लेकिन", "मगर", "पर"]);
// "no problem" / "koi dikkat nahi" contain a NO word but mean the opposite
const NO_PROBLEM = /\b(no|any)\s+(problem|problems|issue|issues|worries|worry|dikkat|tension)\b|\b(problem|dikkat|issue)\s+(nahi|nhi|nahin)\b|\bkoi\s+(problem|dikkat|issue)\s+(nahi|nhi|nahin)\b/gi;

export type Reading = { answer: "yes" | "no" | "change"; extra: string };

/** What the customer meant by a reply to "do you want this order?" / "is this address correct?", or null when it is unclear. */
export function readConfirmation(text: string): Reading | null {
  const cleaned = String(text ?? "").toLowerCase().replace(NO_PROBLEM, " ").replace(/[.,!?;:()"'“”‘’]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const tokens = cleaned.split(" ");
  const yes = tokens.some((t) => YES.has(t)) || /^(theek|thik|sahi) hai/.test(cleaned);
  const strongNo = tokens.some((t) => NO.has(t) && !CHANGE.has(t));
  const change = tokens.some((t) => CHANGE.has(t));
  const condition = tokens.some((t) => CONDITION.has(t));
  const extra = () => {
    const rest = String(text).replace(NO_PROBLEM, " ").split(/\s+/).filter((w) => !YES.has(w.toLowerCase().replace(/[.,!?;:]+$/g, ""))).join(" ").replace(/^[\s,.;:!-]+|[\s,.;:!-]+$/g, "");
    return (rest.match(/\p{L}/gu)?.length ?? 0) >= 6 ? rest.slice(0, 160) : "";
  };
  if (strongNo) return { answer: "no", extra: extra() }; // "yes ... no" is a no
  if (change && (yes || tokens.length <= 12)) return { answer: "change", extra: extra() || String(text).trim().slice(0, 160) };
  if (yes && condition) return { answer: "change", extra: extra() || String(text).trim().slice(0, 160) };
  if (yes) return { answer: "yes", extra: extra() };
  return null;
}

export const noteLine = (note: string) => (note ? `\n\n📝 I have noted your message: “${note}”. Our team will see it.` : "");
export const reviewText = (orderName: string) =>
  `Thank you! 🙏 I have noted your message. I am connecting you with our team to sort out ${orderName}.\nSomeone will reply here shortly.`;
