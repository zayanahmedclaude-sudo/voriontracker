export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;
  retryAfter?: string;

  constructor(message: string, status: number, options?: { code?: string; details?: unknown; retryAfter?: string }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = options?.code;
    this.details = options?.details;
    this.retryAfter = options?.retryAfter;
  }
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, '') || '';

export function buildApiUrl(path: string): string {
  if (!path) return API_BASE_URL || '/';
  if (/^https?:\/\//i.test(path)) return path;

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}

function isFormBody(body: BodyInit | null | undefined): boolean {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}

async function parseErrorResponse(response: Response): Promise<{ message: string; code?: string; details?: unknown }> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      const payload = await response.json();
      if (payload && typeof payload === 'object') {
        const record = payload as Record<string, unknown>;
        const message =
          typeof record.error === 'string'
            ? record.error
            : typeof record.message === 'string'
            ? record.message
            : response.statusText || 'Request failed';
        return {
          message,
          code: typeof record.code === 'string' ? record.code : undefined,
          details: record.details,
        };
      }
    } catch {
      // Fall through to a generic message.
    }
  }

  return { message: response.statusText || 'Request failed' };
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit & {
    token?: string;
    expect?: 'json' | 'text' | 'response';
  } = {},
): Promise<T> {
  const { token, expect = 'response', headers: initHeaders, body, ...init } = options;
  const headers = new Headers(initHeaders);

  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  if (body !== undefined && !headers.has('Content-Type') && !isFormBody(body)) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(buildApiUrl(path), {
    ...init,
    body,
    headers,
  });

  if (!response.ok && expect !== 'response') {
    const parsed = await parseErrorResponse(response);
    throw new ApiError(parsed.message, response.status, {
      code: parsed.code,
      details: parsed.details,
      retryAfter: response.headers.get('retry-after') || undefined,
    });
  }

  if (expect === 'response') return response as T;
  if (expect === 'text') return (await response.text()) as T;
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
