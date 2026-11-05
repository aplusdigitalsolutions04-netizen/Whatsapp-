// Runs `prisma generate` before the dev server starts.
// On Windows, Prisma cannot replace its query-engine file while ANOTHER node process (an old dev server that was
// not closed) still has it loaded. That used to crash `shopify app dev`, so the app never started (blank page).
// The generated client is already up to date in that case, so a locked file is only a warning here.
import { spawnSync } from "node:child_process";

const r = spawnSync("npx", ["prisma", "generate"], { shell: true, encoding: "utf8" });
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
process.stdout.write(out);

if (r.status === 0) process.exit(0);
if (/EPERM|EBUSY|operation not permitted|resource busy/i.test(out)) {
  console.warn(
    "\n[predev] prisma generate could not replace its engine file because another node process still uses it " +
      "(probably an old dev server). Continuing with the existing client. If you changed prisma/schema.prisma, " +
      "close all other node processes and start again.\n",
  );
  process.exit(0);
}
process.exit(r.status ?? 1);
