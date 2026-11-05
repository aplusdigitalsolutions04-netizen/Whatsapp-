// Seeds customer-question phrases (English, Hinglish, Hindi) for common store topics.
// Replies are intentionally EMPTY and the entries are OFF: the answer must come from your real
// policy. Fill each reply on the Quick replies page; it switches on automatically when saved.
//
//   npm run seed:faq            (re-running only adds new phrases; your replies are never touched)
//
// Order status / tracking / agent requests are NOT here: the bot handles those itself.
import { PrismaClient } from "@prisma/client";

const TOPICS = {
  Returns: [
    "return policy", "returns policy", "can i return", "how to return", "how do i return", "return process", "return window",
    "return period", "return allowed", "is return available", "want to return", "return the product", "return karna hai",
    "return kaise kare", "return kaise karu", "return policy kya hai", "return ho sakta hai", "wapas kar sakte hain",
    "product wapas karna hai", "वापसी की नीति", "रिटर्न पॉलिसी", "रिटर्न कैसे करें", "रिटर्न करना है", "सामान वापस करना है",
    "प्रोडक्ट वापस करना है", "रिटर्न हो सकता है",
  ],
  Refund: [
    "refund policy", "when will i get refund", "refund kab milega", "refund kab aayega", "refund timeline", "refund time",
    "how long for refund", "refund process", "money back", "get my money back", "paise wapas", "paise wapas chahiye",
    "paisa kab wapas milega", "refund status", "refund nahi mila", "refund not received", "रिफंड कब मिलेगा", "रिफंड पॉलिसी",
    "पैसे वापस चाहिए", "पैसे कब वापस मिलेंगे", "रिफंड नहीं मिला", "रिफंड कब आएगा",
  ],
  Exchange: [
    "exchange policy", "can i exchange", "exchange the product", "how to exchange", "exchange karna hai", "exchange kaise kare",
    "exchange ho sakta hai", "replace the product", "replacement policy", "product replace karna hai", "replacement chahiye",
    "एक्सचेंज पॉलिसी", "एक्सचेंज करना है", "बदलना है", "प्रोडक्ट बदलना है", "रिप्लेसमेंट चाहिए", "बदल सकते हैं",
  ],
  Cancellation: [
    "cancel my order", "cancel order", "how to cancel", "cancellation policy", "can i cancel", "want to cancel",
    "order cancel karna hai", "order cancel kaise kare", "cancel karna hai", "cancel kar do", "cancellation charges",
    "ऑर्डर कैंसिल करना है", "कैंसिल करना है", "ऑर्डर रद्द करना है", "कैंसल कैसे करें", "कैंसिलेशन पॉलिसी",
  ],
  "Payment methods": [
    "payment methods", "payment options", "how can i pay", "what payment modes", "do you accept upi", "upi accepted",
    "accept credit card", "accept debit card", "net banking", "payment kaise kare", "payment kaise karu", "kaise pay kare",
    "upi se payment", "card se payment", "पेमेंट कैसे करें", "भुगतान कैसे करें", "भुगतान के तरीके", "यूपीआई से पेमेंट",
    "कार्ड से पेमेंट", "पेमेंट ऑप्शन",
  ],
  "Cash on delivery": [
    "cash on delivery", "cod available", "is cod available", "do you have cod", "cod option", "pay on delivery",
    "cod hai kya", "cod milega", "cod milta hai", "cod available hai", "delivery par payment", "कैश ऑन डिलीवरी",
    "सीओडी उपलब्ध है", "कैश ऑन डिलीवरी मिलेगा", "डिलीवरी पर पेमेंट", "सीओडी है क्या",
  ],
  "Payment failed": [
    "payment failed", "payment not going through", "money deducted", "amount deducted but order not placed",
    "paise kat gaye", "paisa kat gaya", "payment fail ho gaya", "payment nahi ho raha", "payment stuck",
    "double payment", "charged twice", "पेमेंट फेल हो गया", "पैसे कट गए", "पेमेंट नहीं हो रहा", "पैसा कट गया ऑर्डर नहीं हुआ",
  ],
  "Delivery time": [
    "how long will delivery take", "how many days for delivery", "delivery time", "delivery timeline", "estimated delivery",
    "when will it be delivered", "kitne din me delivery", "delivery kitne din me hogi", "kitne din lagenge", "delivery time kya hai",
    "kab tak milega", "kab tak pahunchega", "डिलीवरी में कितने दिन लगेंगे", "डिलीवरी कब तक होगी", "कितने दिन में मिलेगा",
    "डिलीवरी का समय", "कब तक पहुंचेगा",
  ],
  "Shipping charges": [
    "shipping charges", "shipping cost", "delivery charges", "delivery charge", "is delivery free", "free shipping",
    "free delivery", "shipping fee", "delivery fee", "shipping kitna lagega", "delivery charge kitna hai", "shipping free hai kya",
    "free delivery hai", "शिपिंग चार्ज", "डिलीवरी चार्ज", "फ्री डिलीवरी", "शिपिंग फ्री है क्या", "डिलीवरी चार्ज कितना है",
  ],
  "International shipping": [
    "international shipping", "ship internationally", "do you ship abroad", "ship outside india", "deliver overseas",
    "worldwide shipping", "shipping to usa", "shipping to uk", "shipping to dubai", "videsh me delivery", "bahar deliver karte ho",
    "विदेश में डिलीवरी", "इंटरनेशनल शिपिंग", "बाहर देश में भेजते हैं", "विदेश भेज सकते हैं",
  ],
  "Damaged or wrong item": [
    "received damaged", "damaged product", "product is damaged", "broken product", "item broken", "wrong product received",
    "wrong item delivered", "received wrong item", "missing item", "item missing in package", "defective product",
    "product kharab aaya", "toota hua aaya", "galat product aaya", "galat item mila", "product damage aaya", "kharab product",
    "खराब प्रोडक्ट आया", "टूटा हुआ सामान आया", "गलत प्रोडक्ट आया", "गलत सामान मिला", "प्रोडक्ट खराब है", "डैमेज प्रोडक्ट",
  ],
  "Change address": [
    "change address", "change delivery address", "update address", "wrong address", "edit shipping address",
    "address change karna hai", "address badalna hai", "address galat daal diya", "pata badalna hai", "address update karna hai",
    "पता बदलना है", "एड्रेस चेंज करना है", "डिलीवरी एड्रेस बदलना है", "पता गलत डाल दिया", "एड्रेस अपडेट",
  ],
  "Invoice and GST": [
    "gst invoice", "gst bill", "need invoice", "tax invoice", "invoice copy", "download invoice", "send invoice",
    "bill chahiye", "invoice chahiye", "gst bill chahiye", "gst number", "gst wala bill", "bill bhej do",
    "जीएसटी बिल", "बिल चाहिए", "इनवॉइस चाहिए", "जीएसटी इनवॉइस", "बिल भेज दो", "जीएसटी नंबर",
  ],
  Warranty: [
    "warranty", "is there warranty", "warranty period", "warranty policy", "how much warranty", "warranty claim",
    "guarantee", "guarantee period", "warranty kitni hai", "warranty hai kya", "warranty milegi", "kitne saal ki warranty",
    "वारंटी", "वारंटी कितनी है", "वारंटी है क्या", "गारंटी", "वारंटी पॉलिसी", "कितने साल की वारंटी",
  ],
  Authenticity: [
    "is it original", "is this genuine", "original product", "genuine product", "authentic product", "is it authentic",
    "fake or original", "100% original", "original hai kya", "genuine hai kya", "asli hai ya nakli", "duplicate to nahi",
    "ओरिजिनल है क्या", "असली है या नकली", "जेन्युइन प्रोडक्ट", "ओरिजिनल प्रोडक्ट", "नकली तो नहीं",
  ],
  "Discount and offers": [
    "any discount", "discount available", "coupon code", "promo code", "any offers", "current offers", "sale going on",
    "any sale", "festival offer", "discount milega", "discount hai kya", "koi offer hai", "coupon code chahiye", "offer kya chal raha hai",
    "डिस्काउंट", "डिस्काउंट मिलेगा", "कोई ऑफर है", "कूपन कोड", "सेल कब है", "छूट मिलेगी", "ऑफर क्या चल रहा है",
  ],
  "Bulk orders": [
    "bulk order", "bulk purchase", "wholesale", "wholesale price", "bulk discount", "buy in bulk", "corporate order",
    "dealer price", "reseller", "bulk me lena hai", "thok me chahiye", "wholesale rate", "dealership",
    "बल्क ऑर्डर", "थोक में चाहिए", "होलसेल", "थोक भाव", "डीलरशिप", "बल्क में खरीदना है",
  ],
  "Store location": [
    "store address", "shop address", "where is your shop", "where is your store", "store location", "visit your store",
    "offline store", "showroom", "do you have a shop", "dukan kahan hai", "shop kahan hai", "aapki dukan kahan hai",
    "store ka address", "showroom kahan hai", "दुकान कहाँ है", "दुकान का पता", "स्टोर कहाँ है", "शोरूम कहाँ है", "आपका पता क्या है",
  ],
  "Contact and timings": [
    "contact number", "phone number", "customer care number", "email address", "support email", "working hours",
    "business hours", "store timing", "shop timing", "when are you open", "kab tak khula hai", "timing kya hai",
    "contact number do", "phone number chahiye", "संपर्क नंबर", "फोन नंबर", "कस्टमर केयर नंबर", "दुकान का समय",
    "कब खुलते हैं", "ईमेल पता",
  ],
  EMI: [
    "emi available", "emi option", "do you have emi", "no cost emi", "pay in installments", "easy installments", "emi on credit card",
    "emi hai kya", "emi milegi", "kisto me payment", "emi par milega", "ईएमआई उपलब्ध है", "ईएमआई है क्या", "किश्तों में पेमेंट", "ईएमआई मिलेगी",
  ],
  "Installation and demo": [
    "installation", "free installation", "installation charges", "who will install", "demo available", "product demo",
    "installation kaun karega", "installation hota hai", "demo milega", "demo chahiye", "setup help", "setup kaise kare",
    "इंस्टॉलेशन", "फ्री इंस्टॉलेशन", "इंस्टॉल कौन करेगा", "डेमो चाहिए", "सेटअप कैसे करें",
  ],
  "Delivery areas": [
    "do you deliver to my pincode", "pincode serviceable", "check pincode", "delivery available in my area", "deliver to my city",
    "which cities do you deliver", "delivery areas", "mere pincode par delivery", "mere shahar me delivery", "pincode check karna hai",
    "meri jagah delivery hogi", "मेरे पिनकोड पर डिलीवरी", "पिनकोड चेक करना है", "मेरे शहर में डिलीवरी", "किन शहरों में डिलीवरी होती है",
  ],
};

