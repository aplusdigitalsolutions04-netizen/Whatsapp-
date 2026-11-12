/** Customer-facing price: Indian rupees as "₹1,499" (never "INR 1499.00"); other currencies keep their own symbol. */
export function formatMoney(amount: string | number | null | undefined, currency: string | null | undefined): string {
  const n = Number(amount);
  if (amount == null || amount === "" || !Number.isFinite(n)) return "";
  const cur = String(currency ?? "").toUpperCase();
  if (!cur || cur === "INR") {
    const whole = Math.abs(n - Math.round(n)) < 0.005;
    return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
  }
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${cur} ${n}`;
  }
}
