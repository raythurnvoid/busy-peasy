import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { NeedsSignInError } from '../../sync/scheduler'

// Google sign-in for installed apps: system browser + loopback redirect + PKCE.
// https://developers.google.com/identity/protocols/oauth2/native-app

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly'
]
// Reads event labels (Google's colors). Asked, not required: without it the app shows the classic colors only.
export const LABELS_SCOPE = 'https://www.googleapis.com/auth/calendar.calendars.readonly'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const SIGN_IN_TIMEOUT = 5 * 60_000

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Busy Peasy</title>
<body style="font:16px system-ui;margin:4rem;text-align:center">Signed in to Busy Peasy. You can close this tab.</body>`

export interface GoogleClient {
  id: string
  secret: string
}

export interface GoogleTokens {
  refreshToken: string
  accessToken: string
  expiresAt: number
  email: string
}

interface TokenResponse {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  id_token?: string
  scope?: string
  error?: string
}

export async function signInGoogle(
  client: GoogleClient,
  deps: { fetch: typeof fetch; openBrowser(url: string): void; now(): number },
  signal: AbortSignal
): Promise<GoogleTokens> {
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(32).toString('base64url')
  const { code, redirectUri } = await waitForCode(state, createHash('sha256').update(verifier).digest('base64url'), client, deps, signal)
  const tokens = await tokenRequest(deps, {
    code,
    client_id: client.id,
    client_secret: client.secret,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  })
  // The consent screen lets the user untick scopes.
  const granted = (tokens.scope ?? '').split(' ')
  if (!GOOGLE_SCOPES.every((s) => granted.includes(s))) throw new Error('Please allow access to your calendars')
  const email = idTokenEmail(tokens.id_token)
  if (!tokens.refresh_token || !tokens.access_token || !email) throw new Error('Google sign-in did not return a token')
  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiresAt: deps.now() + (tokens.expires_in ?? 0) * 1000,
    email
  }
}

export async function refreshGoogleToken(
  client: GoogleClient,
  refreshToken: string,
  deps: { fetch: typeof fetch; now(): number }
): Promise<{ accessToken: string; expiresAt: number }> {
  const tokens = await tokenRequest(deps, {
    client_id: client.id,
    client_secret: client.secret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  })
  return { accessToken: tokens.access_token!, expiresAt: deps.now() + (tokens.expires_in ?? 0) * 1000 }
}

export async function revokeGoogleToken(token: string, deps: { fetch: typeof fetch }): Promise<void> {
  await deps.fetch(REVOKE_URL, { method: 'POST', body: new URLSearchParams({ token }) })
}

async function tokenRequest(deps: { fetch: typeof fetch }, body: Record<string, string>): Promise<TokenResponse> {
  const res = await deps.fetch(TOKEN_URL, { method: 'POST', body: new URLSearchParams(body) })
  const json = (await res.json()) as TokenResponse
  // invalid_grant: the refresh token was revoked or expired (7 days while the Google app is in testing).
  if (json.error === 'invalid_grant') throw new NeedsSignInError('Google sign-in needed')
  if (!res.ok || !json.access_token) throw new Error('Google token request failed: ' + (json.error ?? res.status))
  return json
}

// The id token comes straight from Google's token endpoint over TLS, so it is read without a signature check.
function idTokenEmail(idToken: string | undefined): string | null {
  try {
    const claims = JSON.parse(Buffer.from(idToken!.split('.')[1], 'base64url').toString('utf8')) as { email?: string }
    return claims.email?.toLowerCase() ?? null
  } catch {
    return null
  }
}

function waitForCode(
  state: string,
  challenge: string,
  client: GoogleClient,
  deps: { openBrowser(url: string): void },
  signal: AbortSignal
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let redirectUri = ''
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method !== 'GET' || url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" })
      res.end(DONE_PAGE)
      const code = url.searchParams.get('code')
      finish(code ? null : new Error('Google sign-in was cancelled'), code)
    })
    const timer = setTimeout(() => finish(new Error('Google sign-in timed out')), SIGN_IN_TIMEOUT)
    const onAbort = (): void => finish(new Error('Google sign-in was cancelled'))
    signal.addEventListener('abort', onAbort)

    function finish(error: Error | null, code?: string | null): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      server.close()
      if (error) reject(error)
      else resolve({ code: code!, redirectUri })
    }

    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return finish(new Error('Could not start sign-in'))
      redirectUri = `http://127.0.0.1:${address.port}/callback`
      const auth = new URL(AUTH_URL)
      auth.search = new URLSearchParams({
        client_id: client.id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: [...GOOGLE_SCOPES, LABELS_SCOPE, 'openid', 'email'].join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
        // Always ask, so Google always returns a refresh token.
        prompt: 'consent select_account'
      }).toString()
      deps.openBrowser(auth.toString())
    })
  })
}
