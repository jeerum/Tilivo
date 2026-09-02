import { describe, expect, it } from 'vitest';
import { parseHealthPayload } from './health';

describe('parseHealthPayload', () => {
  it('maps a healthy backend response', () => {
    const state = parseHealthPayload({
      status: 'ok',
      checks: { database: 'up' },
      version: '0.1.0',
      environment: 'production',
      time: '2026-09-02T10:00:00.000Z',
      trace_id: 'trace-1',
    });

    expect(state.status).toBe('ok');
    expect(state.database).toBe('up');
    expect(state.version).toBe('0.1.0');
    expect(state.trace_id).toBe('trace-1');
    expect(state.error).toBeUndefined();
  });

  it('maps a degraded response and keeps the error id', () => {
    const state = parseHealthPayload({
      status: 'degraded',
      checks: { database: 'down' },
      error: {
        code: 'DB-001',
        message: 'Database is unreachable',
        trace_id: 'trace-2',
      },
    });

    expect(state.status).toBe('degraded');
    expect(state.database).toBe('down');
    expect(state.error?.code).toBe('DB-001');
    expect(state.error?.trace_id).toBe('trace-2');
  });

  it('is defensive against malformed payloads', () => {
    const state = parseHealthPayload({});
    expect(state.status).toBe('degraded');
    expect(state.database).toBe('down');
  });
});

