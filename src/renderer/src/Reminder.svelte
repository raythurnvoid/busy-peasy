<script lang="ts">
  import { tick } from 'svelte'
  import type { Reminder, ReminderAction, Reminders } from '../../shared/api'
  import { SNOOZE_CHOICES, beforeStart } from '../../shared/reminders'
  import { formats, loadSettings } from './lib/settings.svelte'
  import { addDays, daysBetween, startOfDay } from './lib/time'

  // One page for both reminder windows. Main sizes the window from the row count, so MAX_ROWS
  // and the CSS heights of padding, header, rows and lines must match SIZES in src/main/reminders.ts.
  const params = new URLSearchParams(location.hash.slice(1))
  const kind = params.get('reminder') === 'alert' ? 'alert' : 'heads-up'
  const sound = params.has('sound')
  // Only when a screen reader runs (main/reminders.ts open()): the card, not a button, so typed keys press nothing.
  let focusCard = params.has('focus')
  const MAX_ROWS = 3

  let reminders: Reminders = $state({ headsUp: [], alerts: [], stale: [] })
  let now = $state(Date.now())
  const list = $derived(kind === 'alert' ? reminders.alerts : reminders.headsUp)
  const started = $derived(list.some((r) => r.stage === 'started'))
  // An alarm rings until it is answered: every 4 s before the start, every 2 s after. 0 = silent.
  const every = $derived(!sound || list.length === 0 ? 0 : started ? 2_000 : 4_000)
  // Notifications chime once when a new one appears.
  const shownKeys = $derived(list.map((r) => `${r.eventId}:${r.fireAt}`).join())
  // The snooze time picked in each alarm row. It counts only when Snooze is clicked: a closed native select changes on
  // each arrow key.
  let picked: Record<number, number> = $state({})

  // The row index to focus after Snooze or Dismiss removed a row, so the keyboard does not start over at the top.
  let refocus: number | null = null

  async function load(): Promise<void> {
    reminders = await window.api.listReminders()
    if (focusCard) {
      focusCard = false
      await tick()
      document.querySelector<HTMLElement>('.card')?.focus()
    }
    if (refocus === null) return
    await tick()
    const rows = document.querySelectorAll('.alert-row, .heads-up-row')
    rows[Math.min(refocus, rows.length - 1)]?.querySelector<HTMLElement>('button, select')?.focus()
    refocus = null
  }

  function when(r: Reminder): string {
    if (r.allDay) {
      const days = daysBetween(startOfDay(new Date(now)), new Date(r.start))
      return days <= 0 ? 'Today' : days === 1 ? 'Tomorrow' : `In ${days} days`
    }
    const left = r.start - now
    if (left > 24 * 3600_000) {
      const days = Math.round(left / (24 * 3600_000))
      return `In ${days} ${days === 1 ? 'day' : 'days'}`
    }
    if (left > 3600_000) return `In ${Math.floor(left / 3600_000)} h ${Math.ceil((left % 3600_000) / 60_000)} min`
    if (left > 30_000) return `In ${Math.ceil(left / 60_000)} min`
    if (left > -60_000) return 'Starting now'
    return `Started ${Math.floor(-left / 60_000)} min ago`
  }

  // With the day when the event is not today, e.g. for a reminder one day before.
  function range(r: Reminder): string {
    if (r.allDay) {
      // The last day by date math: a day is not always 24 h.
      const last = addDays(new Date(r.end), -1)
      const days = last.getTime() > r.start ? `${formats.dayShort.format(r.start)} – ${formats.dayShort.format(last)}` : formats.dayShort.format(r.start)
      return `${days} · All day`
    }
    const time = formats.time.formatRange(r.start, r.end)
    return new Date(r.start).toDateString() === new Date(now).toDateString() ? time : `${formats.dayShort.format(r.start)}, ${time}`
  }

  function act(r: Reminder, action: ReminderAction, snooze?: number): void {
    // Only when the user is in this window: it never takes focus by itself.
    if (document.hasFocus()) refocus = list.indexOf(r)
    void window.api.answerReminder(r.eventId, action, r.fireAt, snooze)
  }

  // Like a system notification: opening it answers it, so the alarm stops and does not cover the event's popover.
  // Shown first, as the dismiss may close this window.
  function open(r: Reminder): void {
    void window.api.showEvent(r.eventId)
    act(r, 'dismiss')
  }

  const name = (r: Reminder): string => r.title || '(No title)'
  const early = (r: Reminder): boolean => beforeStart(now, r)
  // The rule (0) while it applies, else 5 minutes, like Google's next snoozes.
  function choice(r: Reminder): number {
    const value = picked[r.eventId] ?? 0
    return value === 0 && !early(r) ? 5 : value
  }

  // Dismiss all: also the rows behind "+N more".
  function dismissAll(): void {
    void window.api.dismissReminders(list.map((r) => ({ eventId: r.eventId, fireAt: r.fireAt })))
  }

  // A short two-note chime made with WebAudio, so no sound file is needed.
  let audio: AudioContext | undefined
  function chime(volume: number): void {
    audio ??= new AudioContext()
    const t = audio.currentTime
    for (const [i, frequency] of [880, 660].entries()) {
      const at = t + i * 0.25
      const osc = audio.createOscillator()
      const gain = audio.createGain()
      osc.frequency.value = frequency
      gain.gain.setValueAtTime(0, at)
      gain.gain.linearRampToValueAtTime(volume, at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.6)
      osc.connect(gain).connect(audio.destination)
      osc.start(at)
      osc.stop(at + 0.6)
    }
  }

  $effect(() => {
    void load()
    const timer = setInterval(() => (now = Date.now()), 5_000)
    const off = window.api.onDataChanged((change) => {
      if (change.reminders) void load()
      if (change.settings) void loadSettings()
    })
    return () => {
      clearInterval(timer)
      off()
    }
  })

  // Keys already chimed for. Plain, not state: it only guards the chime.
  let heard: string[] = []
  $effect(() => {
    const keys = shownKeys ? shownKeys.split(',') : []
    if (kind === 'heads-up' && keys.some((key) => !heard.includes(key))) chime(0.12)
    heard = keys
  })

  $effect(() => {
    if (!every) return
    chime(0.3)
    const timer = setInterval(() => chime(0.3), every)
    return () => clearInterval(timer)
  })
