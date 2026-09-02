import { runner } from 'node-pg-migrate';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config/env';

async function main(): Promise<void> {
  const direction = process.argv[2];
  if (direction !== 'up' && direction !== 'down') {
    process.stderr.write('Usage: node dist/migrate.js <up|down>\n');
    process.exit(1);
  }

  const config = loadConfig();
  const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? config.DATABASE_URL;

  try {
    await runner({
      databaseUrl,
      dir: fileURLToPath(new URL('../migrations/', import.meta.url)),
      direction,
      migrationsTable: 'pgmigrations',
      count: direction === 'down' ? 1 : undefined,
      log: (msg: string) => process.stdout.write(`migrate: ${msg}\n`),
      noLock: false,
    });
    process.stdout.write(`migration ${direction} complete\n`);
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        level: 'fatal',
        error_id: 'MIG-001',
        action: `migration_${direction}`,
        message: error instanceof Error ? error.message : String(error),
      }) + '\n',
    );
    process.exit(1);
  }
}

void main();
