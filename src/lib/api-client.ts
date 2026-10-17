'use client'

// Typed fetch wrapper for the MjengoOS API.
// Success envelope: { data } — Failure envelope: { error: { message } }

export class ApiClientError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })

  let payload: unknown = null
  try {
    payload = await res.json()
  } catch {
    // non-JSON response
  }

  if (!res.ok) {
    const message =
      (payload as { error?: { message?: string } } | null)?.error?.message ??
      `Request failed (${res.status})`
    throw new ApiClientError(res.status, message)
  }
  return (payload as { data: T }).data
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
}
