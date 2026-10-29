<script lang="ts">
  import type { Settings } from '../../../shared/api'
  import { EVENT_MINUTES, MAX_ZONE_LABEL, WEEK_STARTS } from '../../../shared/settings'
  import { formats } from '../lib/settings.svelte'
  import { errorMessage } from '../lib/sign-in.svelte'
  import { localeWeekStart, pcZone, zoneLabel } from '../lib/time'
  import ReminderList from './ReminderList.svelte'
  import ZonePicker from './ZonePicker.svelte'

  let { initial, onsave, onclose }: { initial: Settings; onsave: (settings: Settings) => Promise<void>; onclose: () => void } =
    $props()

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const THEMES = [
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'system', label: 'Device default' }
  ] as const

  // svelte-ignore state_referenced_locally
  let form = $state($state.snapshot(initial))
  let saving = $state(false)
  let error = $state('')
  let dialog: HTMLDialogElement | undefined = $state()
  const now = Date.now()
  // Like Google's checkbox: off saves no secondary zone, and the picked zone and label stay here.
  // svelte-ignore state_referenced_locally
  let showZones = $state(initial.secondaryTimeZone !== null)
  // svelte-ignore state_referenced_locally
  let secondary = $state(initial.secondaryTimeZone ?? pcZone())
  const next = $derived({ ...form, secondaryTimeZone: showZones ? secondary : null })
  const dirty = $derived(JSON.stringify(next) !== JSON.stringify(initial))

  async function save(): Promise<void> {
    if (saving) return
    error = ''
    saving = true
    try {
      await onsave($state.snapshot(next))
      onclose()
    } catch (e) {
      error = errorMessage(e)
    } finally {
      saving = false
    }
  }

  function close(): void {
    if (dirty && !confirm('Discard your changes?')) return
    onclose()
  }

  $effect(() => {
    dialog?.showModal()
    // Chromium would focus the scroll box first.
    dialog?.querySelector('select')?.focus()
  })
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="settings-title"
  oncancel={(e) => {
    // A cancel that cannot be stopped closes anyway: onclose asks then.
    if (!e.cancelable) return
    e.preventDefault()
    close()
  }}
  onclose={() => {
    // Chromium closes without a stoppable cancel on a second Esc with no click or key in between.
    // Ask the same question, and open the dialog again to keep editing.
    if (dirty && !confirm('Discard your changes?')) dialog?.showModal()
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
      void save()
    }}
  >
    <h2 id="settings-title">Settings</h2>

    <!-- Only this part scrolls, so Save and Cancel stay in view. -->
    <div class="body">
      <fieldset>
        <legend>Language and region</legend>
        <label class="field">
          <span>Time format</span>
          <select bind:value={form.hour12} aria-describedby="time-format-help">
            <option value={null}>Default ({formats.languageTime.format(new Date(2000, 0, 1, 13))})</option>
            <option value={true}>1:00pm</option>
            <option value={false}>13:00</option>
          </select>
        </label>
        <p id="time-format-help" class="note">The time fields in the event editor keep the Windows format.</p>
      </fieldset>

      <fieldset>
        <legend>Time zone</legend>
        <!-- Google's primary zone is a setting; the app always follows Windows, like the grid. -->
        <p class="note">Primary time zone: {zoneLabel(pcZone(), now)}. Busy Peasy uses the Windows time zone.</p>
        <label class="check"><input type="checkbox" bind:checked={showZones} /> Show additional time zones</label>
        {#if showZones}
          <div class="field">
            <span>Secondary time zone</span>
            <ZonePicker id="secondary-zone" label="Secondary time zone" bind:value={secondary} at={now} />
          </div>
          <input
            class="zone-label"
            aria-label="Label for secondary time zone."
            placeholder="Label"
            maxlength={MAX_ZONE_LABEL}
            bind:value={form.secondaryTimeZoneLabel}
          />
        {/if}
      </fieldset>

      <fieldset>
        <legend>Event settings</legend>
        <label class="field">
          <span>Default duration</span>
          <select bind:value={form.eventMinutes}>
            {#each EVENT_MINUTES as minutes (minutes)}
              <option value={minutes}>{minutes} minutes</option>
            {/each}
          </select>
        </label>
      </fieldset>

      <fieldset>
        <legend>Notification settings</legend>
        <p class="note">
          Added to the reminders from Google and Outlook, for every event whose reminders you did not change in this app. A
          meeting has a video link or guests. All-day events have their own list.
        </p>
        <div class="field">
          <span>Every meeting</span>
          <ReminderList bind:reminders={form.meetingReminders} label="Every meeting" />
        </div>
        <div class="field">
          <span>Every other event</span>
          <ReminderList bind:reminders={form.eventReminders} label="Every other event" />
        </div>
        <div class="field">
          <span>Every all-day event</span>
          <ReminderList bind:reminders={form.allDayReminders} label="Every all-day event" allDay />
        </div>
        <!-- Differs from Google: it sets this per calendar, and the API does not give it. -->
        <p class="note">
          Google does not share its all-day setting with apps. All-day events made in Google keep their own notifications.
        </p>
      </fieldset>

      <fieldset>
        <legend>View options</legend>
        <label class="check"><input type="checkbox" bind:checked={form.showWeekends} /> Show weekends</label>
        <label class="check"><input type="checkbox" bind:checked={form.showDeclined} /> Show declined events</label>
        <label class="field">
          <span>Start week on</span>
          <select bind:value={form.weekStart}>
            <option value={null}>Default ({DAYS[localeWeekStart()]})</option>
            {#each WEEK_STARTS as day (day)}
              <option value={day}>{DAYS[day]}</option>
            {/each}
          </select>
        </label>
      </fieldset>

      <fieldset>
        <legend>Appearance</legend>
        {#each THEMES as theme (theme.id)}
          <label class="check"><input type="radio" name="theme" value={theme.id} bind:group={form.theme} /> {theme.label}</label>
        {/each}
      </fieldset>
    </div>

    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="buttons">
      <button type="button" class="pill-btn" onclick={close}>Cancel</button>
      <button type="submit" class="filled-btn" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
    </div>
  </form>
</dialog>

<style>
  dialog {
    width: min(40rem, calc(100vw - 2rem));
    padding: 1.5rem;
    border: 0;
    border-radius: 1.75rem;
    background: var(--surface-container);
    color: var(--on-surface);
    accent-color: var(--primary);
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
    gap: 1rem;
    min-height: 0;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    min-height: 0;
    /* Room for focus rings, which the scroll box would cut. */
    margin: -0.25rem;
    padding: 0.25rem;
    overflow: auto;
  }

  fieldset {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }

  legend {
    margin-bottom: 0.5rem;
    padding: 0;
    font-size: 1rem;
    font-weight: 500;
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

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    color: var(--on-surface-variant);
  }

  .field > :last-child {
    color: var(--on-surface);
  }

  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  select,
  .zone-label {
    align-self: flex-start;
    padding: 0.375rem 0.5rem;
    border: 1px solid var(--outline);
    border-radius: 0.25rem;
    background: var(--surface);
    color: inherit;
    font: inherit;
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
