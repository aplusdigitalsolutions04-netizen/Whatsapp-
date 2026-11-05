/**
 * Indian-focused phone normalisation. Returns a canonical E.164 string
 * ("+91XXXXXXXXXX") or null when the input can't be safely interpreted.
 * Numbers are only treated as equal when their canonical forms are identical.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim();
  const hadPlus = s.startsWith("+");
  s = s.replace(/[^\d]/g, "");
  if (!s) return null;
  if (s.startsWith("00") && !hadPlus) s = s.slice(2);

  // 10-digit Indian mobile (6-9 start)
  if (s.length === 10 && /^[6-9]/.test(s)) return `+91${s}`;
  // 0 + 10 digits (trunk prefix)
  if (s.length === 11 && s.startsWith("0") && /^[6-9]/.test(s.slice(1))) {
    return `+91${s.slice(1)}`;
  }
  // 91 + 10 digits
  if (s.length === 12 && s.startsWith("91") && /^[6-9]/.test(s.slice(2))) {
    return `+${s}`;
  }
  // Other international numbers: only trust when explicitly prefixed / WhatsApp style
  if (s.length >= 11 && s.length <= 15 && !s.startsWith("0")) return `+${s}`;
  return null;
}

/** Variants Shopify may have stored the number as, used to search customers. */
export function phoneSearchVariants(e164: string): string[] {
  const digits = e164.replace(/\D/g, "");
  const out = new Set<string>([e164, digits]);
  if (digits.startsWith("91") && digits.length === 12) out.add(digits.slice(2));
  return [...out];
}

export function samePhone(a?: string | null, b?: string | null): boolean {
  const x = normalizePhone(a);
  const y = normalizePhone(b);
  return !!x && !!y && x === y;
}

export function maskPhone(p: string): string {
  return p.length <= 6 ? p : `${p.slice(0, 3)}${"*".repeat(p.length - 6)}${p.slice(-3)}`;
}
