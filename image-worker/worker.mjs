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
  try {
    const r = await processImage(msg.task);
    process.send({ type: "result", id: msg.task.id, ok: true, ...r });
  } catch (e) {
    process.send({ type: "result", id: msg.task.id, ok: false, error: String(e?.message ?? e).slice(0, 300) });
  }
});

// If the app goes away, this worker must not keep running.
process.on("disconnect", () => process.exit(0));
process.send({ type: "ready", pid: process.pid });
