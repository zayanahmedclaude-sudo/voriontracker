const SOCKET_SERVER_URL =
  process.env.SOCKET_SERVER_URL ||
  process.env.NEXT_PUBLIC_SOCKET_SERVER_URL ||
  (process.env.NODE_ENV !== 'production' ? 'http://127.0.0.1:4000' : '');
const SOCKET_SERVER_SECRET = process.env.SOCKET_SERVER_SECRET || process.env.JWT_SECRET || '';
const SOCKET_EMIT_TIMEOUT_MS = 1500;

export function getSocketServerUrl() {
  return SOCKET_SERVER_URL;
}

export async function emitSocketEvent(event: string, payload: any, options: { toEmployeeId?: string | null; toAdmins?: boolean; toEmployees?: boolean } = {}) {
  const baseUrl = (SOCKET_SERVER_URL || '').replace(/\/$/, '');
  if (!baseUrl) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SOCKET_EMIT_TIMEOUT_MS);
    const res = await fetch(`${baseUrl}/emit`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Socket-Secret': SOCKET_SERVER_SECRET,
      },
      body: JSON.stringify({ event, payload, ...options }),
    }).finally(() => clearTimeout(timeout));

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn('Socket emit failed', res.status, text);
    }
  } catch (error) {
    console.warn('Socket emit failed', error);
  }
}
