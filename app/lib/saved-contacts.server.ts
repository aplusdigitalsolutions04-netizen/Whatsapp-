/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inList } from "./saved-contacts";
import { normalizePhone } from "./phone";

// Contacts WhatsApp tells us about (the names saved in the linked phone's address book).
// Kept in memory and in a small file next to the WhatsApp login, so a restart does not forget them.
const FILE = path.join(path.resolve(process.env.WHATSAPP_AUTH_DIR || ".wa-auth"), "saved-contacts.json");
const g = globalThis as unknown as { __savedContacts?: Set<string> };

function load(): Set<string> {
  if (g.__savedContacts) return g.__savedContacts;
  const set = new Set<string>();
  try {
    if (existsSync(FILE)) for (const n of JSON.parse(readFileSync(FILE, "utf8")) as string[]) set.add(n);
  } catch {
    /* a damaged file just starts empty */
  }
  g.__savedContacts = set;
  return set;
}

let timer: NodeJS.Timeout | null = null;
function persistSoon() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      mkdirSync(path.dirname(FILE), { recursive: true });
      writeFileSync(FILE, JSON.stringify([...load()]));
    } catch {
      /* not being able to save only means they are learned again after a restart */
    }
  }, 3000);
}

/** The phone number of a WhatsApp contact entry (ids ending in @lid have no number unless phoneNumber is given). */
function contactNumber(c: any): string | null {
  for (const raw of [c?.phoneNumber, c?.id]) {
    const s = String(raw ?? "");
    if (s && !s.endsWith("@lid") && !s.endsWith("@g.us") && !s.includes("broadcast")) {
      const n = normalizePhone(`+${s.split("@")[0].split(":")[0].replace(/\D/g, "")}`);
      if (n) return n;
    }
  }
  return null;
}

/** Called by the WhatsApp bridge. Only contacts that have a name saved in the phone's address book count. */
export function rememberContacts(list: any[] | undefined) {
  if (!Array.isArray(list)) return;
  const set = load();
  let changed = false;
  for (const c of list) {
    const n = contactNumber(c);
    if (!n) continue;
    if (c?.name && !set.has(n)) {
      set.add(n);
      changed = true;
    } else if (c && "name" in c && !c.name && set.has(n)) {
      set.delete(n); // the contact was deleted from the phone book
      changed = true;
    }
  }
  if (changed) persistSoon();
}

/** True for a number saved in the owner's phone, or typed into the "personal numbers" list in Bot Settings. */
export function isSavedContact(phone: string, manual: string[]): boolean {
  return inList(phone, manual) || load().has(normalizePhone(phone) ?? phone);
}

export const savedContactCount = () => load().size;
