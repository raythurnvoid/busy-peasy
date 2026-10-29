<script lang="ts">
  import { tick } from 'svelte'
  import type { Account, Answer, Calendar, CalendarEvent, EventDetails, Guest, Scope } from '../../../shared/api'
  import { ANSWER_LABELS, isInvite } from '../../../shared/events'
  import { seriesText } from '../lib/repeat'
  import { formats } from '../lib/settings.svelte'
  import { addDays, allDayReminderText, fromDateKey, reminderText } from '../lib/time'
  import Popover from './Popover.svelte'

  let {
    event,
    calendar,
    account,
    anchor,
    onclose,
    onedit,
    ondelete,
    onrespond
  }: {
    event: CalendarEvent
    calendar: Calendar | undefined
    account: Account | undefined
    anchor: DOMRect
    onclose: () => void
    onedit: () => void
    ondelete: () => void
    onrespond: (answer: Answer, scope: Scope) => void
  } = $props()

  const RESPONSES = { organizer: 'You are the organizer', accepted: 'You accepted', tentative: 'You said maybe', declined: 'You declined', none: 'You have not answered' }
  // Google's words: the guest's answer for screen readers, and the summary under the guest count (in this order).
  const GUEST_ANSWERS = {
    accepted: 'Attending',
    declined: 'Declined',
    tentative: 'Maybe attending',
    none: 'Awaiting response'
  }
  const CHOICES = Object.keys(ANSWER_LABELS) as Answer[]
  const SUMMARY = { accepted: 'yes', declined: 'no', tentative: 'maybe', none: 'awaiting' }
  // Longer guest lists start closed, like Google.
  const COLLAPSE_AT = 10
  const URL_PART = /(https?:\/\/[^\s<>"]+)/

  const invite = $derived(isInvite(event))
  // Only in the main calendar: elsewhere the answer would go out in the owner's name.
  const canRespond = $derived(invite && calendar?.canEdit === true && calendar.isPrimary)
  // The answer waiting for the "This event / All events" step of a repeating invite.
  let asking = $state<Answer | null>(null)
  let scope = $state<Scope>('event')
  let step: HTMLFormElement | undefined = $state()
  const pills: Partial<Record<Answer, HTMLButtonElement>> = $state({})
  // The checked choice takes focus when the step opens, like Google.
  $effect(() => step?.querySelector<HTMLInputElement>('input:checked')?.focus())

  function answer(value: Answer): void {
    if (event.seriesRemoteId === null) return onrespond(value, 'event')
    scope = 'event'
    asking = value
  }

  let deleteButton: HTMLButtonElement | undefined = $state()
  // After Cancel on the question that a delete asks first.
  export function focusDelete(): void {
    deleteButton?.focus()
  }

  // Back to Yes / No / Maybe, with focus on the answer that opened the step.
  function cancelStep(): void {
    const value = asking!
    asking = null
    void tick().then(() => pills[value]?.focus())
  }

  let details = $state<EventDetails | null>(null)
  // Reads again when the live event changes (sync, write). If the event is gone, the last details stay.
  $effect(() => {
    const id = event.id
    void window.api.getEventDetails(id).then((d) => {
      if (d && event.id === id) details = d
    })
  })
  // The rule under the date, like Google. None while it loads, or when it cannot load (offline).
  let rule = $state<string | null>(null)
  $effect(() => {
    const id = event.id
    const allDay = event.allDay
    // The popover stays open from one event to the next: never show the last one's rule.
    rule = null
    if (event.seriesRemoteId === null) return
    window.api.getSeries(id).then(
      (series) => event.id === id && (rule = series && seriesText(series, allDay)),
      () => {}
    )
  })
  // Stays open while the event syncs again.
  let expanded = $state(false)

  const guests = $derived(details?.guests ?? [])
  const omitted = $derived(details?.guestsOmitted ?? false)
  const summary = $derived(
    (Object.keys(SUMMARY) as Guest['response'][])
      .map((r) => [guests.filter((g) => g.response === r).length, SUMMARY[r]] as const)
      .filter(([n]) => n > 0)
      .map(([n, word]) => `${n} ${word}`)
      .join(', ')
  )
  const description = $derived(details?.body ?? event.description)
  // Without authuser, Google opens the link in the browser's first Google account.
  const webLink = $derived.by(() => {
    if (!details?.webLink || account?.provider !== 'google') return details?.webLink ?? null
    const url = new URL(details.webLink)
    url.searchParams.set('authuser', account.email)
    return url.toString()
  })
  const when = $derived.by(() => {
    if (event.allDay) {
      const first = fromDateKey(event.startDate!)
      const last = addDays(fromDateKey(event.endDate!), -1)
      return last > first ? formats.day.formatRange(first, last) : formats.day.format(first)
    }
    const start = new Date(event.start)
    const end = new Date(event.end)
    if (end.getTime() - start.getTime() < 86_400_000 && start.getDate() === new Date(event.end - 1).getDate()) {
      return `${formats.day.format(start)} · ${formats.time.formatRange(start, end)}`
    }
    return `${formats.day.format(start)}, ${formats.time.format(start)} – ${formats.day.format(end)}, ${formats.time.format(end)}`
  })
  let copied = $state(false)
  // Outlook declines an invite, so the organizer knows. Google only takes it off this calendar, like Google web.
  const deleteLabel = $derived(
    event.cancelled ? 'Remove event' : !invite ? 'Delete event' : account?.provider === 'google' ? 'Remove from this calendar' : 'Decline and remove'
  )
</script>

<!-- Esc closes only the scope step, like Google, also when focus is on the card. The capture phase runs before the
     popover's own Esc. -->
<svelte:window
  onkeydowncapture={(e) => {
    if (e.key !== 'Escape' || !asking) return
    e.stopPropagation()
    cancelStep()
  }}
/>

{#snippet guestHead()}
  <!-- With part of the list hidden, a total would be wrong. -->
  <div>{omitted ? 'Guests' : `${guests.length} ${guests.length === 1 ? 'guest' : 'guests'}`}</div>
  {#if !omitted}
    <div class="sub">{summary}</div>
  {/if}
{/snippet}

<Popover {anchor} label={event.title || '(No title)'} {onclose}>
  <div class="actions">
    <!-- First in the markup, so it takes the first focus and Tab goes on to Edit, like Google. CSS shows it last. -->
    <button class="icon-btn close" aria-label="Close" onclick={onclose}>
      <svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z" /></svg>
    </button>
    {#if calendar?.canEdit}
      <!-- A canceled meeting can only be removed. -->
      {#if !event.cancelled}
        <button class="icon-btn" aria-label="Edit event" title="Edit event (e)" onclick={onedit}>
          <svg viewBox="0 0 24 24"><path d="M3 17.3V21h3.8L17.8 9.9l-3.7-3.7zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7z" /></svg>
        </button>
      {/if}
      <!-- Outside the main calendar, removing an invite would act in the owner's name, like an answer. -->
      {#if !invite || calendar.isPrimary}
        <button
          bind:this={deleteButton}
          class="icon-btn"
          aria-label={deleteLabel}
          title="{deleteLabel} (Delete)"
          onclick={ondelete}
        >
          <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z" /></svg>
        </button>
      {/if}
    {:else if !event.cancelled}
      <!-- View-only calendars: the reminders are still the user's own. -->
      <button class="icon-btn" aria-label="Edit reminders" title="Edit reminders" onclick={onedit}>
        <svg viewBox="0 0 24 24"><path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2m6-6v-5c0-3.1-1.6-5.6-4.5-6.3V4a1.5 1.5 0 0 0-3 0v.7C7.6 5.4 6 7.9 6 11v5l-2 2v1h16v-1z" /></svg>
      </button>
    {/if}
  </div>

  <div class="row">
    <span class="swatch" style:background={event.color ?? calendar?.color}></span>
    <div>
      <h2 class="title">{event.title || '(No title)'}</h2>
      <div class="sub">{when}</div>
      {#if rule}<div class="sub">{rule}</div>{/if}
      {#if event.cancelled}
        <div class="sub">This event was canceled.</div>
      {/if}
    </div>
  </div>

  {#if event.cancelled && calendar?.canEdit}
    <!-- Like Outlook: the only thing to do with a canceled meeting. It deletes, it does not decline. -->
    <div class="row">
      <span></span>
      <div><button class="pill-btn" onclick={ondelete}>Remove event</button></div>
    </div>
  {/if}

  {#if event.joinUrl && !event.cancelled}
    <div class="row">
      <svg class="icon" viewBox="0 0 24 24"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11z" /></svg>
      <div class="join">
        <button class="filled-btn" onclick={() => window.api.openLink(event.joinUrl!)}>Join meeting</button>
        <button
          class="icon-btn"
          aria-label="Copy meeting link"
          title={copied ? 'Copied' : 'Copy meeting link'}
          onclick={() =>
            // Main copies it. On an error the button just shows no "Copied", not an unhandled error.
            window.api.copyText(event.joinUrl!).then(
              () => (copied = true),
              () => {}
            )}
        >
          <svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12zm3 4H8a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2m0 16H8V7h11z" /></svg>
        </button>
      </div>
    </div>
  {/if}

  {#if event.location}
    <div class="row">
      <svg class="icon" viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7m0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5" /></svg>
      <div class="text">{event.location}</div>
    </div>
  {/if}

  {#if details?.rooms.length}
    <div class="row">
      <svg class="icon" viewBox="0 0 24 24"><path d="M19 19V4h-4V3H5v16H3v2h12V6h2v15h4v-2zm-6 0H7V5h6zm-3-8h2v2h-2z" /></svg>
      <ul class="text plain" aria-label="Rooms and resources">
        {#each details.rooms as room, i (i)}
          <li title={room.email}>{room.name ?? room.email}</li>
        {/each}
      </ul>
    </div>
  {/if}

  <!-- attendeeCount counts rooms too, so an event with only a room has no guest row. -->
  {#if guests.length > 0 || (event.attendeeCount > 0 && !details?.rooms.length)}
    {@const collapsible = guests.length >= COLLAPSE_AT}
    <div class="row">
      <svg class="icon" viewBox="0 0 24 24"><path d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6m-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6m0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13m8 0h-1c1.2.8 2 1.9 2 3.5V19h6v-2.5c0-2.3-4.7-3.5-7-3.5" /></svg>
      <div class="text">
        {#if guests.length === 0}
          <!-- Details not read yet, or a row from before the guest list was stored. -->
          {event.attendeeCount} {event.attendeeCount === 1 ? 'guest' : 'guests'} · {RESPONSES[event.response]}
        {:else}
          {#if collapsible}
            <button type="button" class="toggle" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
              <span>{@render guestHead()}</span>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d={expanded ? 'M7.4 15.4 12 10.8l4.6 4.6L18 14l-6-6-6 6z' : 'M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z'} /></svg>
            </button>
          {:else}
            {@render guestHead()}
          {/if}
          <!-- A closed list renders nothing, so a long one costs nothing until opened. -->
          {#if !collapsible || expanded}
            <ul class="plain guests" aria-label="Guests">
              {#each guests as guest, i (i)}
                <li class="guest" title={guest.email}>
                  <span class="avatar">
                    <span aria-hidden="true">{(guest.name ?? guest.email).charAt(0).toUpperCase()}</span>
                    <span class="badge {guest.response}" role="img" aria-label={GUEST_ANSWERS[guest.response]}>
                      {#if guest.response === 'accepted'}
                        <svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" /></svg>
                      {:else if guest.response === 'declined'}
                        <svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z" /></svg>
                      {:else if guest.response === 'tentative'}?{/if}
                    </span>
                  </span>
                  <div>
                    <div>{guest.name ?? guest.email}</div>
                    {#if guest.organizer}
                      <div class="sub">Organizer</div>
                    {:else if guest.optional}
                      <div class="sub">Optional</div>
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
          {#if omitted}
            <div class="sub">Some guests are not shown.</div>
          {/if}
          <!-- The Going? strip shows the answer. -->
          {#if !canRespond}
            <div class="sub">{RESPONSES[event.response]}</div>
          {/if}
        {/if}
      </div>
    </div>
  {/if}

  {#if description}
    <div class="row">
      <svg class="icon" viewBox="0 0 24 24"><path d="M3 18h12v-2H3zM3 6v2h18V6zm0 7h18v-2H3z" /></svg>
      <!-- Plain text from the provider. Only http(s) links become clickable, and they open in the browser. -->
      <!-- A Tab stop, so the keys can scroll a long description and Shift+Tab in the popover wraps to it. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="text description" tabindex="0">
        {#each description.split(URL_PART) as part, i (i)}
          {#if i % 2 === 1}
            <a href={part} onclick={(e) => (e.preventDefault(), window.api.openLink(part))}>{part}</a>
          {:else}{part}{/if}
        {/each}
      </div>
    </div>
  {/if}

  <!-- A canceled meeting never rings. -->
  {#if !event.cancelled && event.reminders.length > 0}
    <div class="row">
      <svg class="icon" viewBox="0 0 24 24"><path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2m6-6v-5c0-3.1-1.6-5.6-4.5-6.3V4a1.5 1.5 0 0 0-3 0v.7C7.6 5.4 6 7.9 6 11v5l-2 2v1h16v-1z" /></svg>
      <div class="text">
        {#each event.reminders as r (r.minutes)}
          <!-- Mid-line, so lower case like "10 minutes before". -->
          <div>
            {r.alarm ? 'Alarm' : 'Notification'}, {event.allDay ? allDayReminderText(r.minutes, formats.time).replace(/^./, (c) => c.toLowerCase()) : reminderText(r.minutes)}
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <div class="row">
    <svg class="icon" viewBox="0 0 24 24"><path d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2m0 16H5V9h14z" /></svg>
    <div class="text">
      {calendar?.name ?? 'Calendar'}
      <div class="sub">{account?.email ?? ''}{calendar && !calendar.canEdit ? ' · View only' : ''}</div>
    </div>
  </div>

  {#if webLink}
    {@const link = webLink}
    <div class="row">
      <svg class="icon" viewBox="0 0 24 24"><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-7h-2zM14 3v2h3.6l-9.8 9.8 1.4 1.4L19 6.4V10h2V3z" /></svg>
      <div class="text">
        <a class="link" href={link} onclick={(e) => (e.preventDefault(), window.api.openLink(link))}>
          Open in {account?.provider === 'google' ? 'Google Calendar' : 'Outlook'}
        </a>
      </div>
    </div>
  {/if}

  <!-- Like Google: last, in a strip that stays at the bottom while the rest scrolls. -->
  {#if canRespond && asking}
    {@const value = asking}
    <!-- The keys come from the radios and buttons inside. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <form
      class="going"
      bind:this={step}
      onsubmit={(e) => {
        e.preventDefault()
        onrespond(value, scope)
      }}
      onkeydown={(e) => {
        // Enter on a choice sends, like Google. Not left to the browser: a radio may not submit by itself.
        if (e.key === 'Enter' && (e.target as HTMLInputElement).type === 'radio') {
          e.preventDefault()
          step?.requestSubmit()
        }
      }}
    >
      <fieldset>
        <legend>RSVP to recurring event</legend>
        <label><input type="radio" name="rsvp-scope" value="event" bind:group={scope} /> This event</label>
        <label><input type="radio" name="rsvp-scope" value="series" bind:group={scope} /> All events</label>
        <!-- Outlook keeps an answer given to a single event in the user's own calendar (seen live). -->
        {#if account?.provider === 'google'}
          <div class="sub">This also replaces answers you gave to single events.</div>
        {/if}
      </fieldset>
      <div class="step-actions">
        <button type="button" class="pill-btn" onclick={cancelStep}>Cancel</button>
        <button type="submit" class="filled-btn">OK</button>
      </div>
    </form>
  {:else if canRespond}
    <div class="going" role="group" aria-labelledby="going-label">
      <span id="going-label">Going?</span>
      <!-- A pressed answer still sends: for a series it is how one answer goes to all events. -->
      {#each CHOICES as value (value)}
        <button
          type="button"
          class="pill-btn"
          aria-pressed={event.response === value}
          bind:this={pills[value]}
          onclick={() => answer(value)}
        >
          {ANSWER_LABELS[value]}
        </button>
      {/each}
    </div>
  {/if}
</Popover>

<style>
  .actions {
    display: flex;
    justify-content: flex-end;
  }

  .actions .close {
    order: 1;
  }

  .row {
    display: grid;
    grid-template-columns: 2.5rem minmax(0, 1fr);
    align-items: start;
    gap: 0.5rem;
    padding: 0.375rem 1rem 0.375rem 0.75rem;
  }

  .swatch {
    justify-self: center;
    width: 0.875rem;
    height: 0.875rem;
    margin-top: 0.5rem;
    border-radius: 0.25rem;
  }

  .icon {
    justify-self: center;
    width: 1.25rem;
    height: 1.25rem;
    fill: var(--on-surface-variant);
  }

  .title {
    margin: 0;
    font-size: 1.375rem;
    font-weight: 400;
    line-height: 1.75rem;
    overflow-wrap: anywhere;
  }

  .sub {
    color: var(--on-surface-variant);
    font-size: 0.8125rem;
  }

  .text {
    padding-top: 0.125rem;
    overflow-wrap: anywhere;
  }

  .description {
    max-height: 12rem;
    overflow-y: auto;
    white-space: pre-line;
  }

  .description a,
  .link {
    color: var(--primary);
  }

  .plain {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* The guest count and summary, as one button that opens a long list. */
  .toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }

  .toggle svg {
    flex: none;
    width: 1.5rem;
    height: 1.5rem;
    fill: var(--on-surface-variant);
  }

  .guests {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0.5rem 0;
  }

  .guest {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .avatar {
    position: relative;
    flex: none;
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    background: var(--surface-highest);
    font-weight: 500;
  }

  /* The guest's answer on the avatar, like Google: green check, red x, grey "?", nothing while awaiting. */
  .badge {
    position: absolute;
    right: -0.25rem;
    bottom: -0.25rem;
    display: grid;
    place-items: center;
    width: 0.875rem;
    height: 0.875rem;
    border-radius: 50%;
    color: var(--surface);
    font-size: 0.625rem;
    font-weight: 700;
  }

  .badge svg {
    width: 0.625rem;
    height: 0.625rem;
    fill: currentColor;
  }

  .badge.accepted,
  .badge.declined,
  .badge.tentative {
    box-shadow: 0 0 0 2px var(--surface-container);
  }

  .badge.accepted {
    background: var(--accepted);
  }

  .badge.declined {
    background: var(--declined);
  }

  .badge.tentative {
    background: var(--on-surface-variant);
    color: var(--surface-container);
  }

  .join {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: -0.5rem;
  }

  /* Google's footer: the full card width at its bottom edge (the negative margins undo the card's padding). */
  .going {
    position: sticky;
    bottom: -1rem;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin: 0.5rem -0.5rem -1rem;
    padding: 0.625rem 1rem;
    background: var(--surface-high);
  }

  /* Google's small pills. */
  .going .pill-btn {
    height: 1.75rem;
    padding: 0 1rem;
    border-color: var(--outline-variant);
    font-size: 0.8125rem;
    font-weight: 400;
  }

  .going .pill-btn[aria-pressed='true'] {
    border-color: transparent;
    background: var(--secondary-container);
  }

  .going fieldset {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    border: 0;
  }

  .going legend {
    margin-bottom: 0.25rem;
    padding: 0;
    font-weight: 500;
  }

  .step-actions {
    display: flex;
    gap: 0.5rem;
    margin-left: auto;
  }

  @media (forced-colors: active) {
    .going .pill-btn[aria-pressed='true'] {
      background: Highlight;
      color: HighlightText;
      forced-color-adjust: none;
    }
  }
</style>
