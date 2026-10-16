import type { DbClient } from "./db.js";
import type { AuthContext } from "./types.js";

export async function audit(
  client: DbClient,
  auth: Pick<AuthContext, "userId" | "terminalId"> | null,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {},
  reason?: string,
): Promise<void> {
  await client.query(`
    INSERT INTO audit_logs(actor_user_id, terminal_id, action, entity_type, entity_id, reason, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
  `, [auth?.userId ?? null, auth?.terminalId ?? null, action, entityType, entityId, reason ?? null, JSON.stringify(metadata)]);
}
