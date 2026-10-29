import { describe, expect, it } from 'vitest'
import { parseUtc, removedId, toRecord, type OutlookEvent } from './map'

function event(extra: Partial<OutlookEvent> = {}): OutlookEvent {
  return {
    Id: 'e1',
    Type: 'SingleInstance',
    Subject: 'Standup',
    Start: { DateTime: '2026-10-27T09:45:00.0000000', TimeZone: 'UTC' },
    End: { DateTime: '2026-10-27T10:30:00.0000000', TimeZone: 'UTC' },
    ...extra
  }
}

describe('parseUtc', () => {
  it('reads Outlook times without a zone mark as UTC', () => {
    expect(parseUtc('2026-10-27T09:45:00.0000000')).toBe(Date.UTC(2026, 9, 27, 9, 45))
  })

  it('throws on a bad date instead of storing NaN', () => {
    expect(() => parseUtc('soon')).toThrow('Bad Outlook date')
  })
})

describe('removedId', () => {
  it('unwraps CalendarView(...) ids', () => {
    expect(removedId({ id: "CalendarView('AQMkAD_x-1')", reason: 'deleted' })).toBe('AQMkAD_x-1')
  })

  it('keeps plain ids', () => {
    expect(removedId({ Id: 'AQMkAD', '@removed': { reason: 'deleted' } })).toBe('AQMkAD')
  })
})

