import type { Db } from '../db/pool';
import { withTenantTransaction } from './tenantService';

export interface AuditEventView {
  id: string;
  time: string;
  action: string;
  actor_user_id: string | null;
  actor_email: string | null;
  object_type: string | null;
  object_id: string | null;
  trace_id: string | null;
  event_hash: string | null;
  previous_hash: string | null;
}

export async function listTenantAudit(
  pool: Db,
  tenantId: string,
  options: { limit: number; offset: number },
): Promise<{ events: AuditEventView[]; total: number }> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const count = await client.query(
      'SELECT count(*)::int AS total FROM audit_events WHERE tenant_id = $1',
      [tenantId],
    );
    const result = await client.query(
      `SELECT ae.id, ae.created_at, ae.action, ae.user_id AS actor_user_id,
              u.email AS actor_email, ae.object_type, ae.object_id, ae.trace_id,
              ae.event_hash, ae.previous_hash
       FROM audit_events ae
       LEFT JOIN users u ON u.id = ae.user_id
       WHERE ae.tenant_id = $1
       ORDER BY ae.created_at DESC, ae.id DESC
       LIMIT $2 OFFSET $3`,
      [tenantId, options.limit, options.offset],
    );
    return {
      total: Number(count.rows[0]?.total ?? 0),
      events: result.rows.map((row) => ({
        id: String(row.id),
        time: String(row.created_at),
        action: String(row.action),
        actor_user_id: row.actor_user_id ? String(row.actor_user_id) : null,
        actor_email: row.actor_email ? String(row.actor_email) : null,
        object_type: row.object_type ? String(row.object_type) : null,
        object_id: row.object_id ? String(row.object_id) : null,
        trace_id: row.trace_id ? String(row.trace_id) : null,
        event_hash: row.event_hash ? String(row.event_hash) : null,
        previous_hash: row.previous_hash ? String(row.previous_hash) : null,
      })),
    };
  });
}
