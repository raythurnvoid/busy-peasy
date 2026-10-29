import type { Response, ShowAs } from '../../../shared/api'
import type { EventKind, EventRecord } from '../../db/events'
import { htmlToText } from '../google/map'
import { findJoinUrl } from '../join-url'

// The fields we read from an Outlook REST (beta) event. Requests use Prefer: outlook.timezone="UTC".
export interface OutlookEvent {
  Id: string
  Type?: 'SingleInstance' | 'Occurrence' | 'Exception' | 'SeriesMaster'
  SeriesMasterId?: string | null
  iCalUId?: string
  ChangeKey?: string
  Subject?: string | null
  Start: { DateTime: string; TimeZone: string }
  End: { DateTime: string; TimeZone: string }
  IsAllDay?: boolean
  OriginalStartTimeZone?: string
  OriginalEndTimeZone?: string
  Location?: { DisplayName?: string }
  OnlineMeeting?: { JoinUrl?: string } | null
  OnlineMeetingUrl?: string | null
  IsOnlineMeeting?: boolean
  BodyPreview?: string
  Body?: { ContentType?: string; Content?: string }
  ShowAs?: string
  ResponseStatus?: { Response?: string }
  IsOrganizer?: boolean
  Attendees?: { Type?: string; Status?: { Response?: string }; EmailAddress?: OutlookAddress }[]
  Organizer?: { EmailAddress?: OutlookAddress }
  ResponseRequested?: boolean
  HideAttendees?: boolean
  IsCancelled?: boolean
  IsReminderOn?: boolean
  ReminderMinutesBeforeStart?: number
  Categories?: string[]
  // Only on series masters.
  Recurrence?: unknown
  // With a zone mark, unlike Start.
  OriginalStart?: string
  WebLink?: string
}

interface OutlookAddress {
  Name?: string
  Address?: string
}

// Delta entry for an event that was deleted or left the window.
export interface OutlookRemoved {
  id?: string
  Id?: string
  reason?: string
  '@removed'?: unknown
}

const KINDS: Record<string, EventKind> = {
  SingleInstance: 'single',
  Occurrence: 'occurrence',
  Exception: 'exception',
  SeriesMaster: 'master'
}

const SHOW_AS: Record<string, ShowAs> = {
  Free: 'free',
  Tentative: 'tentative',
  Busy: 'busy',
  Oof: 'oof',
  WorkingElsewhere: 'workingElsewhere'
}

const RESPONSES: Record<string, Response> = {
  Organizer: 'organizer',
  Accepted: 'accepted',
  TentativelyAccepted: 'tentative',
  Declined: 'declined'
}

export function isRemoved(item: object): item is OutlookRemoved {
  return 'reason' in item || '@removed' in item
}

// Removal ids come wrapped, like CalendarView('AQMk...'). Returns the plain event id.
export function removedId(item: OutlookRemoved): string {
  const id = item.id ?? item.Id ?? ''
  const wrapped = id.match(/^\w+\('(.*)'\)$/)
  return wrapped ? wrapped[1].replace(/''/g, "'") : id
}

// Outlook sends "2026-10-27T09:45:00.0000000" with no zone mark. With outlook.timezone="UTC" it is UTC.
// Not in the answer to a write that sends times: that comes in the sent zone, see answer() in write.ts.
export function parseUtc(dateTime: string): number {
  const ms = Date.parse(dateTime.slice(0, 19) + 'Z')
  if (Number.isNaN(ms)) throw new Error('Bad Outlook date: ' + dateTime)
  return ms
}

