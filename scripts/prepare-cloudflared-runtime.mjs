import { copyFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "apps", "desktop", "build", "cloudflared");
const output = path.join(outputDirectory, "cloudflared.exe");
const configured = process.env.NABTA_CLOUDFLARED_BINARY;
const commonLocalCopy = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "@nabta", "desktop", "cloudflared", "cloudflared.exe");
const source = [configured, commonLocalCopy].find((candidate) => candidate && existsSync(candidate));

if (!source) {
  throw new Error("cloudflared.exe was not found. Set NABTA_CLOUDFLARED_BINARY to the verified Cloudflare binary before packaging.");
}
const size = (await stat(source)).size;
if (size < 5_000_000) throw new Error(`Refusing to package an invalid cloudflared binary: ${source}`);
await mkdir(outputDirectory, { recursive: true });
await copyFile(source, output);
console.log(JSON.stringify({ cloudflared: "prepared", bytes: size }));
