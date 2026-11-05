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
