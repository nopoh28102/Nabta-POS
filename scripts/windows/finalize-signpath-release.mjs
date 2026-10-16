// Refresh electron-updater metadata only AFTER SignPath returns the final signed installer.
// This release pipeline sets nsis.differentialPackage=false, and ships full updates.
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

const [installerArg, manifestArg] = process.argv.slice(2);
if (!installerArg || !manifestArg) throw new Error("Usage: node finalize-signpath-release.mjs installer.exe latest.yml");
const installer = resolve(installerArg);
const manifestPath = resolve(manifestArg);
const fileName = basename(installer);
const version = JSON.parse(readFileSync(resolve("apps/desktop/package.json"), "utf8")).version;
const expected = "Nabta-POS-" + version + "-x64.exe";
if (fileName !== expected) throw new Error("Unexpected installer: " + fileName + " (expected " + expected + ")");

let manifest = readFileSync(manifestPath, "utf8");
if (!new RegExp("^version:\\s*" + version.replaceAll(".", "\\.") + "\\s*$", "m").test(manifest)) {
  throw new Error("latest.yml version is not " + version);
}
const urls = [...manifest.matchAll(/^\s*-\s*url:\s*(.+)\s*$/gm)].map(m => m[1].trim().replace(/^["']|["']$/g, ""));
if (urls.length !== 1 || urls[0] !== fileName) throw new Error("latest.yml has an unexpected file URL: " + urls.join(","));
const legacyPath = manifest.match(/^path:\s*(.+)\s*$/m);
if (legacyPath && legacyPath[1].trim() !== fileName) throw new Error("latest.yml legacy path mismatch");
if (/^\s*blockMapSize\s*:/m.test(manifest)) {
  throw new Error("Differential metadata found: rebuild with -c.nsis.differentialPackage=false");
}
const bytes = readFileSync(installer);
const sha512 = createHash("sha512").update(bytes).digest("base64");
const size = statSync(installer).size;
let shaCount = 0;
manifest = manifest.replace(/^(\s*sha512:\s*)\S+(\s*)$/gm, (_match, head, tail) => {
  shaCount++;
  return head + sha512 + tail;
});
if (shaCount < 1 || shaCount > 2) throw new Error("Expected 1-2 SHA512 fields, found " + shaCount);
let sizeCount = 0;
manifest = manifest.replace(/^(\s*size:\s*)\d+(\s*)$/gm, (_match, head, tail) => {
  sizeCount++;
  return head + String(size) + tail;
});
if (sizeCount !== 1) throw new Error("Expected exactly one size entry, found " + sizeCount);
writeFileSync(manifestPath, manifest);
console.log("Final signed installer " + fileName + " size=" + size + " sha512=" + sha512);
