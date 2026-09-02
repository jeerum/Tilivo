export type HealthStatus = 'ok' | 'degraded';
export type DatabaseStatus = 'up' | 'down';

export interface HealthError {
  code: string;
  message: string;
  trace_id: string;
}

export interface HealthState {
  status: HealthStatus;
  database: DatabaseStatus;
  version: string;
  environment: string;
  time: string;
  trace_id?: string;
  error?: HealthError;
}

export interface HealthPayload {
  status?: string;
  checks?: { database?: string };
  version?: string;
  environment?: string;
  time?: string;
  trace_id?: string;
  error?: HealthError;
}

export function parseHealthPayload(payload: HealthPayload): HealthState {
  const status: HealthStatus = payload.status === 'ok' ? 'ok' : 'degraded';
  const database: DatabaseStatus = payload.checks?.database === 'up' ? 'up' : 'down';

  return {
    status,
    database,
    version: payload.version ?? 'unknown',
    environment: payload.environment ?? 'unknown',
    time: payload.time ?? '',
    trace_id: payload.trace_id,
    error: payload.error,
  };
}

export async function fetchHealth(baseUrl = '/api/v1/health', timeoutMs = 5000): Promise<HealthState> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(baseUrl, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    const payload = (await response.json()) as HealthPayload;
    return parseHealthPayload(payload);
  } finally {
    clearTimeout(timer);
  }
}

