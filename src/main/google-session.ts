import { net, safeStorage, shell } from 'electron'
import type { Account } from '../shared/api'
import { getAccount, upsertAccount } from './db/accounts'
import type { Db } from './db/db'
import { GoogleAuthError, type GoogleDeps } from './providers/google/client'
import { refreshGoogleToken, revokeGoogleToken, signInGoogle, type GoogleClient } from './providers/google/oauth'
import { syncGoogleAccount } from './providers/google/sync'
import { NeedsSignInError } from './sync/scheduler'

// An installed app cannot keep its client secret secret; Google knows this and relies on PKCE instead.
const client: GoogleClient = {
  id: import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID,
  secret: import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET
}

// Access tokens live in memory only. The refresh token is stored encrypted in the DB.
const accessTokens = new Map<number, { token: string; expiresAt: number }>()
let pendingSignIn: AbortController | null = null

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const fetchFn = net.fetch as typeof fetch

export async function addGoogle(db: Db): Promise<void> {
  if (!client.id) throw new Error('Google sign-in is not set up in this build')
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('Secure storage is not available on this system')
  // A new click restarts the sign-in, e.g. when the browser tab was closed.
  pendingSignIn?.abort()
  const controller = new AbortController()
  pendingSignIn = controller
  try {
    const tokens = await signInGoogle(
      client,
      { fetch: fetchFn, openBrowser: (url) => void shell.openExternal(url), now: Date.now },
      controller.signal
    )
    const id = upsertAccount(db, 'google', tokens.email, await safeStorage.encryptStringAsync(tokens.refreshToken), Date.now())
    accessTokens.set(id, { token: tokens.accessToken, expiresAt: tokens.expiresAt })
  } finally {
    if (pendingSignIn === controller) pendingSignIn = null
  }
}

export function syncGoogle(db: Db, account: Account): Promise<void> {
  return withGoogle(db, account.id, (deps) => syncGoogleAccount({ ...deps, db, now: Date.now }, account.id))
}

// Runs fn with the account's access token. A rejected token is dropped once and fn runs again.
export async function withGoogle<T>(db: Db, accountId: number, fn: (deps: GoogleDeps) => Promise<T>): Promise<T> {
  const deps: GoogleDeps = { fetch: fetchFn, sleep, getAccessToken: () => accessToken(db, accountId) }
  try {
    return await fn(deps)
  } catch (error) {
    if (!(error instanceof GoogleAuthError)) throw error
    accessTokens.delete(accountId)
    return await fn(deps)
  }
}

export async function forgetGoogle(accountId: number, secret: Uint8Array | null): Promise<void> {
  accessTokens.delete(accountId)
  if (!secret) return
  // Best effort: the account is removed locally even if Google cannot be reached.
  try {
    const { result } = await safeStorage.decryptStringAsync(Buffer.from(secret))
    await revokeGoogleToken(result, { fetch: fetchFn })
  } catch {
    // Ignore.
  }
}

async function accessToken(db: Db, accountId: number): Promise<string> {
  const cached = accessTokens.get(accountId)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
  const secret = getAccount(db, accountId)?.secret
  if (!secret) throw new NeedsSignInError('Google sign-in needed')
  const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(secret))
  const account = getAccount(db, accountId)!
  if (shouldReEncrypt) upsertAccount(db, 'google', account.email, await safeStorage.encryptStringAsync(result), Date.now())
  const fresh = await refreshGoogleToken(client, result, { fetch: fetchFn, now: Date.now })
  accessTokens.set(accountId, { token: fresh.accessToken, expiresAt: fresh.expiresAt })
  return fresh.accessToken
}
