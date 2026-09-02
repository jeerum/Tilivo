import type { Db, DbClient } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import { withTenantTransaction } from './tenantService';

export interface OutboxEvent {
  id: string;
  tenant_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: string;
  attempt_count: number;
}

export async function appendOutboxInTransaction(
  client: DbClient,
  tenantId: string,
  input: {
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    payload?: Record<string, unknown>;
  },
): Promise<string> {
  const result = await client.query(
    'SELECT public.tilivo_outbox_append($1, $2, $3, $4, $5) AS id',
    [
      tenantId,
      input.eventType,
      input.aggregateType,
      input.aggregateId,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  return String(result.rows[0]!.id);
}

export async function appendOutbox(
  pool: Db,
  tenantId: string,
  input: {
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    payload?: Record<string, unknown>;
  },
): Promise<string> {
  return withTenantTransaction(pool, tenantId, (client) =>
    appendOutboxInTransaction(client, tenantId, input),
  );
}

export async function claimOutbox(pool: Db, limit = 10): Promise<OutboxEvent[]> {
  const result = await pool.query(
    `SELECT id, tenant_id, event_type, aggregate_type, aggregate_id, payload, attempt_count
     FROM integration_outbox
     WHERE status = 'PENDING' AND available_at <= now()
     ORDER BY created_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    event_type: String(row.event_type),
    aggregate_type: String(row.aggregate_type),
    aggregate_id: String(row.aggregate_id),
    payload: String(row.payload),
    attempt_count: Number(row.attempt_count ?? 0),
  }));
}

export async function markOutboxProcessed(pool: Db, eventId: string): Promise<void> {
  await pool.query(
    `UPDATE integration_outbox SET status = 'PROCESSED', processed_at = now() WHERE id = $1`,
    [eventId],
  );
}

export async function scheduleOutboxRetry(
  pool: Db,
  eventId: string,
  errorCode: string,
): Promise<void> {
  await pool.query(
    `UPDATE integration_outbox
     SET attempt_count = attempt_count + 1,
         last_error_code = $2,
         status = CASE WHEN attempt_count + 1 >= 10 THEN 'FAILED' ELSE 'PENDING' END,
         available_at = now() + (least(power(2, attempt_count), 3600) || ' seconds')::interval
     WHERE id = $1`,
    [eventId, errorCode],
  );
}

export async function receiveInboxEvent(
  pool: Db,
  input: {
    tenantId: string | null;
    provider: string;
    eventType: string;
    externalEventId: string;
    payload: Record<string, unknown>;
  },
): Promise<'inserted' | 'duplicate'> {
  const result = await pool.query(
    `INSERT INTO integration_inbox (tenant_id, provider, event_type, external_event_id, payload)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, external_event_id) DO NOTHING
     RETURNING id`,
    [
      input.tenantId,
      input.provider,
      input.eventType,
      input.externalEventId,
      JSON.stringify(input.payload),
    ],
  );
  return result.rows[0] ? 'inserted' : 'duplicate';
}

export async function processOutbox(
  pool: Db,
  handler: (event: OutboxEvent) => Promise<void>,
  limit = 10,
): Promise<number> {
  const events = await claimOutbox(pool, limit);
  for (const event of events) {
    try {
      await handler(event);
      await markOutboxProcessed(pool, event.id);
    } catch (error) {
      await scheduleOutboxRetry(pool, event.id, error instanceof Error ? error.message.slice(0, 200) : 'UNKNOWN');
    }
  }
  return events.length;
}

export function requireOutboxEvent(event: OutboxEvent | undefined | null): OutboxEvent {
  if (!event) throw new AppError(ErrorCodes.outboxClaim, 'Outbox event not found', 404);
  return event;
}
