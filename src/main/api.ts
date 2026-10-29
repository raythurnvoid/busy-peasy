import { clipboard, nativeTheme } from 'electron'
import type { Api, CalendarEvent, EventInput, EventReminder, GuestEdit, GuestInput, Repeat, Scope } from '../shared/api'
import { GOOGLE_COLORS } from '../shared/colors'
import { GUEST_FLAGS, MAX_GUESTS, canChangeTime, hasOwnCall, isEmail, isInvite, isOwnSeries } from '../shared/events'
import { MAX_REMINDER_MINUTES, MIN_ALL_DAY_MINUTES, SNOOZE_CHOICES } from '../shared/reminders'
import { MAX_COUNT, MAX_INTERVAL, dayOf, fitsDate } from '../shared/repeat'
import { EVENT_MINUTES, MAX_ZONE_LABEL, WEEK_STARTS } from '../shared/settings'
import { isZone } from '../shared/zones'
import {
  deleteAccount,
  findAccount,
  getAccount,
  getCalendarAccount,
  listAccounts,
  listCalendars,
  setCalendarVisible,
  upsertAccount
} from './db/accounts'
import type { Db } from './db/db'
import { getEvent, getEventDetails, getRecord, listEventsInRange, listPeople, searchEvents, type EventRecord } from './db/events'
import { getSettings, saveSettings } from './db/settings'
import { createEvent, deleteEvent, getSeries, respondEvent, updateEvent } from './event-writes'
import { addGoogle, forgetGoogle } from './google-session'
import { notifyDataChanged } from './ipc'
import { forgetOutlookSession, newOutlookPartition, signInOutlook } from './outlook-session'
import { OWN_KEYS, type EventChange } from './providers/write'
import type { ReminderScheduler } from './reminders'
import { openExternal } from './security'
import type { SyncScheduler } from './sync/scheduler'

// Schedule reads from its start day to the end of the synced dates at once. The sync window (WINDOW_PAST and
// WINDOW_FUTURE in providers/google/sync.ts and providers/outlook/sync.ts: 60 days back, 365 ahead) bounds the rows;
// the rest is room for a DST hour. Change it with them, and WINDOW_MS in event-writes.ts.
const MAX_RANGE = 430 * 24 * 3600_000
// Characters. Search runs on Enter only.
const MAX_SEARCH = 200
// Like Google.
const MAX_RESULTS = 200
const ALL = { accounts: true, calendars: true, events: true, reminders: false, settings: false }
const EVENTS = { accounts: false, calendars: false, events: true, reminders: false, settings: false }
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME_KEYS = ['start', 'end', 'allDay', 'startDate', 'endDate'] as const
const MAX_REMINDERS = 20
// Dismiss all: one window's list. Far more than a window shows.
const MAX_DISMISS = 100
const FREQS = ['daily', 'weekly', 'monthly', 'yearly']
const MONTHLY = ['day', 'weekday', 'last']
const SCOPES = ['event', 'following', 'series']
// A series write waits this long at most for the sync that brings its new rows.
const SERIES_WAIT_MS = 20_000

// The renderer is trusted less than main: check every argument before it reaches the DB or a provider.
function check(ok: boolean): void {
  if (!ok) throw new Error('Invalid arguments')
}

// All-day events carry their dates; start and end must be UTC midnight of those dates.
function checkEvent(e: Omit<EventInput, 'calendarId' | 'guests'>): void {
  check(typeof e.title === 'string' && typeof e.location === 'string' && typeof e.description === 'string')
  check(Number.isSafeInteger(e.start) && Number.isSafeInteger(e.end) && e.end > e.start && typeof e.allDay === 'boolean')
  if (e.allDay) {
    check(DATE.test(e.startDate ?? '') && DATE.test(e.endDate ?? ''))
    check(e.start === Date.parse(e.startDate + 'T00:00:00Z') && e.end === Date.parse(e.endDate + 'T00:00:00Z'))
  } else {
    check(e.startDate === null && e.endDate === null)
  }
}

