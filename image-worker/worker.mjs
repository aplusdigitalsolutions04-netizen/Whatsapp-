// One Image Editor worker process. The app starts several of these; each handles one photo at a time.
// Messages in:  { type: "config", threads } | { type: "task", task } | { type: "exit" }
// Messages out: { type: "ready" } | { type: "result", id, ok, ...stats | error }
import sharp from "sharp";
import { processImage } from "./pipeline.mjs";

sharp.cache(false);

process.on("message", async (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "config") {
    sharp.concurrency(Math.max(1, Math.floor(msg.threads) || 1));
    return;
  }
  if (msg.type === "exit") process.exit(0);
  if (msg.type !== "task") return;
  const noThreads = (e) => /creating thread|Resource temporarily unavailable|EAGAIN/i.test(String(e?.message ?? e));
  try {
    let r;
    try {
      r = await processImage(msg.task);
    } catch (e) {
      // The server does not allow more threads: go down to one thread and try the same photo again.
      if (!noThreads(e)) throw e;
      sharp.concurrency(1);
      r = await processImage(msg.task);
    }
    process.send({ type: "result", id: msg.task.id, ok: true, ...r });
  } catch (e) {
    const hint = noThreads(e) ? " This server limits how many threads a program may use. Set Workers to 1 in the Image Editor." : "";
    process.send({ type: "result", id: msg.task.id, ok: false, error: (String(e?.message ?? e).slice(0, 220) + hint).slice(0, 320) });
  }
});

// If the app goes away, this worker must not keep running.
process.on("disconnect", () => process.exit(0));
process.send({ type: "ready", pid: process.pid });
