// The contract between the renderer (window.api) and the main process.
// Times are UTC epoch milliseconds unless the name says "date" (YYYY-MM-DD).

export type Provider = 'outlook' | 'google'

export type AccountStatus = 'ok' | 'syncing' | 'needs-sign-in' | 'error'

export interface Account {
  id: number
  provider: Provider
  email: string
  status: AccountStatus
  lastSyncAt: number | null
  lastError: string | null
}

export interface Calendar {
  id: number
  accountId: number
  name: string
  color: string
  canEdit: boolean
  visible: boolean
  isPrimary: boolean
  // Minutes. What a new event in this calendar gets from the provider.
  defaultReminders: number[]
  // The video call new events here can get. null: none (or not read yet).
  conference: 'meet' | 'teams' | null
  // IANA. What Google gives a new event here. null: none (Outlook), or not read yet.
  timeZone: string | null
  // The dates the last sync covered (UTC midnight, end exclusive). Events outside are not stored. null: not synced yet.
  windowStart: number | null
  windowEnd: number | null
  // The event colors the user can pick here, in the provider's order. key: Google's label id (or classic color id when
  // no labels are known), or the Outlook category name. Empty: none (view only; Outlook outside the main calendar).
  colors: { key: string; name: string; color: string }[]
  // Google: the last sync read this calendar's labels, so the sign-in has the labels scope. Outlook: false.
  labelsRead: boolean
}

// One reminder of an event. alarm: a big card on every screen that rings until you answer it.
// Otherwise a small card in the corner with one soft sound.
export interface EventReminder {
  minutes: number
  alarm: boolean
}

export type ShowAs = 'free' | 'tentative' | 'busy' | 'oof' | 'workingElsewhere' | 'unknown'
export type Response = 'organizer' | 'accepted' | 'tentative' | 'declined' | 'none'
export type Answer = Exclude<Response, 'organizer' | 'none'>
// Which events of a repeating one an answer or change is for. 'following': this one and later ones. 'series': all of them.
export type Scope = 'event' | 'following' | 'series'

export interface CalendarEvent {
  id: number
  calendarId: number
  title: string
  // For all-day events start/end are UTC midnight of startDate/endDate. Use the dates to render.
  start: number
  end: number
  allDay: boolean
  // All-day only. endDate is exclusive.
  startDate: string | null
  endDate: string | null
  location: string
  joinUrl: string | null
  description: string
  showAs: ShowAs
  response: Response
  isOrganizer: boolean
  // Google: the organizer lets guests change the event. Always false for Outlook.
  guestsCanModify: boolean
  attendeeCount: number
  // The same for every event of a repeating one. null: not repeating.
  seriesRemoteId: string | null
  cancelled: boolean
  reminders: EventReminder[]
  // The event's own color (Google color, Outlook category). null: the calendar's color.
  color: string | null
  // Its key in Calendar.colors. null: none, or one the app cannot show.
  colorKey: string | null
}

// One guest as the provider lists it. False flags are left out.
export interface Guest {
  email: string
  name?: string
  response: Exclude<Response, 'organizer'>
  optional?: true
  organizer?: true
  self?: true
  // A room or other resource.
  resource?: true
}

export interface EventDetails {
  // Organizer first, then required, then optional guests. No rooms. The organizer may be added and your own answer is
  // the event's; emails and optional flags are as stored, so the edit dialog starts from this list.
  guests: Guest[]
  rooms: Guest[]
  // The provider did not send the whole list (cut, or hidden by the organizer), so the total is not known.
  guestsOmitted: boolean
  // The full Outlook body. null: use the event's description.
  body: string | null
  // The event in the provider's web app.
  webLink: string | null
  // Google's guest permissions. null: Outlook.
  guestsCanModify: boolean | null
  guestsCanInviteOthers: boolean | null
  guestsCanSeeOtherGuests: boolean | null
  // IANA names, also for Outlook's Windows names. null: all-day, or a zone the app does not know.
  timeZone: string | null
  endTimeZone: string | null
}

