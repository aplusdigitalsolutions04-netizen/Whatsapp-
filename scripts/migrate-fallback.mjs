// Database updates without Prisma's separate "schema engine" program.
//
// `prisma migrate deploy` starts a second program (the schema engine). On hosting with tight thread / memory limits that program
// can be killed by the host ("exit null"), and then the app cannot start at all. This file does the same job with the database
// client the app already uses: it finds the updates that are not applied yet and runs their SQL, recording each one in
// _prisma_migrations exactly like Prisma does (so a normal `prisma migrate deploy` still agrees with the result).
// It only handles plain updates (CREATE / ALTER / INDEX). Anything else is refused and Prisma's own tool must be used.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const migrationNames = (root) => {
  const dir = path.join(root, "prisma", "migrations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
};

/** SQL text -> separate statements (comment lines dropped). Plain migration files only. */
export function splitStatements(sql) {
  return String(sql)
    .split(/\r?\n/)
    .filter((l) => !/^\s*--/.test(l))
    .join("\n")
    .split(/;[ \t]*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when the file only holds statements this fallback can run safely. */
export const isPlainMigration = (sql) => !/\b(PRAGMA|TRIGGER|BEGIN|COMMIT|DROP\s+TABLE|RENAME)\b/i.test(sql);

/**
 * Names of the migrations that are not applied yet, or null when the database has no _prisma_migrations table
 * (a brand-new database: Prisma's own tool has to create it).
 */
export async function pendingMigrations(db, root) {
  let rows;
  try {
    rows = await db.$queryRawUnsafe("SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations");
  } catch {
    return null;
  }
  const done = new Set(rows.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name));
  return migrationNames(root).filter((n) => !done.has(n));
}

/** Runs the given pending migrations in order, each in one transaction together with its _prisma_migrations row. */
export async function applyMigrations(db, root, names) {
  for (const name of names) {
    const file = path.join(root, "prisma", "migrations", name, "migration.sql");
    const raw = readFileSync(file);
    const sql = raw.toString("utf8");
    if (!isPlainMigration(sql)) throw new Error(`${name} is not a plain update (it redefines tables); it needs Prisma's own tool`);
    const checksum = createHash("sha256").update(raw).digest("hex");
    const statements = splitStatements(sql);
    await db.$transaction(async (tx) => {
      for (const st of statements) await tx.$executeRawUnsafe(st);
      await tx.$executeRawUnsafe(
        "INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) " +
          "VALUES (?, ?, CAST(strftime('%s','now') AS INTEGER) * 1000, ?, NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, 1)",
        randomUUID(),
        checksum,
        name,
      );
    });
  }
  return names.length;
}

/** Opens the app's own database client (loaded from the project folder), runs fn(db), always closes it. */
export async function withDatabase(root, fn) {
  const require = createRequire(path.join(root, "package.json"));
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  try {
    return await fn(db);
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}
