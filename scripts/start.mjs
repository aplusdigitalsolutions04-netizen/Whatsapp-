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
  main();
}

function run(label, script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { stdio: "inherit", env });
  if (r.status !== 0) console.error(`[start] ${label} failed (exit ${r.status})`);
  return r.status === 0;
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
  if (!run("database migration", prismaCli, ["migrate", "deploy"])) {
    return serveProblem("The database could not be prepared", [
      `DATABASE_URL points to ${env.DATABASE_URL.replace(/^file:/, "")}. The folder must exist and be writable.`,
      "The exact error is in the server log.",
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
