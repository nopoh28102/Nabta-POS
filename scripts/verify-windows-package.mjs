import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = process.argv[2] ?? "release";
const outputRoot = path.resolve(root, "apps", "desktop", outputDirectory);
const unpackedRoot = path.join(outputRoot, "win-unpacked");
const runtimeRoot = path.join(unpackedRoot, "resources", "server-runtime");
const fallbackRuntimeRoot = path.join(unpackedRoot, "resources", "app.asar.unpacked", "server-runtime");

const requiredRuntimeFiles = [
  path.join("runner.mjs"),
  path.join("server-bundle.mjs"),
  path.join("pglite", "dist", "index.js"),
];

async function validateRuntime(runtimePath, label) {
  const missing = requiredRuntimeFiles
    .filter((relative) => !existsSync(path.join(runtimePath, relative)))
    .map((relative) => `${label}/${relative}`);
  const migrationDir = path.join(runtimePath, "migrations");
  const migrationCount = existsSync(migrationDir)
    ? (await readdir(migrationDir)).filter((name) => /^\d+_.+\.sql$/.test(name)).length
    : 0;
  if (migrationCount === 0) missing.push(`${label}/migrations/*.sql`);
  return { missing, migrationCount };
}

if (!existsSync(unpackedRoot)) throw new Error(`لم يُنشأ مجلد التطبيق المفكوك: ${unpackedRoot}`);

const entries = await readdir(unpackedRoot);
const applicationExecutable = entries.find((name) => name.endsWith(".exe") && name !== "elevate.exe");
const installers = (await readdir(outputRoot))
  .filter((name) => /^Nabta-POS-.+-x64\.exe$/i.test(name));

const primary = await validateRuntime(runtimeRoot, "resources/server-runtime");
const fallback = await validateRuntime(fallbackRuntimeRoot, "resources/app.asar.unpacked/server-runtime");
const missing = [
  ...primary.missing,
  ...fallback.missing,
  ...(applicationExecutable ? [] : ["win-unpacked/<application>.exe"]),
  ...(installers.length ? [] : ["<installer>.exe"]),
];

if (missing.length) {
  throw new Error(`رفض إنشاء مثبت Windows ناقص. الملفات غير الموجودة:\n${missing.map((item) => `- ${item}`).join("\n")}`);
}

const installerStats = await Promise.all(installers.map(async (name) => ({ name, size: (await stat(path.join(outputRoot, name))).size })));
if (installerStats.some((installer) => installer.size < 50 * 1024 * 1024)) {
  throw new Error(`رفض إنشاء مثبت صغير بصورة غير طبيعية: ${installerStats.map((installer) => `${installer.name} (${installer.size})`).join(", ")}`);
}

console.log(`تم التحقق من حزمة Windows: الخادم المحلي موجود في المسارين، والترحيلات: ${primary.migrationCount}/${fallback.migrationCount}، والمثبت: ${installerStats.map((installer) => installer.name).join(", ")}`);