// Returns clean copies, so nothing else the renderer sent gets stored. Only all-day events take "on the same day" (below 0).
function cleanReminders(list: unknown, allDay = false): EventReminder[] {
  check(Array.isArray(list) && list.length <= MAX_REMINDERS)
  return (list as EventReminder[]).map((r) => {
    check(typeof r === 'object' && r !== null && typeof r.alarm === 'boolean')
    check(Number.isSafeInteger(r.minutes) && r.minutes >= (allDay ? MIN_ALL_DAY_MINUTES : 0) && r.minutes <= MAX_REMINDER_MINUTES)
    return { minutes: r.minutes, alarm: r.alarm }
  })
}

// A clean copy of a rule that can start on the date (YYYY-MM-DD in the series' zone).
function cleanRepeat(r: unknown, date: string): Repeat {
  check(typeof r === 'object' && r !== null)
  const { freq, interval, days, monthly, until, count } = r as Repeat
  check(FREQS.includes(freq) && MONTHLY.includes(monthly))
  check(Number.isSafeInteger(interval) && interval >= 1 && interval <= MAX_INTERVAL)
  check(Array.isArray(days) && days.every((d) => Number.isSafeInteger(d) && d >= 0 && d <= 6))
  check(until === null || (typeof until === 'string' && DATE.test(until)))
  check(count === null || (Number.isSafeInteger(count) && count >= 1 && count <= MAX_COUNT))
  check(until === null || count === null)
  const clean: Repeat = {
    freq,
    interval,
    days: freq === 'weekly' ? [...new Set(days)].sort((a, b) => a - b) : [],
    monthly: freq === 'monthly' ? monthly : 'day',
    until,
    count
  }
  check(fitsDate(clean, date))
  return clean
}

// Only the user's own series takes "This and following" and "All events".
function checkScope(scope: unknown, event: NonNullable<ReturnType<typeof getEvent>>): Scope {
  check(scope === undefined || SCOPES.includes(scope as Scope))
  if (scope === undefined || scope === 'event') return 'event'
  check(isOwnSeries(event))
  return scope as Scope
}

// Providers compare emails in any case, so each one may come only once.
function checkOnce(emails: string[]): void {
  check(new Set(emails.map((email) => email.toLowerCase())).size === emails.length)
}

// A guest the event already has keeps the address the provider stored: Outlook can store none ('') or a non-email one
// (an X500 address). The providers only compare it, so any short string is safe.
const isStored = (email: string): boolean => email.length <= 320

// own: the organizer and the user, lower case. They are never guests, so they are left out. valid: isEmail for new
// guests, isStored for guests the event has.
function cleanGuests(list: unknown, own: string[], valid: (email: string) => boolean): GuestInput[] {
  check(Array.isArray(list) && list.length <= MAX_GUESTS)
  const guests = (list as GuestInput[]).map((g) => {
    check(typeof g === 'object' && g !== null && typeof g.email === 'string' && valid(g.email) && typeof g.optional === 'boolean')
    return { email: g.email, optional: g.optional }
  })
  checkOnce(guests.map((g) => g.email))
  return guests.filter((g) => !own.includes(g.email.toLowerCase()))
}

function cleanGuestEdit(edit: unknown, own: string[]): GuestEdit {
  check(typeof edit === 'object' && edit !== null)
  const { add, set, remove } = edit as GuestEdit
  check(Array.isArray(remove) && remove.every((email) => typeof email === 'string' && isStored(email)))
  const clean = {
    add: cleanGuests(add, own, isEmail),
    set: cleanGuests(set, own, isStored),
    remove: remove.filter((email) => !own.includes(email.toLowerCase()))
  }
  checkOnce([...clean.add, ...clean.set].map((g) => g.email).concat(clean.remove))
  return clean
}

