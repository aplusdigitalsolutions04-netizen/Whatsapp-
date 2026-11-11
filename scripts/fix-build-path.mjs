// Runs after `react-router build`. A build made on Windows stores the browser-files folder as "build\client",
// which does not exist on Linux hosts (every script/stylesheet would answer 404 and pages stay blank).
// This rewrites it to the portable "build/client". scripts/start.mjs does the same check at startup.
import { readFileSync, writeFileSync } from "node:fs";

const bs = String.fromCharCode(92);
const file = "build/server/index.js";
const text = readFileSync(file, "utf8");
const fixed = text.split(`assetsBuildDirectory = "build${bs}${bs}client"`).join('assetsBuildDirectory = "build/client"');
if (fixed !== text) {
  writeFileSync(file, fixed);
  console.log("[build] made the browser-files path portable");
}
