// HTTP access to the Outlook REST beta API with the token captured from Outlook on the web.
// The token can also read mail, so it only ever goes to the calendar URLs below.

export const OUTLOOK_BASE = 'https://outlook.office.com/api/beta/me/'

// calendars, calendars/{id}, calendars/{id}/calendarview, calendars/{id}/events, events/{id}, events/{id}/instances,
// events/{id}/accept, events/{id}/tentativelyaccept, events/{id}/decline, MasterCategories (the category colors)
const ALLOWED_PATH =
  /^(calendars(\/[^/]+(\/(calendarview|events))?)?|events(\/[^/]+(\/(instances|accept|tentativelyaccept|decline))?)?|MasterCategories)$/

export interface OutlookToken {
  raw: string
  anchor: string
  exp: number
  upn: string
  tid: string
}

export interface OutlookDeps {
  fetch: typeof fetch
  getToken(): OutlookToken | null
  sleep(ms: number): Promise<void>
}

// The token is missing, expired or rejected. The caller renews it and tries again.
export class OutlookAuthError extends Error {}

export class OutlookHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(`Outlook ${status} ${code}`)
  }
}

const MAX_RETRIES = 3

export function checkOutlookUrl(url: string): void {
  const path = url.startsWith(OUTLOOK_BASE) ? new URL(url).pathname.slice(new URL(OUTLOOK_BASE).pathname.length) : ''
  if (!ALLOWED_PATH.test(path)) throw new Error('Blocked Outlook URL')
}

export async function outlookRequest<T>(
  deps: OutlookDeps,
  url: string,
  init: { method?: string; body?: unknown; prefer?: string } = {}
): Promise<T> {
  checkOutlookUrl(url)
  for (let attempt = 0; ; attempt++) {
    const token = deps.getToken()
    if (!token) throw new OutlookAuthError('No Outlook token')
    const headers: Record<string, string> = {
      Authorization: 'Bearer ' + token.raw,
      'X-AnchorMailbox': token.anchor,
      Prefer: init.prefer ?? 'outlook.timezone="UTC"'
    }
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await deps.fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'omit'
    })
    if (res.status === 401) throw new OutlookAuthError('Outlook token rejected')
    // The limit is shared with Outlook on the web, so wait as long as the server asks.
    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      await deps.sleep(retryDelay(res.headers.get('Retry-After'), attempt))
      continue
    }
    const text = await res.text()
    if (!res.ok) throw new OutlookHttpError(res.status, errorCode(text))
    return (text ? JSON.parse(text) : null) as T
  }
}

// Retry-After is seconds or an HTTP date. Without it: 5 s, 10 s, 20 s. Never more than 2 min.
function retryDelay(header: string | null, attempt: number): number {
  const seconds = Number(header)
  const ms = header === null ? NaN : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()
  return Math.min(120_000, Math.max(1000, Number.isFinite(ms) ? ms : 5000 * 2 ** attempt))
}

function errorCode(text: string): string {
  try {
    return (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
