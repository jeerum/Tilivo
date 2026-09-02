import { loadConfig } from './config/env';
import { createPool } from './db/pool';
import { processOutbox } from './services/integrationQueue';

async function runOnce(pool: ReturnType<typeof createPool>): Promise<void> {
  const processed = await processOutbox(pool, async (event) => {
    // v0.4 foundation: no real external provider connected yet.
    console.log(
      JSON.stringify({
        level: 'info',
        action: 'outbox_processed',
        outbox_id: event.id,
        tenant_id: event.tenant_id,
        event_type: event.event_type,
      }),
    );
  });
  if (processed > 0) {
    console.log(JSON.stringify({ level: 'info', action: 'worker_cycle', processed }));
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  for (;;) {
    try {
      await runOnce(pool);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          error_id: 'OUTBOX-001',
          action: 'worker_failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

void main();
