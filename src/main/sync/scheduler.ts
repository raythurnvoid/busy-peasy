import type { Account, DataChanged } from '../../shared/api'
import { listAccounts, setAccountStatus } from '../db/accounts'
import type { Db } from '../db/db'

// The account must be signed in again by the user. Polls skip it until then.
export class NeedsSignInError extends Error {}

// A signed-out account gets its notice again after this gap, and only in the day (local hours), not at night.
const NOTICE_GAP = 4 * 3600_000
const DAY_START = 8
const DAY_END = 20

export interface SchedulerDeps {
  db: Db
  now(): number
  notify(change: DataChanged): void
  syncAccount(account: Account): Promise<void>
  // first: the account starts needing a sign-in. Called again while it still does: at app start, then every 4 h in the day.
  onNeedsSignIn(account: Account, first: boolean): void
}

export interface SyncScheduler {
  // Syncs every account. A call during a run queues one more run, and the promise covers it.
  syncNow(): Promise<void>
  // Resolves when this account's next sync that starts after the call ends, also when it fails or is skipped. Queues a run.
  syncAccount(accountId: number): Promise<void>
}

export function createSyncScheduler(deps: SchedulerDeps): SyncScheduler {
  let running: Promise<void> | null = null
  let queued = false
  const waiters = new Map<number, (() => void)[]>()
  // When each account last got its sign-in notice. In memory: a restart must show it again.
  const notices = new Map<number, number>()

  async function runOnce(): Promise<void> {
    for (const account of listAccounts(deps.db)) {
      // Taken before the sync starts: a call made during it waits for the next run.
      const done = waiters.get(account.id) ?? []
      waiters.delete(account.id)
      if (account.status === 'needs-sign-in') {
        const last = notices.get(account.id)
        const hour = new Date(deps.now()).getHours()
        if (last === undefined || (deps.now() - last >= NOTICE_GAP && hour >= DAY_START && hour < DAY_END)) {
          notices.set(account.id, deps.now())
          deps.onNeedsSignIn(account, false)
        }
        done.forEach((resolve) => resolve())
        continue
      }
      setAccountStatus(deps.db, account.id, 'syncing', null)
      deps.notify({ accounts: true, calendars: false, events: false, reminders: false, settings: false })
      try {
        await deps.syncAccount(account)
        setAccountStatus(deps.db, account.id, 'ok', null, deps.now())
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const needsSignIn = error instanceof NeedsSignInError
        setAccountStatus(deps.db, account.id, needsSignIn ? 'needs-sign-in' : 'error', message)
        console.error(`Sync failed for account ${account.id}:`, message)
        if (needsSignIn) {
          notices.set(account.id, deps.now())
          deps.onNeedsSignIn(account, true)
        }
      }
      done.forEach((resolve) => resolve())
      deps.notify({ accounts: true, calendars: true, events: true, reminders: false, settings: false })
    }
  }

  const api: SyncScheduler = {
    syncAccount(accountId) {
      const synced = new Promise<void>((resolve) => waiters.set(accountId, [...(waiters.get(accountId) ?? []), resolve]))
      void api.syncNow()
      return synced
    },
    syncNow() {
      if (running) {
        queued = true
        return running
      }
      running = (async () => {
        // Cleared in the same step as the last queued check, so a call in between is not lost.
        try {
          do {
            queued = false
            await runOnce()
          } while (queued)
        } finally {
          running = null
        }
      })()
      return running
    }
  }
  return api
}
