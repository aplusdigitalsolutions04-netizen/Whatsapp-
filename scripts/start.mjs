// Production entry point: `npm start`. Works the same with Docker, PM2 and Node.js hosting panels.
//
// What it does, in order:
//   1. loads .env (when the file exists; real environment variables always win)
//   2. fills safe defaults (PORT, DATABASE_URL inside ./storage, SCOPES, SHOPIFY_APP_URL from DOMAIN)
//   3. checks the required settings
//   4. prepares the database (prisma generate when needed + migrate deploy)
//   5. builds the app when build/ is missing, then starts the server
//
// If anything fails, a small status page is served on $PORT instead of the host's generic "503", and the same
// reason is printed to the log. The status page never prints secret values.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const require = createRequire(import.meta.url);
// Package "exports" hide bin files from require.resolve, so locate them through the package folder instead.
const pkgFile = (pkg, file) => path.join(path.dirname(require.resolve(`${pkg}/package.json`)), file);

if (existsSync(path.join(root, ".env"))) {
  try {
    process.loadEnvFile(path.join(root, ".env"));
  } catch (e) {
    console.warn(`[start] could not read .env: ${e.message}`);
  }
}

const env = process.env;
// Day, week and month boundaries (Order Update sheet, dashboard "today") follow the server's clock zone. Hosting servers
// run in UTC, which would put an order placed after 6:30 pm UTC (midnight in India) on the wrong day. Override with TZ=...
env.TZ ||= "Asia/Kolkata";
env.NODE_ENV ||= "production";
env.PORT ||= "3000";
env.SCOPES ||= "read_orders,read_customers,read_products,write_products,write_files";
if (!env.SHOPIFY_APP_URL && env.DOMAIN) env.SHOPIFY_APP_URL = `https://${env.DOMAIN}`;
if (env.SHOPIFY_APP_URL) env.SHOPIFY_APP_URL = env.SHOPIFY_APP_URL.replace(/\/+$/, "");
// DATA_DIR keeps everything that must survive a redeploy (database, WhatsApp login, photos) in ONE folder outside the app folder.
if (env.DATA_DIR) {
  const d = path.resolve(env.DATA_DIR);
  mkdirSync(d, { recursive: true });
  env.DATABASE_URL ||= `file:${path.join(d, "shoppilot.sqlite").replaceAll("\\", "/")}`;
  env.WHATSAPP_AUTH_DIR ||= path.join(d, "wa-auth");
  env.WHATSAPP_MEDIA_DIR ||= path.join(d, "wa-media");
  env.FINDER_MEDIA_DIR ||= path.join(d, "finder-media");
  env.IMAGE_EDITOR_DIR ||= path.join(d, "image-editor");
  console.log(`[start] DATA_DIR is ${d}`);
}
if (!env.DATABASE_URL) {
  const dir = path.join(root, "storage");
  mkdirSync(dir, { recursive: true });
  env.DATABASE_URL = `file:${path.join(dir, "shoppilot.sqlite").replaceAll("\\", "/")}`;
  console.log(`[start] DATABASE_URL not set, using ${env.DATABASE_URL}`);
}

