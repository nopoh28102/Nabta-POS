import { readFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createConfiguredDatabase } from "./db.js";
import { startBackupScheduler } from "./backup.js";
import { startDiscoveryResponder } from "./discovery.js";

const config = loadConfig();
const db = await createConfiguredDatabase(config);
if (config.NODE_ENV === "production" && ((!config.TLS_CERT_PATH || !config.TLS_KEY_PATH) && !config.TLS_PFX_PATH)) {
  throw new Error("TLS_CERT_PATH/TLS_KEY_PATH or TLS_PFX_PATH are required in production");
}
const https = config.TLS_CERT_PATH && config.TLS_KEY_PATH
  ? { cert: await readFile(config.TLS_CERT_PATH), key: await readFile(config.TLS_KEY_PATH) }
  : config.TLS_PFX_PATH
    ? { pfx: await readFile(config.TLS_PFX_PATH), ...(config.TLS_PFX_PASSWORD ? { passphrase: config.TLS_PFX_PASSWORD } : {}) }
    : undefined;
const app = buildApp(config, db, { ...(https ? { https } : {}) });

await app.listen({ host: config.HOST, port: config.PORT });
startBackupScheduler(db, config);
let stopDiscovery: (() => Promise<void>) | null = null;
if (process.env.NABTA_LOCAL_MODE !== "1") {
  try {
    const fingerprint = config.TLS_FINGERPRINT ?? (config.TLS_CERT_PATH ? new X509Certificate(await readFile(config.TLS_CERT_PATH)).fingerprint256 : undefined);
    stopDiscovery = await startDiscoveryResponder({ apiPort: config.PORT, discoveryPort: config.DISCOVERY_PORT, tls: Boolean(https), ...(fingerprint ? { certificateFingerprint: fingerprint } : {}) });
  } catch (error) {
    app.log.warn({ error }, "LAN discovery is unavailable; manual connection remains available in Settings");
  }
}

async function shutdown(): Promise<void> {
  if (stopDiscovery) await stopDiscovery();
  await app.close();
  await db.end();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
