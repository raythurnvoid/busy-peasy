<script lang="ts">
  import { tick } from 'svelte'
  import type { Account, Calendar, EventDetails, EventInput, EventReminder, GuestEdit, Repeat, Scope, Series } from '../../../shared/api'
  import { GUEST_FLAGS, SHOWN, hasGuests, hasOwnCall, labelsHint, withoutOwn } from '../../../shared/events'
  import { fitsDate, moveRepeat, sameRepeat, weekday } from '../../../shared/repeat'
  import { asksScope, choicesFor, presets, repeatText } from '../lib/repeat'
  import { formats, prefs } from '../lib/settings.svelte'
  import { errorMessage } from '../lib/sign-in.svelte'
  import { addDays, dateKey, fromDateKey, localeWeekStart, pcZone, wallTime, zoneLabel, zoneOffset, zonedTime } from '../lib/time'
  import GuestList, { type GuestRow } from './GuestList.svelte'
  import ReminderList from './ReminderList.svelte'
  import RepeatDialog from './RepeatDialog.svelte'
  import ScopeDialog from './ScopeDialog.svelte'
  import SendUpdates from './SendUpdates.svelte'
  import ZoneDialog from './ZoneDialog.svelte'

  // Create or edit one event. For the user's own series, Save asks which events change, like Google.
  let {
    initial,
    calendars,
    accounts,
    editing,
    recurring = false,
    viewOnly = false,
    timesLocked = false,
    details = undefined,
    organizer = true,
    joinUrl = null,
    series = undefined,
    defaultReminders,
    onsave,
    onclose
  }: {
    initial: EventInput
    // Calendars the user can write to. The select uses them when creating.
    calendars: Calendar[]
    accounts: Account[]
    editing: boolean
    recurring?: boolean
    // An event in a view-only calendar: only its reminders can change.
    viewOnly?: boolean
    // An invite the organizer did not open to guests: its times cannot change.
    timesLocked?: boolean
    // An edit: the stored guests and permissions, and the event's video call link.
    details?: EventDetails
    // Only the organizer changes guests, permissions and the video call.
    organizer?: boolean
    joinUrl?: string | null
    // An edit of the user's own series: its rule. null: it could not be loaded.
    series?: Series | null
    // What a new event in the calendar gets when the user does not change its reminders.
    defaultReminders: (calendarId: number, meeting?: boolean, allDay?: boolean) => EventReminder[]
    // notify: the answer to the send question (undefined: not asked). guests: an edit's change to the guest list.
    // scope: which events of the user's own series change.
    onsave: (input: EventInput, options: { notify?: boolean; guests?: GuestEdit; scope?: Scope }) => Promise<void>
    onclose: () => void
  } = $props()

  // Google's labels; ours for Teams (Outlook web's not checked).
  const CALLS = {
    meet: { add: 'Add Google Meet video conferencing', name: 'Google Meet video conferencing', added: 'Google Meet is added' },
    teams: { add: 'Add Teams meeting', name: 'Teams meeting', added: 'Teams meeting is added' }
  }

  // Dates are YYYY-MM-DD and times HH:MM, as the date and time inputs use them, in the event's own zones (IANA), like
  // Google's and Outlook's edit pages.
  interface Form {
    title: string
    allDay: boolean
    startDate: string
    startTime: string
    endDate: string
    endTime: string
    startZone: string
    endZone: string
    calendarId: number
    location: string
    description: string
    // One list per kind, like Google: All day shows the other list as it was, never a converted one.
    reminders: { timed: EventReminder[]; allDay: EventReminder[] }
    // Without the organizer, in the order shown.
    guests: GuestRow[]
    guestsCanModify: boolean
    guestsCanInviteOthers: boolean
    guestsCanSeeOtherGuests: boolean
    // The event has a video call after the save.
    conference: boolean
    // null: Does not repeat.
    repeat: Repeat | null
    // A key of the calendar's colors. null: Default.
    colorKey: string | null
  }

  // The form keeps all-day end dates inclusive, like people say them ("Mon to Wed").
  // An edit shows the event's zones (this PC's when it has none); a new event gets its calendar's, as Google gives it.
  function formOf(input: EventInput): Form {
    const startZone = (details ? details.timeZone : calendars.find((c) => c.id === input.calendarId)?.timeZone) ?? pcZone()
    const endZone = details?.endTimeZone ?? startZone
    const start = wallTime(input.start, startZone)
    const end = wallTime(input.end, endZone)
    const own = input.reminders ?? defaultReminders(input.calendarId, false, input.allDay)
    // The other kind starts with its defaults (meeting ones once the event has guests or a call).
    const meeting = (details?.guests ?? []).some((g) => !g.organizer) || joinUrl !== null
    return {
      title: input.title,
      allDay: input.allDay,
      startDate: input.allDay ? input.startDate! : start.date,
      startTime: input.allDay ? '09:00' : start.time,
      endDate: input.allDay ? dateKey(addDays(fromDateKey(input.endDate!), -1)) : end.date,
      endTime: input.allDay ? '10:00' : end.time,
      startZone,
      endZone,
      calendarId: input.calendarId,
      location: input.location,
      description: input.description,
      reminders: {
        timed: input.allDay ? defaultReminders(input.calendarId, meeting, false) : own,
        allDay: input.allDay ? own : defaultReminders(input.calendarId, meeting, true)
      },
      guests: (details?.guests ?? []).filter((g) => !g.organizer).map((g) => ({ email: g.email, name: g.name, optional: !!g.optional })),
      // Google's defaults for a new event.
      guestsCanModify: details?.guestsCanModify ?? false,
      guestsCanInviteOthers: details?.guestsCanInviteOthers ?? true,
      guestsCanSeeOtherGuests: details?.guestsCanSeeOtherGuests ?? true,
      conference: joinUrl !== null,
      repeat: series?.repeat ?? null,
      colorKey: input.colorKey ?? null
    }
  }

  // svelte-ignore state_referenced_locally
  const start = formOf(initial)
  // Its own copy: the form changes its lists in place.
  // svelte-ignore state_referenced_locally
  let form = $state(formOf(initial))
  let saving = $state(false)
  let error = $state('')
  let dialog: HTMLDialogElement | undefined = $state()
  let saveButton: HTMLButtonElement | undefined = $state()
  const dirty = $derived(JSON.stringify(form) !== JSON.stringify(start))

  const calendar = $derived(calendars.find((c) => c.id === form.calendarId))
  const account = $derived(accounts.find((a) => a.id === calendar?.accountId))
  const google = $derived(account?.provider === 'google')
  // Guests, permissions and the video call. Not for invites (the popover lists their guests) or view-only calendars.
  const showMeeting = $derived(organizer && !viewOnly && account !== undefined)
  // Google lists the organizer; a new event's organizer is the account.
  const host = $derived(details?.guests.find((g) => g.organizer) ?? { email: account?.email ?? '', name: undefined })
  // Never guests: the organizer and the user.
  const own = $derived([host.email, account?.email ?? ''].map((email) => email.toLowerCase()))
  const call = $derived(calendar?.conference ? CALLS[calendar.conference] : null)
  // A saved Meet call can be removed. Teams cannot be turned off, and a link in the location or description is no call.
  const removable = $derived(joinUrl === null || (google && hasOwnCall({ joinUrl, location: initial.location, description: initial.description })))
  const colorHint = $derived(!!calendar && labelsHint(calendar, account))

  let addCallButton: HTMLButtonElement | undefined = $state()
  let removeCallButton: HTMLButtonElement | undefined = $state()
  // Google's live texts: "<email> added to the event." and the like.
  let status = $state('')
  // Meet comes with the first guest, like Google, but once per dialog: never again after the user removed it.
  let autoCall = false

  // The user chose the zones in this dialog. Only then they are sent: else Google gives the calendar's zone and Outlook
  // this PC's (or the event keeps its own).
  let zonePicked = $state(false)
  let zoneOpen = $state(false)
  // The moments the fields say. NaN while a field is empty.
  const startMs = $derived(zonedTime(form.startDate, form.startTime, form.startZone))
  const endMs = $derived(zonedTime(form.endDate, form.endTime, form.endZone))
  const valid = $derived(!Number.isNaN(startMs) && !Number.isNaN(endMs))
  const separate = $derived(form.startZone !== form.endZone)
  const clocksDiffer = $derived(
    valid && (zoneOffset(startMs, form.startZone) !== zoneOffset(startMs, pcZone()) || zoneOffset(endMs, form.endZone) !== zoneOffset(endMs, pcZone()))
  )
  // Like Google, the zone shows when it is not the main zone; ours is this PC's, compared by clock (a Lisbon calendar on
  // a London PC shows none). Also right after a pick, so the user sees it took.
  const zoneShown = $derived(valid && (clocksDiffer || separate || zonePicked))
  // Not in Google's edit page: this dialog hides the grid, so it says the user's own times. Differs on purpose.
  const localTimes = $derived.by(() => {
    // None while the end is before the start: a backwards range reads like a long event. Save says what is wrong.
    if (!clocksDiffer || endMs <= startMs) return ''
    const at = (ms: number): string => `${formats.dayShort.format(ms)}, ${formats.time.format(ms)}`
    // Across two local days, formatRange would add numeric dates: name each day instead.
    if (dateKey(new Date(startMs)) !== dateKey(new Date(endMs))) return `${at(startMs)} – ${at(endMs)} in your time zone`
    const day = dateKey(new Date(startMs)) === form.startDate ? '' : `${formats.dayShort.format(startMs)}, `
    return `${day}${formats.time.formatRange(startMs, endMs)} in your time zone`
  })
  // The zone text and the local times (only when the zone shows) each time field points to, for screen readers.
  const local = $derived(localTimes ? ' local-times' : '')
  const startNote = $derived(!zoneShown || form.allDay ? undefined : `${separate ? 'start-zone' : 'zone-text'}${local}`)
  const endNote = $derived(!zoneShown || form.allDay ? undefined : `${separate ? 'end-zone' : 'zone-text'}${local}`)

  function toInput(): EventInput {
    // Unchanged reminders are not sent: the event keeps following the provider and the default settings. After an edit
    // that changes All day, an own list for the old kind no longer counts (main), so the new kind's defaults apply.
    const kind = form.allDay ? 'allDay' : 'timed'
    const before = editing ? start.reminders[kind] : defaultReminders(form.calendarId, defaultsFor.meeting, form.allDay)
    // A plain copy: IPC cannot send the state proxy.
    const reminders = JSON.stringify(form.reminders[kind]) === JSON.stringify(before) ? undefined : $state.snapshot(form.reminders[kind])
    // An unchanged title and unchanged times go back as they came, so saving only reminders changes nothing
    // else, e.g. a title with spaces around it, or a start in the hour that repeats when summer time ends.
    const title = form.title.trim() === start.title.trim() ? initial.title : form.title.trim()
    const common: Omit<EventInput, 'start' | 'end' | 'allDay' | 'startDate' | 'endDate'> = {
      calendarId: form.calendarId,
      title,
      location: form.location,
      description: form.description,
      reminders
    }
    // A new event's guests go as a list; an edit's go as guestEdit(). Permissions and the call only when changed:
    // a new event gets Google's defaults.
    if (showMeeting) {
      if (!editing && form.guests.length > 0) common.guests = form.guests.map(({ email, optional }) => ({ email, optional }))
      for (const key of GUEST_FLAGS) if (google && form[key] !== start[key]) common[key] = form[key]
      if (form.conference !== start.conference) common.conference = form.conference
    }
    if (form.colorKey !== start.colorKey) common.colorKey = form.colorKey
    if (form.repeat && !sameRepeat(form.repeat, start.repeat)) {
      if (!fitsDate(form.repeat, form.startDate)) throw new Error('The repeat rule ends before the start date')
      common.repeat = $state.snapshot(form.repeat)
    }
    const timesSame = (['allDay', 'startDate', 'startTime', 'endDate', 'endTime', 'startZone', 'endZone'] as const).every((k) => form[k] === start[k])
    if (editing && timesSame) {
      const { allDay, startDate, endDate } = initial
      return { ...common, allDay, startDate, endDate, start: initial.start, end: initial.end }
    }
    if (form.allDay) {
      const endDate = dateKey(addDays(fromDateKey(form.endDate), 1))
      if (form.endDate < form.startDate) throw new Error('The end date is before the start date')
      return {
        ...common,
        allDay: true,
        startDate: form.startDate,
        endDate,
        start: Date.parse(form.startDate + 'T00:00:00Z'),
        end: Date.parse(endDate + 'T00:00:00Z')
      }
    }
    if (!(endMs > startMs)) throw new Error('The end must be after the start')
    // Only on timed events: main refuses a zone on an all-day one. A new series always sends its zone: Google needs one.
    const zoneChanged = editing ? form.startZone !== start.startZone || form.endZone !== start.endZone : zonePicked || !!common.repeat
    const zones = zoneChanged ? { timeZone: form.startZone, endTimeZone: form.endZone } : {}
    return { ...common, ...zones, allDay: false, startDate: null, endDate: null, start: startMs, end: endMs }
  }

  // The user's own change to the guest list, by email. main applies it to the provider's latest list, so a guest
  // added elsewhere meanwhile stays. undefined: no change.
  function guestEdit(): GuestEdit | undefined {
    const key = (g: { email: string }): string => g.email.toLowerCase()
    const before = new Map(start.guests.map((g) => [key(g), g]))
    const after = new Set(form.guests.map(key))
    const plain = ({ email, optional }: GuestRow): { email: string; optional: boolean } => ({ email, optional })
    const edit = {
      add: form.guests.filter((g) => !before.has(key(g))).map(plain),
      set: form.guests.filter((g) => before.has(key(g)) && before.get(key(g))!.optional !== g.optional).map(plain),
      remove: start.guests.filter((g) => !after.has(key(g))).map((g) => g.email)
    }
    return edit.add.length + edit.set.length + edit.remove.length > 0 ? edit : undefined
  }

  // Which question Google asks before guests get email. null: nobody to tell, or nothing they see changed.
  function sendKind(input: EventInput, edit?: GuestEdit): 'invite' | 'update' | 'cancel' | null {
    if (!showMeeting || (!hasGuests(details?.guests ?? []) && form.guests.length === 0)) return null
    if (edit?.remove.length) return 'cancel'
    if (editing ? edit?.add.length : form.guests.length > 0) return 'invite'
    // Reminders are the user's own: guests hear nothing about them.
    const seen = SHOWN.some((k) => input[k] !== initial[k])
    // A new rule changes the guests' events too.
    const other =
      edit?.set.length ||
      GUEST_FLAGS.some((k) => input[k] !== undefined) ||
      input.conference !== undefined ||
      input.timeZone !== undefined ||
      input.repeat !== undefined
    return seen || other ? 'update' : null
  }

  // Moving the start keeps the length, like Google Calendar.
  let lastStart = { date: start.startDate, time: start.startTime }
  function startChanged(): void {
    if (!form.startDate || !form.startTime) return
    if (form.allDay) {
      const days = Math.round((fromDateKey(form.endDate).getTime() - fromDateKey(lastStart.date).getTime()) / 86_400_000)
      form.endDate = dateKey(addDays(fromDateKey(form.startDate), Math.max(0, days)))
    } else {
      const length = endMs - zonedTime(lastStart.date, lastStart.time, form.startZone)
      const end = wallTime(startMs + Math.max(length, 15 * 60_000), form.endZone)
      form.endDate = end.date
      form.endTime = end.time
    }
    // A new event's rule follows the start, like Google: a weekly rule with more days keeps them and adds the new one.
    if (!editing && form.repeat && lastStart.date !== form.startDate) {
      const r = form.repeat
      const moved = moveRepeat(r, lastStart.date, form.startDate)
      // A one-day rule takes the new day, also when its end is before the new start: Save then says so.
      const days = r.days.length === 1 ? [weekday(form.startDate)] : [...new Set([...r.days, weekday(form.startDate)])].sort((a, b) => a - b)
      form.repeat = moved ?? (r.freq === 'weekly' ? { ...r, days } : r)
    }
    lastStart = { date: form.startDate, time: form.startTime }
  }

  // The repeat choices: Google's presets for the start date, then the rule the event has when it is none of them. An edit
  // never offers "Does not repeat": Google deletes the other events then, with no question.
  const repeatOptions = $derived.by(() => {
    const list = presets(form.startDate || start.startDate).filter((p) => !editing || p.repeat !== null)
    const r = form.repeat
    if (r && !list.some((p) => sameRepeat(p.repeat, r))) list.push({ label: repeatText(r, form.startDate || start.startDate), repeat: r })
    return list
  })
  const repeatIndex = $derived(repeatOptions.findIndex((p) => sameRepeat(p.repeat, form.repeat)))
  let repeatOpen = $state(false)
  // The user's own series: App passes its rule (null: it did not load). Invites change this event only.
  const ownSeries = $derived(recurring && series !== undefined)
  const showRepeat = $derived(!viewOnly && (!editing || ownSeries))

  // A new event gets the defaults of its calendar, and the meeting defaults once it has guests or a video call (what
  // will ring after the save), unless the user already changed its reminders.
  let defaultsFor = $state({ calendarId: start.calendarId, meeting: false })
  function followDefaults(): void {
    const next = { calendarId: form.calendarId, meeting: form.guests.length > 0 || form.conference }
    if (editing || (next.calendarId === defaultsFor.calendarId && next.meeting === defaultsFor.meeting)) return
    // Timed only: the all-day defaults are one setting for every calendar.
    const old = defaultReminders(defaultsFor.calendarId, defaultsFor.meeting)
    if (JSON.stringify(form.reminders.timed) === JSON.stringify(old)) form.reminders.timed = defaultReminders(next.calendarId, next.meeting)
    defaultsFor = next
  }

  // After the guest list changed: Google's live text, Meet with the first guest, and the meeting reminders.
  function guestsChanged(message: string, first: boolean): void {
    status = message
    if (first && calendar?.conference === 'meet' && !form.conference && !autoCall) {
      form.conference = true
      status += ` ${CALLS.meet.added}`
    }
    if (first) autoCall = true
    followDefaults()
  }

  // A new event's call stays only on a calendar with the same kind of call: Meet never turns into Teams, and a
  // calendar without a call gets none. The new account is the organizer, so it leaves the guests (no invite for nobody).
  // svelte-ignore state_referenced_locally
  let lastCall = calendars.find((c) => c.id === start.calendarId)?.conference ?? null
  function calendarChanged(): void {
    // Until the user picks a zone, it follows the calendar's, at the same moment.
    const zone = calendar?.timeZone ?? pcZone()
    if (!zonePicked && zone !== form.startZone) {
      if (!form.allDay && valid) {
        const s = wallTime(startMs, zone)
        const e = wallTime(endMs, zone)
        Object.assign(form, { startDate: s.date, startTime: s.time, endDate: e.date, endTime: e.time })
        lastStart = s
      }
      form.startZone = form.endZone = zone
    }
    if (form.conference && calendar?.conference !== lastCall) {
      form.conference = false
      // The screen reader text must not still say the old call is added.
      status = ''
    }
    form.guests = withoutOwn(form.guests, own)
    // Colors are per calendar.
    form.colorKey = null
    lastCall = calendar?.conference ?? null
    followDefaults()
  }

  function addCall(): void {
    form.conference = true
    status = call!.added
    followDefaults()
    // The button is gone: focus goes to the one that undoes it.
    void tick().then(() => removeCallButton?.focus())
  }

  function removeCall(): void {
    form.conference = false
    autoCall = true
    status = ''
    followDefaults()
    void tick().then(() => addCallButton?.focus())
  }

  // The edit waits here while the scope or send question is open.
  let pending: { input: EventInput; guests?: GuestEdit; scope?: Scope } | null = null
  let asking = $state<'invite' | 'update' | 'cancel' | null>(null)
  let scoping = $state<Scope[] | null>(null)

  function save(): void {
    if (saving || asking || scoping) return
    error = ''
    try {
      pending = { input: toInput(), guests: editing ? guestEdit() : undefined }
    } catch (e) {
      error = errorMessage(e)
      return
    }
    const input = pending.input
    // Only what is not the user's own: reminders and colors never split a series. Nothing changed: nothing
    // to ask.
    const shownSame = !SHOWN.some((k) => input[k] !== initial[k]) && !pending.guests && GUEST_FLAGS.every((k) => input[k] === undefined)
    const ownOnly = shownSame && input.conference === undefined && input.timeZone === undefined && input.repeat === undefined
    if (ownSeries && !(ownOnly && input.reminders === undefined && input.colorKey === undefined)) {
      // Outlook: a new rule for all events brings deleted events back (choicesFor gives no choice), so say where to do it.
      if (!google && input.repeat) return void (error = 'Change the time or repeat rule of all events in Outlook.')
      const choices = choicesFor(series!, initial, input, { rule: input.repeat, ownOnly, outlook: !google })
      if (choices.length === 0) return void (error = 'The repeat rule does not fit the start date')
      // One choice needs no question, unless it is a split.
      if (asksScope(choices)) return void (scoping = choices)
      pending.scope = choices[0]
    }
    ask()
  }

  // The send question, after the scope one.
  function ask(): void {
    asking = sendKind(pending!.input, pending!.guests)
    if (!asking) void send()
  }

  async function send(notify?: boolean): Promise<void> {
    saving = true
    try {
      await onsave(pending!.input, { notify, guests: pending!.guests, scope: pending!.scope })
      closing = true
      dialog?.close()
    } catch (e) {
      // The provider call runs in main, so say a lost network plainly, like the rest of the app.
      error = navigator.onLine ? errorMessage(e) : 'You are offline.'
    } finally {
      saving = false
    }
  }

  // Set when Save or the user closes it, so the close event does not ask again.
  let closing = false

  // close() while the dialog is still in the page gives focus back to where it was (the row or chip).
  function close(): void {
    if (dirty && !confirm('Discard your changes?')) return
    closing = true
    dialog?.close()
  }

  $effect(() => {
    dialog?.showModal()
    // Chromium would focus the scroll box first: focus the first field instead.
    dialog?.querySelector<HTMLElement>('.body :is(input, select, textarea, button):not(:disabled)')?.focus()
  })
