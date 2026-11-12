import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { normalizePhone, samePhone, phoneSearchVariants } from "../app/lib/phone.ts";
import { detectIntent, parseSelection, productTerms } from "../app/lib/intent.ts";
import { resolveTrackingUrl } from "../app/lib/tracking.ts";
import { verifyMetaSignature } from "../app/lib/signature.ts";
import { parseBridgeMessage } from "../app/lib/bridge-parse.ts";
import { detectLanguage } from "../app/lib/lang.ts";
import { matchFaq, pickFaqReply } from "../app/lib/faq.ts";
import { mergeTemplates, DEFAULT_TEMPLATES } from "../app/lib/templates.ts";

test("phone normalisation covers Indian variants", () => {
  for (const v of ["9876543210", "09876543210", "919876543210", "+91 98765-43210", "0091 9876543210"]) {
    assert.equal(normalizePhone(v), "+919876543210", v);
  }
  assert.equal(normalizePhone("12345"), null);
  assert.equal(normalizePhone(""), null);
  assert.equal(samePhone("9876543210", "+919876543211"), false);
  assert.equal(samePhone(null, null), false);
  assert.ok(phoneSearchVariants("+919876543210").includes("9876543210"));
});

test("intent detection", () => {
  assert.equal(detectIntent("I want to talk to a human").type, "agent");
  assert.deepEqual(detectIntent("where is my order #1001"), { type: "tracking", orderNumber: "1001" });
  assert.deepEqual(detectIntent("order status"), { type: "order", orderNumber: undefined });
  assert.deepEqual(detectIntent("do you have HP laser printer?"), { type: "product", query: "hp laser printer" });
  assert.equal(detectIntent("hello").type, "greeting");
  assert.equal(detectIntent("asdf").type, "unknown");
  assert.equal(parseSelection("2", 3), 2);
  assert.equal(parseSelection("5", 3), null);
  assert.equal(parseSelection("two", 3), null);
});

test("tracking url: Delhivery opens with the id filled in, other couriers keep the Shopify url", () => {
  assert.equal(resolveTrackingUrl({ url: "https://x.example/t/1", number: "1", company: "Bluedart" }), "https://x.example/t/1");
  // Delhivery: always the direct page with the tracking id in the address (even when Shopify sent its own url).
  assert.equal(
    resolveTrackingUrl({ url: "https://x.example/t/1", number: "1234567890123", company: "Delhivery Surface" }),
    "https://www.delhivery.com/track-v2/package/1234567890123",
  );
  assert.equal(
    resolveTrackingUrl({ number: "1234567890123", company: "Delhivery" }),
    "https://www.delhivery.com/track-v2/package/1234567890123",
  );
  assert.equal(
    resolveTrackingUrl({ url: "https://www.delhivery.com/?tracking-id=1234567890123", number: "1234567890123" }),
    "https://www.delhivery.com/track-v2/package/1234567890123",
  );
  assert.equal(resolveTrackingUrl({ number: "1234567890123", company: "Other" }), null);
  assert.equal(resolveTrackingUrl({ number: "bad number!", company: "Delhivery" }), null);
  assert.equal(resolveTrackingUrl({ url: "javascript:alert(1)" }), null);
  assert.equal(resolveTrackingUrl({}), null);
});

test("webhook signature validation", () => {
  const body = '{"a":1}';
  const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
  assert.equal(verifyMetaSignature(body, sig, "s3cret"), true);
  assert.equal(verifyMetaSignature(body + " ", sig, "s3cret"), false);
  assert.equal(verifyMetaSignature(body, sig, "other"), false);
  assert.equal(verifyMetaSignature(body, null, "s3cret"), false);
  assert.equal(verifyMetaSignature(body, "sha256=zz", "s3cret"), false);
});

test("templates fall back to defaults and tolerate bad JSON", () => {
  assert.equal(mergeTemplates("not json").greeting, DEFAULT_TEMPLATES.greeting);
  assert.equal(mergeTemplates('{"greeting":"Hi!"}').greeting, "Hi!");
  assert.equal(mergeTemplates('{"greeting":"  "}').greeting, DEFAULT_TEMPLATES.greeting);
});

