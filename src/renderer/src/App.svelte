<script lang="ts">
  import { tick } from 'svelte'
  import type {
    Account,
    Answer,
    Calendar,
    CalendarEvent,
    EventDetails,
    EventInput,
    EventReminder,
    GuestEdit,
    Scope,
    Series,
    Settings,
    Times
  } from '../../shared/api'
  import { ANSWER_LABELS, canChangeTime, hasGuests, isInvite, isOwnSeries } from '../../shared/events'
  import { mergeReminders } from '../../shared/reminders'
  import ColorMenu from './components/ColorMenu.svelte'
  import EventDialog from './components/EventDialog.svelte'
  import EventPopover from './components/EventPopover.svelte'
  import GoToDate from './components/GoToDate.svelte'
  import MonthView from './components/MonthView.svelte'
  import QuickCreate from './components/QuickCreate.svelte'
  import ScheduleList from './components/ScheduleList.svelte'
  import ScopeDialog from './components/ScopeDialog.svelte'
  import SendUpdates from './components/SendUpdates.svelte'
  import SettingsDialog from './components/SettingsDialog.svelte'
  import ShortcutHelp from './components/ShortcutHelp.svelte'
  import Sidebar from './components/Sidebar.svelte'
  import WeekView from './components/WeekView.svelte'
  import { scheduleDays } from './lib/layout'
  import { asksScope, choicesFor } from './lib/repeat'
  import { formats, loadSettings, prefs } from './lib/settings.svelte'
  import { errorMessage, runAction, signIn, signInOutlook } from './lib/sign-in.svelte'
  import {
    addDays,
    addMonths,
    allDayTimes,
    dateKey,
    daysBetween,
    fromDateKey,
    localeWeekStart,
    monthGridStart,
    rangeTitle,
    shownDays,
    startOfDay,
    startOfWeek,
    syncedDates
  } from './lib/time'

  type View = 'day' | 'week' | 'month' | 'schedule'
  type Point = { left: number; top: number; right: number; bottom: number }

  const VIEWS: { id: View; label: string; key: string }[] = [
    { id: 'day', label: 'Day', key: 'd' },
    { id: 'week', label: 'Week', key: 'w' },
    { id: 'month', label: 'Month', key: 'm' },
    { id: 'schedule', label: 'Schedule', key: 'a' }
  ]
  // Delete waits this long, so Undo can still stop it. A moved event's toast with Undo stays as long.
  const UNDO_MS = 8000
  // Notes (info toasts from showNote) hide after this long.
  const NOTE_MS = 5000
  // The longest Schedule read. main allows 430 days (MAX_RANGE in main/api.ts), with room for a DST hour.
  const SCHEDULE_DAYS = 425

  // Small per-device preferences. Storage can be blocked, so never rely on it.
  function stored(key: string): string | null {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  }
  function store(key: string, value: string): void {
    try {
      localStorage.setItem(key, value)
    } catch {
      // Ignore.
    }
  }

  let view: View = $state((['day', 'week', 'month', 'schedule'] as const).find((v) => v === stored('view')) ?? 'week')
  let anchor = $state(new Date())
  let accounts: Account[] = $state([])
  let calendars: Calendar[] = $state([])
  let events: CalendarEvent[] = $state([])

  let selected: { event: CalendarEvent; anchor: DOMRect } | null = $state(null)
  // The right-click menu: Delete and the event colors.
  let colorMenu: { event: CalendarEvent; anchor: DOMRect } | null = $state(null)
  // Events whose new color is being saved: no menu on them until that ends.
  let coloring: number[] = $state([])
  // "Event saved" after a color pick, for screen readers only, like Google (no toast).
  let colorSaved = $state(false)
  // Counts the picks, so only the newest one's timer clears "Event saved".
  let colorSaves = 0
  let draft: { input: EventInput; anchor: Point } | null = $state(null)
  // details, organizer and joinUrl: only for an edit.
  let dialog: {
    initial: EventInput
    eventId: number | null
    recurring: boolean
    viewOnly: boolean
    timesLocked: boolean
    details?: EventDetails
    organizer?: boolean
    joinUrl?: string | null
    // The user's own series: its rule (null: it did not load).
    series?: Series | null
  } | null = $state(null)
  // Loaded in main.ts before mount (the defaults if that fails).
  const settings = $derived(prefs.settings)
  let settingsOpen = $state(false)
  let helpOpen = $state(false)
  let goToOpen = $state(false)
  let gear: HTMLButtonElement | undefined = $state()
  let magnifier: HTMLButtonElement | undefined = $state()
  let searchBox: HTMLInputElement | undefined = $state()
  let results: ScheduleList | undefined = $state()
  let schedule: ScheduleList | undefined = $state()
  let week: WeekView | undefined = $state()
  let month: MonthView | undefined = $state()
  let popover: EventPopover | undefined = $state()
  // Search mode. ran: the text of the last search. events: its results, null until the first Enter. more: over 200.
  // The type is on $state, so TypeScript does not take search as always null in the code below.
  let search = $state<{ text: string; ran: string; events: CalendarEvent[] | null; more: boolean } | null>(null)
  // decline: an Outlook "No" waiting to be sent, not a delete. notify: the answer to the cancellation question.
  let pendingDelete: {
    event: CalendarEvent
    timer: ReturnType<typeof setTimeout>
    scope: Scope
    decline: boolean
    notify?: boolean
  } | null = $state(null)
  // Sent deletes stay hidden until the delete and the reload after it finish.
  let deleting: number[] = $state([])
  // undo: what the Undo button does. null: no Undo button.
  let toast: { text: string; undo: (() => void) | null } | null = $state(null)
  // Dragged events, shown at their new times while the write runs. They replace the stored copy, so a failed write
  // just drops them.
  let moved: CalendarEvent[] = $state([])
  // The "send updates" question for a meeting the user organizes, asked before the write. times null: a delete.
  let asking: { event: CalendarEvent; times: Times | null; scope: Scope } | null = $state(null)
  // The "which events" question for a drag or a delete of one event of the user's own series, asked first. guests: the
  // note says they get mail. color: a color pick waits for the answer (key null: Default).
  let scoping: { event: CalendarEvent; times: Times | null; choices: Scope[]; guests: boolean; color?: { key: string | null } } | null = $state(null)

  const weekStartDay = $derived(settings.weekStart ?? localeWeekStart())
  const showWeekends = $derived(settings.showWeekends)
  // The dates every visible calendar has synced. Nothing outside them is stored.
  const synced = $derived(syncedDates(calendars))
  const range = $derived.by(() => {
    if (view === 'day') return { start: startOfDay(anchor), days: 1 }
    if (view === 'week') return { start: startOfWeek(anchor, weekStartDay), days: 7 }
    if (view === 'schedule') {
      // From the start day to the end of the synced dates in one read, so the list and its title never change while
      // scrolling. It starts at the synced start if the start day is earlier, so it is never longer than the window.
      const start = synced && synced.from > startOfDay(anchor) ? synced.from : startOfDay(anchor)
      return { start, days: synced ? Math.min(SCHEDULE_DAYS, Math.max(1, daysBetween(start, synced.to))) : 1 }
    }
    return { start: monthGridStart(anchor, weekStartDay), days: 42 }
  })
  // The day view always shows its day, like Google Calendar.
  const days = $derived(shownDays(range.start, range.days, view === 'day' || showWeekends))
  const title = $derived(
    view === 'day'
      ? formats.date.format(anchor)
      : view === 'week'
        ? rangeTitle(days[0], days[days.length - 1])
        : view === 'schedule'
          ? rangeTitle(startOfDay(anchor), addDays(range.start, range.days - 1))
          : formats.month.format(anchor)
  )
  const signedOut = $derived(accounts.filter((a) => a.status === 'needs-sign-in'))
  // New events go to calendars the user can write to and can see.
  const writable = $derived(calendars.filter((c) => c.canEdit && c.visible))
  // Day, week and month show no events on days outside the synced dates, so a note says why.
  const outside = $derived(
    !search?.events && view !== 'schedule' && synced !== null && (days[0] < synced.from || days[days.length - 1] >= synced.to)
  )
  // While quick create is open, a placeholder box shows where the event will go.
  const shown = $derived.by(() => {
    const list = present(events)
    return draft ? [...list, ghost(draft.input)] : list
  })
  // Search results, with the same rules as the views. null: no search has run.
  const found = $derived(search?.events ? present(search.events) : null)
  // Every loaded copy of every event: the view's and the search results'.
  const loaded = $derived([...events, ...(search?.events ?? [])])

  // Hides events being deleted and, if the setting says so, declined ones. Moved events show at their new times.
  function present(list: CalendarEvent[]): CalendarEvent[] {
    const hideDeclined = !settings.showDeclined
    return list
      .filter(
        (e) =>
          e.id !== pendingDelete?.event.id &&
          !(pendingDelete?.scope === 'series' && sameSeries(e, pendingDelete.event)) &&
          !deleting.includes(e.id) &&
          !(hideDeclined && e.response === 'declined')
      )
      .map((e) => moved.find((m) => m.id === e.id) ?? e)
  }

  // "28 August 2026 to 26 October 2027". The end is exclusive.
  const syncedText = (dates: { from: Date; to: Date }): string =>
    `${formats.date.format(dates.from)} to ${formats.date.format(addDays(dates.to, -1))}`

  // The placeholder box of a new event: while quick create is open, and while a drag creates one.
  function ghost(input: EventInput): CalendarEvent {
    return {
      ...input,
      id: -1,
      title: input.title || '(No title)',
      joinUrl: null,
      showAs: 'busy',
      response: 'organizer',
      isOrganizer: true,
      guestsCanModify: false,
      attendeeCount: 0,
      seriesRemoteId: null,
      cancelled: false,
      reminders: [],
      color: null,
      colorKey: null
    }
  }

  const newEvent = (times: Times): CalendarEvent =>
    ghost({ calendarId: defaultCalendar()?.id ?? -1, title: '', location: '', description: '', ...times })

  async function loadAccounts(): Promise<void> {
    ;[accounts, calendars] = await Promise.all([window.api.listAccounts(), window.api.listCalendars()])
  }

  async function loadEvents(start: Date, days: number): Promise<void> {
    const result = await window.api.listEvents({ start: start.getTime(), end: addDays(start, days).getTime() })
    // Ignore answers for a range the user already left.
    if (start.getTime() === range.start.getTime() && days === range.days) {
      events = result
      // The open popover follows sync and edits. If its event is gone, it keeps the last copy, like Google Calendar.
      const open = selected
      if (open) open.event = result.find((e) => e.id === open.event.id) ?? open.event
    }
  }

  $effect(() => {
    void loadEvents(range.start, range.days)
  })

  $effect(() => {
    void loadAccounts()
    return window.api.onDataChanged((change) => {
      if (change.accounts || change.calendars) void loadAccounts()
      if (change.events) void reload()
      if (change.settings) void loadSettings()
    })
  })

  // The banner, the tray and the toast sign in here. Not while busy: a second Google sign-in would cancel the first.
  function signInAgain(account: Account): void {
    if (signIn.busy) return
    void (account.provider === 'outlook' ? signInOutlook(account.id) : runAction(window.api.addGoogleAccount))
  }

  // An old tray item or toast for an account that is signed in again does nothing.
  $effect(() => {
    return window.api.onSignIn((accountId) => {
      const account = signedOut.find((a) => a.id === accountId)
      if (account) signInAgain(account)
    })
  })

  // A click on a reminder's text. Not while a dialog or quick create is open, so unsaved work stays: the window only
  // comes up.
  $effect(() => {
    return window.api.onShowEvent((event) => {
      if (!draft && !document.querySelector('dialog[open]')) void showEvent(event)
    })
  })

  // The event's day, with its popover open next to its chip or row. Not drawn (hidden weekend or declined, under
  // "N more"): next to the middle of the view.
  async function showEvent(event: CalendarEvent): Promise<void> {
    colorMenu = null
    selected = null
    month?.closeMore()
    goTo(event.allDay ? fromDateKey(event.startDate!) : new Date(event.start))
    await loadEvents(range.start, range.days)
    await tick()
    const chip = document.querySelector<HTMLElement>(`main [data-id="${event.id}"]:not([aria-hidden])`)
    // In Week and Day the chip can be out of the scrolled grid. Focused, so closing the popover goes back to it.
    chip?.scrollIntoView({ block: 'center' })
    chip?.focus({ preventScroll: true })
    const main = document.querySelector('main')!.getBoundingClientRect()
    selected = {
      event: events.find((e) => e.id === event.id) ?? event,
      anchor: chip?.getBoundingClientRect() ?? new DOMRect(main.left + main.width / 2, main.top, 0, 0)
    }
  }

  // The view and the search results again: results follow sync and edits too.
  function reload(): Promise<unknown> {
    return Promise.all([loadEvents(range.start, range.days), search?.events && runSearch(search.ran)])
  }

  // Shows the "/" search bar. The view stays until the first Enter, like Google.
  function openSearch(): void {
    search ??= { text: '', ran: '', events: null, more: false }
    void tick().then(() => searchBox?.focus())
  }

  // focus: after Enter, move to the result closest to today. Re-runs after a sync keep focus where it is.
  async function runSearch(text: string, focus = false): Promise<void> {
    const result = await window.api.searchEvents(text).catch((e: unknown) => showNote(errorMessage(e)))
    // Ignore an answer for a search the user already left or replaced.
    if (!result || search?.ran !== text) return
    search.events = result.events
    search.more = result.more
    const open = selected
    if (open) open.event = result.events.find((e) => e.id === open.event.id) ?? open.event
    // With no results focus stays in the box, like Google.
    if (focus) void tick().then(() => results?.focusToday())
  }

  // Back to the view as it was, like Google's "Go back".
  function closeSearch(): void {
    if (!search) return
    search = null
    void tick().then(() => magnifier?.focus())
  }

  // The focused cell or event leaves with the old view: focus goes to the new grid's tab stop (Schedule: its list), not
  // the page, like step.
  function setView(next: View): void {
    const inView = document.activeElement?.closest('main')
    closeSearch()
    view = next
    store('view', next)
    if (!inView) return
    void tick().then(() => {
      if (document.activeElement === document.body)
        document
          .querySelector<HTMLElement>('main [role="gridcell"][tabindex="0"], main .schedule')
          ?.focus({ preventScroll: true })
    })
  }

  // Today, a mini-month day, a date in a list, Go to date: leaves search and shows that day.
  function goTo(day: Date): void {
    closeSearch()
    anchor = day
  }

  // Today (button and "t") also scrolls the Week and Day grid to now, like Google. Focus in the grid goes to today's
  // day header (Month: today's cell), like Google, not to the page when the old dates leave.
  function goToday(): void {
    const inGrid = view !== 'schedule' && document.activeElement?.closest('main')
    goTo(new Date())
    void tick().then(() => {
      week?.scrollToNow()
      if (inGrid && document.activeElement === document.body) document.querySelector<HTMLElement>('main [aria-current="date"]')?.focus()
    })
  }

  // A day number in the month or a date in a list: that day in the Day view, like Google.
  function showDay(day: Date): void {
    goTo(day)
    setView('day')
  }

  function step(direction: 1 | -1): void {
    // Search results have no period to move.
    if (search) return
    // The focused cell or event leaves with the old dates: focusNext puts focus back on the grid (no list here), not the page.
    if (view !== 'schedule' && document.activeElement?.closest('main')) focusNext(0)
    if (view === 'day' || view === 'schedule') anchor = addDays(anchor, direction)
    else if (view === 'week') anchor = addDays(anchor, 7 * direction)
    else anchor = addMonths(anchor, direction)
  }

  // The last calendar used, if it still takes new events. Else the first primary one.
  function defaultCalendar(): Calendar | undefined {
    const last = Number(stored('lastCalendar'))
    return writable.find((c) => c.id === last) ?? writable.find((c) => c.isPrimary) ?? writable[0]
  }

  // end: where a drag on the grid stopped. Else the default length, or one day.
  function newInput(start: Date, allDay: boolean, calendar: Calendar, end?: Date): EventInput {
    const common = { calendarId: calendar.id, title: '', location: '', description: '' }
    const endMs = end ? end.getTime() : start.getTime() + settings.eventMinutes * 60_000
    if (!allDay) return { ...common, allDay: false, start: start.getTime(), end: endMs, startDate: null, endDate: null }
    return { ...common, ...allDayTimes(dateKey(start), dateKey(end ?? addDays(start, 1))) }
  }

  function inputOf(event: CalendarEvent): EventInput {
    const { calendarId, title, start, end, allDay, startDate, endDate, location, description, reminders, colorKey } = event
    return { calendarId, title, start, end, allDay, startDate, endDate, location, description, reminders, colorKey }
  }

  // What a new event gets without its own reminders: the calendar's, plus the defaults for events, or for meetings once
  // it has guests or a video call. All-day events get the all-day defaults only: the calendar's are for timed events.
  function defaultReminders(calendarId: number, meeting = false, allDay = false): EventReminder[] {
    if (allDay) return mergeReminders(settings.allDayReminders)
    const provider = calendars.find((c) => c.id === calendarId)?.defaultReminders ?? []
    const own = meeting ? settings.meetingReminders : settings.eventReminders
    return mergeReminders([...provider.map((minutes) => ({ minutes, alarm: false })), ...own])
  }

  function startCreate(start: Date, allDay: boolean, point: { x: number; y: number }, end?: Date): void {
    const calendar = defaultCalendar()
    if (!calendar) return void (toast = { text: 'Add an account with a calendar you can edit first.', undo: null })
    draft = { input: newInput(start, allDay, calendar, end), anchor: { left: point.x, right: point.x, top: point.y, bottom: point.y } }
  }

  // The "c" key: a new event on the date in view at the next half hour, straight in the full dialog, like Google (checked
  // live: on the week of 18 Nov at 18:2x it starts 18 Nov, 18:30).
  function createFromKeyboard(): void {
    const calendar = defaultCalendar()
    if (!calendar) return void (toast = { text: 'Add an account with a calendar you can edit first.', undo: null })
    const now = new Date()
    const start = new Date(
      anchor.getFullYear(),
      anchor.getMonth(),
      anchor.getDate(),
      now.getHours(),
      now.getMinutes() < 30 ? 30 : 60
    )
    dialog = { initial: newInput(start, false, calendar), eventId: null, recurring: false, viewOnly: false, timesLocked: false }
  }

  async function create(input: EventInput, notify?: boolean): Promise<void> {
    const saved = await window.api.createEvent(input, notify)
    store('lastCalendar', String(input.calendarId))
    noteSaved(input, saved)
  }

  // guests: the dialog's edit of the guest list. scope: which events of the user's own series change.
  async function update(eventId: number, input: EventInput, options: { notify?: boolean; guests?: GuestEdit; scope?: Scope }): Promise<void> {
    const { notify, guests, scope } = options
    const {
      title,
      start,
      end,
      allDay,
      startDate,
      endDate,
      location,
      description,
      reminders,
      conference,
      guestsCanModify,
      guestsCanInviteOthers,
      guestsCanSeeOtherGuests,
      timeZone,
      endTimeZone,
      repeat,
      colorKey
    } = input
    const patch = {
      title,
      start,
      end,
      allDay,
      startDate,
      endDate,
      location,
      description,
      reminders,
      guests,
      conference,
      guestsCanModify,
      guestsCanInviteOthers,
      guestsCanSeeOtherGuests,
      timeZone,
      endTimeZone,
      repeat,
      colorKey
    }
    const saved = await window.api.updateEvent(eventId, patch, { notify, scope })
    noteSaved(input, saved)
  }

  // "Event saved", like Google, or why the event will not show. Google may make a Meet link a moment later.
  // saved null: a series write gave the event a new id, so there is no copy to check.
  function noteSaved(input: EventInput, saved: CalendarEvent | null): void {
    if (noteOutside(input) || noteHiddenDays(input)) return
    const pending = input.conference && saved !== null && !saved.joinUrl && accountOf(input.calendarId)?.provider === 'google'
    showNote(pending ? 'Event saved. The Google Meet link will show after the next sync.' : 'Event saved')
  }

  // An event saved outside the synced dates of its calendar just vanishes: sync keeps only events that overlap them
  // (providers/google/sync.ts). So say why. first: what was done. true: it said so.
  function noteOutside(event: Times & { calendarId: number }, first = 'Event saved'): boolean {
    const calendar = calendars.find((c) => c.id === event.calendarId)
    // null: not synced yet, or hidden (its events do not show anyway).
    const own = calendar && syncedDates([calendar])
    if (!own || (event.end > calendar.windowStart! && event.start < calendar.windowEnd!)) return false
    showNote(`${first}. Only events from ${syncedText(own)} are synced. It will not show here.`, UNDO_MS)
    return true
  }

  // An event only on hidden weekend days would just vanish from the week and month views, so say why. true: it said so.
  function noteHiddenDays(input: EventInput): boolean {
    if (view === 'day' || view === 'schedule' || showWeekends) return false
    const first = input.allDay ? fromDateKey(input.startDate!) : startOfDay(new Date(input.start))
    // End dates are exclusive, so the last day is the day before.
    const last = input.allDay ? addDays(fromDateKey(input.endDate!), -1) : new Date(input.end - 1)
    for (let day = first; day <= last; day = addDays(day, 1)) if (day.getDay() !== 0 && day.getDay() !== 6) return false
    showNote('Event saved. Weekends are hidden.')
    return true
  }

  // A note never replaces an Undo toast, so the delete can still be undone. ms: longer for long text.
  function showNote(text: string, ms = NOTE_MS): void {
    if (toast?.undo) return
    toast = { text, undo: null }
    // The proxy Svelte stored, so a newer toast is not hidden by this timer.
    const note = toast
    setTimeout(() => toast === note && (toast = null), ms)
  }

  function closeSettings(): void {
    settingsOpen = false
    // After the dialog is gone: while it is open, the page behind it cannot take focus.
    void tick().then(() => gear?.focus())
  }

  async function saveSettings(next: Settings): Promise<void> {
    await window.api.saveSettings(next)
    prefs.settings = next
  }

  function openEvent(event: CalendarEvent, element: HTMLElement): void {
    if (event.id < 0) return
    selected = { event, anchor: element.getBoundingClientRect() }
  }

  // No menu for the new-event placeholder, view-only calendars, signed-out accounts, or an event being saved
  //, and none for an invite outside the main calendar without colors: it would be empty.
  function openColors(event: CalendarEvent, element: HTMLElement, e: MouseEvent): void {
    const calendar = calendars.find((c) => c.id === event.calendarId)
    const saving = moved.some((m) => m.id === event.id) || coloring.includes(event.id)
    if (event.id < 0 || !calendar?.canEdit || accountOf(event.calendarId)?.status === 'needs-sign-in' || saving) return
    if (isInvite(event) && !calendar.isPrimary && (event.cancelled || calendar.colors.length === 0)) return
    selected = null
    // A mouse right-click opens at the pointer, like Google. Shift+F10 and the menu key (button -1, checked live) open
    // next to the event.
    colorMenu = { event, anchor: e.button === 2 ? new DOMRect(e.clientX, e.clientY) : element.getBoundingClientRect() }
  }

  // A pick closes the menu. On the user's own series it asks This event / All events first, like Google.
  function pickColor(event: CalendarEvent, colorKey: string | null): void {
    colorMenu = null
    // The same color sends nothing.
    if (colorKey === event.colorKey || gone(event)) return
    // The same choices as choicesFor with ownOnly, without loading the series.
    if (ownSeries(event)) scoping = { event, times: null, choices: ['event', 'series'], guests: false, color: { key: colorKey } }
    else saveColor(event, colorKey, 'event')
  }

  // The chip changes with the reload after the write (main tells the views).
  function saveColor(event: CalendarEvent, colorKey: string | null, scope: Scope): void {
    coloring = [...coloring, event.id]
    window.api
      .updateEvent(event.id, { colorKey }, { scope })
      .then(
        () => {
          // Cleared first, so a screen reader says it again for a second pick.
          colorSaved = false
          const save = ++colorSaves
          void tick().then(() => {
            colorSaved = true
            setTimeout(() => save === colorSaves && (colorSaved = false), NOTE_MS)
          })
        },
        (e) => {
          const reason = navigator.onLine ? errorMessage(e) : 'You are offline.'
          toast = { text: `Could not save "${event.title || '(No title)'}". ${reason}`, undo: pendingDelete ? undoDelete : null }
        }
      )
      .finally(() => (coloring = coloring.filter((id) => id !== event.id)))
  }

  // True if the popover's event is no longer loaded (deleted, or back from sync with a new id). Then it says so in
  // a note, and the popover stays open, like Google Calendar.
  // Not checked: an event that sync only moved out of the shown range also counts as gone (no API reads one event).
  function gone(event: CalendarEvent): boolean {
    if (loaded.some((e) => e.id === event.id)) return false
    showNote('The event has been removed from your calendar.')
    return true
  }

  // In a view-only calendar only the reminders can change. An invitee cannot change the times. The dialog starts from
  // the stored guests and permissions.
  async function edit(event: CalendarEvent): Promise<void> {
    if (gone(event)) return
    selected = null
    const viewOnly = !calendars.find((c) => c.id === event.calendarId)?.canEdit
    const details = await window.api.getEventDetails(event.id)
    if (!details) return showNote('The event has been removed from your calendar.')
    // Offline, the dialog still opens: the repeat select says the rule did not load.
    const series = ownSeries(event) ? await window.api.getSeries(event.id).catch(() => null) : undefined
    dialog = {
      initial: inputOf(event),
      eventId: event.id,
      recurring: event.seriesRemoteId !== null,
      viewOnly,
      timesLocked: !canChangeTime(event),
      details,
      organizer: event.isOrganizer,
      joinUrl: event.joinUrl,
      series
    }
  }

  // The user's own repeating event: a change or delete asks which events, like Google. Invites change this event only.
  function ownSeries(event: CalendarEvent): boolean {
    const calendar = calendars.find((c) => c.id === event.calendarId)
    return isOwnSeries(event) && calendar?.canEdit === true
  }

  // Which events a drag (times) or a delete (null) can change. One choice needs no question, unless it is a split. An
  // Outlook drag moves this event only (choicesFor); an Outlook delete can still end the series.
  async function askScope(event: CalendarEvent, times: Times | null): Promise<void> {
    const series = ownSeries(event) && !event.cancelled ? await window.api.getSeries(event.id).catch(() => null) : null
    const outlook = !!times && accountOf(event.calendarId)?.provider === 'outlook'
    const choices = choicesFor(series, event, times ?? event, { outlook })
    if (asksScope(choices)) scoping = { event, times, choices, guests: !event.cancelled && (await hasGuestsToTell(event)) }
    else void afterScope(event, times, choices[0])
  }

  // Asks about update or cancellation emails next, like Google, while the popover stays open.
  async function afterScope(event: CalendarEvent, times: Times | null, scope: Scope): Promise<void> {
    if (!event.cancelled && (await hasGuestsToTell(event))) return void (asking = { event, times, scope })
    if (times) send(event, times, undefined, timesOf(event), scope)
    else startDelete(event, undefined, scope)
  }

  // A change to a meeting the user organizes emails the guests, so ask first. Rooms and the user do not count.
  async function hasGuestsToTell(event: CalendarEvent): Promise<boolean> {
    if (!event.isOrganizer || event.attendeeCount === 0) return false
    const details = await window.api.getEventDetails(event.id)
    return !!details && hasGuests(details.guests)
  }

  // Asks which events, then about cancellation emails, like Google.
  async function remove(event: CalendarEvent): Promise<void> {
    if (gone(event)) return
    await askScope(event, null)
  }

  // Hides the event at once and deletes it after UNDO_MS, unless Undo is pressed.
  // Outlook declines an invite; Google only takes it off this calendar, like Google web's "Remove from this calendar".
  // "This and following" has no Undo, like Google: it goes at once.
  function startDelete(event: CalendarEvent, notify?: boolean, scope: Scope = 'event'): void {
    focusNext(event.id)
    selected = null
    commitDelete()
    const google = accountOf(event.calendarId)?.provider === 'google'
    pendingDelete = { event, scope, decline: false, notify, timer: setTimeout(commitDelete, UNDO_MS) }
    const text = event.cancelled || (google && isInvite(event)) ? 'Event removed' : isInvite(event) ? 'Event declined' : 'Event deleted'
    if (scope === 'following') {
      commitDelete()
      return showNote(text)
    }
    toast = { text, undo: undoDelete }
  }

  // Like Google: the popover closes at once and a note says how it went. Outlook takes a declined meeting off the
  // calendar, so there "No" waits UNDO_MS like a delete, as Outlook web's "Reply sent" with Undo.
  function respond(event: CalendarEvent, answer: Answer, scope: Scope): void {
    if (gone(event)) return
    selected = null
    commitDelete()
    if (answer === 'declined' && accountOf(event.calendarId)?.provider === 'outlook') {
      focusNext(event.id)
      pendingDelete = { event, scope, decline: true, timer: setTimeout(commitDelete, UNDO_MS) }
      toast = { text: 'Reply sent', undo: undoDelete }
      return
    }
    // An Outlook sign-in renew can take a minute, so say at once that the answer is on its way.
    toast = { text: 'Sending…', undo: null }
    window.api.respondEvent(event.id, answer, scope).then(
      () => showNote(`Responded '${ANSWER_LABELS[answer]}' to "${event.title || '(No title)'}"`),
      // Keeps the Undo of a delete that is still waiting.
      (e) => (toast = { text: answerError(event, e), undo: pendingDelete ? undoDelete : null })
    )
  }

  // The popover is closed by then, so say which event failed.
  function answerError(event: CalendarEvent, e: unknown): string {
    return `Could not send your answer to "${event.title || '(No title)'}". ${navigator.onLine ? errorMessage(e) : 'You are offline.'}`
  }

  // The list on screen (search results or the Schedule view), where Delete and Undo move focus. Week and month: none.
  const shownList = (): ScheduleList | undefined => (found ? results : view === 'schedule' ? schedule : undefined)

  // The event leaves the screen: focus goes to the next row in a list, or in Week and Month to the event's day (else
  // the grid's tab stop), not the page.
  function focusNext(id: number): void {
    const list = shownList()
    if (list) return list.focusNext(id)
    // Read now, while the event is still on screen.
    const day = document.querySelector(`main [data-id="${id}"]:not([aria-hidden])`)?.closest<HTMLElement>('[role="gridcell"]')
    void tick().then(() => {
      if (document.activeElement === document.body)
        (day?.isConnected ? day : document.querySelector<HTMLElement>('main [role="gridcell"][tabindex="0"]'))?.focus({ preventScroll: true })
    })
  }

  const sameSeries = (a: CalendarEvent, b: CalendarEvent): boolean =>
    a.seriesRemoteId !== null && a.seriesRemoteId === b.seriesRemoteId && a.calendarId === b.calendarId

  function commitDelete(): void {
    if (!pendingDelete) return
    const { event, timer, scope, decline, notify } = pendingDelete
    clearTimeout(timer)
    pendingDelete = null
    toast = null
    // A "No" to all events of an Outlook series removes every one of them, like a delete of all events.
    const ids =
      scope === 'event' ? [event.id] : loaded.filter((e) => sameSeries(e, event) && (scope === 'series' || e.start >= event.start)).map((e) => e.id)
    deleting = [...deleting, ...ids]
    // Only a list loaded after the delete is sure not to have the event; a sync may load one before that.
    // The error toast is only for a failed delete, not for a failed reload.
    ;(decline ? window.api.respondEvent(event.id, 'declined', scope) : window.api.deleteEvent(event.id, { notify, scope }))
      .then(reload, (e) => {
        const reason = navigator.onLine ? errorMessage(e) : 'You are offline.'
        toast = {
          text: decline
            ? answerError(event, e)
            : `Could not delete "${event.title || '(No title)'}". ${reason}`,
          undo: pendingDelete ? undoDelete : null
        }
      })
      .finally(() => (deleting = deleting.filter((id) => !ids.includes(id))))
  }

  function undoDelete(): void {
    if (!pendingDelete) return
    const list = shownList()
    const { id } = pendingDelete.event
    if (list) list.focusEvent(id)
    // Week and Month: back on the event's chip, found by its id. Not drawn (folded, under "N more", other week): the grid.
    else
      void tick().then(() => {
        const chip = document.querySelector<HTMLElement>(`main [data-id="${id}"]:not([aria-hidden])`)
        if (chip) chip.focus()
        else focusNext(id)
      })
    clearTimeout(pendingDelete.timer)
    pendingDelete = null
    toast = null
  }

  // Who may drag an event: not the new-event placeholder, not in a view-only calendar or a signed-out account, not
  // a canceled meeting or one being saved, and an invite only when Google lets guests change it.
  function canDrag(event: CalendarEvent): boolean {
    const calendar = calendars.find((c) => c.id === event.calendarId)
    const saving = moved.some((m) => m.id === event.id)
    return (
      event.id >= 0 &&
      calendar?.canEdit === true &&
      !event.cancelled &&
      accountOf(event.calendarId)?.status !== 'needs-sign-in' &&
      canChangeTime(event) &&
      !saving
    )
  }

  // A drop from the grid. On the user's own series it asks which events move, like Google.
  async function moveEvent(event: CalendarEvent, times: Times): Promise<void> {
    // A drop at the same place sends nothing, like Google.
    if (times.start === event.start && times.end === event.end) return
    if (gone(event)) return
    commitDelete()
    await askScope(event, times)
  }

  // Shows the new times at once and saves them. before: the times Undo goes back to; null: this is the Undo.
  // Undo sends the same notify choice and does not ask again. Other scopes have no Undo, like Google.
  function send(event: CalendarEvent, times: Times, notify: boolean | undefined, before: Times | null, scope: Scope = 'event'): void {
    // A resize keeps the start; a move changes it. Only the toast words differ.
    const resize = times.start === event.start
    moved = [...moved.filter((m) => m.id !== event.id), { ...event, ...times }]
    // An Outlook sign-in renew can take a while. A waiting delete keeps its Undo toast.
    if (!pendingDelete) toast = { text: before ? 'Saving…' : 'Undoing…', undo: null }
    window.api.updateEvent(event.id, timesOf(times), { notify, scope }).then(
      (saved) => {
        if (scope !== 'event' || !saved) {
          // Other events moved too, and Google gave them new ids: show a fresh read, then drop the moved copy.
          void reload().finally(() => (moved = moved.filter((m) => m.id !== event.id)))
          if (!pendingDelete) showNote(resize ? 'Event saved' : rescheduled({ ...event, ...times }))
          return
        }
        // Stored now, so the event does not jump back before the reload.
        events = events.map((e) => (e.id === saved.id ? saved : e))
        if (search?.events) search.events = search.events.map((e) => (e.id === saved.id ? saved : e))
        moved = moved.filter((m) => m.id !== event.id)
        if (pendingDelete) return
        if (!before) return showNote('Undone')
        // Sync drops an event moved outside the synced dates, and then Undo would fail. So no Undo, and say why.
        if (noteOutside(saved, rescheduled(saved))) return
        // Undo starts from the live copy, so a title synced in the meantime stays.
        const undo = (): void => send(loaded.find((e) => e.id === saved.id) ?? saved, before, notify, null)
        toast = { text: resize ? 'Event saved' : rescheduled(saved), undo }
        // The proxy Svelte stored, so a newer toast is not hidden by this timer.
        const shownToast = toast
        setTimeout(() => toast === shownToast && (toast = null), UNDO_MS)
      },
      (e) => {
        moved = moved.filter((m) => m.id !== event.id)
        const reason = navigator.onLine ? errorMessage(e) : 'You are offline.'
        const title = event.title || '(No title)'
        toast = { text: `Could not ${resize ? 'save' : 'move'} "${title}". ${reason}`, undo: pendingDelete ? undoDelete : null }
      }
    )
  }

  // Plain copies of the time fields: IPC cannot send a state proxy.
  const timesOf = ({ start, end, allDay, startDate, endDate }: Times): Times => ({ start, end, allDay, startDate, endDate })

  function rescheduled(e: CalendarEvent): string {
    if (e.allDay) return `Event rescheduled to ${formats.fullDate.format(fromDateKey(e.startDate!))}`
    return `Event rescheduled to ${formats.monthDay.format(e.start)}, ${formats.time.format(e.start)}`
  }

  function onKey(e: KeyboardEvent): void {
    if (e.metaKey || e.altKey || e.defaultPrevented) return
    const target = e.target as HTMLElement
    if (target.closest('input, textarea, select, [contenteditable]')) return
    // Keys never act behind a modal dialog: all are native <dialog>s that exist only while open. Quick create (a
    // popover) stops the Ctrl keys too.
    if (draft || document.querySelector('dialog[open]')) return
    // Ctrl only for these two, like Google. Other Ctrl keys stay the browser's, and Ctrl+Shift+Z (redo) never undoes.
    // Help does not open over a popover (the event's too): one Esc would close both.
    if (e.ctrlKey) {
      if (e.key === '/' && !document.querySelector('[role="dialog"]')) helpOpen = true
      else if (e.key.toLowerCase() === 'z' && !e.shiftKey && toast?.undo) toast.undo()
      else return
      e.preventDefault()
      return
    }
    // Before the Escape below: Esc with the popover open only closes the popover (its own window listener).
    if (selected) {
      // Same rule as the popover buttons: read-only calendars cannot delete, and "e" there edits only the reminders.
      // Invites can be removed only in the main calendar.
      // A canceled meeting can only be removed.
      const event = selected.event
      const calendar = calendars.find((c) => c.id === event.calendarId)
      const canEdit = calendar?.canEdit
      if (e.key === 'e' && !event.cancelled) void edit(event)
      else if ((e.key === 'Delete' || e.key === 'Backspace') && canEdit && (!isInvite(event) || calendar!.isPrimary)) void remove(event)
      else return
      // Else the edit dialog's title field, focused at once, also gets the key.
      e.preventDefault()
      return
    }
    // Keys pressed while another popover is open (the month "more" list) belong to it, even if focus fell out of it.
    if (document.querySelector('[role="dialog"]')) return
    const key = e.key.toLowerCase()
    if (key === 'escape' && search) closeSearch()
    else if (key === '/') openSearch()
    else if (key === '?') helpOpen = true
    else if (key === 't') goToday()
    else if (key === 'd' || key === '1') setView('day')
    else if (key === 'w' || key === '2') setView('week')
    else if (key === 'm' || key === '3') setView('month')
    else if (key === 'a' || key === '5') setView('schedule')
    else if (key === 'j' || key === 'n') step(1)
    else if (key === 'k' || key === 'p') step(-1)
    else if (key === 'g') goToOpen = true
    else if (key === 'c') createFromKeyboard()
    else if (key === 'r') void window.api.syncNow()
    else if (key === 's') settingsOpen = true
    // Undo while the toast still offers it, like Google's "if possible".
    else if (key === 'z' && toast?.undo) toast.undo()
    else return
    e.preventDefault()
  }

  const accountOf = (calendarId: number): Account | undefined => {
    const calendar = calendars.find((c) => c.id === calendarId)
    return accounts.find((a) => a.id === calendar?.accountId)
  }