</script>

<!-- Separate zones show only the offset next to the time, like Google; screen readers get the whole name. -->
{#snippet offset(id: string, zone: string, at: number)}
  {@const label = zoneLabel(zone, at, google)}
  <span {id} class="zone-text">{label.split(' ')[0]}<span class="sr-only">{label.slice(label.indexOf(' '))}</span></span>
{/snippet}

<dialog
  bind:this={dialog}
  aria-labelledby="event-dialog-title"
  oncancel={(e) => {
    // A cancel that cannot be stopped closes anyway: onclose asks then.
    if (!e.cancelable) return
    e.preventDefault()
    close()
  }}
  onclose={() => {
    // Chromium closes without a stoppable cancel on a second Esc with no click or key in between.
    // Ask the same question, and open the dialog again to keep editing.
    if (!closing && dirty && !confirm('Discard your changes?')) dialog?.showModal()
    else onclose()
  }}
  onkeydown={(e) => {
    // requestSubmit, not save(): the form checks (required, min, max) must run first.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      dialog?.querySelector('form')?.requestSubmit()
    }
  }}
>
  <form
    method="dialog"
    onsubmit={(e) => {
      e.preventDefault()
      save()
    }}
  >
    <h2 id="event-dialog-title">{viewOnly ? 'Reminders' : editing ? 'Edit event' : 'New event'}</h2>
    <!-- Only this part scrolls, so the error, Save and Cancel stay in view, like Settings. -->
    <div class="body">
      {#if viewOnly}<p class="note">This calendar is view only. Reminders you set here stay in this app.</p>{/if}
      {#if recurring && !ownSeries}<p class="note">Changes apply to this event only.</p>{/if}
      {#if timesLocked && !viewOnly}<p class="note">Only the organizer can change the time.</p>{/if}

      <fieldset class="fields" disabled={viewOnly}>
        <input class="title" placeholder="Add title" aria-label="Title" bind:value={form.title} />

        <div class="when">
          <input
            type="date"
            aria-label="Start date"
            aria-describedby={startNote}
            required
            disabled={timesLocked}
            bind:value={form.startDate}
            onchange={startChanged}
          />
          {#if !form.allDay}
            <input
              type="time"
              aria-label="Start time"
              aria-describedby={startNote}
              required
              disabled={timesLocked}
              bind:value={form.startTime}
              onchange={startChanged}
            />
            {#if zoneShown && separate}{@render offset('start-zone', form.startZone, startMs)}{/if}
          {/if}
          <span aria-hidden="true">to</span>
          {#if !form.allDay}
            <input type="time" aria-label="End time" aria-describedby={endNote} required disabled={timesLocked} bind:value={form.endTime} />
          {/if}
          <input type="date" aria-label="End date" aria-describedby={endNote} required disabled={timesLocked} bind:value={form.endDate} />
          {#if !form.allDay && zoneShown && separate}{@render offset('end-zone', form.endZone, endMs)}{/if}
        </div>
        <!-- Like Google: no zone for all-day events. It stays in the form for when All day is unticked. -->
        {#if !form.allDay}
          <div class="zone-row">
            {#if zoneShown && !separate}<span id="zone-text" class="zone-text">{zoneLabel(form.startZone, startMs, google)}</span>{/if}
            <!-- One event of an invite's series keeps the series' zone; the user's own series changes it with the scope question. -->
            <button
              type="button"
              class="text-btn"
              disabled={timesLocked || (recurring && !ownSeries)}
              onclick={() => (zoneOpen = true)}
            >
              Time zone
            </button>
          </div>
          {#if localTimes}<p id="local-times" class="note">{localTimes}</p>{/if}
        {/if}
        <div class="repeat-row">
          <label class="check"><input type="checkbox" disabled={timesLocked} bind:checked={form.allDay} /> All day</label>
          {#if showRepeat && editing && !series}
            <!-- Text, not a disabled select: Tab skips those, so keyboard users would never hear it. -->
            <p class="note">Could not load the repeat rule.</p>
          {:else if showRepeat && editing && !series?.repeat}
            <!-- Like the popover: a rule the app cannot read cannot change here. -->
            <select aria-label="Recurrence" disabled>
              <option>Repeating event</option>
            </select>
          {:else if showRepeat}
            <select
              aria-label="Recurrence"
              value={String(repeatIndex)}
              onkeydown={(e) => {
                // Arrows open the list, like Google: on the closed select they would pick each rule, and "Custom..."
                // would open its dialog on the way.
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  e.currentTarget.showPicker()
                }
              }}
              onchange={(e) => {
                const value = e.currentTarget.value
                if (value === 'custom') {
                  // The select shows the rule until the dialog gives a new one.
                  e.currentTarget.value = String(repeatIndex)
                  repeatOpen = true
                } else {
                  form.repeat = repeatOptions[Number(value)].repeat
                }
              }}
            >
              {#each repeatOptions as option, i (i)}
                <option value={String(i)}>{option.label}</option>
              {/each}
              <option value="custom">Custom...</option>
            </select>
          {/if}
        </div>

        {#if !editing}
          <label class="field">
            <span>Calendar</span>
            <select bind:value={form.calendarId} onchange={calendarChanged}>
              {#each calendars as calendar (calendar.id)}
                <option value={calendar.id}>{calendar.name}</option>
              {/each}
            </select>
          </label>
        {/if}

        {#if calendar && calendar.colors.length > 0}
          <!-- A select that shows each color next to its name (Chromium's customizable select), not a second grid. -->
          <label class="field">
            <span>Color</span>
            <select class="colors" bind:value={form.colorKey} aria-describedby={colorHint ? 'color-hint' : undefined}>
              <button type="button"><selectedcontent></selectedcontent></button>
              <option value={null}><span class="dot ring" style:--c={calendar.color}></span>Default</option>
              {#each calendar.colors as color (color.key)}
                <option value={color.key}><span class="dot" style:--c={color.color}></span>{color.name}</option>
              {/each}
            </select>
          </label>
          {#if colorHint}<p id="color-hint" class="note">Sign in again to see all event colors.</p>{/if}
        {/if}

        {#if showMeeting}
          <GuestList bind:guests={form.guests} {host} {own} accountId={account!.id} onchange={guestsChanged} />

          {#if google}
            <fieldset class="permissions">
              <legend>Guest permissions</legend>
              <!-- Like Google: Modify event turns the other two on and locks them; turning it off leaves them on. -->
              <label class="check">
                <input
                  type="checkbox"
                  bind:checked={form.guestsCanModify}
                  onchange={() => {
                    if (form.guestsCanModify) form.guestsCanInviteOthers = form.guestsCanSeeOtherGuests = true
                  }}
                />
                Modify event
              </label>
              <label class="check">
                <input type="checkbox" disabled={form.guestsCanModify} bind:checked={form.guestsCanInviteOthers} /> Invite others
              </label>
              <label class="check">
                <input type="checkbox" disabled={form.guestsCanModify} bind:checked={form.guestsCanSeeOtherGuests} /> See guest list
              </label>
            </fieldset>
          {/if}

          {#if form.conference}
            <div class="call">
              <svg class="call-icon" viewBox="0 0 24 24"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11z" /></svg>
              <span class="who">
                <span>{joinUrl ? 'Join video call' : call?.name}</span>
                <span class="sub">{joinUrl ?? 'Added when you save'}</span>
                {#if !removable && !google && joinUrl?.includes('teams.microsoft.com')}
                  <span class="sub">To remove the video call, open the event in Outlook.</span>
                {/if}
              </span>
              {#if removable}
                <button
                  bind:this={removeCallButton}
                  type="button"
                  class="icon-btn row-btn"
                  aria-label="Remove conference"
                  title="Remove conference"
                  onclick={removeCall}
                >
                  <svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z" /></svg>
                </button>
              {/if}
            </div>
          {:else if call}
            <button
              bind:this={addCallButton}
              type="button"
              class="pill-btn add-call"
              onclick={addCall}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11z" /></svg>
              {call.add}
            </button>
          {/if}
        {/if}

        <label class="field"><span>Location</span><input bind:value={form.location} /></label>
        <label class="field"><span>Description</span><textarea rows="5" bind:value={form.description}></textarea></label>
      </fieldset>

      <div class="field">
        <span>Reminders</span>
        <!-- Each kind has its own list and its own ReminderList, so rows of one kind can never show or be saved as the
             other (a click re-renders before any change handler runs). The timed one starts again when its defaults change. -->
        {#if form.allDay}
          <ReminderList bind:reminders={form.reminders.allDay} label="Reminders" allDay />
        {:else}
          {#key defaultsFor}<ReminderList bind:reminders={form.reminders.timed} label="Reminders" />{/key}
        {/if}
      </div>
    </div>

    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <span class="sr-only" role="status">{status}</span>
    <div class="buttons">
      <button type="button" class="pill-btn" onclick={close}>Cancel</button>
      <button bind:this={saveButton} type="submit" class="filled-btn" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
    </div>
  </form>

  {#if zoneOpen}
    <ZoneDialog
      startZone={form.startZone}
      endZone={form.endZone}
      at={valid ? startMs : initial.start}
      endAt={valid ? endMs : initial.end}
      city={google}
      onanswer={(zones) => {
        zoneOpen = false
        if (zones) {
          form.startZone = zones.start
          form.endZone = zones.end
          zonePicked = true
        }
      }}
    />
  {/if}

  {#if repeatOpen}
    <RepeatDialog
      repeat={form.repeat}
      date={form.startDate || start.startDate}
      weekStart={prefs.settings.weekStart ?? localeWeekStart()}
      onanswer={(repeat) => {
        repeatOpen = false
        // A rule equal to a preset shows as that preset (repeatOptions).
        if (repeat) form.repeat = repeat
      }}
    />
  {/if}

  {#if scoping}
    <ScopeDialog
      kind="edit"
      choices={scoping}
      guests={hasGuests(details?.guests ?? [])}
      onanswer={(scope) => {
        scoping = null
        // Back to editing: focus on Save, like Google.
        if (scope === null) return saveButton?.focus()
        pending!.scope = scope
        ask()
      }}
    />
  {/if}

  {#if asking && account}
    <SendUpdates
      provider={account.provider}
      kind={asking}
      onanswer={(notify) => {
        asking = null
        // Back to editing: focus on Save, like Google.
        if (notify === null) saveButton?.focus()
        else void send(notify)
      }}
    />
  {/if}
</dialog>

<style>
  dialog {
    width: min(45rem, calc(100vw - 2rem));
    padding: 1.5rem;
    border: 0;
    border-radius: 1.75rem;
    background: var(--surface-container);
    color: var(--on-surface);
  }

  /* Flex only while open: a closed dialog must stay hidden. */
  dialog[open] {
    display: flex;
    flex-direction: column;
  }

  dialog::backdrop {
    background: rgb(0 0 0 / 32%);
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-height: 0;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-height: 0;
    /* Room for focus rings, which the scroll box would cut. */
    margin: -0.25rem;
    padding: 0.25rem;
    overflow: auto;
  }

  h2 {
    margin: 0;
    font-size: 1.375rem;
    font-weight: 400;
  }

  .note {
    margin: 0;
    color: var(--on-surface-variant);
  }

  .fields {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }

  input,
  select,
  textarea {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--outline);
    border-radius: 0.25rem;
    background: var(--surface);
    color: inherit;
    font: inherit;
  }

  .title {
    font-size: 1.375rem;
  }

  .when {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  /* Like Google: the repeat select sits in the row with All day. */
  .repeat-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1.5rem;
  }

  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  /* Under the times: the zone name is too long for the time row of this dialog. */
  .zone-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-top: -0.5rem;
  }

  .zone-text {
    color: var(--on-surface-variant);
  }

  .text-btn:disabled {
    color: var(--on-surface-variant);
    opacity: 0.6;
    cursor: default;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    color: var(--on-surface-variant);
  }

  .field > :last-child {
    color: var(--on-surface);
  }

  textarea {
    resize: vertical;
  }

  .colors,
  .colors::picker(select) {
    appearance: base-select;
  }

  .colors {
    display: flex;
    align-items: center;
  }

  .colors option,
  .colors selectedcontent {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .dot {
    flex: none;
    width: 1rem;
    height: 1rem;
    border-radius: 50%;
    background: var(--c);
  }

  /* Default: the calendar's color as a ring, like the right-click menu. */
  .ring {
    border: 2px solid var(--c);
    background: none;
  }

  legend {
    margin: 0 0 0.25rem;
    padding: 0;
    color: var(--on-surface-variant);
    font-size: inherit;
    font-weight: 400;
  }

  .call {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 2.5rem;
  }

  .who {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .sub {
    color: var(--on-surface-variant);
    font-size: 0.75rem;
  }

  .row-btn {
    width: 2rem;
    height: 2rem;
  }

  .row-btn svg {
    width: 1.25rem;
    height: 1.25rem;
  }

  .permissions {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    border: 0;
  }

  .call-icon,
  .add-call svg {
    flex: none;
    width: 1.5rem;
    height: 1.5rem;
    fill: var(--primary);
  }

  .add-call {
    display: flex;
    align-items: center;
    align-self: flex-start;
    gap: 0.5rem;
    padding: 0 1rem;
  }

  .error {
    margin: 0;
    color: var(--error);
  }

  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  @media (forced-colors: active) {
    dialog {
      border: 1px solid CanvasText;
    }
  }
</style>