test("bridge message parsing", () => {
  const ok = parseBridgeMessage({ key: { id: "A1", remoteJid: "919876543210@s.whatsapp.net" }, message: { conversation: "hi" }, pushName: "Ravi" });
  assert.equal(ok?.payload.from, "919876543210");
  assert.equal(ok?.payload.text, "hi");
  assert.equal(parseBridgeMessage({ key: { id: "A2", remoteJid: "1@g.us" }, message: { conversation: "x" } }), null);
  assert.equal(parseBridgeMessage({ key: { id: "A3", remoteJid: "919876543210@s.whatsapp.net", fromMe: true }, message: { conversation: "x" } }), null);
  const lid = parseBridgeMessage({ key: { id: "A4", remoteJid: "123@lid", remoteJidAlt: "919876543210@s.whatsapp.net" }, message: { extendedTextMessage: { text: "track" } } });
  assert.equal(lid?.payload.from, "919876543210");
  assert.equal(parseBridgeMessage({ key: { id: "A5", remoteJid: "status@broadcast" }, message: { conversation: "x" } }), null);
});

test("language detection: English, Hindi script and Hinglish", () => {
  assert.equal(detectLanguage("where is my order"), "en");
  assert.equal(detectLanguage("मेरा ऑर्डर कहाँ है"), "hi");
  assert.equal(detectLanguage("mera order kahan hai"), "hinglish");
  assert.equal(detectLanguage("website ka link bhejo"), "hinglish");
  assert.equal(detectLanguage("2"), null);
  assert.equal(detectLanguage("#1001"), null);
  assert.equal(detectLanguage("do you have a laser printer"), "en");
});

test("intent understands Hindi and Hinglish", () => {
  assert.equal(detectIntent("मेरा ऑर्डर कहाँ है").type, "tracking");
  assert.equal(detectIntent("mera order kahan hai").type, "tracking");
  assert.equal(detectIntent("मुझे एजेंट से बात करनी है").type, "agent");
  assert.deepEqual(detectIntent("laser printer chahiye"), { type: "product", query: "laser printer" });
  assert.equal(detectIntent("नमस्ते").type, "greeting");
  assert.deepEqual(detectIntent("ऑर्डर नंबर 1002"), { type: "order", orderNumber: "1002" });
});

test("FAQ matching and language-specific replies", () => {
  const faqs = [
    { keywords: "website, वेबसाइट", replyEn: "Visit https://wery.in", replyHi: "वेबसाइट: https://wery.in", enabled: true },
    { keywords: "return policy, return", replyEn: "EN return", replyHi: "", enabled: true },
    { keywords: "id", replyEn: "no", replyHi: "no", enabled: true },
    { keywords: "price", replyEn: "off", replyHi: "off", enabled: false },
  ];
  assert.equal(matchFaq("what is your website?", faqs)?.replyEn, "Visit https://wery.in");
  assert.equal(matchFaq("आपकी वेबसाइट क्या है", faqs)?.replyHi, "वेबसाइट: https://wery.in");
  assert.equal(matchFaq("send a video", faqs), null); // "id" must not match inside "video"
  assert.equal(matchFaq("price please", faqs), null); // disabled
  const hit = matchFaq("return policy?", faqs)!;
  assert.equal(pickFaqReply(hit, "hi"), "EN return"); // falls back when Hindi is empty
  assert.equal(pickFaqReply(faqs[0], "hi"), "वेबसाइट: https://wery.in");
  assert.equal(pickFaqReply(faqs[0], "en"), "Visit https://wery.in");
});

test("FAQ matching stays fast with 100k phrases", () => {
  const kw = Array.from({ length: 100_000 }, (_, i) => `phrase number ${i} here`).join(", ");
  const faqs = [
    { keywords: kw, replyEn: "big", replyHi: "", enabled: true },
    { keywords: "refund kab milega", replyEn: "refund", replyHi: "", enabled: true },
  ];
  matchFaq("warm up", faqs); // builds the index once
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) matchFaq("hi bhai refund kab milega please", faqs);
  const per = (performance.now() - t0) / 200;
  assert.equal(matchFaq("hi bhai refund kab milega please", faqs)?.replyEn, "refund");
  assert.equal(matchFaq("phrase number 99999 here", faqs)?.replyEn, "big");
  assert.ok(per < 5, `lookup took ${per}ms`);
});

test("API keys are encrypted at rest and round-trip", async () => {
  process.env.SHOPIFY_API_SECRET = "test-app-secret";
  const { encryptSecret, decryptSecret } = await import("../app/lib/secret.server.ts");
  const blob = encryptSecret("sk-test-1234567890abcdef");
  assert.ok(!blob.includes("sk-test"));
  assert.equal(decryptSecret(blob), "sk-test-1234567890abcdef");
  assert.equal(decryptSecret(blob.slice(0, -4) + "AAAA"), null); // tampered
  process.env.SHOPIFY_API_SECRET = "other-secret";
  assert.equal(decryptSecret(blob), null); // wrong key
});

