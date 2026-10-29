import { describe, expect, it } from 'vitest'
import { htmlToText, toRecord, type GoogleEvent } from './map'

function event(extra: Partial<GoogleEvent> = {}): GoogleEvent {
  return {
    id: 'g1',
    status: 'confirmed',
    summary: 'Review',
    start: { dateTime: '2026-10-27T10:00:00+01:00', timeZone: 'Europe/Rome' },
    end: { dateTime: '2026-10-27T11:00:00+01:00', timeZone: 'Europe/Rome' },
    ...extra
  }
}

describe('toRecord', () => {
  it('reads times with their offset', () => {
    expect(toRecord(event())).toMatchObject({ start: Date.UTC(2026, 9, 27, 9), allDay: false, startTz: 'Europe/Rome' })
  })

  it('keeps the end zone, which can differ from the start zone', () => {
    const end = { dateTime: '2026-10-27T06:00:00-04:00', timeZone: 'America/New_York' }
    expect(toRecord(event({ end }))).toMatchObject({ startTz: 'Europe/Rome', endTz: 'America/New_York' })
  })

  it('keeps all-day dates as strings with an exclusive end', () => {
    const r = toRecord(event({ start: { date: '2026-11-18' }, end: { date: '2026-11-19' } }))
    expect(r).toMatchObject({ allDay: true, startDate: '2026-11-18', endDate: '2026-11-19', start: Date.UTC(2026, 10, 18) })
  })

  it('reads the response of the user from the attendee marked self', () => {
    const r = toRecord(
      event({ organizer: { self: false }, attendees: [{ responseStatus: 'accepted' }, { self: true, responseStatus: 'needsAction' }] })
    )
    expect(r).toMatchObject({ response: 'none', isOrganizer: false, attendeeCount: 2 })
  })

  it('treats an event without attendees as the user own event', () => {
    expect(toRecord(event())).toMatchObject({ response: 'organizer', isOrganizer: true })
  })

  it('takes the Meet link, then the conference link, then a link in the text', () => {
    expect(toRecord(event({ hangoutLink: 'https://meet.google.com/abc-defg-hij' })).joinUrl).toBe(
      'https://meet.google.com/abc-defg-hij'
    )
    expect(
      toRecord(event({ conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:1' }, { entryPointType: 'video', uri: 'https://zoom.us/j/1' }] } }))
        .joinUrl
    ).toBe('https://zoom.us/j/1')
    expect(toRecord(event({ description: 'Join: https://teams.microsoft.com/l/meetup-join/x y' })).joinUrl).toBe(
      'https://teams.microsoft.com/l/meetup-join/x'
    )
  })

  it('keeps every popup reminder, or null for the calendar defaults', () => {
    expect(toRecord(event()).reminders).toBeNull()
    const overrides = [{ method: 'popup', minutes: 5 }, { method: 'email', minutes: 60 }, { method: 'popup', minutes: 30 }]
    expect(toRecord(event({ reminders: { useDefault: false, overrides } })).reminders).toEqual([5, 30])
    expect(toRecord(event({ reminders: { useDefault: false } })).reminders).toEqual([])
  })

  it('maps free time and out of office', () => {
    expect(toRecord(event({ transparency: 'transparent' })).showAs).toBe('free')
    expect(toRecord(event({ eventType: 'outOfOffice' })).showAs).toBe('oof')
  })

  it('maps guests and the organizer, leaving out false flags and missing names', () => {
    const r = toRecord(
      event({
        organizer: { email: 'boss@x.com', displayName: 'Boss' },
        attendees: [
          { email: 'boss@x.com', displayName: 'Boss', organizer: true, responseStatus: 'accepted' },
          { email: 'me@x.com', self: true, optional: false, responseStatus: 'needsAction' },
          { email: 'room@resource.calendar.google.com', displayName: 'Room 1', resource: true, responseStatus: 'declined' },
          { email: 'ann@x.com', optional: true, responseStatus: 'tentative' }
        ]
      })
    )
    expect(r.attendees).toEqual([
      { email: 'boss@x.com', name: 'Boss', response: 'accepted', organizer: true },
      { email: 'me@x.com', response: 'none', self: true },
      { email: 'room@resource.calendar.google.com', name: 'Room 1', response: 'declined', resource: true },
      { email: 'ann@x.com', response: 'tentative', optional: true }
    ])
    expect(JSON.stringify(r.attendees[1])).toBe('{"email":"me@x.com","response":"none","self":true}')
    expect(r).toMatchObject({ organizerEmail: 'boss@x.com', organizerName: 'Boss', attendeeCount: 4 })
  })

  it("stores the guest flags with Google's defaults when Google leaves them out", () => {
    expect(toRecord(event())).toMatchObject({ guestsCanModify: false, guestsCanInviteOthers: true, guestsCanSeeOtherGuests: true })
    expect(
      toRecord(event({ guestsCanModify: true, guestsCanInviteOthers: false, guestsCanSeeOtherGuests: false }))
    ).toMatchObject({ guestsCanModify: true, guestsCanInviteOthers: false, guestsCanSeeOtherGuests: false })
  })

  it('reads colors, the original start, the web link and the copy flags', () => {
    const r = toRecord(
      event({
        colorId: '11',
        eventLabelId: 'af0031d5',
        originalStartTime: { dateTime: '2026-10-27T10:00:00+01:00' },
        htmlLink: 'https://www.google.com/calendar/event?eid=abc',
        privateCopy: true,
        attendeesOmitted: true
      })
    )
    expect(r).toMatchObject({
      colorId: '11',
      eventLabelId: 'af0031d5',
      originalStart: Date.UTC(2026, 9, 27, 9),
      webLink: 'https://www.google.com/calendar/event?eid=abc',
      privateCopy: true,
      attendeesOmitted: true,
      categories: [],
      responseRequested: null,
      body: null
    })
    expect(toRecord(event({ originalStartTime: { date: '2026-11-18' } })).originalStart).toBe(Date.UTC(2026, 10, 18))
    expect(toRecord(event())).toMatchObject({ colorId: null, eventLabelId: null, originalStart: null, webLink: null, privateCopy: false })
  })

  it('lists a series (from a write answer) as a master, not as one event', () => {
    expect(toRecord(event({ recurrence: ['RRULE:FREQ=DAILY'] }))).toMatchObject({ kind: 'master', recurrence: null })
  })
})

describe('htmlToText', () => {
  it('drops tags and decodes entities, keeping line breaks', () => {
    expect(htmlToText('<b>Hi</b><br>Tom &amp; Ann<script>x</script> &lt;3')).toBe('Hi\nTom & Annx <3')
  })

  it('decodes numeric entities, but not escaped ones', () => {
    expect(htmlToText('Dial &#43;44, &#x2B;1, it&#39;s &amp;#43;')).toBe("Dial +44, +1, it's &#43;")
  })
})
