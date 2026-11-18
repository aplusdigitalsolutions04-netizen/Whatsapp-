import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The JAZZ icon: a round button at the top right. Click it to read what JAZZ is, open WhatsApp, or chat right here.
 *  - mode "public": the website (link page / store site). Shown only when the owner switched it on in Bot Settings.
 *  - mode "admin": inside ShopPilot. Always shown; the chat there is a test chat.
 * The chat talks to /api/chat (public) or /api/chat-admin (admin). Replies are read by polling while the box is open.
 */
type Msg = { id: string; from: "me" | "jazz" | "agent"; text: string; at: string };
type Mode = "public" | "admin";

const SID_KEY = "jazz-sid";
const newSid = () => {
  const a = new Uint8Array(18);
  (globalThis.crypto ?? ({} as Crypto)).getRandomValues?.(a);
  return Array.from(a, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 32).padEnd(24, "x");
};
function getSid(): string {
  try {
    const s = localStorage.getItem(SID_KEY);
    if (s && /^[A-Za-z0-9_-]{16,64}$/.test(s)) return s;
    const n = newSid();
    localStorage.setItem(SID_KEY, n);
    return n;
  } catch {
    return newSid(); // storage blocked: the chat still works for this page view
  }
}

const URL_RE = /(https?:\/\/[^\s]+)/g;
function Linked({ text }: { text: string }) {
  return (
    <>
      {text.split(URL_RE).map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer">{part}</a>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function Face({ size = 26 }: { size?: number }) {
  return (
    <svg className="jw-face" width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect x="4" y="9" width="32" height="26" rx="10" fill="#fffaf0" />
      <rect x="8" y="13" width="24" height="16" rx="7" fill="#1a120c" />
      <circle className="jw-eye" cx="16" cy="21" r="2.8" fill="#ffd89a" />
      <circle className="jw-eye" cx="24" cy="21" r="2.8" fill="#ffd89a" />
      <path d="M17 26.2q3 2.2 6 0" fill="none" stroke="#ffd89a" strokeWidth="1.6" strokeLinecap="round" />
      <rect x="19" y="2.5" width="2" height="7" rx="1" fill="#fffaf0" />
      <circle cx="20" cy="3.2" r="2.4" fill="#ffe3b0" />
    </svg>
  );
}

export function JazzWidget({ mode }: { mode: Mode }) {
  const api = mode === "admin" ? "/api/chat-admin" : "/api/chat";
  const [cfg, setCfg] = useState<{ enabled: boolean; whatsapp: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"home" | "chat">("home");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sid = useRef("");
  const last = useRef<string | null>(null);
  const log = useRef<HTMLDivElement>(null);

  // should the icon be shown, and which WhatsApp number does the button open?
  useEffect(() => {
    let live = true;
    fetch("/api/chat?config=1")
      .then((r) => r.json())
      .then((c) => live && setCfg({ enabled: !!c.enabled, whatsapp: String(c.whatsapp || "") }))
      .catch(() => live && setCfg({ enabled: false, whatsapp: "" }));
    return () => {
      live = false;
    };
  }, []);

  const poll = useCallback(async () => {
    if (!sid.current) return;
    try {
      const r = await fetch(`${api}?sid=${encodeURIComponent(sid.current)}${last.current ? `&after=${encodeURIComponent(last.current)}` : ""}`);
      if (!r.ok) return;
      const j = (await r.json()) as { messages?: Msg[] };
      const fresh = j.messages ?? [];
      if (fresh.length) {
        last.current = fresh[fresh.length - 1].at;
        setMsgs((cur) => {
          const have = new Set(cur.map((m) => m.id));
          return [...cur, ...fresh.filter((m) => !have.has(m.id))];
        });
        setPending([]);
        if (fresh.some((m) => m.from !== "me")) setWaiting(false);
      }
    } catch {
      /* a missed poll is simply tried again */
    }
  }, [api]);

  // while the chat is open, look for new messages (JAZZ's answers, or a team member's reply)
  useEffect(() => {
    if (!open || view !== "chat") return;
    sid.current ||= getSid();
    void poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, [open, view, poll]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
  }, [msgs, pending, waiting, view]);

  const send = async (value: string) => {
    const t = value.trim();
    if (!t || waiting) return;
    sid.current ||= getSid();
    setError(null);
    setText("");
    setPending((p) => [...p, t]);
    setWaiting(true);
    try {
      const r = await fetch(api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid: sid.current, text: t }) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || j.ok === false) {
        setError(j.error ?? "Could not send. Please try again.");
        setPending([]);
        setWaiting(false);
        return;
      }
      await poll();
    } catch {
      setError("No connection. Please try again.");
      setPending([]);
    } finally {
      setWaiting(false);
    }
  };

  if (!cfg) return null;
  if (mode === "public" && !cfg.enabled) return null;
  const wa = (cfg.whatsapp || "919211890093").replace(/\D/g, "");

  return (
    <div className={`jw jw-${mode}`}>
      <button type="button" className={`jw-fab${open ? " on" : ""}`} onClick={() => setOpen((o) => !o)} aria-label="Ask JAZZ, the assistant" aria-expanded={open} title="Ask JAZZ">
        <Face />
        <span className="jw-ring" aria-hidden="true" />
      </button>

      {open && (
        <div className="jw-panel" role="dialog" aria-label="JAZZ assistant">
          <header className="jw-head">
            {view === "chat" && (
              <button type="button" className="jw-icon" onClick={() => setView("home")} aria-label="Back">‹</button>
            )}
            <span className="jw-avatar"><Face size={24} /></span>
            <span className="jw-title">
              <b>JAZZ</b>
              <small><i className="jw-dot" /> Assistant · Chat bot</small>
            </span>
            <button type="button" className="jw-icon" onClick={() => setOpen(false)} aria-label="Close">×</button>
          </header>

          {view === "home" ? (
            <div className="jw-body">
              <p className="jw-hi">Hi! I&apos;m <b>JAZZ</b>, the assistant (chat bot) of WERY. 👋</p>
              <p>I can help you <b>track your order</b>, check its status and answer your questions about our products.</p>
              {mode === "admin" && <p className="jw-note">This is a test chat. Customers see this icon on your website once you switch it on in Bot Settings.</p>}
              <a className="jw-btn jw-wa" href={`https://wa.me/${wa}?text=${encodeURIComponent("Hi JAZZ")}`} target="_blank" rel="noopener noreferrer">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a8.5 8.5 0 0 1-12.4 7.5L3 21l1.6-5.4A8.5 8.5 0 1 1 21 12Z" /></svg>
                Chat on WhatsApp
              </a>
              <button type="button" className="jw-btn jw-chat" onClick={() => setView("chat")}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5Z" /></svg>
                Chat here
              </button>
            </div>
          ) : (
            <div className="jw-chatview">
              <div className="jw-log" ref={log} role="log" aria-live="polite">
                {msgs.length === 0 && pending.length === 0 && <div className="jw-msg jazz"><div>Hi, I&apos;m JAZZ! 👋 How can I help you today?</div></div>}
                {msgs.map((m) => (
                  <div key={m.id} className={`jw-msg ${m.from}`}>
                    {m.from === "agent" && <small>Team</small>}
                    <div><Linked text={m.text} /></div>
                  </div>
                ))}
                {pending.map((p, i) => (
                  <div key={`p${i}`} className="jw-msg me"><div>{p}</div></div>
                ))}
                {waiting && <div className="jw-msg jazz"><div className="jw-typing" aria-label="JAZZ is typing"><i /><i /><i /></div></div>}
              </div>
              {msgs.length === 0 && pending.length === 0 && (
                <div className="jw-chips">
                  {["Track my order", "Find a product", "Talk to a person"].map((c) => (
                    <button key={c} type="button" onClick={() => void send(c)}>{c}</button>
                  ))}
                </div>
              )}
              {error && <p className="jw-error" role="alert">{error}</p>}
              <form
                className="jw-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send(text);
                }}
              >
                <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type your message…" maxLength={500} aria-label="Message to JAZZ" autoComplete="off" />
                <button type="submit" disabled={waiting || !text.trim()} aria-label="Send">➤</button>
              </form>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
