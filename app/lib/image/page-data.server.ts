import os from "node:os";
import prisma from "../../db.server";
import { signedImageUrl } from "../media.server";
import { getWorkers, recoverInterrupted } from "./jobs.server";
import { pool } from "./pool.server";
import { backupsFor } from "./store-jobs.server";
import { workerAdvice } from "./settings";

/** Everything the Image Editor page shows (kept apart from the route so it can be tested without a Shopify login). */
export async function loadImageEditor(shop: string, url: URL, kind: "upload" | "store" = "upload") {
  await recoverInterrupted();
  const show = ["all", "done", "failed", "waiting"].includes(url.searchParams.get("show") ?? "") ? url.searchParams.get("show")! : "all";

  const jobs = await prisma.imageJob.findMany({ where: { shop, kind }, orderBy: { createdAt: "desc" }, take: 15 });
  const counts = await prisma.imageItem.groupBy({ by: ["jobId", "status"], where: { jobId: { in: jobs.map((j) => j.id) } }, _count: { _all: true } });
  const countOf = (jobId: string) => {
    const c = { queued: 0, running: 0, done: 0, error: 0, cancelled: 0 } as Record<string, number>;
    for (const r of counts) if (r.jobId === jobId) c[r.status] = r._count._all;
    return c;
  };

  const selectedId = url.searchParams.get("job") ?? jobs.find((j) => ["running", "stopped"].includes(j.status))?.id ?? jobs[0]?.id ?? null;
  const sel = jobs.find((j) => j.id === selectedId) ?? null;
  const where = { jobId: sel?.id ?? "-", ...(show === "done" ? { status: "done" } : show === "failed" ? { status: "error" } : show === "waiting" ? { status: { in: ["queued", "running"] } } : {}) };
  const items = sel ? await prisma.imageItem.findMany({ where, orderBy: { createdAt: "asc" }, take: 400 }) : [];
  const selCounts = sel ? countOf(sel.id) : null;
  const doneBytes = sel ? await prisma.imageItem.aggregate({ where: { jobId: sel.id, status: "done" }, _sum: { inBytes: true, outBytes: true } }) : null;

  const backups = sel?.kind === "store" ? await backupsFor(shop, items.map((i) => i.mediaId).filter((m): m is string => Boolean(m))) : [];
  const backupOf = new Map(backups.map((b) => [b.mediaId, b]));

  const cores = os.cpus().length;
  const freeGB = Math.round((os.freemem() / 1e9) * 10) / 10;
  return {
    show,
    workers: await getWorkers(shop),
    stats: pool.stats(),
    hardware: { cores, freeGB, totalGB: Math.round(os.totalmem() / 1e8) / 10 },
    advice: { ai: workerAdvice(cores, freeGB, true), plain: workerAdvice(cores, freeGB, false) },
    jobs: jobs.map((j) => ({ id: j.id, name: j.name, status: j.status, total: j.total, counts: countOf(j.id), at: j.createdAt.toISOString() })),
    selected: sel && {
      kind: sel.kind, id: sel.id, name: sel.name, status: sel.status, total: sel.total, counts: selCounts!,
      startedAt: sel.startedAt?.toISOString() ?? null, finishedAt: sel.finishedAt?.toISOString() ?? null,
      inBytes: doneBytes?._sum.inBytes ?? 0, outBytes: doneBytes?._sum.outBytes ?? 0,
      zip: selCounts!.done > 0 ? signedImageUrl(`zip/${sel.id}`) : null,
    },
    items: items.map((i) => ({
      productTitle: i.productTitle ?? "", mediaId: i.mediaId ?? "", applyStatus: i.applyStatus, applyError: i.applyError, newUrl: i.newUrl,
      hasBackup: Boolean(i.mediaId && backupOf.has(i.mediaId)), restored: Boolean(i.mediaId && backupOf.get(i.mediaId)?.restoredAt),
      id: i.id, name: i.name, folder: i.folder, status: i.status, error: i.error, note: i.note, inBytes: i.inBytes, outBytes: i.outBytes,
      width: i.width, height: i.height, ms: i.ms, outName: i.outName,
      thumb: i.status === "done" && sel ? signedImageUrl(`file/${sel.id}/thumb/${i.id}`) : null,
      orig: sel ? (i.status === "done" ? signedImageUrl(`file/${sel.id}/orig/${i.id}`) : null) : null,
      result: i.status === "done" && sel ? signedImageUrl(`file/${sel.id}/result/${i.id}`) : null,
      download: i.status === "done" && sel ? `${signedImageUrl(`file/${sel.id}/result/${i.id}`)}&dl=1` : null,
    })),
  };
}