test("fuzzy FAQ matching on imported questions", () => {
  const faq = (questions: string, extra = {}) => ({
    keywords: "", questions, replyEn: "EN", replyHi: "", replyHinglish: "HING", enabled: true, ...extra,
  });
  const cancel = faq("Can I cancel my order?\nOrder cancel karna hai\nOrder cancel ho sakta hai?", { replyEn: "cancel-en" });
  const refund = faq("How long will my refund take?\nRefund kitne din mein aayega?", { replyEn: "refund-en" });
  const rto = faq("What does RTO mean?\nRTO ka matlab kya hai?", { replyEn: "rto-en" });
  const faqs = [cancel, refund, rto];
  assert.equal(matchFaq("i want to cancel my order please", faqs)?.replyEn, "cancel-en");
  assert.equal(matchFaq("order cancel karna hai", faqs)?.replyEn, "cancel-en");
  assert.equal(matchFaq("refund kitne din me aayega", faqs)?.replyEn, "refund-en");
  assert.equal(matchFaq("rto ka matlab kya hai", faqs)?.replyEn, "rto-en");
  assert.equal(matchFaq("what is the weather today", faqs), null);
  assert.equal(matchFaq("cancel", faqs), null); // one word is too ambiguous
  assert.equal(pickFaqReply(cancel, "hinglish"), "HING");
  assert.equal(pickFaqReply(cancel, "hi"), "HING"); // no Devanagari reply: falls back to Hinglish
  assert.equal(pickFaqReply(cancel, "en"), "cancel-en");
});

test("language detection: other scripts are routed for translation", () => {
  for (const t of ["என் ஆர்டர் எங்கே", "আমার অর্ডার কোথায়", "میرا آرڈر کہاں ہے", "ਮੇਰਾ ਆਰਡਰ ਕਿੱਥੇ ਹੈ", "我的订单在哪里"]) {
    assert.equal(detectLanguage(t), "other", t);
  }
  assert.equal(detectLanguage("hello there 👍"), "en");
  assert.equal(detectLanguage("👍"), null);
});

test("media message parsing", () => {
  const img = parseBridgeMessage({ key: { id: "M1", remoteJid: "919876543210@s.whatsapp.net" }, message: { imageMessage: { mimetype: "image/jpeg", caption: "damaged box" } } });
  assert.equal(img?.payload.type, "image");
  assert.equal(img?.payload.text, "damaged box");
  assert.equal(img?.payload.media?.kind, "image");
  const doc = parseBridgeMessage({ key: { id: "M2", remoteJid: "919876543210@s.whatsapp.net" }, message: { documentWithCaptionMessage: { message: { documentMessage: { mimetype: "application/pdf", fileName: "invoice.pdf" } } } } });
  assert.equal(doc?.payload.media?.name, "invoice.pdf");
  assert.equal(doc?.payload.text, "");
  const eph = parseBridgeMessage({ key: { id: "M3", remoteJid: "919876543210@s.whatsapp.net" }, message: { ephemeralMessage: { message: { conversation: "hi" } } } });
  assert.equal(eph?.payload.text, "hi");
});

test("media links are signed, expire, and uploads are sandboxed by name", async () => {
  process.env.SHOPIFY_API_SECRET = "media-test-secret";
  const m = await import("../app/lib/media.server.ts");
  const url = new URL("http://x" + m.signedMediaUrl("abc123abc123abc123abc123"));
  const [exp, sig] = [url.searchParams.get("exp"), url.searchParams.get("sig")];
  assert.equal(m.verifyMediaSignature("abc123abc123abc123abc123", exp, sig), true);
  assert.equal(m.verifyMediaSignature("other0other0other0other0", exp, sig), false);
  assert.equal(m.verifyMediaSignature("abc123abc123abc123abc123", String(Number(exp) - 999_999), sig), false);
  assert.equal(m.mediaFilePath("../../etc/passwd"), null);
  assert.equal(m.mediaFilePath("deadbeefdeadbeefdeadbeef.jpg"), null); // well-formed but absent
  assert.equal(m.kindFromMime("application/pdf"), "document");
  assert.equal(m.INLINE_MIME.has("image/svg+xml"), false);
});

test("product terms: any single word works, filler is dropped", () => {
  assert.deepEqual(productTerms("printer"), ["printer"]);
  assert.deepEqual(productTerms("mujhe laser printers ka price batao"), ["laser", "printer"]);
  assert.deepEqual(productTerms("thanks"), []);
  assert.deepEqual(productTerms("how are you"), []);
});
