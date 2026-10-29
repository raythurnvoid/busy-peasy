import type { Account, Answer, Calendar, CalendarEvent, Guest } from './api'

// Someone else's meeting that is still on: the user can answer it (Yes / No / Maybe).
export function isInvite(e: Pick<CalendarEvent, 'isOrganizer' | 'attendeeCount' | 'cancelled'>): boolean {
  return !e.isOrganizer && e.attendeeCount > 0 && !e.cancelled
}

// The main Google calendar synced with a sign-in from before the labels scope: it has the classic colors only, and the
// menu, the dialog and the sidebar say "Sign in again to see all event colors." Not while the account already
// asks for a sign-in or shows an error.
export function labelsHint(
  calendar: Pick<Calendar, 'isPrimary' | 'canEdit' | 'labelsRead'>,
  account: Pick<Account, 'provider' | 'status' | 'lastSyncAt'> | undefined
): boolean {
  const working = account?.status === 'ok' || account?.status === 'syncing'
  return account?.provider === 'google' && working && account.lastSyncAt !== null && calendar.isPrimary && calendar.canEdit && !calendar.labelsRead
}

// People to tell about a change: not the user, the organizer or rooms.
export function hasGuests(guests: Pick<Guest, 'self' | 'organizer' | 'resource'>[]): boolean {
  return guests.some((g) => !g.self && !g.organizer && !g.resource)
}

// A new event's guests after its calendar changed: the new account organizes it, so it is no guest.
export function withoutOwn<T extends { email: string }>(guests: T[], own: string[]): T[] {
  return guests.filter((g) => !own.includes(g.email.toLowerCase()))
}

// Google's limit per event.
export const MAX_GUESTS = 200

// The guest permissions, with Google's names.
export const GUEST_FLAGS = ['guestsCanModify', 'guestsCanInviteOthers', 'guestsCanSeeOtherGuests'] as const

// The fields the app shows and edits, and guests see. A change to one of them elsewhere is a conflict; a change by the
// organizer is an update for the guests. For all-day events, start and end hold the dates.
export const SHOWN = ['title', 'start', 'end', 'allDay', 'location', 'description'] as const

// A plain address, as the guest field takes it. No spaces, brackets or list marks.
export function isEmail(text: string): boolean {
  return text.length <= 254 && /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(text)
}

// Not a person to invite: Google's group, holiday and room calendars, and booking pages with a made-up address
// (g and 32 hex digits). Such addresses organize events but are never suggested.
export function isPerson(email: string): boolean {
  return !/\.calendar\.google\.com$/i.test(email) && !/^g[0-9a-f]{32}@/i.test(email)
}

// Reads what people type or paste into the guest field: "a@b.c, d@e.f; Name <g@h.i>; Last, First <j@k.l>".
// invalid: the other parts.
export function parseGuests(text: string): { emails: string[]; invalid: string[] } {
  const parts = text
    .replace(/"[^"]*"/g, ' ')
    // The words of a name before <email> are not addresses. A word starts after a space or a list mark, and may end
    // with a comma, as in Outlook's "Last, First".
    .replace(/(?<=^|[\s,;])(?:[^\s,;<>@]+,?\s*)*<([^<>]*)>/g, ' $1 ')
    .split(/[\s,;]+/)
    .filter((part) => part !== '')
  return { emails: parts.filter(isEmail), invalid: parts.filter((part) => !isEmail(part)) }
}

// The suggestion Enter takes in the guest field, or -1 for the text as typed. A row the user moved to with the arrow
// keys wins; else an address typed in full (a known longer address must not win); else the first row.
export function pickedSuggestion(text: string, count: number, active: number, moved: boolean): number {
  return count > 0 && (moved || !isEmail(text.trim())) ? active : -1
}

// The event's own video call (Meet, Teams), not a link found in its location or description. Only this one can be
// removed.
export function hasOwnCall(e: Pick<CalendarEvent, 'joinUrl' | 'location' | 'description'>): boolean {
  return e.joinUrl !== null && !e.location.includes(e.joinUrl) && !e.description.includes(e.joinUrl)
}

// An invite the user has not answered yet. Views outline it, like Google.
export function needsRsvp(e: Pick<CalendarEvent, 'response' | 'attendeeCount' | 'cancelled'>): boolean {
  return !e.cancelled && e.response === 'none' && e.attendeeCount > 0
}

// Strike, outline and stripes are not read, so the name says the answer, like Google.
function answerName(e: Pick<CalendarEvent, 'response' | 'attendeeCount' | 'cancelled' | 'isOrganizer'>): string {
  if (e.cancelled) return 'Canceled'
  if (e.response === 'declined') return 'Declined'
  if (e.response === 'tentative') return 'Tentative'
  if (e.response === 'accepted' && isInvite(e)) return 'Accepted'
  return needsRsvp(e) ? 'Needs RSVP' : ''
}

// An event's name for screen readers, in Google's order: "10:00 to 11:00, Standup, Work, Needs RSVP, Location: Room 1,
// colour: Cobalt, 28 October 2026". time and date: already formatted (shared code has no formats).
export function eventName(e: CalendarEvent, calendar: Calendar | undefined, time: string, date: string): string {
  const colour = e.colorKey && calendar?.colors.find((c) => c.key === e.colorKey)?.name
  return [time, e.title || '(No title)', calendar?.name, answerName(e), e.location ? `Location: ${e.location}` : 'No location', colour && `colour: ${colour}`, date]
    .filter(Boolean)
    .join(', ')
}

// Only the organizer changes the time of a meeting, unless Google lets the guests change it.
export function canChangeTime(e: Pick<CalendarEvent, 'isOrganizer' | 'attendeeCount' | 'cancelled' | 'guestsCanModify'>): boolean {
  return !isInvite(e) || e.guestsCanModify
}

// The user's own repeating event: a change or delete can take "This and following" or "All events". Invites change
// one event only, like Google. main checks the organizer again on the series itself.
export function isOwnSeries(e: Pick<CalendarEvent, 'seriesRemoteId' | 'isOrganizer' | 'attendeeCount' | 'cancelled'>): boolean {
  return e.seriesRemoteId !== null && e.isOrganizer && !isInvite(e)
}

// Google's words for each answer, in Google's order.
export const ANSWER_LABELS: Record<Answer, string> = { accepted: 'Yes', declined: 'No', tentative: 'Maybe' }
