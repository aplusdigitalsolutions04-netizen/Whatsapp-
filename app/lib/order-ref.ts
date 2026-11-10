import { normalizePhone } from "./phone.ts";

// Shopify order NAMES as customers type them. The display name (#W1219) is not Shopify's internal numeric id,
// so it is only ever used to search by `name:`, never as an id.

export type OrderRef = {
  /** Letters before the digits, upper case ("W"), or "" when the store has no prefix. */
  prefix: string;
  digits: string;
  /** Key used inside the bot: "W1219" or "1219". */
  key: string;
  /** Shopify display name: "#W1219" or "#1219". */
  name: string;
};

const make = (prefix: string, digits: string): OrderRef => {
  const p = prefix.toUpperCase();
  return { prefix: p, digits, key: `${p}${digits}`, name: `#${p}${digits}` };
};

/** The whole input is one order number: "#W1219", "w1219", "W-1219", "1219". */
export function parseOrderRef(input: string): OrderRef | null {
  const m = input.trim().match(/^#?\s*(?:([A-Za-z]{1,4})\s?-?\s?)?(\d{3,10})$/);
  return m ? make(m[1] ?? "", m[2]) : null;
}

/** "#W1219", "1219" or "W1219" (as stored by the bot) -> comparable form: upper case, no '#', spaces or dashes. */
export const orderKey = (nameOrKey: string) => nameOrKey.toUpperCase().replace(/[#\s_-]/g, "");

/** "9876543210" typed after the word "order" is the customer's mobile number, not an order number. */
export const refIsPhone = (ref: OrderRef): boolean => !ref.prefix && ref.digits.length === 10 && normalizePhone(ref.digits) !== null;

/** Does this Shopify order name answer the number the customer typed? Letters must match when the customer typed them. */
export function orderNameMatches(shopifyName: string, ref: OrderRef): boolean {
  const have = orderKey(shopifyName);
  if (ref.prefix) return have === ref.key;
  return have.replace(/^[A-Z]+/, "") === ref.digits;
}

/** Order number inside a sentence when it is clearly marked: "#W1219", "order no. w1219", "order 1219", "ऑर्डर नंबर 1002". */
export function findMarkedOrderRef(text: string): OrderRef | null {
  const hash = text.match(/#\s?(?:([A-Za-z]{1,4})-?)?(\d{3,10})\b/);
  if (hash) return make(hash[1] ?? "", hash[2]);
  const kw = text.match(/\border(?:\s*(?:no|number|num|id))?\.?\s*[:-]?\s*#?\s*(?:([A-Za-z]{1,4})-?)?(\d{3,10})\b/i);
  if (kw) return make(kw[1] ?? "", kw[2]);
  const hi = text.match(/(?:ऑर्डर|आर्डर|ओर्डर)\s*(?:नंबर|नं|no)?\s*[:-]?\s*#?\s*(?:([A-Za-z]{1,4})-?)?(\d{3,10})/i);
  if (hi) return make(hi[1] ?? "", hi[2]);
  return null;
}

/**
 * A bare token with ONE letter ("W1219", "w1219 please") when the customer is already talking about an order.
 * One letter only: model numbers such as "HP1008" or "LJ1020" are not mistaken for orders.
 */
export function findLooseOrderRef(text: string): OrderRef | null {
  const m = text.match(/(?:^|[^A-Za-z0-9])([A-Za-z])-?(\d{3,8})(?![A-Za-z0-9])/);
  return m ? make(m[1], m[2]) : null;
}
