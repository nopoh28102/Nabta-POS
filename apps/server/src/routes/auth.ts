import type { FastifyInstance } from "fastify";
import { loginRequestSchema } from "@nabta/contracts";
import type { AppConfig } from "../config.js";
import type { Database } from "../db.js";
import { transaction } from "../db.js";
import { ApiError } from "../errors.js";
import { issueSessionToken, sha256, verifyPassword } from "../security.js";
import { requireAuth } from "../auth.js";
import type { Role } from "../types.js";
import { audit } from "../audit.js";

interface UserRow {
  id: string;
  display_name: string;
  username: string;
  password_hash: string;
  role: Role;
  discount_limit_bps: number;
  active: boolean;
  failed_login_count: number;
  locked_until: Date | null;
}

export function registerAuthRoutes(app: FastifyInstance, db: Database, config: AppConfig): void {
  app.post("/v1/auth/login", async (request) => {
    const body = loginRequestSchema.parse(request.body);
    return transaction(db, async (client) => {
      const userResult = await client.query<UserRow>("SELECT * FROM users WHERE lower(username) = lower($1) FOR UPDATE", [body.username]);
      const user = userResult.rows[0];
      const dummyHash = "scrypt$65536$8$1$6v_7i1s4mFh2Qk3rP0o8qg$TGMKn-8OUYvMv6N7G5J_6ydFg_QXxYhO9pdVSvUwBZh18zi33RzVV2LdRIa56taNKJqV0U4O_hbYPlE8BTYt5w";
      const passwordValid = await verifyPassword(body.password, user?.password_hash ?? dummyHash).catch(() => false);
      if (!user || !user.active || (user.locked_until && user.locked_until > new Date()) || !passwordValid) {
        if (user) {
          const failures = user.failed_login_count + 1;
          await client.query(`UPDATE users SET failed_login_count = $2,
            locked_until = CASE WHEN $2 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END,
            updated_at = now() WHERE id = $1`, [user.id, failures]);
        }
        throw new ApiError(401, "LOGIN_FAILED", "اسم المستخدم أو كلمة المرور غير صحيحة، أو الحساب مقفل مؤقتًا");
      }
      const terminal = await client.query<{ id: string }>("SELECT id FROM terminals WHERE id = $1 AND active", [body.terminalId]);
      if (!terminal.rows[0]) throw new ApiError(403, "TERMINAL_INVALID", "نقطة البيع غير مفعّلة على الخادم");
      await client.query("UPDATE users SET failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1", [user.id]);
      const { token, hash } = issueSessionToken();
      const session = await client.query<{ id: string; expires_at: Date }>(`
        INSERT INTO sessions(user_id, terminal_id, token_hash, expires_at)
        VALUES ($1, $2, $3, now() + ($4::text || ' minutes')::interval)
        RETURNING id, expires_at
      `, [user.id, body.terminalId, hash, config.SESSION_TTL_MINUTES]);
      await audit(client, { userId: user.id, terminalId: body.terminalId }, "LOGIN", "session", session.rows[0]!.id);
      const permissions = await client.query<{ permission: string }>("SELECT permission FROM role_permissions WHERE role = $1", [user.role]);
      return {
        token,
        expiresAt: session.rows[0]!.expires_at.toISOString(),
        user: { id: user.id, displayName: user.display_name, role: user.role, permissions: permissions.rows.map((row) => row.permission) },
      };
    });
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const auth = requireAuth(request);
    await transaction(db, async (client) => {
      await client.query("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [auth.sessionId]);
      await audit(client, auth, "LOGOUT", "session", auth.sessionId);
    });
    return reply.status(204).send();
  });

  app.get("/v1/auth/me", async (request) => {
    const auth = requireAuth(request);
    return { id: auth.userId, displayName: auth.displayName, role: auth.role, terminalId: auth.terminalId, permissions: [...auth.permissions] };
  });

  app.post("/v1/auth/verify-manager", async (request) => {
    requireAuth(request);
    const body = loginRequestSchema.omit({ terminalId: true }).parse(request.body);
    const userResult = await db.query<UserRow>("SELECT * FROM users WHERE lower(username) = lower($1) AND active AND role IN ('OWNER','MANAGER')", [body.username]);
    const user = userResult.rows[0];
    if (!user || !(await verifyPassword(body.password, user.password_hash))) throw new ApiError(403, "MANAGER_APPROVAL_FAILED", "بيانات اعتماد المدير غير صحيحة");
    return { managerId: user.id, approvalHash: sha256(`${user.id}:${request.id}`) };
  });
}
