import { QueryClient } from "@tanstack/react-query";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
export function setCsrfToken(t: string | null) {
  csrfToken = t;
}
export function getCsrfToken() {
  return csrfToken;
}

const listeners = new Set<() => void>();
/** Fired when any request comes back 401 so the app can send the user to the login page. */
export function onUnauthenticated(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const method = (init.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) headers.set("x-csrf-token", csrfToken);
  const res = await fetch(`/api${path}`, {
    ...init,
    method,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    credentials: "same-origin",
  });
  if (res.status === 401 && !path.startsWith("/auth/login")) listeners.forEach((fn) => fn());
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const body = (data ?? {}) as Record<string, unknown>;
    const code = typeof body.error === "string" ? body.error : `http_${res.status}`;
    const message = typeof body.message === "string" ? body.message : code.replace(/_/g, " ");
    throw new ApiError(res.status, code, message, body);
  }
  return data as T;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    },
  },
});