</script>

{#snippet extra()}
  {#if list.length > 1}
    <div class="line footer">
      <span class="more">{list.length > MAX_ROWS ? `+${list.length - MAX_ROWS} more` : ''}</span>
      <!-- With hidden rows the count says that they go too. -->
      <button class="text-btn" onclick={dismissAll}>Dismiss all{list.length > MAX_ROWS ? ` ${list.length}` : ''}</button>
    </div>
  {/if}
  {#if reminders.stale.length > 0}
    <div class="line warn" title={reminders.stale.join(', ')}>Not synced lately: {reminders.stale.join(', ')}. This may be out of date.</div>
  {/if}
{/snippet}

{#if kind === 'alert'}
  <div class="card alert" class:started role="alertdialog" aria-labelledby="reminder-title" tabindex="-1">
    <header>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2m6-6v-5c0-3.1-1.6-5.6-4.5-6.3V4a1.5 1.5 0 0 0-3 0v.7C7.6 5.4 6 7.9 6 11v5l-2 2v1h16v-1z" /></svg>
      <!-- All-day alarms come days or hours ahead: the row says when. With one in the list, "Starting soon" would be wrong. -->
      <h1 id="reminder-title">{started ? 'It has started' : list.some((r) => r.allDay) ? 'Reminder' : 'Starting soon'}</h1>
    </header>
    {#each list.slice(0, MAX_ROWS) as r (r.eventId)}
      <div class="alert-row">
        <!-- The whole row opens the event. The buttons are not inside it (a button cannot hold buttons): the grid puts
             them on top of it. -->
        <button class="open" title="Open in calendar" onclick={() => open(r)}>
          <span class="label" class:late={r.stage === 'started'}>{when(r)}</span>
          <span class="title" title={r.title}>{name(r)}</span>
          <span class="sub">{range(r)}{r.location ? ` · ${r.location}` : ''}</span>
        </button>
        <div class="buttons">
          {#if r.joinUrl}<button class="filled-btn" aria-label="Join {name(r)}" onclick={() => act(r, 'join')}>Join</button>{/if}
          <select aria-label="Snooze {name(r)} for" onchange={(e) => (picked[r.eventId] = Number(e.currentTarget.value))}>
            {#if early(r)}<option value="0" selected={choice(r) === 0}>1 min before start</option>{/if}
            {#each SNOOZE_CHOICES.filter((m) => m > 0) as minutes (minutes)}
              <option value={String(minutes)} selected={choice(r) === minutes}>{minutes === 60 ? '1 hour' : `${minutes} minutes`}</option>
            {/each}
          </select>
          <button class="pill-btn" aria-label="Snooze {name(r)}" onclick={() => act(r, 'snooze', choice(r))}>Snooze</button>
          <button class="pill-btn" aria-label="Dismiss {name(r)}" onclick={() => act(r, 'dismiss')}>Dismiss</button>
        </div>
      </div>
    {/each}
    {@render extra()}
  </div>
{:else}
  <div class="card heads-up" role="status">
    {#each list.slice(0, MAX_ROWS) as r (r.eventId)}
      {@const snooze = early(r) ? 'until 1 min before start' : '5 minutes'}
      <div class="heads-up-row">
        <!-- Like the alarm: the row opens the event, and the buttons sit on top of it. -->
        <button class="open" title="Open in calendar" onclick={() => open(r)}>
          <span class="text">
            <span class="title" title={r.title}>{name(r)}</span>
            <span class="sub">{when(r)} · {range(r)}</span>
          </span>
        </button>
        <div class="actions">
          {#if r.joinUrl}<button class="filled-btn" aria-label="Join {name(r)}" onclick={() => act(r, 'join')}>Join</button>{/if}
          <button class="icon-btn" aria-label="Snooze {name(r)} {snooze}" title="Snooze {snooze}" onclick={() => act(r, 'snooze', 0)}>
            <svg viewBox="0 0 24 24"><path d="M9 11h3.6L9 15.2V17h6v-2h-3.6l3.6-4.2V9H9zm7-7.7 1.3-1.5 4.6 3.9-1.3 1.5zM3.3 7.2 2.1 5.7 6.7 1.8 8 3.3zM12 6a7 7 0 1 1 0 14 7 7 0 0 1 0-14m0-2a9 9 0 1 0 0 18 9 9 0 0 0 0-18" /></svg>
          </button>
          <button class="icon-btn" aria-label="Dismiss {name(r)}" title="Dismiss" onclick={() => act(r, 'dismiss')}>
            <svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z" /></svg>
          </button>
        </div>
      </div>
    {/each}
    {@render extra()}
  </div>
{/if}

<style>
  /* An inset outline, not a border, so it takes no space from the sized rows. */
  .card {
    height: 100%;
    outline: 1px solid var(--outline-variant);
    outline-offset: -1px;
    background: var(--surface);
    overflow: hidden;
  }

  .title,
  .sub,
  .line {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sub {
    color: var(--on-surface-variant);
    font-size: 0.8125rem;
  }

  .line {
    height: 1.5rem;
    padding: 0 1.25rem;
    line-height: 1.5rem;
    color: var(--on-surface-variant);
    font-size: 0.8125rem;
  }

  .line.warn {
    color: var(--error);
  }

  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding-right: 0.5rem;
  }

  .footer .more {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* The line is 1.5rem high and cuts what overflows, the focus ring too. */
  .footer .text-btn {
    flex: none;
    height: 1.5rem;
    outline-offset: -2px;
  }

  /* A row is a grid. The open button fills all of it, and the buttons after it in the HTML sit on top of it in the same
     cells. It is a subgrid, so its text stays in the cells the buttons leave free. */
  .open {
    display: grid;
    align-self: stretch;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }

  .open:hover {
    background: var(--hover);
  }

  /* The card cuts what overflows, so the focus ring goes inside. */
  .open:focus-visible {
    outline-offset: -2px;
  }

  /* Heads-up: 0.5rem padding top and bottom, 4rem rows. */
  .heads-up {
    padding: 0.5rem 0;
  }

  .heads-up-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    column-gap: 0.5rem;
    height: 4rem;
  }

  .heads-up .open {
    grid-row: 1;
    grid-column: 1 / -1;
    grid-template-columns: subgrid;
    align-items: center;
  }

  .heads-up .text {
    min-width: 0;
    padding-left: 1.25rem;
  }

  .actions {
    display: flex;
    grid-row: 1;
    grid-column: 2;
    align-items: center;
    gap: 0.5rem;
    padding-right: 0.5rem;
  }

  .heads-up .title {
    font-weight: 500;
  }

  /* Alert: 3.5rem header plus 1.25rem padding top and bottom, 7.5rem rows. */
  .alert {
    padding-bottom: 1.25rem;
  }

  header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    height: 3.5rem;
    margin-bottom: 1.25rem;
    padding: 0 1.25rem;
    background: var(--primary-container);
    color: var(--on-primary-container);
  }

  .started header {
    background: var(--error);
    color: var(--surface);
  }

  header svg {
    width: 1.5rem;
    height: 1.5rem;
    fill: currentColor;
  }

  h1 {
    margin: 0;
    font-size: 1rem;
    font-weight: 500;
  }

  /* Rows: label, title, sub, buttons. */
  .alert-row {
    display: grid;
    grid-template-rows: 1.25rem 1.75rem 1.25rem 1fr;
    height: 7.5rem;
  }

  .alert .open {
    grid-row: 1 / -1;
    grid-column: 1;
    grid-template-rows: subgrid;
    padding: 0 1.25rem;
  }

  .label {
    height: 1.25rem;
    color: var(--primary);
    font-size: 0.8125rem;
    font-weight: 500;
  }

  .label.late {
    color: var(--error);
  }

  .alert .title {
    height: 1.75rem;
    font-size: 1.375rem;
    line-height: 1.75rem;
  }

  .alert .sub {
    height: 1.25rem;
  }

  /* Only as wide and high as the buttons, so a click beside them opens the event. */
  .buttons {
    display: flex;
    grid-row: 4;
    grid-column: 1;
    align-self: start;
    justify-self: start;
    gap: 0.5rem;
    margin: 0.5rem 1.25rem 0;
  }

  .buttons .pill-btn {
    height: 2.25rem;
  }

  .buttons select {
    height: 2.25rem;
    padding: 0 0.75rem;
    border: 1px solid var(--outline);
    border-radius: 1.125rem;
    background: var(--surface);
    color: inherit;
    font: inherit;
  }

  @media (forced-colors: active) {
    .card {
      outline-color: CanvasText;
    }
  }
</style>
