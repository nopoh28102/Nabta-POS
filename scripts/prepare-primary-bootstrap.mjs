import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "apps", "desktop", "build", "primary-bootstrap");
const requested = process.env.NABTA_PRIMARY_INSTALLER === "1";
const useExisting = process.env.NABTA_PRIMARY_USE_EXISTING === "1";
const tunnelToken = process.env.NABTA_PRIMARY_TUNNEL_TOKEN?.trim();
const commerceSharedSecret = process.env.NABTA_COMMERCE_SHARED_SECRET?.trim();

const existingProvisioning = path.join(target, "cloudflare-provisioning.json");
if (useExisting && existsSync(existingProvisioning) && !tunnelToken && !commerceSharedSecret) {
  await copyFile(path.join(root, "scripts", "windows", "provision-primary-cloudflare.ps1"), path.join(target, "provision-primary-cloudflare.ps1"));
  console.log(JSON.stringify({ primaryBootstrap: "reused" }));
  process.exit(0);
}
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await copyFile(path.join(root, "scripts", "windows", "provision-primary-cloudflare.ps1"), path.join(target, "provision-primary-cloudflare.ps1"));
if (requested && (!tunnelToken || tunnelToken.length < 32 || !commerceSharedSecret || commerceSharedSecret.length < 32)) {
  throw new Error("Primary installer needs NABTA_PRIMARY_TUNNEL_TOKEN and NABTA_COMMERCE_SHARED_SECRET; secrets are never read from Git.");
}
if (tunnelToken && commerceSharedSecret) {
  await writeFile(path.join(target, "cloudflare-provisioning.json"), JSON.stringify({ version: 1, enabled: true, autoStart: true, tunnelToken, commerceSharedSecret }, null, 2), { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ primaryBootstrap: "prepared" }));
} else {
  await writeFile(path.join(target, "README.txt"), "No primary-device Cloudflare provisioning was included in this installer.\r\n", "utf8");
  console.log(JSON.stringify({ primaryBootstrap: "not-requested" }));
}
