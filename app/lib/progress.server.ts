// Progress of background jobs (order sync, Google Sheet update). Kept in memory: a restart simply forgets it,
// and the page then shows nothing instead of a bar that never moves.

export type Task = { id: string; label: string; done: number; total: number | null; running: boolean; error: string | null; at: number };

const g = globalThis as unknown as { __tasks?: Map<string, Task> };
const tasks = (g.__tasks ??= new Map());
const key = (shop: string, id: string) => `${shop}:${id}`;

const STALE_MS = 30 * 60_000; // a "running" job older than this is assumed dead
const SHOW_DONE_MS = 6_000; // a finished job stays visible for a few seconds so the person sees it complete

/** Starts (or keeps) a task. Calling it again while the task runs does not reset its numbers. */
export function startTask(shop: string, id: string, label: string, total: number | null = null): void {
  const cur = tasks.get(key(shop, id));
  if (cur?.running && Date.now() - cur.at < STALE_MS) return;
  tasks.set(key(shop, id), { id, label, done: 0, total, running: true, error: null, at: Date.now() });
}

export function updateTask(shop: string, id: string, patch: Partial<Pick<Task, "label" | "done" | "total">>): void {
  const cur = tasks.get(key(shop, id));
  if (!cur) return;
  tasks.set(key(shop, id), { ...cur, ...patch });
}

export function endTask(shop: string, id: string, error: string | null = null): void {
  const cur = tasks.get(key(shop, id));
  if (!cur || !cur.running) return; // already ended (e.g. with an error): keep that result
  tasks.set(key(shop, id), { ...cur, running: false, error, done: error ? cur.done : cur.total ?? cur.done, at: Date.now() });
}

/** The task as the page should show it: running, or just finished. Otherwise null. */
export function getTask(shop: string, id: string): Task | null {
  const t = tasks.get(key(shop, id));
  if (!t) return null;
  const age = Date.now() - t.at;
  if (t.running) return age < STALE_MS ? t : null;
  return age < SHOW_DONE_MS ? t : null;
}
