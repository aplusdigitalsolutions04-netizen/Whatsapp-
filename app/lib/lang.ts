/** "hi" = Devanagari Hindi, "hinglish" = Hindi in Roman letters, "other" = any other script (Tamil, Bengali, Urdu...). */
export type Lang = "en" | "hi" | "hinglish" | "other";

// Romanised Hindi (Hinglish) words that are very unlikely in plain English text.
const STRONG = new Set([
  "kya", "hai", "hain", "kaise", "kaisa", "kab", "kahan", "kahaan", "kaha", "kidhar", "mujhe", "mera", "meri", "mere",
  "chahiye", "chahie", "nahi", "nhi", "aap", "aapka", "aapki", "kitna", "kitne", "kitni", "batao", "bataiye", "bataye",
  "dikhao", "dikhaye", "bhejo", "bhejiye", "hoga", "aayega", "aayegi", "milega", "milegi", "kripya", "dhanyavad",
  "shukriya", "namaste", "namaskar", "haan", "theek", "accha", "acha", "kaun", "kyun", "kyu", "wala", "wali", "abhi",
  "hum", "humko", "tumhara", "tum", "pahunchega", "pahuncha", "dedo", "dijiye", "karna", "karni", "karo", "karun",
  "karein", "kare", "khareed", "khareedun", "milta", "milte", "milenge", "sakta", "sakte", "sakti", "chahta", "chahti",
  "bhool", "toot", "kharab", "galat", "paise", "paisa", "kat", "wapas", "bhej", "diya", "gaya", "gayi", "raha", "rahi",
]);
// Ambiguous short words: only count when two or more appear.
const WEAK = new Set(["ka", "ki", "ke", "ko", "se", "mein", "me", "par", "ho", "kar", "bhi", "toh", "to", "ye", "yeh", "woh"]);

/** Returns the language of `text`, or null when it is too short/ambiguous to tell (e.g. "2" or "#1001"). */
export function detectLanguage(text: string): Lang | null {
  if (/[ऀ-ॿ]/.test(text)) return "hi";
  if (/(?![\p{Script=Latin}\p{Script=Devanagari}])\p{L}/u.test(text)) return "other";
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (!words.length) return null;
  let strong = 0;
  let weak = 0;
  for (const w of words) {
    if (STRONG.has(w)) strong++;
    else if (WEAK.has(w)) weak++;
  }
  if (strong >= 1 || weak >= 2) return "hinglish";
  return words.length >= 2 ? "en" : null;
}

// Words that give away a language written in Roman letters other than English / Hinglish (Spanish, French, German, Portuguese, Italian,
// Indonesian, Turkish, Dutch, Swahili and Roman-script Marathi, Tamil, Telugu, Bengali, Gujarati, Punjabi, Kannada, Malayalam).
// STRONG: one of them is enough ("hola"). WEAK: two different ones are needed. Words that are also English are left out on purpose.
const FOREIGN_STRONG = new Set([
  "hola", "gracias", "buenos", "buenas", "cuanto", "cuánto", "cuesta", "quiero", "necesito", "precio", "envio", "envío", "pedido", "tienen", "dónde", "donde",
  "bonjour", "bonsoir", "merci", "combien", "commande", "livraison", "voudrais", "prix", "bonne", "salut",
  "hallo", "danke", "nicht", "bestellung", "lieferung", "möchte", "kostet", "bitte", "wieviel", "guten",
  "olá", "obrigado", "obrigada", "você", "preço", "entrega", "quanto", "custa", "quero", "não", "bom",
  "ciao", "grazie", "ordine", "consegna", "vorrei", "buongiorno", "prezzo", "quanto",
  "halo", "terima", "kasih", "berapa", "harga", "pesanan", "pengiriman", "saya", "mau", "ingin", "apakah", "tolong", "selamat",
  "merhaba", "teşekkür", "fiyat", "sipariş", "kargo", "istiyorum", "lütfen", "nasıl", "kaç",
  "bedankt", "hoeveel", "bestelling", "levering", "graag", "goedemorgen",
  "habari", "asante", "bei", "ngapi", "nataka",
  "vanakkam", "enna", "evvalavu", "venum", "irukka", "irukku", "enakku", "nandri", "epdi",
  "kavali", "entha", "nenu", "meeru", "dhanyavadalu", "enti",
  "pahije", "kiti", "kuthe", "mala", "tumhi", "majha", "mazha", "aahe", "ahe",
  "amar", "koto", "lagbe", "kothay", "dhonnobad", "apni", "kemon", "kinte",
  "kem", "cho", "joiye", "chhe", "mane", "tamaru",
  "kithe", "tuhada", "chahida", "kiddan", "mainu", "haiga",
  "namaskara", "beku", "yenu", "eshtu", "namaskaram", "venam", "evide", "ethra", "ente", "nanni",
]);
const FOREIGN_WEAK = new Set([
  "que", "por", "para", "una", "los", "las", "del", "con", "mi", "tiene", "esta", "está",
  "je", "vous", "pour", "avec", "est", "les", "des", "une", "mon", "suis", "pas", "oui", "non",
  "ich", "wie", "viel", "ein", "eine", "der", "die", "das", "und", "ist", "haben", "sie", "nein",
  "uma", "com", "tem", "sim", "os", "as", "do", "da",
  "che", "non", "il", "una", "sono", "per",
  "yang", "dan", "ini", "itu", "tidak", "bisa", "ada", "iya",
  "bir", "ve", "bu", "için", "evet", "hayır",
  "het", "niet", "ik", "wil", "van", "nee",
]);
const DIACRITICS = /[áàâãäåçéèêëíìîïñóòôõöúùûüýÿşğıœß¿¡]/i;

/**
 * True when Roman-letter text is probably NOT English or Hinglish (so the AI should translate it and the reply goes back in the
 * customer's own language). Product names, model numbers and plain English questions return false.
 */
export function isLatinForeign(text: string): boolean {
  if (/(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])\p{L}/u.test(text)) return false; // other scripts are handled elsewhere
  const words = text.toLowerCase().match(/[\p{L}]+/gu) ?? [];
  if (!words.length) return false;
  const strong = new Set(words.filter((w) => FOREIGN_STRONG.has(w)));
  const weak = new Set(words.filter((w) => FOREIGN_WEAK.has(w)));
  if (strong.size >= 1) return true;
  if (weak.size >= 2) return true;
  return words.length >= 2 && DIACRITICS.test(text);
}
