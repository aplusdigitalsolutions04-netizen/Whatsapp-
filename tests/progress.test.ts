import { test } from "node:test";
import assert from "node:assert/strict";
import { endTask, getTask, startTask, updateTask } from "../app/lib/progress.server.ts";

test("a task shows its count and total while it runs, and starting it again does not reset it", () => {
  const shop = "progress-test-1.invalid";
  assert.equal(getTask(shop, "sync"), null, "nothing is shown when nothing runs");
  startTask(shop, "sync", "Reading orders");
  updateTask(shop, "sync", { done: 40, total: 200 });
  startTask(shop, "sync", "Reading orders"); // a second click must not send the bar back to 0
  const t = getTask(shop, "sync")!;
  assert.deepEqual([t.running, t.done, t.total], [true, 40, 200]);
});

test("a finished task jumps to 100% and keeps an error message when it failed", () => {
  const shop = "progress-test-2.invalid";
  startTask(shop, "sheet", "Sending", 50);
  updateTask(shop, "sheet", { done: 10 });
  endTask(shop, "sheet");
  const ok = getTask(shop, "sheet")!;
  assert.deepEqual([ok.running, ok.done, ok.total, ok.error], [false, 50, 50, null]);

  startTask(shop, "sync", "Reading", 100);
  updateTask(shop, "sync", { done: 30 });
  endTask(shop, "sync", "Shopify did not answer");
  endTask(shop, "sync"); // the cleanup that always runs afterwards must not wipe the error
  const bad = getTask(shop, "sync")!;
  assert.deepEqual([bad.running, bad.done, bad.error], [false, 30, "Shopify did not answer"]);
});

test("tasks of different shops and different jobs do not mix", () => {
  startTask("progress-test-3.invalid", "sync", "A", 10);
  startTask("progress-test-4.invalid", "sync", "B", 20);
  assert.equal(getTask("progress-test-3.invalid", "sync")?.total, 10);
  assert.equal(getTask("progress-test-4.invalid", "sync")?.total, 20);
  assert.equal(getTask("progress-test-3.invalid", "sheet"), null);
});
