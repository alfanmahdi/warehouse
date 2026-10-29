const TOKEN_KEY = 'wr.token';

// sessionStorage: cleared when the tab closes. Trade-off documented in README (XSS vs. CSRF).
export const tokenStore = {
  get: (): string | null => {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t: string) => sessionStorage.setItem(TOKEN_KEY, t),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }

  /** Human-readable text including field-level validation problems. */
  get friendly(): string {
    if (this.code === 'VALIDATION_ERROR' && Array.isArray(this.details)) {
      const parts = (this.details as Array<{ path: string; message: string }>).map((d) =>
        d.path ? `${d.path}: ${d.message}` : d.message,
      );
      if (parts.length) return parts.join('; ');
    }
    return this.message;
  }
}

export const AUTH_EXPIRED_EVENT = 'wr:auth-expired';

interface Options {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined | null>;
}

export async function api<T>(path: string, opts: Options = {}): Promise<{ data: T; status: number }> {
  const url = new URL(`/api${path}`, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { ...opts.headers };
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.');
  }

  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON body */
  }

  if (!res.ok) {
    const err = (json as { error?: { code: string; message: string; details?: unknown } } | undefined)?.error;
    if (res.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return { data: json as T, status: res.status };
}

/** Random id for the Idempotency-Key header. randomUUID needs a secure context, so fall back for plain-http LANs. */
export function newKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
