import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envFile = resolve(process.cwd(), ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(7443),
  DISCOVERY_PORT: z.coerce.number().int().min(1).max(65535).default(47620),
  DATABASE_MODE: z.enum(["embedded", "postgres"]).default("embedded"),
  DATABASE_DIR: z.string().min(1).default("./data/nabta-pglite"),
  DATABASE_URL: z.string().optional(),
  SETUP_TOKEN: z.string().min(20),
  SESSION_TTL_MINUTES: z.coerce.number().int().min(15).max(1440).default(480),
  TLS_CERT_PATH: z.string().optional(),
  TLS_KEY_PATH: z.string().optional(),
  TLS_PFX_PATH: z.string().optional(),
  TLS_PFX_PASSWORD: z.string().optional(),
  TLS_FINGERPRINT: z.string().optional(),
  BACKUP_DIR: z.string().optional(),
  // Set only by the packaged single-machine desktop host. It permits the
  // loopback-only routes that receive a path chosen through a native dialog.
  NABTA_LOCAL_MODE: z.enum(["0", "1"]).optional(),
  PG_DUMP_PATH: z.string().optional(),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  // The owner requested a separate confirmation code for the destructive
  // "start a new business cycle" action.  It can be overridden per server.
  DATA_RESET_PIN: z.string().regex(/^\d{6}$/).default("281020"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.parse(env);
  if (parsed.DATABASE_MODE === "postgres" && !parsed.DATABASE_URL) {
    throw new Error("DATABASE_URL is required when DATABASE_MODE=postgres");
  }
  return parsed;
}
