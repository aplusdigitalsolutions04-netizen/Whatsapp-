import { readFile } from "node:fs/promises";
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { mediaFilePath, verifyAvatarSignature } from "../lib/media.server";

// Customer profile pictures, served through short-lived signed links (<img> sends no session header).
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const id = params.id ?? "";
  if (!/^[a-z0-9]{20,40}$/.test(id) || !verifyAvatarSignature(id, url.searchParams.get("exp"), url.searchParams.get("sig"))) {
    return new Response("Forbidden", { status: 403 });
  }
  const conv = await prisma.conversation.findUnique({ where: { id }, select: { avatarFile: true } });
  const file = conv?.avatarFile ? mediaFilePath(conv.avatarFile) : null;
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(await readFile(file)), {
    headers: { "Content-Type": "image/jpeg", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600" },
  });
};
