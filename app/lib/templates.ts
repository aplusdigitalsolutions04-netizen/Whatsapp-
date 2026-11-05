export const DEFAULT_TEMPLATES = {
  greeting: "👋 Hi! Welcome to WERY. I can help you find products, compare models, check order tracking, understand returns, or request a bulk quotation. What do you need help with?",
  askOrderNumber: "I couldn't find an order linked to this WhatsApp number. Please send your order number (for example #1001).",
  chooseOrder: "I found multiple orders for this number. Reply with the number of the order you want:",
  noOrderFound: "I checked this WhatsApp number and the order number you sent, but I could not find any order for you. It looks like you have no order with us yet. If you think this is a mistake, type \"agent\" and our team will check.",
  verificationFailed: "Sorry, I couldn't verify that order against this WhatsApp number, so I can't share its details. Please try again with the order number placed using this number.",
  handoff: "Sure, I'm connecting you with a member of our team. They'll reply here shortly.",
  humanActive: "",
  botDisabled: "",
  unknown: "Sorry, I didn't catch that. You can send an order number, ask to track a shipment, ask about a product, or type \"agent\" to talk to a person.",
  noProduct: "Sorry, this product is currently unavailable. Try a different name or SKU, or type \"agent\" for help.",
  lookupError: "Sorry, I'm having trouble looking that up right now. Please try again in a few minutes or type \"agent\" for help.",
  outsideWindow: "",
  mediaReceived: "📎 Thanks, we received your file. Our team will review it. You can also type your question and I will help right away.",
  unsupportedLanguage: "Sorry, I can reply in English, हिंदी and Hinglish right now. Please write your message in one of these. 🙏",
} as const;

export type TemplateKey = keyof typeof DEFAULT_TEMPLATES;
export type Templates = Record<TemplateKey, string>;

export function mergeTemplates(stored: string | null | undefined): Templates {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = stored ? JSON.parse(stored) : {};
  } catch {
    /* ignore corrupt JSON */
  }
  const out = { ...DEFAULT_TEMPLATES } as Templates;
  for (const k of Object.keys(DEFAULT_TEMPLATES) as TemplateKey[]) {
    if (typeof parsed[k] === "string" && (parsed[k] as string).trim()) out[k] = parsed[k] as string;
  }
  return out;
}

/** Templates editable in settings (empty-by-design ones excluded). */
export const EDITABLE_TEMPLATES: TemplateKey[] = [
  "greeting", "askOrderNumber", "chooseOrder", "noOrderFound", "verificationFailed", "handoff", "unknown", "noProduct", "lookupError", "mediaReceived",
];

/** Built-in Hindi replies, used when the customer writes in Hindi/Hinglish. */
export const TEMPLATES_HI: Templates = {
  greeting: "👋 नमस्ते! मैं आपके ऑर्डर, शिपमेंट ट्रैकिंग और प्रोडक्ट से जुड़े सवालों में मदद कर सकता हूँ। आज मैं आपकी कैसे मदद करूँ?",
  askOrderNumber: "इस WhatsApp नंबर से जुड़ा कोई ऑर्डर नहीं मिला। कृपया अपना ऑर्डर नंबर भेजें (जैसे #1001)।",
  chooseOrder: "इस नंबर पर कई ऑर्डर मिले हैं। जो ऑर्डर चाहिए उसकी संख्या लिखकर भेजें:",
  noOrderFound: "मैंने इस WhatsApp नंबर और आपके भेजे ऑर्डर नंबर, दोनों से देखा, लेकिन आपका कोई ऑर्डर नहीं मिला। लगता है आपका हमारे साथ अभी कोई ऑर्डर नहीं है। अगर आपको लगता है कि कुछ गड़बड़ है, तो \"agent\" लिखें, हमारी टीम जाँच करेगी।",
  verificationFailed: "माफ़ कीजिए, यह ऑर्डर इस WhatsApp नंबर से सत्यापित नहीं हो सका, इसलिए मैं इसकी जानकारी साझा नहीं कर सकता। कृपया इसी नंबर से किए गए ऑर्डर का नंबर भेजें।",
  handoff: "ज़रूर, मैं आपको हमारी टीम के सदस्य से जोड़ रहा हूँ। वे जल्द ही यहीं जवाब देंगे।",
  humanActive: "",
  botDisabled: "",
  unknown: "माफ़ कीजिए, मैं समझ नहीं पाया। आप ऑर्डर नंबर भेज सकते हैं, शिपमेंट ट्रैक करवा सकते हैं, प्रोडक्ट के बारे में पूछ सकते हैं, या किसी व्यक्ति से बात करने के लिए \"agent\" लिखें।",
  noProduct: "माफ़ कीजिए, यह प्रोडक्ट अभी उपलब्ध नहीं है। कोई दूसरा नाम या SKU आज़माएँ, या मदद के लिए \"agent\" लिखें।",
  lookupError: "माफ़ कीजिए, अभी जानकारी नहीं मिल पा रही। कृपया कुछ देर बाद फिर कोशिश करें या मदद के लिए \"agent\" लिखें।",
  outsideWindow: "",
  mediaReceived: "📎 धन्यवाद, आपकी फ़ाइल मिल गई। हमारी टीम इसे देखेगी। आप अपना सवाल भी लिख सकते हैं, मैं तुरंत मदद करूँगा।",
  unsupportedLanguage: "माफ़ कीजिए, मैं अभी English, हिंदी और Hinglish में जवाब दे सकता हूँ। कृपया इनमें से किसी एक में लिखें। 🙏",
};

