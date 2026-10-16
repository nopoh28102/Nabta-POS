import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConfiguredDatabase } from "../db.js";
import { loadConfig } from "../config.js";

const config = loadConfig();
const db = await createConfiguredDatabase(config);
const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const migrationDir = resolve(root, "migrations");

try {
  const files = (await readdir(migrationDir)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied = new Set((await db.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((row) => row.version));
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    const sql = await readFile(resolve(migrationDir, file), "utf8");
    process.stdout.write(`Applying ${version}... `);
    await db.exec(sql);
    await db.query("INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT (version) DO NOTHING", [version]);
    process.stdout.write("done\n");
  }
} finally {
  await db.end();
}
