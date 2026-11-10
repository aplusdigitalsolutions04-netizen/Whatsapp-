import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import { BellRing, X } from "lucide-react";
import type { Waiting } from "../lib/waiting.server";

/** "3m ago" style time for a waiting customer. */
export function waitedFor(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

/** One short, quiet beep for a NEW customer. Browsers may block audio before the first click; that is fine. */
function beep() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
    setTimeout(() => void ctx.close(), 500);
  } catch {
    /* no sound: the pop-up is still shown */
  }
}

/**
 * Pop-up in the top corner of every page: "this customer asked for our support team, please attend".
 * It checks for new handovers every few seconds, animates when a NEW customer arrives, stays until the chat is
 * answered (or the card is dismissed) and comes back if the same customer asks for a person again later.
 */
export function SupportAlert({ initial }: { initial: Waiting[] }) {
  const fetcher = useFetcher<{ waiting: Waiting[] }>();
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [fresh, setFresh] = useState<string[]>([]);
  const [, setTick] = useState(0);
  const known = useRef<Set<string> | null>(null);
  const load = useRef(fetcher.load);
  const busy = useRef(fetcher.state !== "idle");
  load.current = fetcher.load;
  busy.current = fetcher.state !== "idle";

  const list = fetcher.data?.waiting ?? initial;

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const poll = () => {
      if (document.visibilityState === "visible" && !busy.current) void load.current("/app/waiting");
    };
    const t = setInterval(poll, 6000);
    const clock = setInterval(() => setTick((n) => n + 1), 30_000); // keeps "3 min" fresh
    document.addEventListener("visibilitychange", poll);
    return () => {
      clearInterval(t);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", poll);
    };
  }, []);

  // Which customers are new since the last look? (The first look only records who is already waiting.)
  useEffect(() => {
    const ids = list.map((w) => w.id);
    const before = known.current;
    known.current = new Set(ids);
    setDismissed((d) => d.filter((id) => ids.includes(id))); // served customers are forgotten, so a repeat request alerts again
    if (!before) {
      setFresh(ids);
      return;
    }
    const added = ids.filter((id) => !before.has(id));
    if (added.length) {
      setFresh((f) => [...f.filter((id) => ids.includes(id)), ...added]);
      beep();
      const t = setTimeout(() => setFresh((f) => f.filter((id) => !added.includes(id))), 12_000);
      return () => clearTimeout(t);
    }
    setFresh((f) => f.filter((id) => ids.includes(id)));
  }, [list]);

  if (!mounted) return null;
  const visible = list.filter((w) => !dismissed.includes(w.id));
  if (!visible.length) return null;
  const dismiss = (id: string) => setDismissed((d) => [...d, id]);

  return (
    <div className="sa" role="alert" aria-live="assertive">
      {visible.slice(0, 3).map((w) => (
        <div key={w.id} className={`sa-card${fresh.includes(w.id) ? " is-new" : ""}`}>
          <span className="sa-bell" aria-hidden="true">
            <BellRing size={18} />
            <i />
          </span>
          <div className="sa-text">
            <b>Customer needs you</b>
            <span>{w.name} asked for our support team</span>
            <small>Waiting {waitedFor(w.at)}. Please attend this customer.</small>
          </div>
          <Link className="sa-btn" to={`/app/conversations?c=${w.id}&filter=human`} onClick={() => dismiss(w.id)}>
            Attend
          </Link>
          <button className="sa-x" onClick={() => dismiss(w.id)} aria-label="Hide this alert">
            <X size={14} />
          </button>
        </div>
      ))}
      {visible.length > 3 && (
        <Link className="sa-more" to="/app/conversations?filter=human">
          +{visible.length - 3} more waiting
        </Link>
      )}
    </div>
  );
}
