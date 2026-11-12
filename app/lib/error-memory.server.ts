import { redact } from "./log.server";

// Keeps the last few server errors in memory so /health?debug=1 can show WHY a page answered "Application Error",
// even when the hosting panel gives no access to the server log. Nothing is stored on disk or sent anywhere.
type Entry = { at: string; where: string; message: string };
const g = globalThis as unknown as { __lastErrors?: Entry[] };
const list = (g.__lastErrors ??= []);

export function rememberError(error: unknown, url?: string) {
  let where = "";
  try {
    where = url ? new URL(url).pathname : "";
  } catch {
    /* not a full URL */
  }
  const e = error as { message?: string; stack?: string } | undefined;
  const text = String(e?.message ?? error ?? "unknown error");
  // the first stack line that points into the app tells where it happened
  const frame = String(e?.stack ?? "").split("\n").find((l) => /\/(build|app|node_modules)\//.test(l))?.trim() ?? "";
  list.unshift({ at: new Date().toISOString(), where, message: redact(`${text} ${frame}`.trim(), 500) });
  list.length = Math.min(list.length, 5);
}

export const recentErrors = () => list.slice();