describe('toRecord', () => {
  it('keeps both zones the event was made in', () => {
    const r = toRecord(event({ OriginalStartTimeZone: 'W. Europe Standard Time', OriginalEndTimeZone: 'Eastern Standard Time' }))
    expect(r).toMatchObject({ startTz: 'W. Europe Standard Time', endTz: 'Eastern Standard Time' })
  })

  it('keeps the calendar date of all-day events', () => {
    const r = toRecord(
      event({
        IsAllDay: true,
        Start: { DateTime: '2026-11-18T00:00:00.0000000', TimeZone: 'UTC' },
        End: { DateTime: '2026-11-20T00:00:00.0000000', TimeZone: 'UTC' }
      })
    )
    expect(r).toMatchObject({ allDay: true, startDate: '2026-11-18', endDate: '2026-11-20', start: Date.UTC(2026, 10, 18) })
  })

  it('maps a Teams meeting the user accepted', () => {
    const r = toRecord(
      event({
        ShowAs: 'Busy',
        ResponseStatus: { Response: 'Accepted' },
        IsOrganizer: false,
        Attendees: [{}, {}],
        OnlineMeeting: { JoinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
        IsReminderOn: true,
        ReminderMinutesBeforeStart: 15
      })
    )
    expect(r).toMatchObject({
      showAs: 'busy',
      response: 'accepted',
      attendeeCount: 2,
      joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
      reminders: [15],
      kind: 'single'
    })
  })

  it('finds the join link in the HTML body when OnlineMeeting is missing', () => {
    const r = toRecord(event({ Body: { Content: '<a href="https://acme.zoom.us/j/123?pwd=a&amp;b=c">Join</a>' } }))
    expect(r.joinUrl).toBe('https://acme.zoom.us/j/123?pwd=a&b=c')
  })

  // Seen live: after "Maybe" on one event, every event of the series says TentativelyAccepted.
  it("takes the answer of one event of a series from the user's own row", () => {
    const occurrence = (own: string): OutlookEvent =>
      event({
        Type: 'Occurrence',
        ResponseStatus: { Response: 'TentativelyAccepted' },
        Attendees: [{ EmailAddress: { Address: 'Me@Work.com' }, Status: { Response: own } }]
      })
    expect(toRecord(occurrence('None'), 'me@work.com').response).toBe('none')
    expect(toRecord(occurrence('Accepted'), 'me@work.com').response).toBe('accepted')
    // No own row (e.g. invited through a group): the event's own status.
    expect(toRecord(occurrence('None'), 'other@work.com').response).toBe('tentative')
  })

  it('treats the organizer as organizer whatever the response says', () => {
    expect(toRecord(event({ IsOrganizer: true, ResponseStatus: { Response: 'None' } })).response).toBe('organizer')
  })

  it('has no reminder when reminders are off', () => {
    expect(toRecord(event({ IsReminderOn: false, ReminderMinutesBeforeStart: 15 })).reminders).toEqual([])
  })

  it('maps guests: type, answer, and the organizer found by email in any case', () => {
    const r = toRecord(
      event({
        Organizer: { EmailAddress: { Name: 'Boss', Address: 'Boss@X.com' } },
        Attendees: [
          { Type: 'Required', Status: { Response: 'None' }, EmailAddress: { Name: 'Boss', Address: 'boss@x.com' } },
          { Type: 'Optional', Status: { Response: 'TentativelyAccepted' }, EmailAddress: { Name: 'Ann', Address: 'ann@x.com' } },
          { Type: 'Resource', Status: { Response: 'Accepted' }, EmailAddress: { Name: 'Room 1', Address: 'room1@x.com' } },
          { Type: 'Required', Status: { Response: 'Declined' }, EmailAddress: { Address: 'bob@x.com' } },
          { Type: 'Required', Status: { Response: 'NotResponded' }, EmailAddress: { Name: 'Me', Address: 'me@x.com' } }
        ]
      })
    )
    expect(r.attendees).toEqual([
      { email: 'boss@x.com', name: 'Boss', response: 'accepted', organizer: true },
      { email: 'ann@x.com', name: 'Ann', response: 'tentative', optional: true },
      { email: 'room1@x.com', name: 'Room 1', response: 'accepted', resource: true },
      { email: 'bob@x.com', response: 'declined' },
      { email: 'me@x.com', name: 'Me', response: 'none' }
    ])
    expect(r).toMatchObject({ organizerEmail: 'Boss@X.com', organizerName: 'Boss', attendeeCount: 5, guestsCanModify: null })
  })

  it('keeps categories, the web link, the original start, and the rule only on masters', () => {
    const rule = { Pattern: { Type: 'Daily', Interval: 1 }, Range: { Type: 'NoEnd', StartDate: '2026-10-27' } }
    const r = toRecord(
      event({
        Type: 'Occurrence',
        Categories: ['Red category', 'Blue category'],
        WebLink: 'https://outlook.office365.com/owa/?itemid=x',
        OriginalStart: '2026-10-27T09:45:00+00:00',
        ResponseRequested: true,
        Recurrence: rule
      })
    )
    expect(r).toMatchObject({
      categories: ['Red category', 'Blue category'],
      webLink: 'https://outlook.office365.com/owa/?itemid=x',
      originalStart: Date.UTC(2026, 9, 27, 9, 45),
      responseRequested: true,
      recurrence: null
    })
    expect(toRecord(event({ Type: 'SeriesMaster', Recurrence: rule })).recurrence).toBe(JSON.stringify(rule))
    expect(toRecord(event())).toMatchObject({ categories: [], webLink: null, originalStart: null, responseRequested: null })
  })

  it('marks a hidden guest list as cut, except for the organizer', () => {
    expect(toRecord(event({ HideAttendees: true })).attendeesOmitted).toBe(true)
    expect(toRecord(event({ HideAttendees: true, IsOrganizer: true })).attendeesOmitted).toBe(false)
  })

  it('stores the full body as text without the style block, and keeps the preview as the description', () => {
    const r = toRecord(
      event({
        BodyPreview: 'Agenda',
        Body: {
          ContentType: 'HTML',
          Content: '<html><head><style>p{color:red}</style></head><body><p>Agenda</p><p>Dial &#43;44</p></body></html>'
        }
      })
    )
    expect(r.body).toBe('Agenda\nDial +44')
    expect(r.description).toBe('Agenda')
    expect(toRecord(event({ Body: { ContentType: 'Text', Content: 'a < b' } })).body).toBe('a < b')
    expect(toRecord(event({ Body: { ContentType: 'HTML', Content: '' } })).body).toBeNull()
  })

  it('drops the line breaks of the HTML source and keeps at most one empty line', () => {
    const html = '<div>To: Ann &lt;ann@x.com&gt;; Utsav\r\n &lt;utsav@x.com&gt;</div>\r\n<div>\r\n<p>Agenda</p>\r\n</div>'
    expect(toRecord(event({ Body: { ContentType: 'HTML', Content: html } })).body).toBe(
      'To: Ann <ann@x.com>; Utsav <utsav@x.com>\nAgenda'
    )
    const gaps = '<p>Hello</p><p>&nbsp;</p><br><br><br><p>Bye</p>'
    expect(toRecord(event({ Body: { ContentType: 'HTML', Content: gaps } })).body).toBe('Hello\n\nBye')
  })
})
