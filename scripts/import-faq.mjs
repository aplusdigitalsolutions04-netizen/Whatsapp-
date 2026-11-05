// Imports the WERY question/answer knowledge base (data/wery-faq.json) as Quick replies.
//
//   npm run import:faq            creates new entries, leaves ones you already edited untouched
//   npm run import:faq -- --force overwrites entries with the same title
//
// Live-data questions (track my order, when will it arrive...) are intentionally not imported:
// the bot answers those from real Shopify orders.
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const force = process.argv.includes("--force");
const entries = JSON.parse(readFileSync(new URL("../data/wery-faq.json", import.meta.url), "utf8"));
const prisma = new PrismaClient();

async function resolveShop() {
  if (process.env.SHOPIFY_STORE_DOMAIN) return process.env.SHOPIFY_STORE_DOMAIN;
  const s = await prisma.session.findFirst({ where: { isOnline: false }, orderBy: { expires: "desc" } });
  return s?.shop ?? null;
}

const shop = await resolveShop();
if (!shop) {
  console.error("No shop found. Open the app once in your Shopify admin first (or set SHOPIFY_STORE_DOMAIN).");
  process.exit(1);
}

let created = 0;
let updated = 0;
let skipped = 0;
for (const e of entries) {
  const title = `WERY: ${e.question}`.slice(0, 80);
  const data = {
    title,
    keywords: "",
    questions: e.questions.join("\n"),
    replyEn: e.replyEn,
    replyHi: "",
    replyHinglish: e.replyHinglish || "",
    enabled: true,
  };
  const existing = await prisma.faq.findFirst({ where: { shop, title } });
  if (!existing) {
    await prisma.faq.create({ data: { shop, ...data } });
    created++;
  } else if (force) {
    await prisma.faq.update({ where: { id: existing.id }, data: { ...data, replyHi: existing.replyHi } });
    updated++;
  } else {
    skipped++;
  }
}
console.log(`Shop ${shop}: ${created} created, ${updated} updated, ${skipped} already present.`);
await prisma.$disconnect();
