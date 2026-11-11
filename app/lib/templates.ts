// Customer-facing texts. House style: a short line, numbered points, one clear next step. No long paragraphs.
export const DEFAULT_TEMPLATES = {
  greeting:
    "Welcome to WERY! 👋\nHow can I help you today?\n\n1. Find a Product\n2. Check Order Status\n3. Track My Shipment\n4. Product Information\n5. Talk to Our Support Team\n\nPlease reply with a number or type your question.",
  askOrderNumber:
    "I couldn't find an order linked to this WhatsApp number. 😕\n\nPlease send either:\n\n1. Your Order Number (Example: #W1219)\n2. Your registered mobile number",
  askOrderDetails:
    "Sure! 😊 How would you like to check your order?\n\n1. Use this WhatsApp number\n2. Send your Order Number (Example: #W1219)\n3. Send your registered mobile number\n\nReply with 1, 2 or 3.",
  typeOrderNumber: "Please type your Order Number. 📦\n\nExample: #W1219",
  typeMobileNumber: "Please type your registered mobile number. 📱\n\nExample: 9876543210",
  askMore: "Anything else I can help with?\n\n1. Find a Product\n2. Check Order Status\n3. Talk to Our Support Team",
  thanksReply: "You're welcome! 😊 Message us anytime you need help.",
  askProductName: "Sure! 😊\nWhich product are you looking for?\n\n1. Type the product name\n2. Or the model / SKU",
  chooseOrder: "I found multiple orders for you. 📦\nReply with the number of the order you want:",
  noOrderFound:
    "Sorry, I could not find any order for those details. 😕\n\nPlease check:\n\n1. Your Order Number (Example: #W1219)\n2. Your registered mobile number\n\nOr type \"agent\" to talk to our team.",
  verificationFailed:
    "Sorry, I couldn't verify that order for this WhatsApp number, so I can't share its details. 🔒\n\n1. Try the order number placed with this number\n2. Or type \"agent\" for help",
  verifyOrderPhone:
    "To protect your order, please send the mobile number registered on it. 🔒\n\nExample: 9876543210",
  verifyPhoneOrder:
    "To protect your account, please also send an Order Number placed with this mobile number. 🔒\n\nExample: #W1219",
  handoff: "Sure! 😊 Connecting you to our support team.\nThey will reply here shortly.",
  humanActive: "Thanks for your patience. 🙏\n\nOur support team has your request and will reply here shortly.",
  botDisabled: "",
  unknown:
    "Sorry, I didn't understand that. 😕\n\nYou can:\n\n1. Send your Order Number\n2. Ask to track a shipment\n3. Ask about a product\n4. Type \"agent\" to talk to our team",
  noProduct: "Sorry, I couldn't find that product. 😕\n\n1. Try another name or model\n2. Or type \"agent\" for help",
  lookupError: "Sorry, something went wrong on our side. 🙏\n\n1. Please try again in a few minutes\n2. Or type \"agent\" for help",
  outsideWindow: "",
  mediaReceived: "📎 Thanks, we received your file.\n\n1. Our team will review it\n2. You can also type your question here",
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
  "greeting", "askOrderNumber", "askOrderDetails", "askMore", "askProductName", "chooseOrder", "noOrderFound", "verificationFailed", "verifyOrderPhone", "verifyPhoneOrder", "handoff", "humanActive", "unknown", "noProduct", "lookupError", "mediaReceived",
];

