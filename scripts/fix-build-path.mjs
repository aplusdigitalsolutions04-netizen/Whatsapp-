// Runs after `react-router build`. A build made on Windows stores the browser-files folder as "build\client",
// which does not exist on Linux hosts (every script/stylesheet would answer 404 and pages stay blank).
// This rewrites it to the portable "build/client". scripts/start.mjs does the same check at startup.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

// The store website loads /jazz.js (public/jazz.js, copied by the build), which loads this stylesheet from the app.
// One source: app/styles/jazz-widget.css is also what the link page and the admin use.
copyFileSync("app/styles/jazz-widget.css", "build/client/jazz-widget.css");

const bs = String.fromCharCode(92);
const file = "build/server/index.js";
const text = readFileSync(file, "utf8");
const fixed = text.split(`assetsBuildDirectory = "build${bs}${bs}client"`).join('assetsBuildDirectory = "build/client"');
writeFileSync("build/build-info.json", JSON.stringify({ builtAt: new Date().toISOString() }));
if (fixed !== text) {
  writeFileSync(file, fixed);
  console.log("[build] made the browser-files path portable");
}