const prisma = new PrismaClient();

async function resolveShop() {
  if (process.env.SHOPIFY_STORE_DOMAIN) return process.env.SHOPIFY_STORE_DOMAIN;
  const s = await prisma.session.findFirst({ where: { isOnline: false }, orderBy: { expires: "desc" } });
  return s?.shop ?? null;
}

const shop = await resolveShop();
if (!shop) {
  console.error("No shop found. Install the app on your store first (or set SHOPIFY_STORE_DOMAIN).");
  process.exit(1);
}

// Phrases already claimed by existing entries must not be duplicated into another topic.
const existing = await prisma.faq.findMany({ where: { shop } });
const claimed = new Set();
for (const f of existing) for (const k of f.keywords.split(",")) claimed.add(k.trim().toLowerCase());

let phrases = 0;
let topics = 0;
for (const [name, list] of Object.entries(TOPICS)) {
  const title = `Auto: ${name}`;
  const row = existing.find((f) => f.title === title);
  const own = new Set(row ? row.keywords.split(",").map((k) => k.trim().toLowerCase()) : []);
  const fresh = [...new Set(list.map((p) => p.trim().toLowerCase()))].filter((p) => !own.has(p) && !claimed.has(p));
  if (!fresh.length) continue;
  fresh.forEach((p) => claimed.add(p));
  phrases += fresh.length;
  if (row) {
    await prisma.faq.update({ where: { id: row.id }, data: { keywords: [...own, ...fresh].filter(Boolean).join(", ") } });
  } else {
    await prisma.faq.create({ data: { shop, title, keywords: fresh.join(", "), replyEn: "", replyHi: "", enabled: false } });
    topics++;
  }
}
console.log(`Shop ${shop}: added ${phrases} phrases (${topics} new topics). Fill the replies on the Quick replies page.`);
await prisma.$disconnect();