</script>

<!-- A pending delete is sent before the window goes away. -->
<svelte:window onkeydown={onKey} onpagehide={commitDelete} />

<div class="shell pz-shell">
  <!-- Palazzo frame: an Ionic column beside the sidebar and a moulding under the top bar. Never inside the content. -->
  <div class="pz-column column" aria-hidden="true">
    <div class="pz-ornament pz-column-capital"></div>
    <div class="pz-ornament pz-column-shaft"></div>
    <div class="pz-ornament pz-column-base"></div>
  </div>
  <div class="pz-ornament pz-moulding moulding" aria-hidden="true"></div>
  <header class="top">
    {#if search}
      <button class="icon-btn" aria-label="Go back" title="Go back" onclick={closeSearch}>
        <svg viewBox="0 0 24 24"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z" /></svg>
      </button>
      <h1 class="brand search-title">Search</h1>
      <form
        class="search"
        role="search"
        onsubmit={(e) => {
          e.preventDefault()
          // Only spaces: nothing happens.
          if (!search?.text.trim()) return
          search.ran = search.text.trim()
          void runSearch(search.ran, true)
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9"
          />
        </svg>
        <!-- Esc here leaves search: the window key handler skips text fields. -->
        <input
          bind:this={searchBox}
          bind:value={search.text}
          aria-label="Search"
          placeholder="Search"
          maxlength="200"
          autocomplete="off"
          onkeydown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            closeSearch()
          }}
        />
        {#if search.text}
          <button
            type="button"
            class="icon-btn"
            aria-label="Clear search"
            title="Clear search"
            onclick={() => {
              search!.text = ''
              searchBox?.focus()
            }}
          >
            <svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z" /></svg>
          </button>
        {/if}
      </form>
    {:else}
      <div class="brand">Busy Peasy</div>
      <button class="pill-btn" title="Today (t)" onclick={goToday}>Today</button>
      <button class="icon-btn" aria-label="Previous {view === 'schedule' ? 'day' : view}" title="Previous (k)" onclick={() => step(-1)}>
        <svg viewBox="0 0 24 24"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4-4.6-4.6z" /></svg>
      </button>
      <button class="icon-btn" aria-label="Next {view === 'schedule' ? 'day' : view}" title="Next (j)" onclick={() => step(1)}>
        <svg viewBox="0 0 24 24"><path d="M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z" /></svg>
      </button>
      <!-- Like a carved stone calendar (Fasti): the period between two title rules. -->
      <h1 class="title pz-fasti" aria-live="polite">
        <span class="pz-title-rule"></span><span>{title}</span><span class="pz-title-rule"></span>
      </h1>
      <div class="views" role="group" aria-label="View">
        {#each VIEWS as v (v.id)}
          <button class="view-btn pz-label" aria-pressed={view === v.id} title="{v.label} ({v.key})" onclick={() => setView(v.id)}>
            {v.label}
          </button>
        {/each}
      </div>
      <button bind:this={magnifier} class="icon-btn" aria-label="Search" title="Search (/)" onclick={openSearch}>
        <svg viewBox="0 0 24 24">
          <path
            d="M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9"
          />
        </svg>
      </button>
    {/if}
    <button bind:this={gear} class="icon-btn" aria-label="Settings" title="Settings" onclick={() => (settingsOpen = true)}>
      <svg viewBox="0 0 24 24"><path d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L14.9 3h-4l-.4 2.9a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.4 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1l.4 2.9h4l.4-2.9a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM12.9 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7" /></svg>
    </button>
  </header>

  <Sidebar
    {accounts}
    {calendars}
    {anchor}
    weekStart={weekStartDay}
    onpick={goTo}
    oncreate={createFromKeyboard}
  />

  <main class="card pz-panel">
    {#each signedOut as account (account.id)}
      <div class="banner" role="alert">
        <span>
          <strong>{account.email}</strong> is signed out. Its events and reminders may be out of date until you sign in.
        </span>
        <button
          class="pill-btn"
          disabled={signIn.busy}
          onclick={() => signInAgain(account)}
        >
          {signIn.outlookOpen && account.provider === 'outlook' ? 'Start over' : 'Sign in'}
        </button>
      </div>
    {/each}
    <!-- Always here, so a screen reader reads the text when it comes. -->
    <div class="note-bar" role="status">{#if outside && synced}Only events from {syncedText(synced)} are synced. Days outside these dates show no events.{/if}</div>
    <div class="sr-only" role="status">{#if colorSaved}Event saved{/if}</div>
    <!-- The toasts' text, here always: a live region that comes with its text is often not read. Each new toast makes a
         new text node, so the same text is read again. -->
    <div class="sr-only" role="status" aria-atomic="true">{#key toast}{toast?.text ?? ''}{/key}</div>
    {#if search}
      <h2 class="sr-only" aria-live="polite">
        {#if found}Search results. {found.length ? `${found.length} ${found.length === 1 ? 'event' : 'events'} found.` : 'No events found.'}{/if}
      </h2>
    {/if}
    {#if found}
      <ScheduleList bind:this={results} days={scheduleDays(found, null)} {calendars} years onopen={openEvent} onmenu={openColors} onday={showDay}>
        {#if !found.length}
          <p class="empty">No results found</p>
        {/if}
        {#if search?.more}
          <p class="list-note">Showing the 200 events closest to today.</p>
        {/if}
        {#if synced}
          <p class="list-note">Search finds only events from {syncedText(synced)}. Other dates are not synced.</p>
        {/if}
      </ScheduleList>
    {:else if view === 'schedule'}
      {@const first = startOfDay(anchor)}
      {@const list = scheduleDays(shown, first)}
      <h2 class="sr-only">
        Schedule starting {formats.fullDate.format(first)}, {list.reduce((n, d) => n + d.events.length, 0)} events
      </h2>
      <ScheduleList bind:this={schedule} days={list} {calendars} years={false} onopen={openEvent} onmenu={openColors} onday={showDay}>
        {#snippet top()}
          {#if synced && first < synced.from}
            <p class="list-note">Showing events from {formats.date.format(synced.from)}. Earlier events are not synced.</p>
          {/if}
        {/snippet}
        {#if synced}
          <p class="list-note">Showing events until {formats.date.format(addDays(synced.to, -1))}. Later events are not synced.</p>
        {/if}
      </ScheduleList>
    {:else if view === 'month'}
      <MonthView
        bind:this={month}
        start={range.start}
        month={anchor.getMonth()}
        weekends={showWeekends}
        events={shown}
        {calendars}
        {canDrag}
        {newEvent}
        onopen={openEvent}
        onmenu={openColors}
        oncreate={startCreate}
        onmove={moveEvent}
        onday={showDay}
      />
    {:else}
      <WeekView
        bind:this={week}
        {days}
        events={shown}
        {calendars}
        secondary={settings.secondaryTimeZone ? { zone: settings.secondaryTimeZone, label: settings.secondaryTimeZoneLabel } : null}
        {canDrag}
        {newEvent}
        onopen={openEvent}
        onmenu={openColors}
        oncreate={startCreate}
        onmove={moveEvent}
        onday={showDay}
      />
    {/if}
  </main>
</div>

{#if selected}
  {@const open = selected}
  <EventPopover
    bind:this={popover}
    event={open.event}
    calendar={calendars.find((c) => c.id === open.event.calendarId)}
    account={accountOf(open.event.calendarId)}
    anchor={open.anchor}
    onclose={() => (selected = null)}
    onedit={() => edit(open.event)}
    ondelete={() => remove(open.event)}
    oncopy={() =>
      // A toast like Google's "Successfully copied to clipboard". The popover stays open.
      window.api.copyText(open.event.joinUrl!).then(
        () => showNote('Meeting link copied'),
        () => showNote('Could not copy the meeting link')
      )}
    onrespond={(answer, scope) => respond(open.event, answer, scope)}
  />
{/if}

{#if colorMenu}
  {@const menu = colorMenu}
  {@const calendar = calendars.find((c) => c.id === menu.event.calendarId)}
  {#if calendar}
    <ColorMenu
      event={menu.event}
      {calendar}
      account={accountOf(calendar.id)}
      anchor={menu.anchor}
      onclose={() => (colorMenu = null)}
      ondelete={() => {
        // Read before clearing: menu and calendar are null after.
        const { event } = menu
        colorMenu = null
        void remove(event)
      }}
      onpick={(key) => pickColor(menu.event, key)}
      onsignin={() => {
        const account = accountOf(calendar.id)!
        colorMenu = null
        signInAgain(account)
      }}
    />
  {/if}
{/if}

{#if draft}
  <QuickCreate
    bind:draft={draft.input}
    calendars={writable}
    anchor={draft.anchor}
    onsave={create}
    onmore={() => {
      dialog = { initial: draft!.input, eventId: null, recurring: false, viewOnly: false, timesLocked: false }
      draft = null
    }}
    onclose={() => (draft = null)}
  />
{/if}

{#if dialog}
  {@const open = dialog}
  <EventDialog
    initial={open.initial}
    calendars={writable}
    {accounts}
    editing={open.eventId !== null}
    recurring={open.recurring}
    viewOnly={open.viewOnly}
    timesLocked={open.timesLocked}
    details={open.details}
    organizer={open.organizer}
    joinUrl={open.joinUrl}
    {defaultReminders}
    series={open.series}
    onsave={(input, options) => (open.eventId === null ? create(input, options.notify) : update(open.eventId, input, options))}
    onclose={() => (dialog = null)}
  />
{/if}

{#if asking}
  <SendUpdates
    provider={accountOf(asking.event.calendarId)?.provider ?? 'google'}
    kind={asking.times ? 'move' : 'delete'}
    onanswer={(notify) => {
      // Read before clearing: asking is null after.
      const { event, times, scope } = asking!
      asking = null
      if (notify === null) {
        // Cancel on the delete question: back to Delete, like Google.
        if (!times) popover?.focusDelete()
        return
      }
      if (times) send(event, times, notify, timesOf(event), scope)
      else startDelete(event, notify, scope)
    }}
  />
{/if}

{#if scoping}
  <ScopeDialog
    kind={scoping.times || scoping.color ? 'edit' : 'delete'}
    choices={scoping.choices}
    guests={scoping.guests}
    onanswer={(scope) => {
      // Read before clearing: scoping is null after.
      const { event, times, color } = scoping!
      scoping = null
      // Cancel: a dragged event stays where it was; a delete goes back to Delete, like Google.
      if (scope === null) return void (!times && !color && popover?.focusDelete())
      if (color) return saveColor(event, color.key, scope)
      void afterScope(event, times, scope)
    }}
  />
{/if}

{#if settingsOpen}
  <SettingsDialog initial={settings} onsave={saveSettings} onclose={closeSettings} />
{/if}

{#if helpOpen}
  <ShortcutHelp onclose={() => (helpOpen = false)} />
{/if}

{#if goToOpen}
  <GoToDate
    initial={anchor}
    ongo={(day) => {
      goToOpen = false
      goTo(day)
    }}
    onclose={() => (goToOpen = false)}
  />
{/if}

{#if toast}
  <!-- Read by the live region above. Every toast has Close, like Google; some have no timer (errors). -->
  <div class="toast pz-panel">
    <span>{toast.text}</span>
    {#if toast.undo}
      <button class="toast-btn pz-label" onclick={toast.undo}>Undo</button>
    {/if}
    <button class="toast-btn close" aria-label="Close" onclick={() => (toast = null)}>
      <svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z" /></svg>
    </button>
  </div>
{/if}

<style>
  /* The middle 2rem track holds the column, so it never covers the sidebar or the card. */
  .shell {
    position: relative;
    display: grid;
    grid-template-columns: 16rem 2rem minmax(0, 1fr);
    grid-template-rows: 4rem minmax(0, 1fr);
    height: 100%;
  }

  /* Absolute in its grid area, beside the card from top to bottom. Not in the top bar: in a narrow window the bar's
     buttons slide over this track. Both lines set: on an absolute item, an auto end line means the grid's far edge. */
  .column {
    grid-column: 2 / 3;
    grid-row: 2 / 3;
    bottom: 1rem;
    inset-inline-end: 2px;
  }

  /* The top bar's bottom edge, as wide as the card below it. Its buttons are centered, so it covers none of them. */
  .moulding {
    grid-column: 3;
    grid-row: 1;
    align-self: end;
    margin: 0 1rem 0.375rem 0;
    pointer-events: none;
  }

  /* Rows set by hand: the moulding shares row 1, so auto placement would push the bar down. */
  .top {
    grid-row: 1;
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0 1rem;
  }

  /* Wide enough that Today starts above the card. In a narrow window it shrinks and wraps first. */
  .brand {
    width: 16.75rem;
    line-height: 1.2;
    font-family: var(--font-family-display);
    font-size-adjust: none;
    font-size: 1.125rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--on-surface);
  }

  .top .pill-btn {
    margin-right: 0.5rem;
  }

  /* After the back button, so the box still starts above the card, like Google. */
  .search-title {
    width: 13.5rem;
    margin: 0;
    font-weight: 400;
  }

  .search {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    max-width: 40rem;
    height: 3rem;
    margin-right: auto;
    padding: 0 0.25rem 0 1rem;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .search > svg {
    flex: none;
    width: 1.5rem;
    height: 1.5rem;
    fill: var(--on-surface-variant);
  }

  .search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 1rem;
    outline: none;
  }

  /* The box has no outline of its own, so the pill shows focus. */
  .search:focus-within {
    outline: 2px solid var(--accent);
  }

  /* Cuts the title and its rules in a narrow window, so they never run over the view buttons. */
  .title {
    flex: 1;
    margin: 0 0 0 0.75rem;
    font-size: 1.25rem;
    line-height: 1.75rem;
    overflow: hidden;
  }

  /* Never squeezed: Cinzel labels are wide, and a cut view button is unusable. */
  .views {
    flex: none;
    display: flex;
    margin-right: 0.5rem;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
    overflow: hidden;
  }

  .view-btn {
    height: 2.375rem;
    padding: 0 0.875rem;
    border: 0;
    background: transparent;
    color: var(--on-surface-variant);
    cursor: pointer;
  }

  .view-btn:hover {
    background: var(--hover);
    color: var(--on-surface);
  }

  /* Active: the accent wash with a full outline, never a bar on one side. */
  .view-btn[aria-pressed='true'] {
    background: var(--accent-wash);
    color: var(--accent-ink);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 45%, var(--accent-wash));
  }

  .card {
    display: flex;
    flex-direction: column;
    grid-row: 2;
    grid-column: 3;
    margin: 0 1rem 1rem 0;
    min-height: 0;
    overflow: hidden;
  }

  .banner {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 1rem 0.75rem 1.5rem;
    border-bottom: 1px solid color-mix(in oklab, var(--danger) 30%, var(--line));
    background: var(--danger-wash);
    color: var(--danger);
  }

  .banner span {
    flex: 1;
  }

  .note-bar {
    padding: 0.75rem 1.5rem;
    background: var(--surface-high);
  }

  .note-bar:empty {
    display: none;
  }

  .empty {
    margin: 4rem 0 1rem;
    font-size: 1.375rem;
    text-align: center;
  }

  .list-note {
    margin: 1rem 1.5rem 0;
    color: var(--on-surface-variant);
  }

  /* Bottom center, like Google. */
  .toast {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: 1.5rem;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 1.5rem;
    min-width: 18rem;
    max-width: min(40rem, calc(100vw - 2rem));
    padding: 0.5rem 0.5rem 0.5rem 1rem;
    color: var(--on-surface);
    box-shadow: var(--shadow-float);
  }

  .toast span {
    flex: 1;
  }

  .toast-btn {
    height: 2.25rem;
    padding: 0 0.75rem;
    border: 0;
    border-radius: var(--radius);
    background: transparent;
    color: var(--accent-ink);
    cursor: pointer;
  }

  .toast-btn:hover {
    background: var(--hover);
  }

  .close {
    display: grid;
    place-items: center;
    width: 2.25rem;
    padding: 0;
    margin-left: -1rem;
    color: var(--on-surface-variant);
  }

  .close svg {
    width: 1.25rem;
    height: 1.25rem;
    fill: currentColor;
  }

  @media (forced-colors: active) {
    .views,
    .search,
    .note-bar,
    .toast {
      border: 1px solid CanvasText;
    }

    /* The pressed view is a background, which forced colors remove. */
    .view-btn[aria-pressed='true'] {
      forced-color-adjust: none;
      background: Highlight;
      color: HighlightText;
    }
  }
</style>
