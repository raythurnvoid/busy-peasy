import { createHash } from 'node:crypto'
import type { GuestEdit, Repeat, Times } from '../../shared/api'
import { countBefore, dayOf, moveRepeat, scopeChoices, seriesTimes, type First } from '../../shared/repeat'
import type { EventRecord } from '../db/events'

// Only the fields the user changed. Times always travel together. notify is a send option, not a field.
export interface EventChange {
  title?: string
  location?: string
  description?: string
  times?: Times
  // IANA names the user picked: both, or none. Only together with times.
  timeZone?: string
  endTimeZone?: string
  // Minutes, earliest first. The provider keeps what it can (Outlook one, Google five); the answer says what it kept.
  reminders?: number[]
  // Applied to the provider's latest list.
  guests?: GuestEdit
  // Google only.
  guestsCanModify?: boolean
  guestsCanInviteOthers?: boolean
  guestsCanSeeOtherGuests?: boolean
  // true: add the calendar's video call. false: remove it (Google only).
  conference?: boolean
  // false: do not email guests about this change. Google only; Outlook always emails them.
  notify?: boolean
  // A new rule, for "This and following" or "All events" only.
  repeat?: Repeat
  // Google: the label id; '' takes it off. Sent with eventLabelVersion=1, and then Google ignores colorId.
  label?: string
  // Google's classic color id. null takes it off.
  colorId?: string | null
  // Outlook: first becomes the first category (the one the app shows); remove: categories to take off. Others stay.
  categories?: { first: string | null; remove: string[] }
}

// The user's own keys: reminders and colors. A change of only these never splits a series.
export const OWN_KEYS = ['reminders', 'notify', 'label', 'colorId', 'categories']

// The event changed on the server since we last synced. Carries the latest version so the caller can store it.
export class ConflictError extends Error {
  constructor(readonly latest: EventRecord) {
    super('This event was changed somewhere else. The latest version is shown now; please try again.')
  }
}

// The id of the new series a split makes: the same for the same series and cut, so a retry (a sign-in renew, a quit,
// offline) finds that series instead of making another one. Google takes 0-9 and a-v.
export function splitId(seriesRemoteId: string, cut: number): string {
  return createHash('sha256').update(`${seriesRemoteId}|${cut}`).digest('hex').slice(0, 32)
}

// "Some events may show twice: Standup from 8 December 2026", naming the new copy to delete. app: where. The
// old series may be cut already, so the copy is deleted only if the events really show twice.
export function twice(title: string, start: number, zone: string, app: string): string {
  const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: zone }).format(start)
  return `Some events may show twice: ${title || '(No title)'} from ${date}. If they do, delete that copy in ${app}.`
}

// What a series write does, from fresh copies of the series (master) and the event. A scope Google would not offer for
// them (the series changed since the question, say) is a conflict. weekStart: the rule's week start, for COUNT.
export function seriesPlan(o: {
  master: Times
  zone: string
  repeat: Repeat | null
  weekStart: number
  instance: EventRecord
  change: EventChange
  scope: 'following' | 'series'
}): { times: Times; old: First; next: First; rule: Repeat | null; rewrite: boolean; moved: boolean } {
  const { master, zone, repeat, instance, change, scope } = o
  const first = { start: master.start, allDay: master.allDay, zone }
  // Where the rule put the event: a moved event counts as a day change.
  const original = { start: instance.originalStart ?? instance.start, allDay: instance.allDay, zone }
  const newZone = change.timeZone ?? zone
  // No new times: the event's slot in the series, with the series' length, also when it was moved or resized once, so a
  // split does not give the later events that one-off slot.
  const length = master.end - master.start
  const date = (t: number): string | null => (instance.allDay ? new Date(t).toISOString().slice(0, 10) : null)
  const slot = { allDay: instance.allDay, start: original.start, end: original.start + length, startDate: date(original.start), endDate: date(original.start + length) }
  const after = change.times ?? slot
  const from = dayOf(original, zone).date
  const to = dayOf(after, newZone).date
  const ownOnly = Object.keys(change).every((k) => OWN_KEYS.includes(k))
  const choices = scopeChoices({ repeat, firstDate: dayOf(first, zone).date, from, to, rule: change.repeat, ownOnly })
  if (!choices.includes(scope)) throw new ConflictError(instance)
  if (scope === 'series') {
    // All events keep the first date (the first event may move it) and take the event's new wall time.
    const times = change.times ? seriesTimes(master, zone, from, change.times, newZone) : master
    const next = { start: times.start, allDay: times.allDay, zone: newZone }
    const rewrite = change.repeat !== undefined || from !== to || newZone !== zone || times.allDay !== master.allDay
    const rule = change.repeat ?? (repeat && moveRepeat(repeat, from, to))
    return { times, old: first, next, rule, rewrite, moved: times.start !== master.start || newZone !== zone }
  }
  // A split starts at this event. Its COUNT is what is left: COUNT counts deleted events too, so it comes from the rule.
  const next = { start: after.start, allDay: after.allDay, zone: newZone }
  let rule = change.repeat ?? moveRepeat(repeat!, from, to)
  if (!change.repeat && rule?.count) rule = { ...rule, count: Math.max(1, rule.count - countBefore(repeat!, first, from, o.weekStart)) }
  return { times: after, old: original, next, rule, rewrite: true, moved: true }
}