// One guest to invite. The organizer is never in this list.
export interface GuestInput {
  email: string
  optional: boolean
}

// The user's own edit of a guest list. It is applied to the provider's latest list, so changes made elsewhere stay.
export interface GuestEdit {
  // New guests.
  add: GuestInput[]
  // Guests already there whose optional flag changed. Their address is the stored one, maybe not an email (Outlook).
  set: GuestInput[]
  // Stored addresses to take off.
  remove: string[]
}

// A rule the app can show and write. Monthly and yearly days come from the series' first date, like Google's presets.
export interface Repeat {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly'
  // 1 to 99.
  interval: number
  // Weekly only, with the first date's weekday. 0 = Sunday.
  days: number[]
  // Monthly only: on the first date's day of the month, its nth weekday (first to fourth), or its last weekday.
  monthly: 'day' | 'weekday' | 'last'
  // Ends: both null = never. until: the last day, inclusive (YYYY-MM-DD in the series' zone). count: 1 to 730.
  until: string | null
  count: number | null
}

// The rule of a repeating event's series.
export interface Series {
  // null: a rule the app cannot read (Google web and Outlook can make more kinds).
  repeat: Repeat | null
  // Start of the series' first event.
  first: number
  // IANA zone of the series. null: an all-day series, or a zone the app does not know.
  zone: string | null
}

export interface EventInput {
  calendarId: number
  title: string
  start: number
  end: number
  allDay: boolean
  startDate: string | null
  endDate: string | null
  location: string
  description: string
  // Leave out to get the calendar's default reminders.
  reminders?: EventReminder[]
  guests?: GuestInput[]
  // Google only. Leave out to keep them (a new event gets Google's defaults).
  guestsCanModify?: boolean
  guestsCanInviteOthers?: boolean
  guestsCanSeeOtherGuests?: boolean
  // true: add the calendar's video call (Google Meet or Teams). In a change, false removes it (Google only).
  conference?: boolean
  // IANA, only when the user picked it. Left out, the event keeps its zone (a new one gets the calendar's, or this PC's
  // for Outlook). Timed events only.
  timeZone?: string
  endTimeZone?: string
  // Create: makes a repeating event. Change: a new rule for scope 'following' or 'series'.
  repeat?: Repeat
  // One of the calendar's colors (Calendar.colors key). null: the calendar's color. Left out: keep it.
  colorKey?: string | null
}

// The times of an event, which always change together (a drag, an edit).
export type Times = Pick<EventInput, 'start' | 'end' | 'allDay' | 'startDate' | 'endDate'>

export type EventPatch = Partial<Omit<EventInput, 'calendarId' | 'guests'>> & { guests?: GuestEdit }

export interface Range {
  start: number
  end: number
}

export interface SearchResult {
  // By start. At most 200, the ones closest to now.
  events: CalendarEvent[]
  // There were more matches.
  more: boolean
}

// heads-up: a notification. alert: an alarm before the start (all-day: always). started: an alarm after the start, red,
// until 10 min after it.
export type ReminderStage = 'heads-up' | 'alert' | 'started'

export interface Reminder {
  // The event to act on. Copies of the same meeting in other calendars follow it.
  eventId: number
  title: string
  // For all-day events start and end are local midnight of the first day and of the day after the last.
  start: number
  end: number
  allDay: boolean
  // When it stops showing: the end, or for all-day events the end of the first day. A snooze never goes past it.
  last: number
  // When the event's next reminder fires. null: none. A snooze never goes past it.
  next: number | null
  location: string
  joinUrl: string | null
  stage: ReminderStage
  // When the shown reminder fired. Dismiss uses it, so later reminders still come.
  fireAt: number
}

export interface Reminders {
  headsUp: Reminder[]
  alerts: Reminder[]
  // Accounts not synced for a while: their reminders may be wrong.
  stale: string[]
}

export type ReminderAction = 'join' | 'snooze' | 'dismiss'

