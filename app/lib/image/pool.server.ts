import { fork, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { LIMITS, type ImageOptions } from "./settings.ts";

export type Task = {
  id: string;
  jobId: string;
  inPath: string;
  outBase: string;
  thumbPath: string;
  origPath: string;
  options: ImageOptions;
  /** keep this file type (used when a result replaces an existing Shopify image) */
  forceExt?: "jpg" | "png" | "webp";
};
export type TaskResult =
  | { ok: true; ext: string; width: number; height: number; inBytes: number; outBytes: number; note: string; ms: number }
  | { ok: false; error: string };

type Worker = { id: number; proc: ChildProcess; ready: boolean; busy: Task | null; retiring: boolean; done: number };

const WORKER_FILE = () => path.resolve(process.cwd(), "image-worker/worker.mjs");
const RECYCLE_AFTER = 100; // a fresh process after this many photos keeps memory bounded
const WINDOW_MS = 60_000;
const MAX_TRIES = 2; // a photo that kills its worker is tried once more, then reported as failed

/**
 * A pool of worker PROCESSES that run the image pipeline. The number of workers can be changed at any moment:
 * more workers start immediately, fewer workers retire as soon as they finish their current photo.
 * Processes (not threads) are used so each worker has its own libuv/libvips threads and its own memory.
 */
export class ImagePool {
  target = 2;
  readonly workers = new Map<number, Worker>();
  readonly queue: Task[] = [];
  onStart: (task: Task) => void = () => undefined;
  onResult: (task: Task, result: TaskResult) => void = () => undefined;
  lastError: string | null = null;
  private nextId = 1;
  private finished: { at: number; ms: number }[] = [];
  private crashes: number[] = [];
  private tries = new Map<string, number>();

  /** Adds photos to the queue and wakes the workers. */
  submit(tasks: Task[]) {
    this.queue.push(...tasks);
    this.reconcile();
    this.pump();
  }

  setWorkers(n: number) {
    this.target = Math.min(LIMITS.maxWorkers, Math.max(1, Math.round(n) || 1));
    this.reconcile();
    this.sendConfig();
    this.pump();
  }

  /** Removes the not-yet-started photos of a job. Photos already being processed finish normally. */
  cancelJob(jobId: string): string[] {
    const removed = this.queue.filter((t) => t.jobId === jobId).map((t) => t.id);
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i].jobId === jobId) this.queue.splice(i, 1);
    return removed;
  }

  hasJob(jobId: string) {
    return this.queue.some((t) => t.jobId === jobId) || [...this.workers.values()].some((w) => w.busy?.jobId === jobId);
  }

  stats() {
    const now = Date.now();
    this.finished = this.finished.filter((f) => now - f.at < WINDOW_MS);
    const first = this.finished[0];
    const span = first ? Math.max(10_000, Math.min(WINDOW_MS, now - (first.at - first.ms))) : WINDOW_MS;
    const timed = this.finished.filter((f) => f.ms > 0);
    return {
      target: this.target,
      alive: this.active().filter((w) => w.ready).length,
      busy: [...this.workers.values()].filter((w) => w.busy).length,
      queued: this.queue.length,
      perMinute: first ? Math.round((this.finished.length * 60_000) / span) : 0,
      avgMs: timed.length ? Math.round(timed.reduce((a, f) => a + f.ms, 0) / timed.length) : 0,
      lastError: this.lastError,
    };
  }

  /** Stops every worker (shutdown and tests). */
  async shutdown() {
    this.queue.length = 0;
    this.target = 1;
    for (const w of this.workers.values()) {
      w.retiring = true;
      w.proc.send({ type: "exit" }, () => undefined);
      setTimeout(() => w.proc.kill(), 1500).unref();
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  // ---- internals ----
  private active() {
    return [...this.workers.values()].filter((w) => !w.retiring);
  }

  /**
   * Threads each worker may use inside the image library. Hosting plans cap how many threads a process may create
   * ("glib: Error creating thread: Resource temporarily unavailable"), so the default is ONE: parallel speed comes
   * from several worker processes, not from many threads. IMAGE_THREADS raises it on a strong server.
   */
  private threadsPerWorker() {
    const cap = Math.max(1, Math.floor(Number(process.env.IMAGE_THREADS)) || 1);
    return Math.min(cap, Math.max(1, Math.floor(os.cpus().length / Math.max(1, this.target))));
  }

  private sendConfig() {
    for (const w of this.workers.values()) if (w.ready) w.proc.send({ type: "config", threads: this.threadsPerWorker() }, () => undefined);
  }

  private reconcile() {
    // Never spawn more workers than there is work for, and stop retrying a worker that keeps crashing.
    const recentCrashes = this.crashes.filter((t) => Date.now() - t < 20_000).length;
    const busy = this.active().filter((w) => w.busy).length;
    const want = Math.min(this.target, busy + this.queue.length);
    if (recentCrashes < 4) while (this.active().length < want) this.spawn();

    // Too many workers (the target was lowered): retire idle ones first; busy ones stop after their current photo.
    let extra = this.active().length - this.target;
    if (extra > 0) {
      for (const w of this.active().sort((a, b) => Number(Boolean(a.busy)) - Number(Boolean(b.busy)))) {
        if (extra-- <= 0) break;
        this.retire(w);
      }
    }
  }

  private retire(w: Worker) {
    w.retiring = true;
    if (!w.busy) {
      w.proc.send({ type: "exit" }, () => undefined);
      setTimeout(() => w.proc.kill(), 1500).unref();
    }
  }

  private spawn() {
    const id = this.nextId++;
    const proc = fork(WORKER_FILE(), [], { execArgv: [], stdio: ["ignore", "inherit", "pipe", "ipc"], env: { ...process.env, VIPS_CONCURRENCY: String(this.threadsPerWorker()), UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || "4" } });
    const w: Worker = { id, proc, ready: false, busy: null, retiring: false, done: 0 };
    this.workers.set(id, w);
    // Keep the last words the worker printed, so "could not start" can say WHY (missing package, out of memory, ...).
    let errTail = "";
    proc.stderr?.on("data", (d: Buffer) => {
      process.stderr.write(d);
      errTail = (errTail + d.toString()).slice(-600);
    });

    proc.on("message", (m: Record<string, unknown>) => {
      if (m.type === "ready") {
        w.ready = true;
        proc.send({ type: "config", threads: this.threadsPerWorker() }, () => undefined);
        this.pump();
        return;
      }
      if (m.type !== "result" || !w.busy) return;
      const task = w.busy;
      w.busy = null;
      w.done++;
      this.tries.delete(task.id);
      const result = (m.ok ? m : { ok: false, error: String(m.error ?? "failed") }) as unknown as TaskResult;
      this.finished.push({ at: Date.now(), ms: m.ok ? Number(m.ms) || 0 : 0 });
      this.onResult(task, result);
      if (w.done >= RECYCLE_AFTER && !w.retiring) {
        this.retire(w);
        this.reconcile();
      }
      if (w.retiring) {
        proc.send({ type: "exit" }, () => undefined);
        setTimeout(() => proc.kill(), 1500).unref();
      }
      this.pump();
    });

    proc.on("exit", (code, signal) => {
      this.workers.delete(id);
      const task = w.busy;
      if (task) {
        // The worker died in the middle of a photo: retry once on another worker, then report it as failed.
        this.crashes.push(Date.now());
        if ((this.tries.get(task.id) ?? 1) < MAX_TRIES) this.queue.unshift(task);
        else {
          this.tries.delete(task.id);
          this.lastError = "A worker stopped unexpectedly while processing this photo.";
          this.onResult(task, { ok: false, error: this.lastError });
        }
      } else if (!w.retiring && !w.ready) {
        this.crashes.push(Date.now());
        const why = errTail.trim().split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 300);
        this.lastError = `A worker could not start (${signal ? `killed by ${signal}` : `exit code ${code}`})${why ? `: ${why}` : signal === "SIGKILL" ? ". The server probably ran out of memory." : ". Check that the Image Editor packages are installed."}`;
        console.error("[image-editor]", this.lastError);
      }
      if (this.crashes.filter((t) => Date.now() - t < 20_000).length >= 4 && this.queue.length) {
        const lost = this.queue.splice(0, this.queue.length); // give up instead of looping forever
        for (const t of lost) this.onResult(t, { ok: false, error: this.lastError ?? "Workers keep crashing." });
      }
      this.reconcile();
      this.pump();
    });
    proc.on("error", () => undefined);
  }

  private pump() {
    for (const w of this.workers.values()) {
      if (!w.ready || w.busy || w.retiring) continue;
      const task = this.queue.shift();
      if (!task) break;
      w.busy = task;
      this.tries.set(task.id, (this.tries.get(task.id) ?? 0) + 1);
      this.onStart(task);
      w.proc.send({ type: "task", task }, (err) => {
        if (err && w.busy === task) {
          w.busy = null;
          this.queue.unshift(task);
        }
      });
    }
  }
}

const g = globalThis as unknown as { __imagePool?: ImagePool };
/** One pool per server process (survives hot reloads). */
export const pool = (g.__imagePool ??= new ImagePool());
