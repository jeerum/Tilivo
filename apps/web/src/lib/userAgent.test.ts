import { describe, expect, it } from 'vitest';
import { parseUserAgent } from './userAgent';

describe('parseUserAgent', () => {
  it('parses Edge on Windows', () => {
    const info = parseUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Edg/120.0',
    );
    expect(info.browser).toBe('Microsoft Edge');
    expect(info.os).toBe('Windows');
    expect(info.device).toBe('Desktop');
  });

  it('parses Safari on iPhone', () => {
    const info = parseUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1',
    );
    expect(info.browser).toBe('Safari');
    expect(info.os).toBe('iOS');
    expect(info.device).toBe('iPhone');
  });

  it('parses curl', () => {
    const info = parseUserAgent('curl/8.0.1');
    expect(info.browser).toBe('API client');
  });
});
