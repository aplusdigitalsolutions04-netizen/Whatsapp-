import { readFile } from "node:fs/promises";
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { INLINE_MIME, mediaFilePath, verifyMediaSignature } from "../lib/media.server";

// Serves chat attachments through short-lived signed links (no session header is available to <img>/<a>).
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const id = params.id ?? "";
  if (!/^[a-z0-9]{20,40}$/.test(id) || !verifyMediaSignature(id, url.searchParams.get("exp"), url.searchParams.get("sig"))) {
    return new Response("Forbidden", { status: 403 });
  }
  const msg = await prisma.message.findUnique({ where: { id } });
  const file = msg?.mediaFile ? mediaFilePath(msg.mediaFile) : null;
  if (!msg || !file) return new Response("Not found", { status: 404 });

  const mime = (msg.mediaMime ?? "").toLowerCase();
  const inline = INLINE_MIME.has(mime);
  const name = (msg.mediaName ?? msg.mediaFile!).replace(/[^\w.\- ]+/g, "_").slice(0, 100);
  return new Response(new Uint8Array(await readFile(file)), {
    headers: {
      // Never let user-supplied content render as HTML/SVG: unknown types are forced to download.
      "Content-Type": inline ? mime : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name}"`,
      "X-Content-Type-Options": "nosniff",
      ...(inline ? {} : { "Content-Security-Policy": "default-src 'none'; sandbox" }),
      "Cache-Control": "private, max-age=3600",
    },
  });
};