// The provider fields for a color the user picked: a key of the calendar's colors, or null for the calendar's own.
// record: the event as stored, null for a new one. Google's Default also takes off a classic color; Outlook's
// takes off only the categories that have a color, from Outlook's latest list. series: "This and following" or
// "All events". Google's stored series master is not kept up to date (the sync reads single events), so then nothing is
// compared with stored data and the fields are always sent.
function colorChange(db: Db, calendarId: number, key: unknown, record: EventRecord | null, series = false): EventChange {
  const calendar = listCalendars(db).find((c) => c.id === calendarId)
  check(!!calendar && calendar.colors.length > 0 && (key === null || calendar.colors.some((c) => c.key === key)))
  const color = key as string | null
  if (getCalendarAccount(db, calendarId)!.provider === 'outlook') {
    return { categories: { first: color, remove: color === null ? calendar!.colors.map((c) => c.key) : [] } }
  }
  // The key passed the check above, so it is a label unless it is a classic id: label ids are long, never '1'-'11'.
  if (color !== null && GOOGLE_COLORS[color] === undefined) return !series && record?.eventLabelId === color ? {} : { label: color }
  // A classic color id or Default: the label comes off too, as it would win over the id.
  if (series) return { label: '', colorId: color }
  const change: EventChange = record?.eventLabelId ? { label: '' } : {}
  if (record?.eventLabelId || (record?.colorId ?? null) !== color) change.colorId = color
  return change
}