// me: the user's address, for one event of a series. Its ResponseStatus is the last answer given to any event of the
// series (seen live); the user's own row in Attendees has the answer for this one, like Outlook web shows.
export function toRecord(e: OutlookEvent, me?: string): EventRecord {
  const allDay = e.IsAllDay === true
  const isOrganizer = e.IsOrganizer === true
  const organizer = e.Organizer?.EmailAddress
  const own = me && e.Attendees?.find((a) => a.EmailAddress?.Address?.toLowerCase() === me.toLowerCase())?.Status?.Response
  const html = e.Body?.ContentType === 'HTML'
  // The style block in <head> is not text. Line breaks in the HTML source are only spaces, so they go before
  // htmlToText turns tags into breaks. Then at most one empty line in a row.
  const body =
    (html
      ? htmlToText(
          (e.Body?.Content ?? '').replace(/<head\b[\s\S]*?<\/head>/gi, '').replace(/\s+/g, ' ')
        )
          .replace(/ *\n */g, '\n')
          .replace(/\n{3,}/g, '\n\n')
      : e.Body?.Content) || null
  return {
    remoteId: e.Id,
    kind: KINDS[e.Type ?? 'SingleInstance'] ?? 'single',
    seriesRemoteId: e.SeriesMasterId ?? null,
    icalUid: e.iCalUId ?? null,
    version: e.ChangeKey ?? null,
    title: e.Subject ?? '',
    start: parseUtc(e.Start.DateTime),
    end: parseUtc(e.End.DateTime),
    allDay,
    // All-day events are midnight to midnight in UTC here, so the date part is the calendar date.
    startDate: allDay ? e.Start.DateTime.slice(0, 10) : null,
    endDate: allDay ? e.End.DateTime.slice(0, 10) : null,
    startTz: e.OriginalStartTimeZone ?? null,
    endTz: e.OriginalEndTimeZone ?? null,
    location: e.Location?.DisplayName ?? '',
    joinUrl: e.OnlineMeeting?.JoinUrl || e.OnlineMeetingUrl || findJoinUrl(e.Location?.DisplayName, e.Body?.Content),
    description: e.BodyPreview ?? '',
    showAs: SHOW_AS[e.ShowAs ?? ''] ?? 'unknown',
    response: isOrganizer ? 'organizer' : (RESPONSES[(own || e.ResponseStatus?.Response) ?? ''] ?? 'none'),
    isOrganizer,
    attendeeCount: e.Attendees?.length ?? 0,
    cancelled: e.IsCancelled === true,
    // Outlook has one reminder per event.
    reminders: e.IsReminderOn && e.ReminderMinutesBeforeStart !== undefined ? [e.ReminderMinutesBeforeStart] : [],
    // Undefined flags and names are left out of the stored JSON.
    attendees: (e.Attendees ?? []).map((a) => {
      const address = a.EmailAddress?.Address ?? ''
      const isHost = address !== '' && address.toLowerCase() === organizer?.Address?.toLowerCase()
      const response = RESPONSES[a.Status?.Response ?? ''] ?? 'none'
      return {
        email: address,
        name: a.EmailAddress?.Name || undefined,
        // Google shows the organizer as attending; Outlook often says "None" for them.
        response: response === 'organizer' || (isHost && response === 'none') ? 'accepted' : response,
        optional: a.Type === 'Optional' || undefined,
        organizer: isHost || undefined,
        resource: a.Type === 'Resource' || undefined
      }
    }),
    organizerEmail: organizer?.Address || null,
    organizerName: organizer?.Name || null,
    // The organizer still sees a hidden list.
    attendeesOmitted: e.HideAttendees === true && !isOrganizer,
    responseRequested: e.ResponseRequested ?? null,
    guestsCanModify: null,
    guestsCanInviteOthers: null,
    guestsCanSeeOtherGuests: null,
    privateCopy: false,
    colorId: null,
    eventLabelId: null,
    categories: e.Categories ?? [],
    originalStart: e.OriginalStart ? Date.parse(e.OriginalStart) : null,
    recurrence: e.Type === 'SeriesMaster' && e.Recurrence ? JSON.stringify(e.Recurrence) : null,
    body,
    webLink: e.WebLink ?? null
  }
}
