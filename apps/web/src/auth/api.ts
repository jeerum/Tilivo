export interface PublicUser {
  id: string;
  email: string;
  email_verified: boolean;
  totp_enabled: boolean;
  created_at: string;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  created_at: string;
  expires_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  remember_me: boolean;
  user_agent: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  csrf?: string;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
  };
  if (options.body) headers['content-type'] = 'application/json';
  if (options.csrf) headers['x-csrf-token'] = options.csrf;

  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload: any = await (async () => {
    try {
      return await response.json();
    } catch {
      return null;
    }
  })();

  if (!response.ok) {
    throw new ApiError(
      payload?.error?.message ?? `Request failed with status ${response.status}`,
      response.status,
      payload?.error?.code,
    );
  }
  return payload as T;
}

export function getCookie(name: string): string {
  const match = document.cookie
    .split('; ')
    .find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.split('=').slice(1).join('=')) : '';
}
