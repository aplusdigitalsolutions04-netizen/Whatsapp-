// Entry file for hosts that ask for a "server.js" (e.g. Hostinger Node.js apps).
// Runs DB migrations, then starts the built React Router server on $PORT.
// Requires `npm run build` to have run first (build/server/index.js).
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = (p) => fileURLToPath(new URL(p, import.meta.url));

if (!existsSync(new URL("./build/server/index.js", import.meta.url))) {
  console.error("build/server/index.js not found. Run `npm run build` first.");
  process.exit(1);
}

const prismaBin = file("./node_modules/prisma/build/index.js");
for (const args of [["generate"], ["migrate", "deploy"]]) {
  const r = spawnSync(process.execPath, [prismaBin, ...args], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`prisma ${args.join(" ")} failed`);
    process.exit(r.status ?? 1);
  }
}

const serveBin = file("./node_modules/@react-router/serve/bin.js");
const child = spawn(process.execPath, [serveBin, "./build/server/index.js"], {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "production" },
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