/** Serves a status page (HTTP 503) so the problem is visible in the browser and in the log. */
function serveProblem(title, lines) {
  console.error(`[start] ${title}`);
  for (const l of lines) console.error(`[start]   - ${l}`);
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Setup needed</title>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:10vh auto;padding:0 16px;line-height:1.5">
<h1 style="font-size:22px">${esc(title)}</h1><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
<p style="color:#666">Fix this in the server settings (or .env), then restart the app.</p></body>`;
  http
    .createServer((req, res) => {
      const isHealth = req.url?.startsWith("/health");
      res.writeHead(503, { "Content-Type": isHealth ? "application/json" : "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "60" });
      res.end(isHealth ? JSON.stringify({ ok: false, problem: title }) : html);
    })
    .listen(/^\d+$/.test(env.PORT) ? Number(env.PORT) : env.PORT, () => console.error(`[start] status page listening on port ${env.PORT}`));
}

const missing = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_APP_URL"].filter((k) => !env[k]?.trim());
if (missing.length) {
  serveProblem("Required settings are missing", [
    `Set: ${missing.join(", ")}${missing.includes("SHOPIFY_APP_URL") ? " (or set DOMAIN, e.g. app.example.com)" : ""}`,
  ]);
} else if (!/^https:\/\//.test(env.SHOPIFY_APP_URL) && env.NODE_ENV === "production" && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(env.SHOPIFY_APP_URL)) {
  serveProblem("SHOPIFY_APP_URL must be a public https:// address", [`Current value: ${env.SHOPIFY_APP_URL}`]);
} else {
  Promise.resolve(main()).catch((e) => serveProblem("The app could not start", [String(e?.message ?? e)]));
}

function run(label, script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { stdio: "inherit", env });
  if (r.status !== 0) console.error(`[start] ${label} failed (exit ${r.status})`);
  return r.status === 0;
}

/** Runs a node script and keeps its output, so the real reason of a failure can be shown on the status page. */
function runCapture(script, args) {
  // Few threads for Prisma's schema engine: on hosting with a low process limit it is otherwise killed ("exit null").
  const lean = { ...env, TOKIO_WORKER_THREADS: env.TOKIO_WORKER_THREADS || "1", RAYON_NUM_THREADS: env.RAYON_NUM_THREADS || "1" };
  const r = spawnSync(process.execPath, [script, ...args], { env: lean, encoding: "utf8" });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const killed = r.status === null ? `\nThe program was stopped by the server (${r.signal ?? "no exit code"}): \`killed\`, probably a memory or thread limit.` : "";
  return { ok: r.status === 0, text: `${r.stdout ?? ""}\n${r.stderr ?? ""}${killed}` };
}

/** Plain-words reason for a failed `prisma migrate deploy`, taken from its output. */
function explainMigrationFailure(text) {
  const t = String(text);
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => /error|P\d{4}|failed|locked|unable|denied|no such|already exists/i.test(l) && !/^\[start\]/.test(l));
  const why = [];
  if (/P3009|failed migrations?/i.test(t)) why.push("An earlier database update stopped half way. The log names the migration; it has to be marked as resolved (npx prisma migrate resolve) before the app can start.");
  else if (/stopped by the server|killed/i.test(t)) why.push("The server stopped Prisma's update program (a memory or thread limit). The app then tries to apply the update itself.");
  else if (/database is locked|SQLITE_BUSY|timed out/i.test(t)) why.push("The database is busy: another copy of the app is still running. Stop the app completely, wait a minute and start it again.");
  else if (/unable to open|EACCES|permission denied|read-only|readonly|P1003|P1001|P1009/i.test(t)) why.push("The database file or its folder cannot be opened or written. Check that the folder exists and the hosting user can write to it.");
  else if (/already exists|duplicate column/i.test(t)) why.push("The database already has a table or column from this update (a half-applied update). The log shows which one.");
  return { why, lines: [...new Set(lines)].slice(-6).map((l) => l.slice(0, 220)) };
}