export interface Settings {
  // Default reminders for events whose reminders the user did not set in this app.
  // A meeting has a join link or other people.
  meetingReminders: EventReminder[]
  eventReminders: EventReminder[]
  // All-day events: minutes before local midnight of the first day. Below 0: on that day.
  allDayReminders: EventReminder[]
  // true: 12h clock, false: 24h. null: the language's own clock.
  hour12: boolean | null
  // 0 = Sunday ... 6 = Saturday. null: the language's first day.
  weekStart: number | null
  showWeekends: boolean
  // Length of new events.
  eventMinutes: number
  showDeclined: boolean
  theme: 'system' | 'light' | 'dark'
  // IANA. A second column of times in Day and Week view. null: off.
  secondaryTimeZone: string | null
  // Shown above that column. '': its GMT offset.
  secondaryTimeZoneLabel: string
}

export interface Api {
  listAccounts(): Promise<Account[]>
  listCalendars(): Promise<Calendar[]>
  listEvents(range: Range): Promise<CalendarEvent[]>
  // Events of visible calendars with every word of text in the title, location, description, organizer or a guest.
  // From the local DB, so only the synced dates.
  searchEvents(text: string): Promise<SearchResult>
  // Guests, full body and web link of one event, from the local DB. null: the event is gone.
  getEventDetails(eventId: number): Promise<EventDetails | null>
  // The rule of a repeating event: from the stored Outlook series, or read from Google. null: not repeating. Throws when
  // the event is gone, the rule cannot be loaded, or the provider read fails.
  getSeries(eventId: number): Promise<Series | null>
  // People seen in the account's events, newest first, without the user. The guest field suggests them.
  listPeople(accountId: number): Promise<Pick<Guest, 'email' | 'name'>[]>
  setCalendarVisible(calendarId: number, visible: boolean): Promise<void>
  // With an account id: sign that account in again.
  addOutlookAccount(accountId?: number): Promise<void>
  addGoogleAccount(): Promise<void>
  removeAccount(accountId: number): Promise<void>
  syncNow(): Promise<void>
  // notify false: guests get no email about this create, change or delete (Google only; Outlook always emails them).
  createEvent(input: EventInput, notify?: boolean): Promise<CalendarEvent>
  // scope (default 'event'): which events of a repeating one change; only for the organizer's own series.
  // null: a series write gave the event a new id or removed it; the view reloads.
  updateEvent(eventId: number, patch: EventPatch, options?: { notify?: boolean; scope?: Scope }): Promise<CalendarEvent | null>
  deleteEvent(eventId: number, options?: { notify?: boolean; scope?: Scope }): Promise<void>
  // Answers an invite. Scope 'series' also replaces the answers given to single events.
  respondEvent(eventId: number, answer: Answer, scope: Scope): Promise<void>
  openLink(url: string): Promise<void>
  // Main writes the clipboard: the page has no clipboard permission (security.ts denies all).
  copyText(text: string): Promise<void>
  listReminders(): Promise<Reminders>
  // fireAt: the reminder the user saw when they clicked. snooze: one of SNOOZE_CHOICES, only with 'snooze' (default 0).
  answerReminder(eventId: number, action: ReminderAction, fireAt: number, snooze?: number): Promise<void>
  // Dismiss all: the reminders one window lists.
  dismissReminders(shown: { eventId: number; fireAt: number }[]): Promise<void>
  // A click on a reminder's text: the main window opens with the event's popover.
  showEvent(eventId: number): Promise<void>
  getSettings(): Promise<Settings>
  saveSettings(settings: Settings): Promise<void>
  // The version of a downloaded update that installs on the next quit. null: none.
  getUpdate(): Promise<string | null>
  // Quits, installs the downloaded update and starts the app again.
  installUpdate(): Promise<void>
}

// Pushed from main when stored data changes. The renderer re-reads what it shows.
export interface DataChanged {
  accounts: boolean
  calendars: boolean
  events: boolean
  reminders: boolean
  // Every window re-reads the settings (formats, week start). Main applies the theme itself.
  settings: boolean
}
