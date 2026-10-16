import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const release = path.join(root, "apps", "desktop", "release");
await mkdir(release, { recursive: true });
await copyFile(path.join(root, "scripts", "windows", "Nabta-Server-Admin.cmd"), path.join(release, "Nabta-Server-Admin.cmd"));
await copyFile(path.join(root, "scripts", "windows", "Nabta-Server-Admin.vbs"), path.join(release, "Nabta-Server-Admin.vbs"));
await copyFile(path.join(root, "scripts", "windows", "README-LAUNCHER-AR.md"), path.join(release, "README-LAUNCHER-AR.md"));
