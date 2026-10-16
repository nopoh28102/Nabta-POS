// A remotely signed Electron executable must ship the certificate publisher to electron-updater.
// Run after electron-builder creates win-unpacked, BEFORE the EXE is sent to SignPath.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const file = process.argv[2] ?? join("apps", "desktop", "release", "win-unpacked", "resources", "app-update.yml");
const publisher = "SignPath Foundation";
let content = readFileSync(file, "utf8");
if (!/^provider:\s*github\s*$/m.test(content)) {
  throw new Error("Expected GitHub update provider in app-update.yml");
}
const existing = content.match(/^publisherName:\s*(.+)\s*$/m);
if (existing && existing[1].trim() !== publisher) {
  throw new Error("Unexpected updater publisher: " + existing[1]);
}
if (!existing) {
  content = content.trimEnd() + "\n" + "publisherName: " + publisher + "\n";
  writeFileSync(file, content);
}
console.log("Updater certificate publisher: " + publisher);
