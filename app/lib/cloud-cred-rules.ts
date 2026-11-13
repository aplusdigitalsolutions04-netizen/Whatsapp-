// The four Meta WhatsApp Cloud API keys and what each one must look like. No secrets here: the page and the server both import it.

export const CRED_NAMES = ["accessToken", "phoneNumberId", "appSecret", "verifyToken"] as const;
export type CredName = (typeof CRED_NAMES)[number];

/** Rejecting obvious mistakes (a pasted sentence, the wrong field) protects the saved keys. */
export const CRED_RULES: Record<CredName, { re: RegExp; label: string; hint: string }> = {
  accessToken: { re: /^[A-Za-z0-9_\-.~+/=]{20,1000}$/, label: "Access token", hint: "the long token from Meta (starts with EA…)" },
  phoneNumberId: { re: /^\d{8,20}$/, label: "Phone number ID", hint: "digits only, from WhatsApp → API Setup" },
  appSecret: { re: /^[A-Za-z0-9]{16,64}$/, label: "App secret", hint: "32 letters/numbers, from App settings → Basic" },
  verifyToken: { re: /^[A-Za-z0-9_-]{8,128}$/, label: "Verify token", hint: "8–128 letters, numbers, - or _" },
};