/** Built-in Hindi replies, used when the customer writes in Hindi/Hinglish. */
export const TEMPLATES_HI: Templates = {
  greeting:
    "WERY में आपका स्वागत है! 👋\nमैं आपकी कैसे मदद करूँ?\n\n1. प्रोडक्ट खोजें\n2. ऑर्डर की स्थिति देखें\n3. मेरा शिपमेंट ट्रैक करें\n4. प्रोडक्ट की जानकारी\n5. सपोर्ट टीम से बात करें\n\nकृपया संख्या लिखकर भेजें या अपना सवाल लिखें।",
  askOrderNumber:
    "इस WhatsApp नंबर से जुड़ा कोई ऑर्डर नहीं मिला। 😕\n\nकृपया इनमें से एक भेजें:\n\n1. आपका ऑर्डर नंबर (जैसे #W1219)\n2. आपका रजिस्टर्ड मोबाइल नंबर",
  askOrderDetails:
    "ज़रूर! 😊 आप ऑर्डर कैसे देखना चाहेंगे?\n\n1. इसी WhatsApp नंबर से\n2. अपना ऑर्डर नंबर भेजें (जैसे #W1219)\n3. अपना रजिस्टर्ड मोबाइल नंबर भेजें\n\nकृपया 1, 2 या 3 लिखें।",
  typeOrderNumber: "कृपया अपना ऑर्डर नंबर लिखें। 📦\n\nजैसे: #W1219",
  typeMobileNumber: "कृपया अपना रजिस्टर्ड मोबाइल नंबर लिखें। 📱\n\nजैसे: 9876543210",
  askMore: "क्या मैं और किसी चीज़ में मदद कर सकता हूँ?\n\n1. प्रोडक्ट खोजें\n2. ऑर्डर की स्थिति देखें\n3. सपोर्ट टीम से बात करें",
  thanksReply: "आपका स्वागत है! 😊 जब भी मदद चाहिए, हमें मैसेज करें।",
  askProductName: "ज़रूर! 😊\nआपको कौन सा प्रोडक्ट चाहिए?\n\n1. प्रोडक्ट का नाम लिखें\n2. या मॉडल / SKU लिखें",
  chooseOrder: "आपके कई ऑर्डर मिले हैं। 📦\nजो ऑर्डर चाहिए उसकी संख्या लिखकर भेजें:",
  noOrderFound:
    "माफ़ कीजिए, इन जानकारियों से कोई ऑर्डर नहीं मिला। 😕\n\nकृपया जाँचें:\n\n1. आपका ऑर्डर नंबर (जैसे #W1219)\n2. आपका रजिस्टर्ड मोबाइल नंबर\n\nया हमारी टीम से बात करने के लिए \"agent\" लिखें।",
  verificationFailed:
    "माफ़ कीजिए, यह ऑर्डर इस WhatsApp नंबर से सत्यापित नहीं हो सका, इसलिए जानकारी साझा नहीं कर सकता। 🔒\n\n1. इसी नंबर से किए गए ऑर्डर का नंबर भेजें\n2. या मदद के लिए \"agent\" लिखें",
  verifyOrderPhone:
    "आपके ऑर्डर की सुरक्षा के लिए, कृपया इस ऑर्डर पर रजिस्टर्ड मोबाइल नंबर भेजें। 🔒\n\nजैसे: 9876543210",
  verifyPhoneOrder:
    "आपकी सुरक्षा के लिए, कृपया इस मोबाइल नंबर से किया गया कोई ऑर्डर नंबर भी भेजें। 🔒\n\nजैसे: #W1219",
  handoff: "ज़रूर! 😊 मैं आपको हमारी सपोर्ट टीम से जोड़ रहा हूँ।\nवे जल्द ही यहीं जवाब देंगे।",
  humanActive: "आपके धैर्य के लिए धन्यवाद। 🙏\n\nहमारी सपोर्ट टीम को आपका अनुरोध मिल गया है और वे जल्द ही यहीं जवाब देंगे।",
  botDisabled: "",
  unknown:
    "माफ़ कीजिए, मैं समझ नहीं पाया। 😕\n\nआप ये कर सकते हैं:\n\n1. अपना ऑर्डर नंबर भेजें\n2. शिपमेंट ट्रैक करवाएँ\n3. प्रोडक्ट के बारे में पूछें\n4. टीम से बात करने के लिए \"agent\" लिखें",
  noProduct: "माफ़ कीजिए, यह प्रोडक्ट नहीं मिला। 😕\n\n1. कोई दूसरा नाम या मॉडल आज़माएँ\n2. या मदद के लिए \"agent\" लिखें",
  lookupError: "माफ़ कीजिए, कुछ गड़बड़ हो गई। 🙏\n\n1. कृपया कुछ देर बाद फिर कोशिश करें\n2. या मदद के लिए \"agent\" लिखें",
  outsideWindow: "",
  mediaReceived: "📎 धन्यवाद, आपकी फ़ाइल मिल गई।\n\n1. हमारी टीम इसे देखेगी\n2. आप अपना सवाल भी यहीं लिख सकते हैं",
  unsupportedLanguage: "माफ़ कीजिए, मैं अभी English, हिंदी और Hinglish में जवाब दे सकता हूँ। कृपया इनमें से किसी एक में लिखें। 🙏",
};

