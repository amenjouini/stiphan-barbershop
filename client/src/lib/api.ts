import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, any> = {}) {
    super(message);
  }
}

/** JSON fetch against /api with the CSRF header the server requires. */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'clubbarber', ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection and try again.');
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? 'Something went wrong. Please try again.', e);
  }
  return data as T;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

/** Loads `path` (null = skip) and reloads when it changes. Keeps previous data visible while refreshing. */
export function useApi<T = any>(path: string | null) {
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: !!path });
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return setState({ data: null, error: null, loading: false });
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await api<T>(path);
      if (mine === seq.current) setState({ data, error: null, loading: false });
    } catch (e) {
      if (mine === seq.current) setState((s) => ({ data: s.data, error: e as ApiError, loading: false }));
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  return { ...state, reload: load };
}

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function qs(params: Record<string, string | number | null | undefined | false>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
