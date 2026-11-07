export interface Env {
  NABTA_CLOUD_BOOTSTRAP_KEY: string;
  NABTA_STORE_LEDGER: DurableObjectNamespace;
  NABTA_STORE_DIRECTORY: DurableObjectNamespace;
  NABTA_BACKUP_ARCHIVE: R2Bucket;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}
interface DurableObjectId { readonly toString: () => string; }
interface DurableObjectStub { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>; }
interface SqlCursor<T extends Record<string, unknown> = Record<string, unknown>> extends Iterable<T> { toArray(): T[]; }
interface DurableObjectSqlStorage { exec<T extends Record<string, unknown> = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<T>; }
interface DurableObjectStorage { readonly sql: DurableObjectSqlStorage; }
interface DurableObjectState { readonly storage: DurableObjectStorage; }
interface R2Bucket {
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

const FORMAT = "NABTA_CLOUD_MIGRATION_V1";
const MAX_CHUNK_BYTES = 512 * 1024;
const CLOUD_API_VERSION = "2026-11-07";
/*
 * A Durable Object is already a strongly-consistent per-store database.  The
 * first cut of the cloud service used it as a one-time import target, which
 * made a later backup dangerous: switching `migrationId` at upload start
 * briefly hid the last verified copy.  This mode keeps a verified active
 * replica and stages every replacement separately until it is complete.
 *
 * Financial posting deliberately remains disabled here.  A snapshot replica
 * must never pretend to be a transaction authority before sale/purchase
 * reconciliation is implemented end-to-end.
 */
const CLOUD_MODE = "CLOUD_PROTECTED_REPLICA" as const;
const CLOUD_CAPABILITIES = {
  apiVersion: CLOUD_API_VERSION,
  mode: CLOUD_MODE,
  authoritativeTransactions: false,
  operations: {
    catalogRead: true,
    reorderRead: true,
    expiryRegistration: true,
    staffProvisioning: true,
    pendingMutationExport: true,
    productCreate: false,
    productUpdate: false,
    barcodeGeneration: false,
    purchaseReceiptPost: false,
    salePost: false,
    returnPost: false,
  },
  guarantees: {
    idempotency: ["expiryRegistration"],
    auditEvents: ["expiryRegistration"],
    desktopReconciliationRequired: true,
  },
} as const;
const CLOUD_STAFF_ROLES = new Set(["MANAGER", "CASHIER", "STOCK_KEEPER", "EXPIRY_CLERK"]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Manifest = {
  format: typeof FORMAT;
  migrationId: string;
  createdAt: string;
  schemaVersion: string;
  backup: { id: string; sha256: string; sizeBytes: number };
  chunkCount: number;
  recordCount: number;
  tables: Array<{ name: string; rowCount: number; sha256: string }>;
};
type MigrationChunk = {
  format: typeof FORMAT;
  migrationId: string;
  sequence: number;
  records: Array<{ table: string; record: Json }>;
  sha256: string;
};

type CloudUser = { id: string; username: string; displayName: string; role: string; passwordHash: string; salt: string };
type CloudSession = { token: string; userId: string; terminalId: string; expiresAt: string };

const OWNER_PERMISSIONS = ["SALE_POST", "DISCOUNT", "PRODUCT_WRITE", "SHIFT_OPEN", "SHIFT_CLOSE", "CASH_MOVE", "RETURN_SALE", "PURCHASE_RECEIVE", "STOCK_COUNT", "VIEW_COST", "VIEW_PROFIT", "BACKUP", "SETTINGS", "EXPORT"];
const MANAGER_PERMISSIONS = OWNER_PERMISSIONS.filter((permission) => !["BACKUP", "SETTINGS"].includes(permission));
const STOCK_KEEPER_PERMISSIONS = ["PRODUCT_WRITE", "PURCHASE_RECEIVE", "STOCK_COUNT"];

function permissionsFor(role: string): string[] {
  if (role === "OWNER") return OWNER_PERMISSIONS;
  if (role === "MANAGER") return MANAGER_PERMISSIONS;
  if (role === "STOCK_KEEPER") return STOCK_KEEPER_PERMISSIONS;
  return ["SALE_POST", "SHIFT_OPEN", "SHIFT_CLOSE"];
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

function sameSecret(provided: string | null, expected: string | null | undefined): boolean {
  if (!provided || !expected || provided.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  return mismatch === 0;
}

function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

async function sha256(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function passwordHash(password: string, salt: string): Promise<string> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 210_000 }, material, 256);
  return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseManifest(value: unknown): Manifest | null {
  if (!value || typeof value !== "object") return null;
  const manifest = value as Partial<Manifest>;
  const chunkCount = manifest.chunkCount;
  const recordCount = manifest.recordCount;
  if (manifest.format !== FORMAT || typeof manifest.migrationId !== "string" || !/^[0-9a-f-]{36}$/i.test(manifest.migrationId)
    || typeof chunkCount !== "number" || !Number.isInteger(chunkCount) || chunkCount < 0
    || typeof recordCount !== "number" || !Number.isInteger(recordCount) || recordCount < 0
    || !Array.isArray(manifest.tables) || typeof manifest.schemaVersion !== "string") return null;
  return manifest as Manifest;
}

function parseChunk(value: unknown): MigrationChunk | null {
  if (!value || typeof value !== "object") return null;
  const chunk = value as Partial<MigrationChunk>;
  if (chunk.format !== FORMAT || typeof chunk.migrationId !== "string" || !Number.isInteger(chunk.sequence) || (chunk.sequence ?? -1) < 0
    || !Array.isArray(chunk.records) || typeof chunk.sha256 !== "string") return null;
  return chunk as MigrationChunk;
}

function sqlRows<T extends Record<string, unknown>>(cursor: SqlCursor<T>): T[] { return cursor.toArray(); }

export class NabtaStoreLedger {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS cloud_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS migration_chunks (migration_id TEXT NOT NULL, sequence INTEGER NOT NULL, sha256 TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (migration_id, sequence))");
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS cloud_records (migration_id TEXT NOT NULL, source_table TEXT NOT NULL, source_ordinal INTEGER NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY (migration_id, source_table, source_ordinal))");
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS cloud_users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, role TEXT NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL)");
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS cloud_user_access (user_id TEXT PRIMARY KEY, active INTEGER NOT NULL, updated_at TEXT NOT NULL)");
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS cloud_sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, terminal_id TEXT NOT NULL, expires_at TEXT NOT NULL)");
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS cloud_idempotency (user_id TEXT NOT NULL, key TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(user_id, key))");
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS cloud_mutation_idempotency (user_id TEXT NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id, operation, key))");
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS cloud_mutation_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, operation TEXT NOT NULL, actor_user_id TEXT NOT NULL, terminal_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, applied_at TEXT, UNIQUE(actor_user_id, operation, idempotency_key))");
    // Each verified upload remains addressable by its immutable migration ID.
    // The active pointer changes only inside a successful finalization.
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS cloud_snapshots (migration_id TEXT PRIMARY KEY, record_count INTEGER NOT NULL, backup_id TEXT NOT NULL, backup_sha256 TEXT NOT NULL, completed_at TEXT NOT NULL)");
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS cloud_snapshot_archives (migration_id TEXT PRIMARY KEY, state TEXT NOT NULL, archive_prefix TEXT NOT NULL, archived_at TEXT, last_error TEXT)");
  }

  private value(key: string): string | null {
    const row = sqlRows(this.state.storage.sql.exec<{ value: string }>("SELECT value FROM cloud_meta WHERE key = ?", key))[0];
    return typeof row?.value === "string" ? row.value : null;
  }

  private set(key: string, value: string): void {
    this.state.storage.sql.exec("INSERT INTO cloud_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  private authorized(request: Request): boolean {
    return sameSecret(request.headers.get("x-nabta-cloud-migration-key"), this.value("migrationKey"));
  }

  /** Legacy stores used `migrationId` as the active pointer. Keep them readable. */
  private activeMigrationId(): string | null {
    return this.value("activeMigrationId") ?? this.value("migrationId");
  }

  private records(table: string): Array<{ ordinal: number; row: Record<string, Json> }> {
    const migrationId = this.activeMigrationId();
    if (!migrationId) return [];
    return sqlRows(this.state.storage.sql.exec<{ source_ordinal: number; row_json: string }>("SELECT source_ordinal, row_json FROM cloud_records WHERE migration_id = ? AND source_table = ? ORDER BY source_ordinal", migrationId, table))
      .map((item) => ({ ordinal: Number(item.source_ordinal), row: JSON.parse(item.row_json) as Record<string, Json> }));
  }

  private updateRecord(table: string, ordinal: number, row: Record<string, Json>): void {
    const migrationId = this.activeMigrationId();
    if (!migrationId) throw new Error("import required");
    this.state.storage.sql.exec("UPDATE cloud_records SET row_json = ? WHERE migration_id = ? AND source_table = ? AND source_ordinal = ?", JSON.stringify(row), migrationId, table, ordinal);
  }

  private insertRecord(table: string, row: Record<string, Json>): void {
    const migrationId = this.activeMigrationId();
    if (!migrationId) throw new Error("import required");
    const next = sqlRows(this.state.storage.sql.exec<{ next: number }>("SELECT COALESCE(MAX(source_ordinal) + 1, 0) AS next FROM cloud_records WHERE migration_id = ? AND source_table = ?", migrationId, table))[0]?.next ?? 0;
    this.state.storage.sql.exec("INSERT INTO cloud_records(migration_id, source_table, source_ordinal, row_json) VALUES (?, ?, ?, ?)", migrationId, table, next, JSON.stringify(row));
  }

  private session(request: Request): { user: CloudUser; session: CloudSession } | null {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    if (!token) return null;
    const session = sqlRows(this.state.storage.sql.exec<{ token: string; user_id: string; terminal_id: string; expires_at: string }>("SELECT token, user_id, terminal_id, expires_at FROM cloud_sessions WHERE token = ?", token))[0];
    if (!session || Date.parse(session.expires_at) <= Date.now()) return null;
    const user = sqlRows(this.state.storage.sql.exec<{ id: string; username: string; display_name: string; role: string; password_hash: string; salt: string }>("SELECT id, username, display_name, role, password_hash, salt FROM cloud_users WHERE id = ?", session.user_id))[0];
    const access = sqlRows(this.state.storage.sql.exec<{ active: number }>("SELECT active FROM cloud_user_access WHERE user_id = ?", session.user_id))[0];
    if (!user || !access || Number(access.active) !== 1) return null;
    return { user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role, passwordHash: user.password_hash, salt: user.salt }, session: { token: session.token, userId: session.user_id, terminalId: session.terminal_id, expiresAt: session.expires_at } };
  }

  private requirePermission(request: Request, permission: string): { user: CloudUser; session: CloudSession } | Response {
    const auth = this.session(request);
    if (!auth) return json({ code: "AUTH_REQUIRED", message: "سجّل الدخول أولًا" }, 401);
    if (!permissionsFor(auth.user.role).includes(permission)) return json({ code: "FORBIDDEN", message: "ليست لديك صلاحية لتنفيذ هذه العملية" }, 403);
    return auth;
  }

  private async registerTerminals(): Promise<void> {
    const storeId = this.value("storeId");
    if (!storeId) return;
    const terminals = this.records("terminals").map((entry) => String(entry.row.id ?? "")).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (terminals.length === 0) return;
    const directory = this.env.NABTA_STORE_DIRECTORY.get(this.env.NABTA_STORE_DIRECTORY.idFromName("nabta-store-directory"));
    const response = await directory.fetch(new Request("https://nabta.internal/internal/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ storeId, terminals }) }));
    if (!response.ok) throw new Error("store directory update failed");
  }

  private publicStatus(request: Request): Response {
    const auth = this.session(request);
    if (!auth) return json({ code: "AUTH_REQUIRED" }, 401);
    const pendingMutations = Number(sqlRows(this.state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM cloud_mutation_events WHERE state = 'PENDING_DESKTOP_SYNC'"))[0]?.count ?? 0);
    const latestSnapshot = sqlRows(this.state.storage.sql.exec<{ migration_id: string; record_count: number; backup_id: string; backup_sha256: string; completed_at: string }>("SELECT migration_id, record_count, backup_id, backup_sha256, completed_at FROM cloud_snapshots ORDER BY completed_at DESC LIMIT 1"))[0];
    const archive = latestSnapshot ? sqlRows(this.state.storage.sql.exec<{ state: string; archive_prefix: string; archived_at: string | null }>("SELECT state, archive_prefix, archived_at FROM cloud_snapshot_archives WHERE migration_id = ?", latestSnapshot.migration_id))[0] : null;
    return json({
      apiVersion: CLOUD_API_VERSION,
      mode: CLOUD_MODE,
      storeId: this.value("storeId"),
      import: {
        state: this.value("state") ?? "EMPTY",
        migrationId: this.activeMigrationId(),
        importedAt: this.value("importedAt"),
        uploadMigrationId: this.value("uploadMigrationId"),
        // This is a verified source snapshot, not a promise of financial
        // transaction authority.
        lastVerifiedBackup: latestSnapshot ? {
          migrationId: latestSnapshot.migration_id,
          recordCount: Number(latestSnapshot.record_count),
          backupId: latestSnapshot.backup_id,
          sha256: latestSnapshot.backup_sha256,
          completedAt: latestSnapshot.completed_at,
          archive: archive ? { state: archive.state, prefix: archive.archive_prefix, archivedAt: archive.archived_at } : { state: "PENDING" },
        } : null,
      },
      reconciliation: { pendingMutations, lastEventSequence: Number(this.value("lastEventSequence") ?? "0"), required: true },
      user: { id: auth.user.id, role: auth.user.role, terminalId: auth.session.terminalId },
    });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/internal/bootstrap" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { migrationKey?: unknown; storeId?: unknown } | null;
      if (typeof body?.migrationKey !== "string" || body.migrationKey.length < 48 || typeof body.storeId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.storeId) || this.value("migrationKey")) return json({ code: "CLOUD_BOOTSTRAP_REJECTED" }, 403);
      this.set("migrationKey", body.migrationKey);
      this.set("storeId", body.storeId);
      this.set("state", "EMPTY");
      this.set("createdAt", new Date().toISOString());
      return json({ status: "ready" }, 201);
    }
    if (path === "/internal/public/auth/login" && request.method === "POST") return this.login(request);
    if (path === "/internal/public/catalog" && request.method === "GET") return this.catalog(request);
    if (path === "/internal/public/reorder-list" && request.method === "GET") return this.reorderList(request);
    if (path === "/internal/public/expiry-registration" && request.method === "POST") return this.registerExpiry(request);
    if (path === "/internal/public/status" && request.method === "GET") return this.publicStatus(request);
    if (!this.authorized(request)) return json({ code: "CLOUD_MIGRATION_UNAUTHORIZED", messageAr: "مفتاح نقل البيانات غير صالح" }, 401);
    if (path === "/internal/migration/start" && request.method === "POST") return this.start(request);
    if (path === "/internal/migration/chunk" && request.method === "POST") return this.acceptChunk(request);
    if (path === "/internal/migration/finalize" && request.method === "POST") return this.finalize(request);
    // This endpoint is intentionally idempotent.  A completed migration may
    // predate the terminal directory, or the directory write may have failed
    // after the import was committed.  The primary desktop app can safely
    // request a repair later with the per-store migration key.
    if (path === "/internal/terminals/register" && request.method === "POST") {
      await this.registerTerminals();
      return json({ status: "registered" });
    }
    if (path === "/internal/migration/status" && request.method === "GET") {
      return json({
        state: this.value("state") ?? "EMPTY",
        migrationId: this.activeMigrationId(),
        uploadMigrationId: this.value("uploadMigrationId"),
        importedRecords: Number(this.value("importedRecords") ?? "0"),
      });
    }
    if (path === "/internal/auth/claim" && request.method === "POST") return this.claimOwner(request);
    if (path === "/internal/auth/staff/sync" && request.method === "POST") return this.syncStaff(request);
    if (path === "/internal/mutations/pending" && request.method === "GET") return this.pendingMutations(request);
    if (path === "/internal/mutations/ack" && request.method === "POST") return this.acknowledgeMutations(request);
    return json({ code: "NOT_FOUND" }, 404);
  }

  private async claimOwner(request: Request): Promise<Response> {
    if (this.value("state") !== "IMPORTED") return json({ code: "CLOUD_IMPORT_REQUIRED", messageAr: "أكمل نقل البيانات والتحقق منها أولًا" }, 409);
    const body = await request.json().catch(() => null) as { username?: unknown; password?: unknown } | null;
    const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!username || password.length < 12) return json({ code: "CLOUD_OWNER_CREDENTIALS_INVALID", messageAr: "اكتب اسم مستخدم المالك وكلمة مرور سحابية من 12 حرفًا على الأقل" }, 422);
    const owner = this.records("users").map((entry) => entry.row).find((user) => String(user.role) === "OWNER" && String(user.username ?? "").toLowerCase() === username);
    if (!owner) return json({ code: "CLOUD_OWNER_NOT_FOUND", messageAr: "اسم مستخدم المالك لا يطابق بيانات نبتة المنقولة" }, 403);
    const salt = crypto.randomUUID();
    const hash = await passwordHash(password, salt);
    this.state.storage.sql.exec("INSERT INTO cloud_users(id, username, display_name, role, password_hash, salt) VALUES (?, ?, ?, 'OWNER', ?, ?) ON CONFLICT(username) DO UPDATE SET display_name = excluded.display_name, role = excluded.role, password_hash = excluded.password_hash, salt = excluded.salt", String(owner.id), username, String(owner.display_name ?? owner.username), hash, salt);
    this.state.storage.sql.exec("INSERT INTO cloud_user_access(user_id, active, updated_at) VALUES (?, 1, ?) ON CONFLICT(user_id) DO UPDATE SET active = 1, updated_at = excluded.updated_at", String(owner.id), new Date().toISOString());
    return json({ status: "claimed" }, 201);
  }

  /**
   * The local server uses the per-store migration key over TLS to provision
   * cloud-only credentials.  Local password hashes are intentionally never
   * copied: they use a different password algorithm and are not a portable
   * authentication contract.
   */
  private async syncStaff(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { staff?: unknown; replace?: unknown } | null;
    const staff = Array.isArray(body?.staff) ? body.staff : null;
    if (!staff || staff.length > 100 || (body?.replace === true && staff.length === 0)) return json({ code: "CLOUD_STAFF_SYNC_INVALID" }, 422);
    const knownUsers = new Set(this.records("users").map((entry) => String(entry.row.id ?? "")));
    const accepted: Array<{ id: string; username: string; displayName: string; role: string; password: string | null; active: boolean }> = [];
    const ids = new Set<string>();
    for (const candidate of staff) {
      if (!candidate || typeof candidate !== "object") return json({ code: "CLOUD_STAFF_SYNC_INVALID" }, 422);
      const item = candidate as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id : "";
      const username = typeof item.username === "string" ? item.username.trim().toLowerCase() : "";
      const displayName = typeof item.displayName === "string" ? item.displayName.trim() : "";
      const role = typeof item.role === "string" ? item.role : "";
      const password = typeof item.password === "string" ? item.password : null;
      const active = item.active !== false;
      if (!/^[0-9a-f-]{36}$/i.test(id) || !knownUsers.has(id) || !username || username.length > 120 || !displayName || displayName.length > 200 || !CLOUD_STAFF_ROLES.has(role) || ids.has(id) || (password !== null && password.length < 12)) {
        return json({ code: "CLOUD_STAFF_SYNC_INVALID" }, 422);
      }
      ids.add(id);
      const exists = sqlRows(this.state.storage.sql.exec<{ id: string }>("SELECT id FROM cloud_users WHERE id = ?", id))[0];
      if (!exists && (!password || !active)) return json({ code: "CLOUD_STAFF_PASSWORD_REQUIRED" }, 422);
      accepted.push({ id, username, displayName, role, password, active });
    }
    const prepared: Array<{ item: (typeof accepted)[number]; cloudPasswordHash: string; salt: string }> = [];
    for (const item of accepted) {
      const existing = sqlRows(this.state.storage.sql.exec<{ password_hash: string; salt: string }>("SELECT password_hash, salt FROM cloud_users WHERE id = ?", item.id))[0];
      let cloudPasswordHash = existing?.password_hash ?? "";
      let salt = existing?.salt ?? "";
      if (item.password) {
        salt = crypto.randomUUID();
        cloudPasswordHash = await passwordHash(item.password, salt);
      }
      if (!cloudPasswordHash || !salt) return json({ code: "CLOUD_STAFF_PASSWORD_REQUIRED" }, 422);
      prepared.push({ item, cloudPasswordHash, salt });
    }
    this.state.storage.sql.exec("BEGIN");
    try {
      for (const { item, cloudPasswordHash, salt } of prepared) {
        this.state.storage.sql.exec("INSERT INTO cloud_users(id, username, display_name, role, password_hash, salt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET username = excluded.username, display_name = excluded.display_name, role = excluded.role, password_hash = excluded.password_hash, salt = excluded.salt", item.id, item.username, item.displayName, item.role, cloudPasswordHash, salt);
        this.state.storage.sql.exec("INSERT INTO cloud_user_access(user_id, active, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET active = excluded.active, updated_at = excluded.updated_at", item.id, item.active ? 1 : 0, new Date().toISOString());
      }
      if (body?.replace === true) {
        const placeholders = accepted.map(() => "?").join(",");
        if (placeholders) this.state.storage.sql.exec(`UPDATE cloud_user_access SET active = 0, updated_at = ? WHERE user_id IN (SELECT id FROM cloud_users WHERE role != 'OWNER') AND user_id NOT IN (${placeholders})`, new Date().toISOString(), ...accepted.map((item) => item.id));
      }
      this.state.storage.sql.exec("COMMIT");
    } catch {
      this.state.storage.sql.exec("ROLLBACK");
      return json({ code: "CLOUD_STAFF_SYNC_FAILED" }, 409);
    }
    return json({ status: "synced", users: accepted.length, replace: body?.replace === true }, 201);
  }

  private async login(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { username?: unknown; password?: unknown; terminalId?: unknown } | null;
    const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const terminalId = typeof body?.terminalId === "string" ? body.terminalId : "";
    const user = sqlRows(this.state.storage.sql.exec<{ id: string; username: string; display_name: string; role: string; password_hash: string; salt: string }>("SELECT id, username, display_name, role, password_hash, salt FROM cloud_users WHERE username = ?", username))[0];
    const access = user ? sqlRows(this.state.storage.sql.exec<{ active: number }>("SELECT active FROM cloud_user_access WHERE user_id = ?", user.id))[0] : null;
    const terminal = this.records("terminals").some((entry) => String(entry.row.id) === terminalId && entry.row.active !== false);
    if (!user || !access || Number(access.active) !== 1 || !terminal || !sameSecret(await passwordHash(password, user.salt), user.password_hash)) return json({ code: "LOGIN_INVALID", message: "بيانات الدخول أو الكاشير غير صحيحة" }, 401);
    const storeId = this.value("storeId") ?? "";
    const token = `${storeId}.${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    this.state.storage.sql.exec("INSERT INTO cloud_sessions(token, user_id, terminal_id, expires_at) VALUES (?, ?, ?, ?)", token, user.id, terminalId, expiresAt);
    return json({ token, expiresAt, user: { id: user.id, displayName: user.display_name, role: user.role, permissions: permissionsFor(user.role) } });
  }

  private async catalog(request: Request): Promise<Response> {
    const auth = this.requirePermission(request, "PRODUCT_WRITE");
    if (auth instanceof Response) return auth;
    const url = new URL(request.url);
    const query = (url.searchParams.get("query") ?? "").trim().toLocaleLowerCase("ar");
    const terminal = this.records("terminals").find((entry) => String(entry.row.id) === auth.session.terminalId)?.row;
    if (!terminal) return json({ code: "TERMINAL_INVALID", message: "الكاشير غير موجود" }, 409);
    const warehouseId = String(terminal.warehouse_id ?? "");
    const barcodes = this.records("product_barcodes");
    const balances = this.records("stock_balances");
    const products = this.records("products").map((entry) => entry.row).filter((product) => product.active !== false).map((product) => {
      const id = String(product.id);
      const codes = barcodes.filter((barcode) => String(barcode.row.product_id) === id).map((barcode) => String(barcode.row.barcode));
      const balance = balances.find((item) => String(item.row.product_id) === id && String(item.row.warehouse_id) === warehouseId)?.row;
      return { id, warehouseId, nameAr: String(product.name_ar ?? ""), description: String(product.description ?? ""), category: String(product.category ?? ""), unitKind: String(product.unit_kind ?? "PIECE"), priceMinor: Number(product.price_minor ?? 0), wholesalePriceMinor: product.wholesale_price_minor === null || product.wholesale_price_minor === undefined ? null : Number(product.wholesale_price_minor), purchasePackSize: Number(product.purchase_pack_size ?? 1), availableQtyMilli: Number(balance?.qty_milli ?? 0), reorderLevelMilli: Number(product.reorder_level_milli ?? 0), barcodes: codes, version: Number(balance?.version ?? product.version ?? 0) };
    }).filter((product) => !query || product.nameAr.toLocaleLowerCase("ar").includes(query) || product.category.toLocaleLowerCase("ar").includes(query) || product.barcodes.some((barcode) => barcode === query));
    return json({ products: products.slice(0, Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 20)))), hasMore: products.length > 200, nextCursor: null });
  }

  /** Mirrors the desktop alert rule: 28-day net demand, ten days of cover. */
  private async reorderList(request: Request): Promise<Response> {
    const auth = this.requirePermission(request, "STOCK_COUNT");
    if (auth instanceof Response) return auth;
    const terminal = this.records("terminals").find((entry) => String(entry.row.id) === auth.session.terminalId)?.row;
    if (!terminal) return json({ code: "TERMINAL_INVALID" }, 409);
    const warehouseId = String(terminal.warehouse_id ?? "");
    const windowStart = Date.now() - 28 * 24 * 60 * 60 * 1000;
    const demand = new Map<string, number>();
    for (const entry of this.records("stock_movements")) {
      const row = entry.row;
      if (String(row.warehouse_id) !== warehouseId || (row.movement_type !== "SALE" && row.movement_type !== "SALE_RETURN")) continue;
      const occurredAt = Date.parse(String(row.occurred_at ?? ""));
      if (!Number.isFinite(occurredAt) || occurredAt < windowStart) continue;
      const productId = String(row.product_id ?? "");
      const delta = Number(row.qty_delta_milli ?? 0);
      if (!productId || !Number.isSafeInteger(delta)) continue;
      demand.set(productId, Math.max(0, (demand.get(productId) ?? 0) - delta));
    }
    const balances = this.records("stock_balances");
    const barcodes = this.records("product_barcodes");
    const items = this.records("products").map((entry) => entry.row).filter((product) => product.active !== false).map((product) => {
      const productId = String(product.id ?? "");
      const unitKind = String(product.unit_kind ?? "PIECE");
      const availableQtyMilli = Number(balances.find((balance) => String(balance.row.warehouse_id) === warehouseId && String(balance.row.product_id) === productId)?.row.qty_milli ?? 0);
      const soldQtyMilli = demand.get(productId) ?? 0;
      const averageDailyDemandMilli = Math.ceil(soldQtyMilli / 28);
      const smartReorderLevelMilli = unitKind === "PIECE"
        ? Math.ceil((soldQtyMilli * 10) / 28 / 1000) * 1000
        : Math.ceil((soldQtyMilli * 10) / 28);
      const reorderLevelMilli = Math.max(Number(product.reorder_level_milli ?? 0), smartReorderLevelMilli);
      const status = availableQtyMilli === 0 ? "OUT_OF_STOCK" : availableQtyMilli < reorderLevelMilli ? "BELOW_REORDER" : "AT_REORDER";
      return {
        productId,
        nameAr: String(product.name_ar ?? ""),
        category: String(product.category ?? ""),
        barcode: barcodes.find((barcode) => String(barcode.row.product_id) === productId)?.row.barcode ?? null,
        unitKind,
        availableQtyMilli,
        reorderLevelMilli,
        smartReorderLevelMilli,
        averageDailyDemandMilli,
        shortageQtyMilli: Math.max(0, reorderLevelMilli - availableQtyMilli),
        status,
      };
    }).filter((item) => item.reorderLevelMilli > 0 && item.availableQtyMilli <= item.reorderLevelMilli)
      .sort((left, right) => (left.status === "OUT_OF_STOCK" ? -1 : right.status === "OUT_OF_STOCK" ? 1 : left.nameAr.localeCompare(right.nameAr, "ar")));
    return json({
      generatedAt: new Date().toISOString(),
      items,
      totals: {
        outOfStock: items.filter((item) => item.status === "OUT_OF_STOCK").length,
        belowReorder: items.filter((item) => item.status === "BELOW_REORDER").length,
        atReorder: items.filter((item) => item.status === "AT_REORDER").length,
      },
    });
  }

  private async registerExpiry(request: Request): Promise<Response> {
    const auth = this.requirePermission(request, "STOCK_COUNT");
    if (auth instanceof Response) return auth;
    const key = request.headers.get("idempotency-key") ?? "";
    const body = await request.json().catch(() => null) as { productId?: unknown; qtyMilli?: unknown; expiresOn?: unknown; lotCode?: unknown } | null;
    const productId = typeof body?.productId === "string" ? body.productId : "";
    const qtyMilli = typeof body?.qtyMilli === "number" ? body.qtyMilli : NaN;
    const expiresOn = typeof body?.expiresOn === "string" ? body.expiresOn : "";
    const lotCode = typeof body?.lotCode === "string" && body.lotCode.trim() ? body.lotCode.trim().slice(0, 120) : null;
    if (!/^[0-9a-f-]{36}$/i.test(key) || !/^[0-9a-f-]{36}$/i.test(productId) || !Number.isSafeInteger(qtyMilli) || qtyMilli <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) return json({ code: "EXPIRY_REQUEST_INVALID" }, 422);
    const requestPayload = { productId, qtyMilli, expiresOn, lotCode } satisfies Json;
    const requestHash = await sha256(canonicalJson(requestPayload));
    const replay = sqlRows(this.state.storage.sql.exec<{ request_hash: string; response: string }>("SELECT request_hash, response FROM cloud_mutation_idempotency WHERE user_id = ? AND operation = 'EXPIRY_REGISTERED' AND key = ?", auth.user.id, key))[0];
    if (replay) {
      if (!sameSecret(requestHash, replay.request_hash)) return json({ code: "IDEMPOTENCY_KEY_REUSE" }, 409);
      return json(JSON.parse(replay.response), 201);
    }
    const terminal = this.records("terminals").find((entry) => String(entry.row.id) === auth.session.terminalId)?.row;
    const product = this.records("products").find((entry) => String(entry.row.id) === productId)?.row;
    if (!terminal || !product || product.active === false) return json({ code: !terminal ? "TERMINAL_INVALID" : "PRODUCT_NOT_FOUND" }, !terminal ? 409 : 404);
    if (product.unit_kind === "PIECE" && qtyMilli % 1000 !== 0) return json({ code: "PIECE_FRACTION" }, 422);
    const warehouseId = String(terminal.warehouse_id ?? "");
    const sources = this.records("stock_lots").filter((entry) => String(entry.row.warehouse_id) === warehouseId && String(entry.row.product_id) === productId && entry.row.expires_on === null && Number(entry.row.qty_milli ?? 0) > 0);
    if (sources.reduce((sum, entry) => sum + Number(entry.row.qty_milli), 0) < qtyMilli) return json({ code: "EXPIRY_QTY_UNAVAILABLE" }, 409);
    const eventId = crypto.randomUUID();
    const result = { lotId: crypto.randomUUID(), productId, qtyMilli, expiresOn, eventId, reconciliation: { state: "PENDING_DESKTOP_SYNC" } };
    this.state.storage.sql.exec("BEGIN");
    try {
      let remaining = qtyMilli;
      for (const source of sources) {
        if (remaining <= 0) break;
        const moved = Math.min(remaining, Number(source.row.qty_milli));
        this.updateRecord("stock_lots", source.ordinal, { ...source.row, qty_milli: Number(source.row.qty_milli) - moved });
        remaining -= moved;
      }
      if (remaining !== 0) throw new Error("expiry allocation failed");
      this.insertRecord("stock_lots", { id: result.lotId, warehouse_id: warehouseId, product_id: productId, lot_code: lotCode, expires_on: expiresOn, qty_milli: qtyMilli, received_at: new Date().toISOString() });
      this.state.storage.sql.exec("INSERT INTO cloud_mutation_events(event_id, operation, actor_user_id, terminal_id, idempotency_key, payload_hash, payload_json, state, created_at) VALUES (?, 'EXPIRY_REGISTERED', ?, ?, ?, ?, ?, 'PENDING_DESKTOP_SYNC', ?)", eventId, auth.user.id, auth.session.terminalId, key, requestHash, JSON.stringify({ ...requestPayload, lotId: result.lotId, warehouseId }), new Date().toISOString());
      const sequence = Number(sqlRows(this.state.storage.sql.exec<{ sequence: number }>("SELECT sequence FROM cloud_mutation_events WHERE event_id = ?", eventId))[0]?.sequence ?? 0);
      if (!sequence) throw new Error("event creation failed");
      this.set("lastEventSequence", String(sequence));
      this.state.storage.sql.exec("INSERT INTO cloud_mutation_idempotency(user_id, operation, key, request_hash, response, created_at) VALUES (?, 'EXPIRY_REGISTERED', ?, ?, ?, ?)", auth.user.id, key, requestHash, JSON.stringify({ ...result, sequence }), new Date().toISOString());
      this.state.storage.sql.exec("COMMIT");
      return json({ ...result, sequence }, 201);
    } catch {
      this.state.storage.sql.exec("ROLLBACK");
      return json({ code: "EXPIRY_REGISTRATION_FAILED" }, 409);
    }
  }

  /** Export only immutable cloud mutations that have not been reconciled by the desktop. */
  private async pendingMutations(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const after = Math.max(0, Number(url.searchParams.get("after") ?? "0"));
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? "50")));
    if (!Number.isSafeInteger(after) || !Number.isSafeInteger(limit)) return json({ code: "CLOUD_MUTATION_CURSOR_INVALID" }, 422);
    const rows = sqlRows(this.state.storage.sql.exec<{ sequence: number; event_id: string; operation: string; actor_user_id: string; terminal_id: string; idempotency_key: string; payload_hash: string; payload_json: string; created_at: string }>("SELECT sequence, event_id, operation, actor_user_id, terminal_id, idempotency_key, payload_hash, payload_json, created_at FROM cloud_mutation_events WHERE state = 'PENDING_DESKTOP_SYNC' AND sequence > ? ORDER BY sequence LIMIT ?", after, limit));
    const events = rows.map((row) => ({ sequence: Number(row.sequence), eventId: row.event_id, operation: row.operation, actorUserId: row.actor_user_id, terminalId: row.terminal_id, idempotencyKey: row.idempotency_key, payloadHash: row.payload_hash, payload: JSON.parse(row.payload_json), createdAt: row.created_at }));
    return json({ events, nextAfter: events.length ? events[events.length - 1]!.sequence : after, hasMore: events.length === limit });
  }

  /** Acknowledgement is deliberately explicit and idempotent; it never deletes the audit event. */
  private async acknowledgeMutations(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { eventIds?: unknown } | null;
    const eventIds = Array.isArray(body?.eventIds) ? body.eventIds.filter((value): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)) : [];
    if (eventIds.length === 0 || eventIds.length > 100 || new Set(eventIds).size !== eventIds.length) return json({ code: "CLOUD_MUTATION_ACK_INVALID" }, 422);
    const placeholders = eventIds.map(() => "?").join(",");
    const now = new Date().toISOString();
    this.state.storage.sql.exec(`UPDATE cloud_mutation_events SET state = 'APPLIED_TO_DESKTOP', applied_at = ? WHERE state = 'PENDING_DESKTOP_SYNC' AND event_id IN (${placeholders})`, now, ...eventIds);
    const applied = Number(sqlRows(this.state.storage.sql.exec<{ count: number }>(`SELECT count(*) AS count FROM cloud_mutation_events WHERE state = 'APPLIED_TO_DESKTOP' AND event_id IN (${placeholders})`, ...eventIds))[0]?.count ?? 0);
    return json({ status: "acknowledged", applied, requested: eventIds.length });
  }

  private async start(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { manifest?: unknown } | null;
    const manifest = parseManifest(body?.manifest);
    if (!manifest) return json({ code: "CLOUD_MANIFEST_INVALID", messageAr: "بيانات النقل غير صالحة" }, 422);
    const currentUpload = this.value("uploadMigrationId");
    const state = this.value("state") ?? "EMPTY";
    if (currentUpload && currentUpload !== manifest.migrationId && state === "UPLOADING") {
      return json({ code: "CLOUD_MIGRATION_IN_PROGRESS", messageAr: "يوجد رفع سحابي آخر لم يكتمل بعد؛ استكمله من جهاز نبتة المصدر أولًا" }, 409);
    }

    // A completed request is safe to replay. More importantly, do not point
    // catalogue reads at the new migration until its hash validation succeeds.
    if (state === "IMPORTED" && this.activeMigrationId() === manifest.migrationId) {
      return json({
        status: "imported",
        migrationId: manifest.migrationId,
        acceptedChunks: sqlRows(this.state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM migration_chunks WHERE migration_id = ?", manifest.migrationId))[0]?.count ?? 0,
      }, 200);
    }

    const existingManifest = this.value("manifest");
    if (currentUpload === manifest.migrationId && existingManifest && existingManifest !== JSON.stringify(manifest)) {
      return json({ code: "CLOUD_MANIFEST_CONFLICT", messageAr: "تمت إعادة استخدام عملية النقل نفسها ببيانات مختلفة" }, 409);
    }
    this.set("uploadMigrationId", manifest.migrationId);
    this.set("manifest", JSON.stringify(manifest));
    this.set("state", "UPLOADING");
    return json({ status: "uploading", migrationId: manifest.migrationId, acceptedChunks: sqlRows(this.state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM migration_chunks WHERE migration_id = ?", manifest.migrationId))[0]?.count ?? 0 }, 201);
  }

  private async acceptChunk(request: Request): Promise<Response> {
    const chunk = parseChunk(await request.json().catch(() => null));
    if (!chunk || chunk.migrationId !== this.value("uploadMigrationId") || new TextEncoder().encode(JSON.stringify(chunk)).byteLength > MAX_CHUNK_BYTES + 32 * 1024) return json({ code: "CLOUD_CHUNK_INVALID", messageAr: "دفعة النقل غير صالحة أو كبيرة جدًا" }, 422);
    if (chunk.sha256 !== await sha256(canonicalJson(chunk.records))) return json({ code: "CLOUD_CHUNK_HASH_INVALID", messageAr: "بصمة دفعة النقل لا تطابق محتواها" }, 422);
    const existing = sqlRows(this.state.storage.sql.exec<{ sha256: string }>("SELECT sha256 FROM migration_chunks WHERE migration_id = ? AND sequence = ?", chunk.migrationId, chunk.sequence))[0];
    if (existing && existing.sha256 !== chunk.sha256) return json({ code: "CLOUD_CHUNK_CONFLICT", messageAr: "تمت إعادة إرسال دفعة بمحتوى مختلف" }, 409);
    if (!existing) this.state.storage.sql.exec("INSERT INTO migration_chunks(migration_id, sequence, sha256, payload) VALUES (?, ?, ?, ?)", chunk.migrationId, chunk.sequence, chunk.sha256, JSON.stringify(chunk.records));
    return json({ status: "accepted", sequence: chunk.sequence, replay: Boolean(existing) });
  }

  private async finalize(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { migrationId?: unknown } | null;
    const migrationId = typeof body?.migrationId === "string" ? body.migrationId : "";
    const manifest = parseManifest(JSON.parse(this.value("manifest") ?? "null"));
    if (!manifest || migrationId !== manifest.migrationId || migrationId !== this.value("uploadMigrationId")) {
      // Finalize is idempotent after a response is lost on the network.
      if (this.value("state") === "IMPORTED" && migrationId === this.activeMigrationId()) {
        return json({ status: "imported", migrationId, recordCount: Number(this.value("importedRecords") ?? "0"), replay: true });
      }
      return json({ code: "CLOUD_FINALIZE_INVALID", messageAr: "عملية النقل المطلوبة غير موجودة" }, 422);
    }
    const chunks = sqlRows(this.state.storage.sql.exec<{ sequence: number; payload: string }>("SELECT sequence, payload FROM migration_chunks WHERE migration_id = ? ORDER BY sequence", migrationId));
    if (chunks.length !== manifest.chunkCount || chunks.some((chunk, index) => chunk.sequence !== index)) return json({ code: "CLOUD_CHUNKS_INCOMPLETE", messageAr: "لم تصل كل دفعات نقل البيانات بعد" }, 409);
    let recordCount = 0;
    const perTable = new Map<string, { rows: number; hash: string[] }>();
    this.state.storage.sql.exec("BEGIN");
    try {
      this.state.storage.sql.exec("DELETE FROM cloud_records WHERE migration_id = ?", migrationId);
      for (const stored of chunks) {
        const records = JSON.parse(stored.payload) as MigrationChunk["records"];
        for (const item of records) {
          const table = item.table;
          const current = perTable.get(table) ?? { rows: 0, hash: [] };
          const ordinal = current.rows;
          current.rows += 1;
          current.hash.push(canonicalJson(item.record));
          perTable.set(table, current);
          this.state.storage.sql.exec("INSERT INTO cloud_records(migration_id, source_table, source_ordinal, row_json) VALUES (?, ?, ?, ?)", migrationId, table, ordinal, JSON.stringify(item.record));
          recordCount += 1;
        }
      }
      if (recordCount !== manifest.recordCount) throw new Error("record count mismatch");
      for (const table of manifest.tables) {
        const actual = perTable.get(table.name) ?? { rows: 0, hash: [] };
        if (actual.rows !== table.rowCount || table.sha256 !== await sha256(`${actual.hash.join("\n")}${actual.hash.length ? "\n" : ""}`)) throw new Error(`table validation failed: ${table.name}`);
      }
      const completedAt = new Date().toISOString();
      this.state.storage.sql.exec("INSERT INTO cloud_snapshots(migration_id, record_count, backup_id, backup_sha256, completed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(migration_id) DO UPDATE SET record_count = excluded.record_count, backup_id = excluded.backup_id, backup_sha256 = excluded.backup_sha256, completed_at = excluded.completed_at", migrationId, recordCount, manifest.backup.id, manifest.backup.sha256, completedAt);
      const archivePrefix = `stores/${this.value("storeId") ?? "unknown"}/snapshots/${migrationId}`;
      this.state.storage.sql.exec("INSERT INTO cloud_snapshot_archives(migration_id, state, archive_prefix, archived_at, last_error) VALUES (?, 'PENDING', ?, NULL, NULL) ON CONFLICT(migration_id) DO UPDATE SET state = 'PENDING', archive_prefix = excluded.archive_prefix, archived_at = NULL, last_error = NULL", migrationId, archivePrefix);
      // Atomic cut-over: all public reads continue using the old pointer until
      // this exact point. A failed upload therefore never blanks the cloud
      // catalogue or destroys the last verified recovery point.
      this.set("activeMigrationId", migrationId);
      this.set("migrationId", migrationId); // Compatibility with stores imported before protected refreshes.
      this.set("uploadMigrationId", "");
      this.set("state", "IMPORTED");
      this.set("importedRecords", String(recordCount));
      this.set("importedAt", completedAt);
      this.state.storage.sql.exec("COMMIT");
    } catch (error) {
      this.state.storage.sql.exec("ROLLBACK");
      return json({ code: "CLOUD_IMPORT_VALIDATION_FAILED", messageAr: "فشل التحقق من البيانات المنقولة؛ بقيت البيانات المحلية كما هي" }, 422);
    }
    try {
      await this.registerTerminals();
    } catch {
      return json({ code: "CLOUD_DIRECTORY_SYNC_FAILED", messageAr: "اكتمل استيراد البيانات لكن تعذر ربط أجهزة الكاشير؛ أعد عملية الإنهاء لاحقًا" }, 503);
    }
    const archive = await this.archiveSnapshot(migrationId, manifest, chunks);
    return json({ status: "imported", migrationId, recordCount, archive });
  }

  /**
   * R2 is deliberately an additional recovery copy, not the live database.
   * The verified Durable Object copy is committed first; an R2 outage leaves
   * that copy intact and marks the archive as pending instead of failing the
   * migration or discarding any data.
   */
  private async archiveSnapshot(migrationId: string, manifest: Manifest, chunks: Array<{ sequence: number; payload: string }>): Promise<{ state: "ARCHIVED" | "PENDING" }> {
    const row = sqlRows(this.state.storage.sql.exec<{ archive_prefix: string }>("SELECT archive_prefix FROM cloud_snapshot_archives WHERE migration_id = ?", migrationId))[0];
    if (!row) return { state: "PENDING" };
    try {
      this.state.storage.sql.exec("UPDATE cloud_snapshot_archives SET state = 'ARCHIVING', last_error = NULL WHERE migration_id = ?", migrationId);
      await this.env.NABTA_BACKUP_ARCHIVE.put(`${row.archive_prefix}/manifest.json`, JSON.stringify({ archivedAt: new Date().toISOString(), manifest }), { httpMetadata: { contentType: "application/json" } });
      for (const chunk of chunks) {
        await this.env.NABTA_BACKUP_ARCHIVE.put(`${row.archive_prefix}/chunks/${String(chunk.sequence).padStart(8, "0")}.json`, chunk.payload, { httpMetadata: { contentType: "application/json" } });
      }
      this.state.storage.sql.exec("UPDATE cloud_snapshot_archives SET state = 'ARCHIVED', archived_at = ?, last_error = NULL WHERE migration_id = ?", new Date().toISOString(), migrationId);
      return { state: "ARCHIVED" };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "R2 archive failed";
      this.state.storage.sql.exec("UPDATE cloud_snapshot_archives SET state = 'PENDING', last_error = ? WHERE migration_id = ?", message, migrationId);
      return { state: "PENDING" };
    }
  }
}

export class NabtaStoreDirectory {
  constructor(private readonly state: DurableObjectState) {
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS terminal_store (terminal_id TEXT PRIMARY KEY, store_id TEXT NOT NULL)");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/register" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { storeId?: unknown; terminals?: unknown } | null;
      const storeId = typeof body?.storeId === "string" ? body.storeId : "";
      const terminals = Array.isArray(body?.terminals) ? body.terminals.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)) : [];
      if (!/^[0-9a-f-]{36}$/i.test(storeId)) return json({ code: "DIRECTORY_REQUEST_INVALID" }, 422);
      for (const terminalId of terminals) this.state.storage.sql.exec("INSERT INTO terminal_store(terminal_id, store_id) VALUES (?, ?) ON CONFLICT(terminal_id) DO UPDATE SET store_id = excluded.store_id", terminalId, storeId);
      return json({ status: "registered", terminals: terminals.length }, 201);
    }
    if (url.pathname === "/internal/lookup" && request.method === "GET") {
      const terminalId = url.searchParams.get("terminalId") ?? "";
      const row = sqlRows(this.state.storage.sql.exec<{ store_id: string }>("SELECT store_id FROM terminal_store WHERE terminal_id = ?", terminalId))[0];
      return row ? json({ storeId: row.store_id }) : json({ code: "TERMINAL_NOT_REGISTERED" }, 404);
    }
    return json({ code: "NOT_FOUND" }, 404);
  }
}

function storePath(request: Request): string | null {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  return parts.length >= 4 && parts[0] === "v1" && parts[1] === "cloud" && parts[2] === "stores" ? parts[3]! : null;
}

async function proxyToStore(request: Request, env: Env, storeId: string, suffix: string): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(storeId)) return json({ code: "CLOUD_STORE_ID_INVALID" }, 422);
  const id = env.NABTA_STORE_LEDGER.idFromName(`store:${storeId}`);
  const url = new URL(request.url);
  url.pathname = `/internal/migration/${suffix}`;
  return env.NABTA_STORE_LEDGER.get(id).fetch(new Request(url, request));
}

async function proxyInternalStore(request: Request, env: Env, storeId: string, path: string): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(storeId)) return json({ code: "CLOUD_STORE_ID_INVALID" }, 422);
  const id = env.NABTA_STORE_LEDGER.idFromName(`store:${storeId}`);
  const url = new URL(request.url);
  url.pathname = path;
  return env.NABTA_STORE_LEDGER.get(id).fetch(new Request(url, request));
}

async function storeForTerminal(env: Env, terminalId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(terminalId)) return null;
  const directory = env.NABTA_STORE_DIRECTORY.get(env.NABTA_STORE_DIRECTORY.idFromName("nabta-store-directory"));
  const response = await directory.fetch(`https://nabta.internal/internal/lookup?terminalId=${encodeURIComponent(terminalId)}`);
  if (!response.ok) return null;
  const body = await response.json() as { storeId?: unknown };
  return typeof body.storeId === "string" && /^[0-9a-f-]{36}$/i.test(body.storeId) ? body.storeId : null;
}

function storeFromToken(request: Request): string | null {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const match = /^([0-9a-f-]{36})\.[a-z0-9]+$/i.exec(token);
  return match?.[1] ?? null;
}

async function proxyPublic(request: Request, env: Env, storeId: string, suffix: string): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(storeId)) return json({ code: "AUTH_REQUIRED" }, 401);
  const id = env.NABTA_STORE_LEDGER.idFromName(`store:${storeId}`);
  const url = new URL(request.url);
  url.pathname = `/internal/public/${suffix}`;
  return env.NABTA_STORE_LEDGER.get(id).fetch(new Request(url, request));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/v1/cloud/health") return json({ status: "ok", service: "nabta-cloud-core", storage: "durable-object-sqlite", ...CLOUD_CAPABILITIES });
    if (url.pathname === "/v1/cloud/capabilities" && request.method === "GET") return json(CLOUD_CAPABILITIES);
    if (url.pathname === "/v1/cloud/stores/bootstrap" && request.method === "POST") {
      if (!sameSecret(request.headers.get("x-nabta-cloud-bootstrap-key"), env.NABTA_CLOUD_BOOTSTRAP_KEY)) return json({ code: "CLOUD_BOOTSTRAP_UNAUTHORIZED" }, 401);
      const storeId = crypto.randomUUID();
      const migrationKey = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
      const id = env.NABTA_STORE_LEDGER.idFromName(`store:${storeId}`);
      const internal = new Request("https://nabta.internal/internal/bootstrap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ migrationKey, storeId }) });
      const initialized = await env.NABTA_STORE_LEDGER.get(id).fetch(internal);
      if (!initialized.ok) return json({ code: "CLOUD_STORE_BOOTSTRAP_FAILED" }, 500);
      return json({ storeId, migrationKey }, 201);
    }
    if (url.pathname === "/v1/auth/login" && request.method === "POST") {
      const body = await request.clone().json().catch(() => null) as { terminalId?: unknown } | null;
      const storeId = await storeForTerminal(env, typeof body?.terminalId === "string" ? body.terminalId : "");
      return storeId ? proxyPublic(request, env, storeId, "auth/login") : json({ code: "TERMINAL_NOT_REGISTERED", message: "رقم الكاشير غير مرتبط بمتجر سحابي" }, 404);
    }
    if (url.pathname === "/v1/catalog" && request.method === "GET") {
      return proxyPublic(request, env, storeFromToken(request) ?? "", "catalog");
    }
    if (url.pathname === "/v1/stock/reorder-list" && request.method === "GET") {
      return proxyPublic(request, env, storeFromToken(request) ?? "", "reorder-list");
    }
    if (url.pathname === "/v1/stock-lots/expiry-registration" && request.method === "POST") {
      return proxyPublic(request, env, storeFromToken(request) ?? "", "expiry-registration");
    }
    if (url.pathname === "/v1/cloud/status" && request.method === "GET") {
      return proxyPublic(request, env, storeFromToken(request) ?? "", "status");
    }
    const storeId = storePath(request);
    if (!storeId) return json({ code: "NOT_FOUND" }, 404);
    const tail = url.pathname.split("/").filter(Boolean).slice(4).join("/");
    if (tail === "migration/start" && request.method === "POST") return proxyToStore(request, env, storeId, "start");
    if (tail === "migration/chunk" && request.method === "POST") return proxyToStore(request, env, storeId, "chunk");
    if (tail === "migration/finalize" && request.method === "POST") return proxyToStore(request, env, storeId, "finalize");
    if (tail === "migration/status" && request.method === "GET") return proxyToStore(request, env, storeId, "status");
    if (tail === "terminals/register" && request.method === "POST") {
      return proxyInternalStore(request, env, storeId, "/internal/terminals/register");
    }
    if (tail === "auth/claim" && request.method === "POST") {
      return proxyInternalStore(request, env, storeId, "/internal/auth/claim");
    }
    if (tail === "auth/staff/sync" && request.method === "POST") return proxyInternalStore(request, env, storeId, "/internal/auth/staff/sync");
    if (tail === "mutations/pending" && request.method === "GET") return proxyInternalStore(request, env, storeId, "/internal/mutations/pending");
    if (tail === "mutations/ack" && request.method === "POST") return proxyInternalStore(request, env, storeId, "/internal/mutations/ack");
    return json({ code: "NOT_FOUND" }, 404);
  },
};