export const LABELS = {
  en: {
    intro: "Your order details: 📦", orderNo: "Order Number", date: "Order Date", status: "Order Status", fulfillment: "Fulfillment Status",
    payment: "Payment", total: "Total", items: "Items", shipment: "Shipment", shipStatus: "Shipment Status", courier: "Courier", trackNo: "Tracking ID",
    trackLink: "Tracking Link", eta: "Expected Delivery", trackIntro: "Tracking details: 🚚",
    noTracking: "Tracking details are not available yet. We'll have them here as soon as the order ships.", statusPage: "Order status page",
    thanks: "Thank you for shopping with WERY! 🙏", cancelled: "Cancelled", closed: "Completed", active: "Active", unknownStatus: "Unknown",
    found: "Here's what I found: 🔎", more: "You may also like: ✨", inStock: "In stock", from: "from",
    price: "Price", compareAt: "Compare-at price", save: "You save", description: "Description", stock: "Availability",
    link: "Link", pickProduct: (n: number) => `Reply with a number (1-${n}) or the product name for full details.`,
    pick: (n: number) => `Reply with a number between 1 and ${n}.`, locale: "en-IN",
    details: "Here are the key details:", comboIntro: "Here is what you get in this combo: 🎁", mainProduct: "Main Product", included: "Included", optional: "Optional (not included)",
    comboPrice: "Combo Price", warranty: "Warranty", viewProduct: "View Product", viewCombo: "View Combo", options: "Options",
    noDetails: "I couldn't find detailed specifications for this product.",
    comboUnclear: "I can't see the exact items of this combo in the listing, so I won't guess.",
    askTeam: "Type \"agent\" and our team will confirm the details for you.",
    piece: "Piece", pieces: "Pieces", pack: "Pack", packs: "Packs",
  },
  hi: {
    intro: "आपके ऑर्डर की जानकारी: 📦", orderNo: "ऑर्डर नंबर", date: "ऑर्डर की तारीख", status: "ऑर्डर स्टेटस", fulfillment: "डिलीवरी स्थिति",
    payment: "भुगतान", total: "कुल", items: "प्रोडक्ट", shipment: "शिपमेंट", shipStatus: "शिपमेंट स्थिति", courier: "कूरियर", trackNo: "ट्रैकिंग नंबर",
    trackLink: "ट्रैकिंग लिंक", eta: "अनुमानित डिलीवरी", trackIntro: "ट्रैकिंग की जानकारी: 🚚",
    noTracking: "ट्रैकिंग की जानकारी अभी उपलब्ध नहीं है। ऑर्डर शिप होते ही यहीं मिल जाएगी।", statusPage: "ऑर्डर स्टेटस पेज",
    thanks: "WERY से खरीदारी करने के लिए धन्यवाद! 🙏", cancelled: "रद्द", closed: "पूरा हुआ", active: "सक्रिय", unknownStatus: "अज्ञात",
    found: "मुझे यह मिला: 🔎", more: "आपको ये भी पसंद आ सकते हैं: ✨", inStock: "स्टॉक में उपलब्ध", from: "से शुरू",
    price: "कीमत", compareAt: "पुरानी कीमत (MRP)", save: "आपकी बचत", description: "विवरण", stock: "उपलब्धता",
    link: "लिंक", pickProduct: (n: number) => `पूरी जानकारी के लिए 1-${n} में से संख्या या प्रोडक्ट का नाम लिखकर भेजें।`,
    pick: (n: number) => `कृपया 1 से ${n} के बीच की संख्या लिखकर भेजें।`, locale: "hi-IN",
    details: "ये मुख्य जानकारी है:", comboIntro: "इस कॉम्बो में आपको यह मिलेगा: 🎁", mainProduct: "मुख्य प्रोडक्ट", included: "शामिल", optional: "वैकल्पिक (शामिल नहीं)",
    comboPrice: "कॉम्बो की कीमत", warranty: "वारंटी", viewProduct: "प्रोडक्ट देखें", viewCombo: "कॉम्बो देखें", options: "विकल्प",
    noDetails: "इस प्रोडक्ट की पूरी स्पेसिफिकेशन नहीं मिली।",
    comboUnclear: "लिस्टिंग में इस कॉम्बो के आइटम साफ़ नहीं दिख रहे, इसलिए मैं अंदाज़ा नहीं लगाऊँगा।",
    askTeam: "\"agent\" लिखें, हमारी टीम आपको सही जानकारी देगी।",
    piece: "पीस", pieces: "पीस", pack: "पैक", packs: "पैक",
  },
} as const;

const STATUS_HI: Record<string, string> = {
  FULFILLED: "भेज दिया गया (Fulfilled)", UNFULFILLED: "प्रोसेस हो रहा है (Unfulfilled)",
  PARTIALLY_FULFILLED: "आंशिक रूप से भेजा गया", IN_PROGRESS: "प्रोसेस हो रहा है", ON_HOLD: "होल्ड पर",
  PAID: "भुगतान हो गया (Paid)", PENDING: "लंबित (Pending)", AUTHORIZED: "अधिकृत (Authorized)",
  REFUNDED: "रिफ़ंड हो गया", PARTIALLY_REFUNDED: "आंशिक रिफ़ंड", PARTIALLY_PAID: "आंशिक भुगतान", VOIDED: "रद्द (Voided)",
  IN_TRANSIT: "रास्ते में (In Transit)", OUT_FOR_DELIVERY: "डिलीवरी के लिए निकला", DELIVERED: "डिलीवर हो गया", ATTEMPTED_DELIVERY: "डिलीवरी का प्रयास हुआ",
};
export const statusHi = (s: string | null) => (s && STATUS_HI[s]) || null;
