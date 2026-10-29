// Local event writes per calendar, counted in memory (a restart also ends every sync).
// A sync reads the provider, then commits. A write stored in between may be newer than what the sync read,
// so the sync skips its commit and the sync the write queued reads again.
// Every change to stored events outside sync must call noteLocalWrite.
const writes = new Map<number, number>()
const skips = new Map<number, number>()
// Steady edits must not block a calendar's sync for good: after this many skips in a row it commits anyway.
const MAX_SKIPS = 3

export function noteLocalWrite(calendarId: number): void {
  writes.set(calendarId, localWrites(calendarId) + 1)
}

export function localWrites(calendarId: number): number {
  return writes.get(calendarId) ?? 0
}

// writesAtStart: localWrites() from before the sync's first request.
export function skipCommit(calendarId: number, writesAtStart: number): boolean {
  const skipped = skips.get(calendarId) ?? 0
  const skip = localWrites(calendarId) !== writesAtStart && skipped < MAX_SKIPS
  skips.set(calendarId, skip ? skipped + 1 : 0)
  if (skip) console.info(`Sync skipped for calendar ${calendarId}: an event changed in the app`)
  return skip
}
