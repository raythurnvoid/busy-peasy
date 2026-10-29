import { describe, expect, it, vi } from 'vitest'
import { setAccountStatus, upsertAccount } from '../db/accounts'
import { openDb, type Db } from '../db/db'
import { createSyncScheduler, NeedsSignInError, type SyncScheduler } from './scheduler'

describe('syncAccount', () => {
  // One account. Each of its syncs waits until release is called.
  function setup(): {
    scheduler: SyncScheduler
    db: Db
    id: number
    started: number[]
    release: () => void
  } {
    const db = openDb(':memory:')
    const id = upsertAccount(db, 'google', 'me@gmail.com', null, 0)
    const started: number[] = []
    let release = (): void => {}
    const scheduler = createSyncScheduler({
      db,
      now: () => 0,
      notify: () => {},
      onNeedsSignIn: () => {},
      syncAccount: (account) => {
        started.push(account.id)
        return new Promise<void>((resolve) => (release = resolve))
      }
    })
    return { scheduler, db, id, started, release: () => release() }
  }

  it('waits for a sync that starts after the call, not for the one already running', async () => {
    const { scheduler, id, started, release } = setup()
    void scheduler.syncNow()
    let done = false
    const waited = scheduler.syncAccount(id).then(() => (done = true))
    // The running sync read the provider before the write: its end is not enough.
    release()
    await vi.waitFor(() => expect(started).toEqual([id, id]))
    expect(done).toBe(false)
    release()
    await waited
  })

  it('does not wait for an account that needs a sign-in', async () => {
    const { scheduler, db, id, started } = setup()
    setAccountStatus(db, id, 'needs-sign-in', 'Sign in again')
    await scheduler.syncAccount(id)
    expect(started).toEqual([])
  })
})

describe('sign-in notice', () => {
  // One account whose sync always needs a sign-in. The clock is local time. calls: the `first` flag of each notice.
  // With a db: the same app data after a restart.
  function setup(db?: Db): { scheduler: SyncScheduler; db: Db; calls: boolean[]; at: (time: Date) => void } {
    if (!db) {
      db = openDb(':memory:')
      upsertAccount(db, 'outlook', 'me@work.com', null, 0)
    }
    const calls: boolean[] = []
    let now = 0
    const scheduler = createSyncScheduler({
      db,
      now: () => now,
      notify: () => {},
      onNeedsSignIn: (_, first) => calls.push(first),
      syncAccount: async () => {
        throw new NeedsSignInError('Microsoft sign-in needed')
      }
    })
    return { scheduler, db, calls, at: (time) => (now = time.getTime()) }
  }

  it('shows it with the window when an account first needs a sign-in, and again after a restart', async () => {
    const { scheduler, db, calls, at } = setup()
    at(new Date(2026, 9, 28, 9, 0))
    await scheduler.syncNow()
    expect(calls).toEqual([true])
    at(new Date(2026, 9, 28, 9, 2))
    await scheduler.syncNow()
    expect(calls).toEqual([true])
    // The app starts again: a new scheduler on the same DB, at night too.
    const restarted = setup(db)
    restarted.at(new Date(2026, 9, 28, 23, 0))
    await restarted.scheduler.syncNow()
    expect(restarted.calls).toEqual([false])
  })

  it('repeats it at most every 4 hours, and not at night', async () => {
    const { scheduler, db, calls, at } = setup()
    setAccountStatus(db, 1, 'needs-sign-in', 'Sign in again')
    const check = async (hour: number, minute: number, count: number, day = 28): Promise<void> => {
      at(new Date(2026, 9, day, hour, minute))
      await scheduler.syncNow()
      expect(calls.length, `${day} ${hour}:${minute}`).toBe(count)
    }
    // At app start.
    await check(12, 0, 1)
    await check(15, 59, 1)
    await check(16, 0, 2)
    // Night: 20:00 is 4 h later, but no toast until 08:00.
    await check(20, 0, 2)
    await check(23, 0, 2)
    await check(7, 59, 2, 29)
    await check(8, 0, 3, 29)
    expect(calls.every((first) => !first)).toBe(true)
  })
})
