// Plain-language reasons for WhatsApp (QR) disconnects, and the history shown on the WhatsApp page. Pure functions.

export type CloseReason = { title: string; advice: string };

/** What a WhatsApp "connection closed" status code means, and what to do about it. */
export function explainClose(code: number | undefined | null, message = ""): CloseReason {
  const m = message.toLowerCase();
  switch (code) {
    case 401:
      return { title: "Logged out by WhatsApp", advice: "The number was removed from Linked devices on the phone, or WhatsApp ended the login. Scan the QR code again." };
    case 403:
      return { title: "WhatsApp refused the login", advice: "The number may be restricted. Open WhatsApp on the phone and check for a warning, then try again later." };
    case 405:
      return { title: "WhatsApp rejected this connection method", advice: "The WhatsApp library on the server is out of date. This needs an update of the app, not a rescan." };
    case 408:
      return { title: "Connection timed out", advice: "The server could not reach WhatsApp in time (slow or blocked internet on the hosting). It reconnects by itself." };
    case 411:
      return { title: "Linked-device mismatch", advice: "Unlink the number on this page and scan the QR code again." };
    case 428:
      return { title: "WhatsApp closed the connection", advice: "Usually the server was idle, busy or had a short network drop. It reconnects by itself." };
    case 440:
      return { title: "Same login opened somewhere else", advice: "Another server or a PC is using this WhatsApp login. Close it there (or unlink and scan again) so only one place stays connected." };
    case 500:
      return { title: "Saved login files are damaged", advice: "Unlink the number on this page and scan the QR code again." };
    case 503:
      return { title: "WhatsApp is temporarily unavailable", advice: "A short problem on WhatsApp's side. It reconnects by itself." };
    case 515:
      return { title: "WhatsApp asked for a restart", advice: "Normal right after scanning the QR code. It reconnects by itself." };
    default:
      if (/timed? ?out/.test(m)) return { title: "Connection timed out", advice: "The server could not reach WhatsApp in time. It reconnects by itself." };
      if (/enotfound|econn|network|socket|fetch failed/.test(m)) return { title: "Network problem on the server", advice: "The hosting lost its internet connection for a moment. It reconnects by itself." };
      return { title: "Connection dropped", advice: "WhatsApp or the network closed the connection without a reason. It reconnects by itself." };
  }
}

export type HistoryRow = { at: string; kind: "connected" | "disconnected" | "restarted" | "logged_out" | "replaced"; title: string; detail: string; code?: number };

type LogRow = { event: string; detail: string | null; createdAt: Date | string };

/** Turns one stored activity-log row into a line of the history list (or null when it is not about the connection). */
export function historyRow(r: LogRow): HistoryRow | null {
  const at = new Date(r.createdAt).toISOString();
  const d = r.detail ?? "";
  switch (r.event) {
    case "bridge_connected":
      return { at, kind: "connected", title: "Connected", detail: d ? `Number +${d}` : "" };
    case "bridge_app_started":
      return { at, kind: "restarted", title: "The app (re)started on the server", detail: "WhatsApp is disconnected for a moment every time the server restarts." };
    case "bridge_logged_out":
      return { at, kind: "logged_out", title: "Logged out by WhatsApp", detail: explainClose(401).advice, code: 401 };
    case "bridge_replaced":
      return { at, kind: "replaced", title: "Same login opened somewhere else", detail: explainClose(440).advice, code: 440 };
    case "bridge_closed": {
      const c = d.match(/code=(\d+)/);
      const code = c ? Number(c[1]) : undefined;
      const why = explainClose(code, d);
      return { at, kind: "disconnected", title: `Disconnected: ${why.title}${code ? ` (code ${code})` : ""}`, detail: why.advice, code };
    }
    default:
      return null;
  }
}

/** A one-paragraph answer to "why does it keep disconnecting?" from the last 24 hours of history. */
export function summarizeHistory(rows: HistoryRow[], now: number = Date.now()): { disconnects: number; restarts: number; verdict: string } {
  const recent = rows.filter((r) => now - new Date(r.at).getTime() < 24 * 3_600_000);
  const disconnects = recent.filter((r) => r.kind === "disconnected" || r.kind === "replaced" || r.kind === "logged_out").length;
  const restarts = recent.filter((r) => r.kind === "restarted").length;
  const byCode = new Map<string, number>();
  for (const r of recent) if (r.kind === "disconnected" || r.kind === "replaced") byCode.set(String(r.code ?? "?"), (byCode.get(String(r.code ?? "?")) ?? 0) + 1);
  const top = [...byCode.entries()].sort((a, b) => b[1] - a[1])[0];
  let verdict: string;
  if (!recent.length) verdict = "No disconnects in the last 24 hours.";
  else if (recent.some((r) => r.kind === "replaced")) verdict = "The same WhatsApp login is open in another place. Close the other copy (another server, or the app on your PC) and press Connect.";
  else if (restarts >= 3) verdict = `The hosting restarted the app ${restarts} times in 24 hours. Every restart drops WhatsApp for a moment. This is a hosting limit (memory or idle restarts): ask Hostinger support to keep the Node.js app running without restarts.`;
  else if (top && (top[0] === "408" || top[0] === "428" || top[0] === "?")) verdict = `Most drops are network drops between the server and WhatsApp (${top[1]} in 24 hours). The app reconnects by itself each time.`;
  else if (top) verdict = `Most common reason in 24 hours: ${explainClose(top[0] === "?" ? undefined : Number(top[0])).title} (${top[1]} times).`;
  else verdict = `${disconnects} disconnect(s) in 24 hours.`;
  return { disconnects, restarts, verdict };
}
