import type { Guest, ShowAs } from '../../../shared/api'
import type { EventRecord } from '../../db/events'
import { findJoinUrl } from '../join-url'

// The fields we read from a Google Calendar event (events.list with singleEvents=true).
export interface GoogleEvent {
  id: string
  status?: 'confirmed' | 'tentative' | 'cancelled'
  summary?: string
  description?: string
  location?: string
  start?: { date?: string; dateTime?: string; timeZone?: string }
  end?: { date?: string; dateTime?: string; timeZone?: string }
  recurringEventId?: string
  iCalUID?: string
  etag?: string
  transparency?: 'opaque' | 'transparent'
  eventType?: string
  hangoutLink?: string
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] }
  organizer?: { self?: boolean; email?: string; displayName?: string }
  attendees?: {
    email?: string
    displayName?: string
    self?: boolean
    organizer?: boolean
    optional?: boolean
    resource?: boolean
    responseStatus?: string
  }[]
  attendeesOmitted?: boolean
  // Google leaves these out when they have the default value.
  guestsCanModify?: boolean
  guestsCanInviteOthers?: boolean
  guestsCanSeeOtherGuests?: boolean
  privateCopy?: boolean
  colorId?: string
  eventLabelId?: string
  originalStartTime?: { date?: string; dateTime?: string }
  // Only on series masters, which only come back from writes.
  recurrence?: string[]
  htmlLink?: string
  reminders?: { useDefault?: boolean; overrides?: GoogleReminder[] }
}

export interface GoogleReminder {
  method?: string
  minutes?: number
}

const RESPONSES: Record<string, Guest['response']> = {
  accepted: 'accepted',
  tentative: 'tentative',
  declined: 'declined'
}

export function toRecord(e: GoogleEvent): EventRecord {
  const allDay = e.start?.date !== undefined
  const self = e.attendees?.find((a) => a.self)
  // No attendees means the user's own event.
  const isOrganizer = e.organizer?.self === true || !e.attendees?.length
  return {
    remoteId: e.id,
    kind: e.recurringEventId ? 'occurrence' : e.recurrence ? 'master' : 'single',
    seriesRemoteId: e.recurringEventId ?? null,
    icalUid: e.iCalUID ?? null,
    version: e.etag ?? null,
    title: e.summary ?? '',
    start: allDay ? Date.parse(e.start!.date! + 'T00:00:00Z') : Date.parse(e.start!.dateTime!),
    end: allDay ? Date.parse(e.end!.date! + 'T00:00:00Z') : Date.parse(e.end!.dateTime!),
    allDay,
    startDate: allDay ? e.start!.date! : null,
    endDate: allDay ? e.end!.date! : null,
    startTz: e.start?.timeZone ?? null,
    endTz: e.end?.timeZone ?? null,
    location: e.location ?? '',
    joinUrl:
      e.hangoutLink ??
      e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ??
      findJoinUrl(e.location, e.description),
    description: htmlToText(e.description ?? ''),
    showAs:
      e.transparency === 'transparent' ? 'free' : e.eventType === 'outOfOffice' ? 'oof' : e.status === 'tentative' ? 'tentative' : ('busy' as ShowAs),
    response: isOrganizer ? 'organizer' : (RESPONSES[self?.responseStatus ?? ''] ?? 'none'),
    isOrganizer,
    attendeeCount: e.attendees?.length ?? 0,
    cancelled: e.status === 'cancelled',
    // useDefault: the calendar's default reminders apply. Email reminders are not ours to show.
    reminders: e.reminders?.useDefault !== false ? null : popups(e.reminders.overrides),
    // Undefined flags and names are left out of the stored JSON.
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.email ?? '',
      name: a.displayName || undefined,
      response: RESPONSES[a.responseStatus ?? ''] ?? 'none',
      optional: a.optional || undefined,
      organizer: a.organizer || undefined,
      self: a.self || undefined,
      resource: a.resource || undefined
    })),
    organizerEmail: e.organizer?.email ?? null,
    organizerName: e.organizer?.displayName ?? null,
    attendeesOmitted: e.attendeesOmitted === true,
    responseRequested: null,
    guestsCanModify: e.guestsCanModify ?? false,
    guestsCanInviteOthers: e.guestsCanInviteOthers ?? true,
    guestsCanSeeOtherGuests: e.guestsCanSeeOtherGuests ?? true,
    privateCopy: e.privateCopy === true,
    colorId: e.colorId ?? null,
    eventLabelId: e.eventLabelId ?? null,
    categories: [],
    originalStart: e.originalStartTime
      ? Date.parse(e.originalStartTime.dateTime ?? e.originalStartTime.date + 'T00:00:00Z')
      : null,
    // Not kept: the sync never sees masters (singleEvents=true), so only kind uses it.
    recurrence: null,
    body: null,
    webLink: e.htmlLink ?? null
  }
}

export function popups(reminders: GoogleReminder[] | undefined): number[] {
  return (reminders ?? []).filter((r) => r.method === 'popup').map((r) => r.minutes ?? 0)
}

// Google descriptions may hold simple HTML. We only ever show text.
// Numeric entities too (&#43; in dial-in numbers); the digit limits keep the code point valid.
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d{1,6});/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]{1,5});/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .trim()
}