function main() {
  const prismaCli = pkgFile("prisma", "build/index.js");

  // The generated database client must match prisma/schema.prisma. A server that keeps an old node_modules between deploys
  // would otherwise run an old client against the new database and answer every page with a 500. A small marker file
  // remembers which schema the client was generated from; when it differs (or is missing) the client is generated again.
  const clientDir = path.join(root, "node_modules", ".prisma", "client");
  const schemaHash = createHash("sha1").update(readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8").replace(/\r\n/g, "\n")).digest("hex");
  const markerFile = path.join(clientDir, ".schema-hash");
  const clientCurrent = existsSync(path.join(clientDir, "index.js")) && existsSync(markerFile) && readFileSync(markerFile, "utf8").trim() === schemaHash;
  if (!clientCurrent) {
    console.log("[start] database client is missing or out of date, generating it");
    if (run("prisma generate", prismaCli, ["generate"])) {
      try {
        writeFileSync(markerFile, schemaHash);
      } catch {
        /* without the marker the client is simply generated again on the next start */
      }
    } else if (!existsSync(path.join(clientDir, "index.js"))) {
      return serveProblem("The database client could not be generated", ["Run `npx prisma generate` on the server and check the log above."]);
    } else {
      console.warn("[start] could not refresh the database client (a file may be in use); starting with the existing one");
    }
  }
  // 1) Nothing to do? Then Prisma's update program is not started at all (it is the part hosting limits kill).
  // 2) Otherwise it is tried up to 3 times (a second copy of the app during a redeploy can hold the database for a few seconds).
  // 3) If it keeps failing, plain updates are applied by the app itself with its own database client.
  return migrateThenServe(prismaCli);
}

async function migrateThenServe(prismaCli) {
  const fb = await import("./migrate-fallback.mjs");
  let pending = null;
  try {
    pending = await fb.withDatabase(root, (db) => fb.pendingMigrations(db, root));
  } catch (e) {
    console.warn(`[start] could not check the database updates (${e.message}); using Prisma's tool`);
  }
  let migrated = { ok: pending !== null && pending.length === 0, text: "" };
  if (migrated.ok) console.log("[start] database is up to date");
  for (let attempt = 1; attempt <= 3 && !migrated.ok; attempt++) {
    migrated = runCapture(prismaCli, ["migrate", "deploy"]);
    if (!migrated.ok) {
      console.error(`[start] database migration failed (attempt ${attempt}/3)`);
      if (attempt < 3) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);
    }
  }
  if (!migrated.ok && pending && pending.length) {
    try {
      const n = await fb.withDatabase(root, (db) => fb.applyMigrations(db, root, pending));
      console.warn(`[start] applied ${n} database update(s) without Prisma's tool: ${pending.join(", ")}`);
      migrated = { ok: true, text: "" };
    } catch (e) {
      console.error(`[start] the app could not apply the updates itself: ${e.message}`);
      migrated.text += `\n${e.message}`;
    }
  }
  if (!migrated.ok) {
    const why = explainMigrationFailure(migrated.text);
    return serveProblem("The database could not be prepared", [
      `DATABASE_URL points to ${env.DATABASE_URL.replace(/^file:/, "")}.`,
      ...why.why,
      ...(why.lines.length ? [`Prisma said: ${why.lines.join(" | ")}`] : []),
      "The full error is in the server log (look for 'database migration failed').",
    ]);
  }

  const serverEntry = path.join(root, "build", "server", "index.js");
  if (!existsSync(serverEntry)) {
    console.log("[start] build/ not found, building the app first");
    const rrDev = pkgFile("@react-router/dev", "bin.js");
    if (!run("build", rrDev, ["build"]) || !existsSync(serverEntry)) {
      return serveProblem("The app is not built", ["Run `npm run build` on the server (needs the dev dependencies: `npm ci`)."]);
    }
  }

  // Run the server IN THIS PROCESS: managed Node.js hosts (e.g. Hostinger) attach the port to the entry process,
  // so a child process would never receive traffic.
  process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
  process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));
  process.argv[2] = "./build/server/index.js";
  // A build made on Windows stores the browser-files folder as "build\client". On Linux hosts that is a folder
  // that does not exist, so every script/stylesheet answers 404 and pages stay blank. Rewrite it to a portable path.
  try {
    const entryText = readFileSync(serverEntry, "utf8");
    const fixed = entryText.replace(/assetsBuildDirectory = "build\\\\client"/, 'assetsBuildDirectory = "build/client"');
    if (fixed !== entryText) {
      writeFileSync(serverEntry, fixed);
      console.log("[start] fixed the browser-files path in the build");
    }
  } catch (e) {
    console.warn(`[start] could not check the browser-files path: ${e.message}`);
  }
  const assetsDir = path.join(root, "build", "client", "assets");
  console.log(`[start] folder ${root}, browser files: ${existsSync(assetsDir) ? readdirSync(assetsDir).length : "MISSING"}`);
  console.log(`[start] starting app on port ${env.PORT}`);
  import(pathToFileURL(pkgFile("@react-router/serve", "dist/cli.js")).href).catch((e) => {
    console.error("[start] the server failed to start:", e);
    serveProblem("The server failed to start", ["The exact error is in the server log."]);
  });
}
