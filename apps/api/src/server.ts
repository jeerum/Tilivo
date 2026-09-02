import { loadConfig } from './config/env';
import { createPool } from './db/pool';
import { buildApp } from './app';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // No logger exists yet; this must go to stderr as plain JSON.
    process.stderr.write(
      JSON.stringify({
        level: 'fatal',
        error_id: 'CFG-001',
        action: 'load_config',
        message: error instanceof Error ? error.message : String(error),
      }) + '\n',
    );
    process.exit(1);
  }

  const pool = createPool(config.DATABASE_URL);
  const app = await buildApp({ config, db: pool });

  const shutdown = async (signal: string) => {
    app.log.info({ action: 'shutdown', signal }, 'shutting down');
    await app.close();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    app.log.info(
      {
        action: 'server_started',
        version: config.API_VERSION,
        environment: config.NODE_ENV,
        docs: config.EXPOSE_DOCS ? '/docs' : 'disabled',
      },
      'Tilivo API listening',
    );
  } catch (error) {
    app.log.fatal({ err: error, action: 'listen_failed' }, 'failed to start server');
    await pool.end();
    process.exit(1);
  }
}

void main();
