import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Database } from "./db.js";
import { ApiError } from "./errors.js";
import { sha256 } from "./security.js";
import type { AuthContext, Role } from "./types.js";

interface SessionRow {
  session_id: string;
  user_id: string;
  terminal_id: string;
  display_name: string;
  role: Role;
  discount_limit_bps: number;
  permission: string | null;
}

export function installAuth(app: FastifyInstance, db: Database): void {
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return;
    const token = header.slice(7);
    if (token.length < 32 || token.length > 256) return;
    const result = await db.query<SessionRow>(`
      SELECT s.id AS session_id, s.user_id, s.terminal_id, u.display_name, u.role,
             u.discount_limit_bps, rp.permission
      FROM sessions s
      JOIN users u ON u.id = s.user_id AND u.active
      LEFT JOIN role_permissions rp ON rp.role = u.role
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
    `, [sha256(token)]);
    if (result.rows.length === 0) return;
    const first = result.rows[0]!;
    request.auth = {
      sessionId: first.session_id,
      userId: first.user_id,
      terminalId: first.terminal_id,
      displayName: first.display_name,
      role: first.role,
      discountLimitBps: first.discount_limit_bps,
      permissions: new Set(result.rows.flatMap((row) => row.permission ? [row.permission] : [])),
    };
  });
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new ApiError(401, "AUTH_REQUIRED", "سجّل الدخول أولًا");
  return request.auth;
}

export function requirePermission(request: FastifyRequest, permission: string): AuthContext {
  const auth = requireAuth(request);
  if (!auth.permissions.has(permission)) throw new ApiError(403, "FORBIDDEN", "ليست لديك صلاحية لتنفيذ هذه العملية");
  return auth;
}
