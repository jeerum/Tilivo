import pg from 'pg';

export interface Queryable {
  query(text: string): Promise<{ rows: unknown[] }>;
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30_000,
    application_name: 'mrjkp-accounting-api',
  });
}
