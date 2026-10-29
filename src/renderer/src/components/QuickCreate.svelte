<script lang="ts">
  import type { Calendar, EventInput } from '../../../shared/api'
  import { formats } from '../lib/settings.svelte'
  import { errorMessage } from '../lib/sign-in.svelte'
  import { addDays, fromDateKey } from '../lib/time'
  import Popover from './Popover.svelte'

  // Opens on a click in empty grid space. Enter saves; "More options" moves to the full dialog.
  let {
    draft = $bindable(),
    calendars,
    anchor,
    onsave,
    onmore,
    onclose
  }: {
    draft: EventInput
    calendars: Calendar[]
    anchor: { left: number; top: number; right: number; bottom: number }
    onsave: (input: EventInput) => Promise<void>
    onmore: () => void
    onclose: () => void
  } = $props()

  const when = $derived(
    draft.allDay
      ? formats.day.formatRange(fromDateKey(draft.startDate!), addDays(fromDateKey(draft.endDate!), -1))
      : `${formats.day.format(draft.start)} · ${formats.time.formatRange(draft.start, draft.end)}`
  )
  let saving = $state(false)
  let error = $state('')

  async function save(): Promise<void> {
    if (saving) return
    saving = true
    error = ''
    try {
      await onsave({ ...draft, title: draft.title.trim() })
      onclose()
    } catch (e) {
      error = errorMessage(e)
    } finally {
      saving = false
    }
  }
</script>

<Popover {anchor} label="New event" width="25rem" {onclose}>
  <form
    onsubmit={(e) => {
      e.preventDefault()
      void save()
    }}
  >
    <input class="title" placeholder="Add title" aria-label="Title" bind:value={draft.title} />
    <div class="when">{when}</div>
    <select aria-label="Calendar" bind:value={draft.calendarId}>
      {#each calendars as calendar (calendar.id)}
        <option value={calendar.id}>{calendar.name}</option>
      {/each}
    </select>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="buttons">
      <button type="button" class="text-btn" onclick={onmore}>More options</button>
      <button type="submit" class="filled-btn" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
    </div>
  </form>
</Popover>

<style>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem 1rem 0;
  }

  .title {
    padding: 0.25rem 0;
    border: 0;
    border-bottom: 1px solid var(--outline);
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 1.375rem;
  }

  .title:focus {
    outline: none;
    border-bottom: 2px solid var(--primary);
  }

  .when {
    color: var(--on-surface-variant);
  }

  select {
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
</style>
