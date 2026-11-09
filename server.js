// Entry file for hosts that ask for a "server.js" (e.g. Hostinger Node.js apps).
// Runs DB migrations, then starts the built React Router server on $PORT.
// Requires `npm run build` to have run first (build/server/index.js).
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = (p) => fileURLToPath(new URL(p, import.meta.url));

const prismaBin = file("./node_modules/prisma/build/index.js");
const run = (args) => spawnSync(process.execPath, args, { stdio: "inherit" });

// Build output is not in git. If the host skipped the build step, build now.
if (!existsSync(new URL("./build/server/index.js", import.meta.url))) {
  console.log("build/server/index.js missing - building now (this takes a minute)...");
  let r = run([prismaBin, "generate"]);
  if (r.status === 0) r = run([file("./node_modules/@react-router/dev/bin.js"), "build"]);
  if (r.status !== 0 || !existsSync(new URL("./build/server/index.js", import.meta.url))) {
    console.error("Build failed. Set the host build command to: npm ci --include=dev && npx prisma generate && npm run build");
    process.exit(r.status || 1);
  }
}

for (const args of [["generate"], ["migrate", "deploy"]]) {
  const r = run([prismaBin, ...args]);
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
