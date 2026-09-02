export interface DeviceInfo {
  label: string;
  browser: string;
  os: string;
  device: string;
}

export function parseUserAgent(raw: string): DeviceInfo {
  const ua = raw || '';
  const device =
    /iPhone|iPad|Android/.test(ua)
      ? /iPad/.test(ua)
        ? 'iPad'
        : /iPhone/.test(ua)
          ? 'iPhone'
          : 'Android'
      : 'Desktop';
  const browser = /Edg\//.test(ua)
    ? 'Microsoft Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Safari\//.test(ua)
        ? 'Safari'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /curl\//.test(ua)
            ? 'API client'
            : 'Unknown';
  const os = /Windows NT 10/.test(ua)
    ? 'Windows'
    : /Windows NT 11/.test(ua)
      ? 'Windows 11'
      : /iPhone OS/.test(ua)
        ? 'iOS'
        : /Android/.test(ua)
          ? 'Android'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Unknown';
  return { label: `${browser} · ${os}`, browser, os, device };
}

