'use client'

// Typed fetch wrapper for the MjengoOS API.
// Success envelope: { data } — Failure envelope: { error: { message } }

export class ApiClientError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

// MJG-072 — result shape for paginated list endpoints. `total` comes from the
// org-filtered X-Total-Count response header; it is null when the header is
// absent (the endpoints only send it when a `page` query param was used, so a
// plain param-less fetch keeps its legacy unknown-total behavior).
export interface PaginatedList<T> {
  items: T[]
  total: number | null
}

function toClientError(res: Response, payload: unknown): ApiClientError {
  const message =
    (payload as { error?: { message?: string } } | null)?.error?.message ??
    `Request failed (${res.status})`
  return new ApiClientError(res.status, message)
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

  if (!res.ok) throw toClientError(res, payload)
  return (payload as { data: T }).data
}

// MJG-072 — fetch a (possibly paginated) list endpoint. The response body
// stays the legacy JSON array under { data }; the org-filtered total is read
// from the X-Total-Count header when present.
async function requestList<T>(path: string, init?: RequestInit): Promise<PaginatedList<T>> {
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

  if (!res.ok) throw toClientError(res, payload)

  const raw = res.headers.get('X-Total-Count')
  const parsed = raw === null ? Number.NaN : Number(raw)
  return {
    items: (payload as { data: T[] }).data,
    total: Number.isInteger(parsed) && parsed >= 0 ? parsed : null,
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  // MJG-072 — paginated list fetch (payments, deliveries, evidence,
  // assignments, inventory movements, purchase orders).
  list: <T>(path: string) => requestList<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
}
