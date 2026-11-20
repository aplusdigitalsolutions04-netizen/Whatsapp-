// Profit / loss of one order for the Order Update sheet. Pure: no database, no Shopify.
//
//   normal order : order amount - landing price - delivery charges
//   RTO (returned): a loss of the delivery charges only (the goods came back, the courier still has to be paid)
//   Cancelled    : nothing (no goods left, no courier): empty
//   Landing price not filled in yet (normal order): empty, so a wrong profit is never shown

export type ProfitInput = {
  status: string | null | undefined;
  amount: number | null | undefined;
  landingPrice: number | null | undefined;
  /** Delivery charges the team typed, or Shopify's shipping charge when nobody typed one. */
  deliveryCharges: number | null | undefined;
};

const num = (n: number | null | undefined): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);
const round2 = (n: number) => Math.round(n * 100) / 100 + 0; // + 0 turns -0 into 0

/** The profit (positive) or loss (negative) in rupees, or null when it cannot be worked out. */
export function profitLoss(i: ProfitInput): number | null {
  const status = String(i.status ?? "");
  if (status === "Cancelled") return null;
  const delivery = num(i.deliveryCharges);
  if (status === "RTO") return delivery === null ? null : round2(-delivery);
  const amount = num(i.amount);
  const landing = num(i.landingPrice);
  if (amount === null || landing === null) return null;
  return round2(amount - landing - (delivery ?? 0));
}

/** "profit", "loss" or "" (zero or unknown): decides the cell colour (green / red). */
export const profitTone = (v: number | null | undefined): "profit" | "loss" | "" => {
  const n = num(v);
  return n === null || n === 0 ? "" : n > 0 ? "profit" : "loss";
};
