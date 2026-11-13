import prisma from "../db.server";
import { CRED_NAMES, CRED_RULES, type CredName } from "./cloud-cred-rules";
import { decryptSecret, encryptSecret } from "./secret.server";

// Meta WhatsApp Cloud API keys. They are typed into the Integrations page, stored ENCRYPTED in the database and never sent
// back to any browser (the page only learns "saved, ends in 1234"). Environment variables still work as a fallback.

const ENV: Record<CredName, string> = {
  accessToken: "WHATSAPP_ACCESS_TOKEN",
  phoneNumberId: "WHATSAPP_PHONE_NUMBER_ID",
  appSecret: "WHATSAPP_APP_SECRET",
  verifyToken: "WHATSAPP_VERIFY_TOKEN",
};

type Cache = { values: Map<CredName, string>; timer: NodeJS.Timeout | null };
const g = globalThis as unknown as { __cloudCreds?: Cache };
const cache = (g.__cloudCreds ??= { values: new Map(), timer: null });

/** The key to use right now: the saved (encrypted) one, else the environment variable, else nothing. Synchronous on purpose. */
export function cred(name: CredName): string | undefined {
  return cache.values.get(name) || process.env[ENV[name]] || undefined;
}

/** Every key value in use, so log lines can hide them even when they appear in an error message. */
export function secretValues(): string[] {
  return CRED_NAMES.map((n) => cred(n)).filter((v): v is string => !!v && v.length >= 8);
}

/** Reads the saved keys from the database into memory. Called at start, every minute (other workers), and after a save. */
export async function refreshCreds(): Promise<void> {
  try {
    const rows = await prisma.integrationSecret.findMany();
    const next = new Map<CredName, string>();
    for (const r of rows) {
      if (!(CRED_NAMES as readonly string[]).includes(r.name)) continue;
      const v = decryptSecret(r.value);
      if (v) next.set(r.name as CredName, v);
    }
    cache.values = next;
  } catch {
    /* database not ready yet: environment variables keep working */
  }
}

export function startCredRefresh() {
  if (cache.timer) return;
  cache.timer = setInterval(() => void refreshCreds(), 60_000);
  cache.timer.unref?.();
}

const hintOf = (v: string) => (v.length >= 8 ? `••••${v.slice(-4)}` : "••••");

/** Saves the non-empty values (blank = keep what is saved). Returns the names that were saved, or the first problem. */
export async function saveCreds(shop: string, input: Partial<Record<CredName, string>>): Promise<{ ok: true; saved: CredName[] } | { ok: false; error: string }> {
  const toSave: [CredName, string][] = [];
  for (const n of CRED_NAMES) {
    const v = String(input[n] ?? "").trim();
    if (!v) continue;
    if (!CRED_RULES[n].re.test(v)) return { ok: false, error: `${CRED_RULES[n].label} does not look right: ${CRED_RULES[n].hint}.` };
    toSave.push([n, v]);
  }
  if (!toSave.length) return { ok: false, error: "Nothing to save: fill in at least one field." };
  for (const [name, v] of toSave) {
    const value = encryptSecret(v);
    await prisma.integrationSecret.upsert({
      where: { shop_name: { shop, name } },
      create: { shop, name, value, hint: hintOf(v) },
      update: { value, hint: hintOf(v) },
    });
  }
  await refreshCreds();
  return { ok: true, saved: toSave.map(([n]) => n) };
}

export async function removeCreds(shop: string): Promise<void> {
  await prisma.integrationSecret.deleteMany({ where: { shop } });
  await refreshCreds();
}

/** For the page: which keys are saved and how they end. Never the keys themselves. */
export async function credStatus(shop: string): Promise<Record<CredName, { saved: boolean; hint: string; updatedAt: string | null; fromEnv: boolean }>> {
  const rows = await prisma.integrationSecret.findMany({ where: { shop } });
  const out = {} as Record<CredName, { saved: boolean; hint: string; updatedAt: string | null; fromEnv: boolean }>;
  for (const n of CRED_NAMES) {
    const r = rows.find((x) => x.name === n);
    out[n] = { saved: !!r, hint: r?.hint ?? "", updatedAt: r?.updatedAt.toISOString() ?? null, fromEnv: !r && !!process.env[ENV[n]] };
  }
  return out;
}
