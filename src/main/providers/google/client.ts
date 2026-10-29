// HTTP access to the Google Calendar API v3.

export const GOOGLE_BASE = 'https://www.googleapis.com/calendar/v3/'

export interface GoogleDeps {
  fetch: typeof fetch
  getAccessToken(): Promise<string>
  sleep(ms: number): Promise<void>
}

// The access token was rejected. The caller gets a new one and tries again.
export class GoogleAuthError extends Error {}

export class GoogleHttpError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string
  ) {
    super(`Google ${status} ${reason}`)
  }
}

const MAX_RETRIES = 4
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded'])

export async function googleRequest<T>(
  deps: GoogleDeps,
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<T> {
  if (!url.startsWith(GOOGLE_BASE)) throw new Error('Blocked Google URL')
  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = { Authorization: 'Bearer ' + (await deps.getAccessToken()), ...init.headers }
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await deps.fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    })
    if (res.status === 401) throw new GoogleAuthError('Google token rejected')
    const text = await res.text()
    if (res.ok) return (text ? JSON.parse(text) : null) as T
    const reason = errorReason(text)
    // Back off with jitter: about 1 s, 2 s, 4 s, 8 s.
    if ((res.status === 429 || (res.status === 403 && RATE_LIMIT_REASONS.has(reason))) && attempt < MAX_RETRIES) {
      await deps.sleep(1000 * 2 ** attempt + Math.random() * 1000)
      continue
    }
    throw new GoogleHttpError(res.status, reason)
  }
}

function errorReason(text: string): string {
  try {
    const error = (JSON.parse(text) as { error?: { errors?: { reason?: string }[]; status?: string } }).error
    return error?.errors?.[0]?.reason ?? error?.status ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
