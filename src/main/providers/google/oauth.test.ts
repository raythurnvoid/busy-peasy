import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { NeedsSignInError } from '../../sync/scheduler'
import { GOOGLE_SCOPES, LABELS_SCOPE, refreshGoogleToken, signInGoogle } from './oauth'

const client = { id: 'cid', secret: 'secret' }
const idToken = `x.${Buffer.from(JSON.stringify({ email: 'Me@Gmail.com' })).toString('base64url')}.sig`

// Plays the browser: opens the auth URL by calling our loopback redirect, like Google would.
function browser(respond: (auth: URL) => string): { openBrowser(url: string): void; auth: Promise<URL> } {
  let resolve: (u: URL) => void
  const auth = new Promise<URL>((r) => (resolve = r))
  return {
    auth,
    openBrowser(url) {
      const u = new URL(url)
      resolve(u)
      void (async () => {
        // A request with a wrong state must be ignored.
        const wrong = await fetch(`${u.searchParams.get('redirect_uri')}?code=evil&state=nope`)
        expect(wrong.status).toBe(404)
        await fetch(`${u.searchParams.get('redirect_uri')}?${respond(u)}`)
      })()
    }
  }
}

function tokenEndpoint(body: object, seen: URLSearchParams[] = []): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    seen.push(new URLSearchParams(init.body as URLSearchParams))
    return new Response(JSON.stringify(body))
  }) as typeof fetch
}

describe('signInGoogle', () => {
  it('uses PKCE and state, and returns the refresh token and email', async () => {
    const seen: URLSearchParams[] = []
    const b = browser((u) => `code=c1&state=${u.searchParams.get('state')}`)
    const fetchToken = tokenEndpoint(
      { access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: idToken, scope: GOOGLE_SCOPES.join(' ') },
      seen
    )
    const tokens = await signInGoogle(client, { fetch: fetchToken, openBrowser: b.openBrowser, now: () => 0 }, new AbortController().signal)
    expect(tokens).toEqual({ refreshToken: 'rt', accessToken: 'at', expiresAt: 3600_000, email: 'me@gmail.com' })
    const auth = await b.auth
    expect(auth.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
    // The verifier sent to the token endpoint must hash to the challenge sent to the browser.
    const verifier = seen[0].get('code_verifier')!
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(auth.searchParams.get('code_challenge'))
    expect(seen[0].get('code')).toBe('c1')
  })

  it('asks for the labels scope, and signs in also when the user unticked it', async () => {
    const b = browser((u) => `code=c1&state=${u.searchParams.get('state')}`)
    const fetchToken = tokenEndpoint({ access_token: 'at', refresh_token: 'rt', id_token: idToken, scope: GOOGLE_SCOPES.join(' ') })
    await expect(
      signInGoogle(client, { fetch: fetchToken, openBrowser: b.openBrowser, now: () => 0 }, new AbortController().signal)
    ).resolves.toMatchObject({ refreshToken: 'rt' })
    const scopes = (await b.auth).searchParams.get('scope')!.split(' ')
    expect(scopes).toContain(LABELS_SCOPE)
  })

  it('refuses when the user unticked the calendar scope', async () => {
    const b = browser((u) => `code=c1&state=${u.searchParams.get('state')}`)
    const fetchToken = tokenEndpoint({ access_token: 'at', refresh_token: 'rt', id_token: idToken, scope: GOOGLE_SCOPES[1] })
    await expect(
      signInGoogle(client, { fetch: fetchToken, openBrowser: b.openBrowser, now: () => 0 }, new AbortController().signal)
    ).rejects.toThrow('Please allow access to your calendars')
  })

  it('stops when the user denies access', async () => {
    const b = browser((u) => `error=access_denied&state=${u.searchParams.get('state')}`)
    await expect(
      signInGoogle(client, { fetch: tokenEndpoint({}), openBrowser: b.openBrowser, now: () => 0 }, new AbortController().signal)
    ).rejects.toThrow('cancelled')
  })
})

describe('refreshGoogleToken', () => {
  it('asks for a new sign-in when the refresh token is no longer valid', async () => {
    const fetchToken = (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch
    await expect(refreshGoogleToken(client, 'rt', { fetch: fetchToken, now: () => 0 })).rejects.toBeInstanceOf(NeedsSignInError)
  })
})
