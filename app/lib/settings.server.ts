import prisma from "../db.server";
import { mergeTemplates, type Templates } from "./templates";

export type Settings = {
  shop: string;
  enabled: boolean;
  maxVerifyAttempts: number;
  recommendationsEnabled: boolean;
  maxRecommendations: number;
  recommendationRule: "productType" | "tag";
  templates: Templates;
};

export async function getSettings(shop: string): Promise<Settings> {
  const row = await prisma.botSettings.findUnique({ where: { shop } });
  return {
    shop,
    enabled: row?.enabled ?? true,
    maxVerifyAttempts: row?.maxVerifyAttempts ?? 3,
    recommendationsEnabled: row?.recommendationsEnabled ?? true,
    maxRecommendations: row?.maxRecommendations ?? 3,
    recommendationRule: row?.recommendationRule === "tag" ? "tag" : "productType",
    templates: mergeTemplates(row?.templates),
  };
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Math.round(Number.isFinite(n) ? n : lo)));

function safeJson(s: string): Record<string, string> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

export async function saveSettings(shop: string, form: FormData) {
  const stored = await prisma.botSettings.findUnique({ where: { shop } });
  const templates: Record<string, string> = stored ? safeJson(stored.templates) : {};
  for (const [k, v] of form.entries()) {
    if (k.startsWith("tpl_") && typeof v === "string") {
      templates[k.slice(4)] = v.trim().slice(0, 1000);
    }
  }
  const data = {
    enabled: form.get("enabled") === "on",
    maxVerifyAttempts: clamp(Number(form.get("maxVerifyAttempts")), 1, 10),
    recommendationsEnabled: form.get("recommendationsEnabled") === "on",
    maxRecommendations: clamp(Number(form.get("maxRecommendations")), 1, 5),
    recommendationRule: form.get("recommendationRule") === "tag" ? "tag" : "productType",
    templates: JSON.stringify(templates),
  };
  await prisma.botSettings.upsert({
    where: { shop },
    create: { shop, ...data },
    update: data,
  });
}

/**
 * The WhatsApp webhook carries no shop context, so this app serves one store:
 * SHOPIFY_STORE_DOMAIN if set, otherwise the most recent installed offline session.
 */
export async function resolveShop(): Promise<string | null> {
  if (process.env.SHOPIFY_STORE_DOMAIN) return process.env.SHOPIFY_STORE_DOMAIN;
  const s = await prisma.session.findFirst({
    where: { isOnline: false },
    orderBy: { expires: "desc" },
  });
  return s?.shop ?? null;
}