export const LABELS = {
  en: {
    hello: "👋 Hello! Here are your order details:", orderNo: "📦 *Order Number*", date: "📅 *Order Date*", status: "🚚 *Status*",
    payment: "💳 *Payment Status*", total: "💰 *Total*", product: "🛍️ *Product*", courier: "🚛 *Courier*", trackNo: "🔢 *Tracking Number*",
    trackLink: "🔗 *Track Your Order*", noTracking: "⏳ Tracking: not available yet. We'll have it here as soon as the order ships.",
    statusPage: "🧾 *Order status page*", thanks: "🙏 Thank you for shopping with us!", cancelled: "Cancelled",
    found: "🔎 Here's what I found:", more: "✨ You may also like:", inStock: "In stock", from: "from",
    price: "💰 *Price*", compareAt: "🏷️ *Compare-at price*", save: "You save", description: "📝 *Description*", stock: "📦 *Availability*",
    link: "🔗 *Link*", pickProduct: (n: number) => `👉 Reply with a number (1-${n}) or the product name to get its full details and photo.`,
    pick: (n: number) => `Reply with a number between 1 and ${n}.`, locale: "en-IN",
  },
  hi: {
    hello: "👋 नमस्ते! आपके ऑर्डर की जानकारी:", orderNo: "📦 *ऑर्डर नंबर*", date: "📅 *ऑर्डर की तारीख*", status: "🚚 *स्थिति*",
    payment: "💳 *भुगतान की स्थिति*", total: "💰 *कुल*", product: "🛍️ *प्रोडक्ट*", courier: "🚛 *कूरियर*", trackNo: "🔢 *ट्रैकिंग नंबर*",
    trackLink: "🔗 *अपना ऑर्डर ट्रैक करें*", noTracking: "⏳ ट्रैकिंग: अभी उपलब्ध नहीं है। ऑर्डर शिप होते ही यहीं मिल जाएगी।",
    statusPage: "🧾 *ऑर्डर स्टेटस पेज*", thanks: "🙏 हमसे खरीदारी करने के लिए धन्यवाद!", cancelled: "रद्द",
    found: "🔎 मुझे यह मिला:", more: "✨ आपको ये भी पसंद आ सकते हैं:", inStock: "स्टॉक में उपलब्ध", from: "से शुरू",
    price: "💰 *कीमत*", compareAt: "🏷️ *पुरानी कीमत (MRP)*", save: "आपकी बचत", description: "📝 *विवरण*", stock: "📦 *उपलब्धता*",
    link: "🔗 *लिंक*", pickProduct: (n: number) => `👉 पूरी जानकारी और फोटो के लिए 1-${n} में से संख्या या प्रोडक्ट का नाम लिखकर भेजें।`,
    pick: (n: number) => `कृपया 1 से ${n} के बीच की संख्या लिखकर भेजें।`, locale: "hi-IN",
  },
} as const;

const STATUS_HI: Record<string, string> = {
  FULFILLED: "भेज दिया गया (Fulfilled)", UNFULFILLED: "प्रोसेस हो रहा है (Unfulfilled)",
  PARTIALLY_FULFILLED: "आंशिक रूप से भेजा गया", IN_PROGRESS: "प्रोसेस हो रहा है", ON_HOLD: "होल्ड पर",
  PAID: "भुगतान हो गया (Paid)", PENDING: "लंबित (Pending)", AUTHORIZED: "अधिकृत (Authorized)",
  REFUNDED: "रिफ़ंड हो गया", PARTIALLY_REFUNDED: "आंशिक रिफ़ंड", PARTIALLY_PAID: "आंशिक भुगतान", VOIDED: "रद्द (Voided)",
};
export const statusHi = (s: string | null) => (s && STATUS_HI[s]) || null;
