import type { OutlookToken } from './client'

// "One Outlook Web", Microsoft's own app behind outlook.cloud.microsoft.
export const OWA_APP_ID = '9199bf20-a13f-4107-85dc-02114787ef48'
const AUDIENCE = 'https://outlook.office.com'
// A token this close to expiry is not worth keeping.
const MIN_LIFETIME = 5 * 60_000

interface Claims {
  aud?: string
  appid?: string
  tid?: string
  exp?: number
  scp?: string
  upn?: string
  unique_name?: string
  preferred_username?: string
}

// Reads a bearer token that Outlook on the web sent. Returns null unless it is a calendar token for
// Outlook REST from the Outlook web app. The signature is not checked: clients must not validate
// Microsoft access tokens, and the server rejects bad ones anyway.
export function parseOutlookToken(authorization: string | undefined, anchor: string | undefined, now: number): OutlookToken | null {
  const raw = authorization?.match(/^Bearer (\S+)$/)?.[1]
  const payload = raw?.split('.')[1]
  if (!raw || !payload) return null
  let claims: Claims
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims
  } catch {
    return null
  }
  const upn = (claims.upn ?? claims.unique_name ?? claims.preferred_username ?? '').toLowerCase()
  const exp = (claims.exp ?? 0) * 1000
  const ok =
    claims.aud === AUDIENCE &&
    claims.appid === OWA_APP_ID &&
    typeof claims.tid === 'string' &&
    exp > now + MIN_LIFETIME &&
    (claims.scp ?? '').split(' ').includes('Calendars.ReadWrite') &&
    upn.includes('@')
  return ok ? { raw, anchor: anchor ?? `UPN:${upn}`, exp, upn, tid: claims.tid! } : null
}