// onAccountRemoved: the tray drops the account's sign-in item; no sync runs to tell it. showEvent: brings up the main
// window, on the event if it still exists.
export function createApi(
  db: Db,
  scheduler: SyncScheduler,
  reminders: ReminderScheduler,
  onAccountRemoved: () => void,
  showEvent: (event: CalendarEvent | null) => void
): Api {
  return {
    listAccounts: async () => listAccounts(db),
    listCalendars: async () => listCalendars(db),
    listEvents: async (range) => {
      check(Number.isSafeInteger(range?.start) && Number.isSafeInteger(range?.end))
      check(range.end > range.start && range.end - range.start <= MAX_RANGE)
      return listEventsInRange(db, range)
    },
    searchEvents: async (text) => {
      check(typeof text === 'string' && text.length <= MAX_SEARCH && text.trim() !== '')
      return searchEvents(db, text, Date.now(), MAX_RESULTS)
    },
    getEventDetails: async (eventId) => {
      check(Number.isSafeInteger(eventId))
      return getEventDetails(db, eventId)
    },
    getSeries: async (eventId) => {
      check(Number.isSafeInteger(eventId))
      return getSeries(db, eventId)
    },
    listPeople: async (accountId) => {
      check(Number.isSafeInteger(accountId))
      const account = getAccount(db, accountId)
      check(account !== null)
      return listPeople(db, accountId, account!.email)
    },
    setCalendarVisible: async (calendarId, visible) => {
      check(Number.isSafeInteger(calendarId) && typeof visible === 'boolean')
      setCalendarVisible(db, calendarId, visible)
      notifyDataChanged({ accounts: false, calendars: true, events: true, reminders: false, settings: false })
    },
    addOutlookAccount: async (accountId) => {
      check(accountId === undefined || Number.isSafeInteger(accountId))
      const existing = accountId === undefined ? null : getAccount(db, accountId)
      check(accountId === undefined || existing?.provider === 'outlook')
      // Signing in again reuses the account's partition. A new account gets its own.
      const { partition, token } = await signInOutlook(existing?.session ?? newOutlookPartition(), !existing?.session)
      if (existing && token.upn !== existing.email) {
        await forgetOutlookSession(partition)
        throw new Error(`You signed in as ${token.upn}. Sign in as ${existing.email}, or add ${token.upn} as a new account.`)
      }
      // The same account added again moves to the new partition, so drop the old one.
      const old = findAccount(db, 'outlook', token.upn)?.session
      upsertAccount(db, 'outlook', token.upn, null, Date.now(), partition)
      if (old && old !== partition) await forgetOutlookSession(old)
      notifyDataChanged(ALL)
      // Not awaited: the sign-in is done, and the sidebar must stop offering "Start over" now.
      void scheduler.syncNow()
    },
    addGoogleAccount: async () => {
      await addGoogle(db)
      notifyDataChanged(ALL)
      await scheduler.syncNow()
    },
    removeAccount: async (accountId) => {
      check(Number.isSafeInteger(accountId))
      const account = getAccount(db, accountId)
      check(account !== null)
      if (account!.provider === 'google') await forgetGoogle(accountId, account!.secret)
      deleteAccount(db, accountId)
      onAccountRemoved()
      if (account!.session) {
        // Sign out of Outlook on the web too, including the saved session cookies.
        await forgetOutlookSession(account!.session)
      }
      notifyDataChanged(ALL)
    },
    syncNow: () => scheduler.syncNow(),
    createEvent: async (input, notify) => {
      check(typeof input === 'object' && input !== null && Number.isSafeInteger(input.calendarId))
      check(notify === undefined || typeof notify === 'boolean')
      const { calendarId, title, start, end, allDay, startDate, endDate, location, description, conference, timeZone, endTimeZone } = input
      const wanted = input.reminders === undefined ? undefined : cleanReminders(input.reminders, allDay === true)
      const clean: EventInput = { calendarId, title, start, end, allDay, startDate, endDate, location, description, reminders: wanted }
      checkEvent(clean)
      // A missing calendar fails in createEvent, with its own message.
      const calendar = getCalendarAccount(db, calendarId)
      if (input.guests !== undefined) clean.guests = cleanGuests(input.guests, [calendar?.email.toLowerCase() ?? ''], isEmail)
      for (const key of GUEST_FLAGS) {
        if (input[key] === undefined) continue
        check(typeof input[key] === 'boolean' && calendar?.provider === 'google')
        clean[key] = input[key]
      }
      if (conference !== undefined) {
        check(typeof conference === 'boolean' && (!conference || !!calendar?.conference))
        clean.conference = conference
      }
      if (timeZone !== undefined || endTimeZone !== undefined) {
        check(isZone(timeZone) && (endTimeZone === undefined || isZone(endTimeZone)) && !allDay)
        clean.timeZone = timeZone
        clean.endTimeZone = endTimeZone ?? timeZone
      }
      if (input.repeat !== undefined) {
        // Google needs a zone for a timed series, and Outlook must not get UTC for one, so the dialog always sends it.
        check(allDay || clean.timeZone !== undefined)
        clean.repeat = cleanRepeat(input.repeat, dayOf(clean, clean.timeZone ?? 'UTC').date)
      }
      const color = input.colorKey === undefined ? {} : colorChange(db, calendarId, input.colorKey, null)
      const event = await createEvent(db, clean, notify, color).finally(() => {
        notifyDataChanged(EVENTS)
        // Fills in what the create answer lacks, e.g. Google's default reminder. Also on failure: a write counted
        // before an error makes a running sync skip.
        void scheduler.syncNow()
      })
      if (wanted) reminders.check()
      return event
    },
    updateEvent: async (eventId, patch, options = {}) => {
      check(Number.isSafeInteger(eventId) && typeof patch === 'object' && patch !== null && typeof options === 'object' && options !== null)
      const { notify } = options
      check(notify === undefined || typeof notify === 'boolean')
      const current = getEvent(db, eventId)
      // A sync can remove it while a drag's Undo or the send-updates question waits.
      if (current === null) throw new Error('This event no longer exists.')
      // A canceled meeting can only be removed. A sync can cancel it while the edit dialog is open, so say why.
      if (current.cancelled) throw new Error('This event was canceled.')
      const scope = checkScope(options.scope, current)
      const next = { ...current, ...patch }
      checkEvent(next)
      // Send only what changed. Times always go together.
      const change: EventChange = {}
      if (next.title !== current.title) change.title = next.title
      if (next.location !== current.location) change.location = next.location
      if (next.description !== current.description) change.description = next.description
      if (TIME_KEYS.some((k) => next[k] !== current[k])) change.times = next
      // A picked zone keeps the wall time, so it travels with the times, also when the moment did not change.
      if (patch.timeZone !== undefined || patch.endTimeZone !== undefined) {
        check(isZone(patch.timeZone) && (patch.endTimeZone === undefined || isZone(patch.endTimeZone)) && !next.allDay)
        change.times = next
        change.timeZone = patch.timeZone
        change.endTimeZone = patch.endTimeZone ?? patch.timeZone
      }
      if (change.times && !canChangeTime(current)) throw new Error('Only the organizer can change the time.')
      if (patch.guests !== undefined || GUEST_FLAGS.some((k) => patch[k] !== undefined) || patch.conference !== undefined) {
        if (!current.isOrganizer) throw new Error('Only the organizer can change the guests.')
        const record = getRecord(db, current.calendarId, current.remoteId)!
        const calendar = getCalendarAccount(db, current.calendarId)!
        // The dialog sends its own edit, not the whole list: the stored list may be older or newer than the one it showed.
        if (patch.guests !== undefined) {
          const own = [calendar.email, record.organizerEmail ?? ''].filter((email) => email !== '').map((email) => email.toLowerCase())
          const edit = cleanGuestEdit(patch.guests, own)
          if (edit.add.length + edit.set.length + edit.remove.length > 0) change.guests = edit
        }
        for (const key of GUEST_FLAGS) {
          if (patch[key] === undefined) continue
          check(typeof patch[key] === 'boolean' && calendar.provider === 'google')
          if (patch[key] !== record[key]) change[key] = patch[key]
        }
        if (patch.conference !== undefined) {
          check(typeof patch.conference === 'boolean' && (patch.conference ? calendar.conference !== null : calendar.provider === 'google'))
          // A link in the text is not a call the provider can remove: saying "saved" would be wrong.
          if (!patch.conference && current.joinUrl !== null && !hasOwnCall(current)) {
            throw new Error('This video call link is in the description or location. Remove it there.')
          }
          // Added only to an event without a link, removed only from one with a link.
          if (patch.conference === (current.joinUrl === null)) change.conference = patch.conference
        }
      }
      if (patch.repeat !== undefined) {
        // A new rule is for this and later events, or all of them. Never null ("Does not repeat"): Google would delete
        // every other event of the series, past ones too.
        check(scope !== 'event')
        const zone = change.timeZone ?? getEventDetails(db, eventId)!.timeZone ?? 'UTC'
        change.repeat = cleanRepeat(patch.repeat, dayOf(next, zone).date)
      }
      if (patch.colorKey !== undefined) {
        const record = getRecord(db, current.calendarId, current.remoteId)
        Object.assign(change, colorChange(db, current.calendarId, patch.colorKey, record, scope !== 'event'))
      }
      // Reminders and colors alone never split a series: the new one would invite every guest again.
      check(scope !== 'following' || Object.keys(change).some((k) => !OWN_KEYS.includes(k)))
      // After the other keys, so the flag alone never makes a provider call.
      if (notify === false && Object.keys(change).length > 0) change.notify = false
      const wanted = patch.reminders === undefined ? undefined : cleanReminders(patch.reminders, next.allDay === true)
      const accountId = getCalendarAccount(db, current.calendarId)!.accountId
      let synced: Promise<void> | undefined
      const event = await updateEvent(db, eventId, change, wanted, scope).finally(() => {
        notifyDataChanged(EVENTS)
        // Also on failure: a conflict stores the server's version, which makes a running sync skip. A series write waits
        // for this account's sync below, so it starts that one and not a run that may take the account too soon.
        if (scope === 'event') void scheduler.syncNow()
        else synced = scheduler.syncAccount(accountId)
      })
      if (wanted) reminders.check()
      if (scope === 'event') return event
      // Google gives every event new ids after a series time change, and a split ends this one, so the rows come from the
      // sync of this account. null: the event has another id now.
      await Promise.race([synced, new Promise((resolve) => setTimeout(resolve, SERIES_WAIT_MS))])
      return getEvent(db, eventId)
    },
    deleteEvent: async (eventId, options = {}) => {
      check(Number.isSafeInteger(eventId) && typeof options === 'object' && options !== null)
      const { notify } = options
      check(notify === undefined || typeof notify === 'boolean')
      const current = getEvent(db, eventId)
      if (current === null) throw new Error('This event no longer exists.')
      await deleteEvent(db, eventId, notify, checkScope(options.scope, current)).finally(() => {
        notifyDataChanged(EVENTS)
        // Also on failure: a write counted before an error makes a running sync skip.
        void scheduler.syncNow()
      })
    },
    respondEvent: async (eventId, answer, scope) => {
      check(Number.isSafeInteger(eventId) && (answer === 'accepted' || answer === 'declined' || answer === 'tentative'))
      check(scope === 'event' || scope === 'series')
      const current = getEvent(db, eventId)
      // A sync can remove or cancel the meeting while the popover or the Undo toast is open, so say why.
      if (current === null) throw new Error('This event no longer exists.')
      if (current.cancelled) throw new Error('This event was canceled.')
      check(isInvite(current) && (scope === 'event' || current.seriesRemoteId !== null))
      await respondEvent(db, eventId, answer, scope).finally(() => {
        notifyDataChanged(EVENTS)
        // Brings a series answer, and also runs on failure: a write counted before an error makes a running sync skip.
        void scheduler.syncNow()
      })
      // A declined meeting stops ringing now, not at the next check.
      reminders.check()
    },
    openLink: async (url) => {
      check(typeof url === 'string')
      openExternal(url)
    },
    copyText: async (text) => {
      // A meeting link: a long string is not one.
      check(typeof text === 'string' && text.length <= 2000)
      clipboard.writeText(text)
    },
    listReminders: async () => reminders.list(),
    answerReminder: async (eventId, action, fireAt, snooze) => {
      check(Number.isSafeInteger(eventId) && (action === 'join' || action === 'snooze' || action === 'dismiss'))
      check(Number.isSafeInteger(fireAt))
      check(snooze === undefined || (action === 'snooze' && SNOOZE_CHOICES.includes(snooze)))
      reminders.answer(eventId, action, fireAt, snooze)
    },
    dismissReminders: async (shown) => {
      check(Array.isArray(shown) && shown.length <= MAX_DISMISS)
      const clean = shown.map((r) => {
        check(typeof r === 'object' && r !== null && Number.isSafeInteger(r.eventId) && Number.isSafeInteger(r.fireAt))
        return { eventId: r.eventId, fireAt: r.fireAt }
      })
      reminders.dismiss(clean)
    },
    showEvent: async (eventId) => {
      check(Number.isSafeInteger(eventId))
      showEvent(getEvent(db, eventId))
    },
    getSettings: async () => getSettings(db),
    saveSettings: async (settings) => {
      check(typeof settings === 'object' && settings !== null)
      const { hour12, weekStart, showWeekends, eventMinutes, showDeclined, theme, secondaryTimeZone, secondaryTimeZoneLabel } = settings
      check(hour12 === null || typeof hour12 === 'boolean')
      check(weekStart === null || WEEK_STARTS.includes(weekStart))
      check(typeof showWeekends === 'boolean' && typeof showDeclined === 'boolean')
      check(EVENT_MINUTES.includes(eventMinutes))
      check(theme === 'system' || theme === 'light' || theme === 'dark')
      check(secondaryTimeZone === null || isZone(secondaryTimeZone))
      check(typeof secondaryTimeZoneLabel === 'string' && secondaryTimeZoneLabel.length <= MAX_ZONE_LABEL)
      const meetingReminders = cleanReminders(settings.meetingReminders)
      const eventReminders = cleanReminders(settings.eventReminders)
      const allDayReminders = cleanReminders(settings.allDayReminders, true)
      saveSettings(db, {
        meetingReminders,
        eventReminders,
        allDayReminders,
        hour12,
        weekStart,
        showWeekends,
        eventMinutes,
        showDeclined,
        theme,
        secondaryTimeZone,
        secondaryTimeZoneLabel
      })
      // Every window follows at once, reminder windows too.
      nativeTheme.themeSource = theme
      notifyDataChanged({ accounts: false, calendars: false, events: true, reminders: false, settings: true })
      reminders.check()
    }
  }
}
