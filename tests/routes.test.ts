import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// app/routes.ts lists routes explicitly (see the comment there). A route file that is not listed would silently
// never be served, so every module under app/routes must be registered.
test("every file in app/routes is registered in app/routes.ts", () => {
  const registry = readFileSync(new URL("../app/routes.ts", import.meta.url), "utf8");
  const dir = new URL("../app/routes/", import.meta.url);
  const modules = readdirSync(dir).map((name) => (/\.(tsx?|jsx?)$/.test(name) ? `routes/${name}` : `routes/${name}/route.tsx`));
  assert.ok(modules.length > 20, "route files were found");
  const missing = modules.filter((m) => !registry.includes(`"${m}"`));
  assert.deepEqual(missing, [], `not registered in app/routes.ts: ${missing.join(", ")}`);
});

test("every route in app/routes.ts points at a file that exists", () => {
  const registry = readFileSync(new URL("../app/routes.ts", import.meta.url), "utf8");
  const files = [...registry.matchAll(/"(routes\/[^"]+\.tsx?)"/g)].map((m) => m[1]);
  const present = new Set(readdirSync(new URL("../app/routes/", import.meta.url)).map((n) => `routes/${n}`));
  const missing = files.filter((f) => !present.has(f) && !present.has(f.split("/").slice(0, 2).join("/")));
  assert.deepEqual(missing, [], `registered but missing: ${missing.join(", ")}`);
});
