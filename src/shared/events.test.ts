import { describe, expect, it } from 'vitest'
import type { Calendar, CalendarEvent } from './api'
import { canChangeTime, eventName, hasGuests, hasOwnCall, isEmail, isPerson, labelsHint, parseGuests, pickedSuggestion, withoutOwn } from './events'

describe('canChangeTime', () => {
  const meeting = { isOrganizer: false, attendeeCount: 2, cancelled: false, guestsCanModify: false }

  it('lets the organizer and events without guests change the time, but not an invitee', () => {
    expect(canChangeTime({ ...meeting, isOrganizer: true })).toBe(true)
    expect(canChangeTime({ ...meeting, attendeeCount: 0 })).toBe(true)
    expect(canChangeTime(meeting)).toBe(false)
  })

  it('lets an invitee change the time when Google lets guests change the event', () => {
    expect(canChangeTime({ ...meeting, guestsCanModify: true })).toBe(true)
  })
})

describe('labelsHint', () => {
  const calendar = { isPrimary: true, canEdit: true, labelsRead: false }
  const account = { provider: 'google' as const, status: 'ok' as const, lastSyncAt: 1 }

  it('shows on the main Google calendar of a synced, working sign-in without the labels scope only', () => {
    expect(labelsHint(calendar, account)).toBe(true)
    expect(labelsHint(calendar, { ...account, status: 'syncing' })).toBe(true)
    expect(labelsHint({ ...calendar, labelsRead: true }, account)).toBe(false)
    expect(labelsHint({ ...calendar, isPrimary: false }, account)).toBe(false)
    expect(labelsHint(calendar, { ...account, lastSyncAt: null })).toBe(false)
    expect(labelsHint(calendar, { ...account, status: 'needs-sign-in' })).toBe(false)
    expect(labelsHint(calendar, { ...account, status: 'error' })).toBe(false)
    expect(labelsHint(calendar, { ...account, provider: 'outlook' })).toBe(false)
    expect(labelsHint(calendar, undefined)).toBe(false)
  })
})

describe('isEmail', () => {
  it('takes plain addresses only', () => {
    expect(isEmail('a@b.co')).toBe(true)
    for (const bad of ['x', 'a@b', 'a b@c.d', '<a@b.c>', 'a@b.c,', `${'a'.repeat(250)}@b.co`]) expect(isEmail(bad)).toBe(false)
  })
})

describe('isPerson', () => {
  it('leaves out group, holiday and room calendars, and booking pages with a made-up address', () => {
    expect(isPerson('ann@x.com')).toBe(true)
    expect(isPerson('g3ac4f90dcccb41a88f277a8628643271@x.com')).toBe(false)
    expect(isPerson('c_1fc3@group.calendar.google.com')).toBe(false)
    expect(isPerson('en.usa#holiday@group.v.calendar.google.com')).toBe(false)
    expect(isPerson('c_188@resource.calendar.google.com')).toBe(false)
  })
})

describe('parseGuests', () => {
  it('splits a typed or pasted list, reads "Name <email>", and keeps the parts that are not addresses', () => {
    const text = 'ann@x.com, notanemail; Bob Smith <bob@x.com>\n"Doe, Cleo" <cleo@x.com>  dan@x.com'
    expect(parseGuests(text)).toEqual({ emails: ['ann@x.com', 'bob@x.com', 'cleo@x.com', 'dan@x.com'], invalid: ['notanemail'] })
  })

  it("reads Outlook's names: \"Last, First <email>\", and a name with no space before <", () => {
    expect(parseGuests('ann@x.com, Rossi, Dana <d@x.com>; Eve Lee<eve@x.com>')).toEqual({
      emails: ['ann@x.com', 'd@x.com', 'eve@x.com'],
      invalid: []
    })
  })
})

describe('pickedSuggestion', () => {
  it('adds an address typed in full, not a longer known one', () => {
    // Known: bob@corp.com.
    expect(pickedSuggestion('bob@corp.co', 1, 0, false)).toBe(-1)
  })

  it('takes the row the user moved to, or the first row for a part of a name', () => {
    expect(pickedSuggestion('bob@corp.co', 2, 1, true)).toBe(1)
    expect(pickedSuggestion('bob', 1, 0, false)).toBe(0)
    expect(pickedSuggestion('zed', 0, 0, false)).toBe(-1)
  })
})

describe('hasGuests', () => {
  it('counts only people to tell: not the user, the organizer or rooms', () => {
    expect(hasGuests([{ self: true, organizer: true }, { resource: true }])).toBe(false)
    expect(hasGuests([{ organizer: true }, {}])).toBe(true)
  })
})

describe('withoutOwn', () => {
  it('drops the new organizer from the guests, in any case', () => {
    const guests = [{ email: 'Me@Work.com' }, { email: 'eve@x.com' }]
    expect(withoutOwn(guests, ['me@work.com'])).toEqual([{ email: 'eve@x.com' }])
  })
})

describe('hasOwnCall', () => {
  const event = { joinUrl: 'https://meet.google.com/abc-defg-hij', location: '', description: '' }

  it('counts a call that came with the event, not a link in its text', () => {
    expect(hasOwnCall(event)).toBe(true)
    expect(hasOwnCall({ ...event, description: 'Join: https://meet.google.com/abc-defg-hij' })).toBe(false)
    expect(hasOwnCall({ ...event, location: 'https://meet.google.com/abc-defg-hij' })).toBe(false)
    expect(hasOwnCall({ ...event, joinUrl: null })).toBe(false)
  })
})

describe('eventName', () => {
  const calendar = { name: 'Work', colors: [{ key: '9', name: 'Cobalt', color: '#3F51B5' }] } as Calendar
  const invite = {
    title: 'Standup',
    response: 'none',
    attendeeCount: 3,
    isOrganizer: false,
    cancelled: false,
    colorKey: null,
    location: 'Room 1'
  } as CalendarEvent
  const name = (e: Partial<CalendarEvent>): string => eventName({ ...invite, ...e }, calendar, '10:00 to 11:00', '28 October 2026')

  it("says time, title, calendar, answer, location, color and date, in Google's order", () => {
    expect(name({})).toBe('10:00 to 11:00, Standup, Work, Needs RSVP, Location: Room 1, 28 October 2026')
    expect(name({ colorKey: '9' })).toBe('10:00 to 11:00, Standup, Work, Needs RSVP, Location: Room 1, colour: Cobalt, 28 October 2026')
    expect(name({ colorKey: '9', location: '' })).toBe('10:00 to 11:00, Standup, Work, Needs RSVP, No location, colour: Cobalt, 28 October 2026')
  })

  it('says every answer of an invite, and none on own events, like Google', () => {
    expect(name({ response: 'accepted' })).toContain(', Work, Accepted, ')
    expect(name({ response: 'declined' })).toContain(', Work, Declined, ')
    expect(name({ response: 'tentative' })).toContain(', Work, Tentative, ')
    expect(name({ cancelled: true })).toContain(', Work, Canceled, ')
    expect(name({ response: 'organizer', isOrganizer: true })).toBe('10:00 to 11:00, Standup, Work, Location: Room 1, 28 October 2026')
    expect(name({ response: 'accepted', attendeeCount: 0 })).toBe('10:00 to 11:00, Standup, Work, Location: Room 1, 28 October 2026')
  })

  it('leaves out a color that is not in the calendar, and names an empty title', () => {
    expect(name({ colorKey: 'gone', title: '' })).toBe('10:00 to 11:00, (No title), Work, Needs RSVP, Location: Room 1, 28 October 2026')
  })
})
