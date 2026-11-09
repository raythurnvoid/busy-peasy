<script lang="ts">
  import type { Repeat } from '../../../shared/api'
  import { MAX_COUNT, MAX_INTERVAL, isLast, nth, weekday } from '../../../shared/repeat'
  import { customDefaults, monthlyText, rule } from '../lib/repeat'
  import { formats } from '../lib/settings.svelte'

  // Google's "Custom recurrence" dialog. Monthly and yearly rules take their day from the start date, like Google.
  let {
    repeat,
    date,
    weekStart,
    onanswer
  }: {
    // The rule the select shows now. null: Does not repeat.
    repeat: Repeat | null
    // The start date, YYYY-MM-DD.
    date: string
    // The app's week start: the day buttons start there. Google starts on Sunday here.
    weekStart: number
    // The new rule. null: Cancel, nothing changes.
    onanswer: (repeat: Repeat | null) => void
  } = $props()

  const UNITS = {
    daily: ['day', 'days'],
    weekly: ['week', 'weeks'],
    monthly: ['month', 'months'],
    yearly: ['year', 'years']
  }

  // 1 Nov 2026 is a Sunday.
  const dayName = (day: number): string => formats.weekdayLong.format(new Date(2026, 10, 1 + day))
  const dayLetter = (day: number): string =>
    formats.weekdayNarrow.format(new Date(2026, 10, 1 + day))
  const startDay = $derived(weekday(date))
  const order = $derived(Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7))

  // svelte-ignore state_referenced_locally
  const r = repeat ?? rule({ freq: 'weekly', days: [weekday(date)] })
  // svelte-ignore state_referenced_locally
  const defaults = customDefaults(r.freq, date)
  let freq = $state(r.freq)
  let interval = $state(r.interval)
  // svelte-ignore state_referenced_locally
  let days = $state(r.freq === 'weekly' ? [...r.days] : [weekday(date)])
  let monthly = $state(r.monthly)
  let ends = $state<'never' | 'until' | 'count'>(
    r.count !== null ? 'count' : r.until !== null ? 'until' : 'never'
  )
  let until = $state(r.until ?? defaults.until)
  let count = $state(r.count ?? defaults.count)
  type Field = 'interval' | 'days' | 'until' | 'count'
  // The field OK last stopped on. Its message goes away once the field is fine.
  let failed = $state<Field | null>(null)
  // A message, not a silent fix: the user sees what to change.
  const problem = $derived.by((): { message: string; field: Field } | null => {
    if (!(Number.isInteger(interval) && interval >= 1 && interval <= MAX_INTERVAL))
      return { message: `Repeat every must be 1 to ${MAX_INTERVAL}.`, field: 'interval' }
    if (freq === 'weekly' && !days.includes(startDay))
      return {
        message: `Repeat on must include ${dayName(startDay)}, the day the event starts.`,
        field: 'days'
      }
    if (ends === 'until' && !until) return { message: 'Choose an end date.', field: 'until' }
    if (ends === 'until' && !(until >= date))
      return { message: 'The end date is before the start date.', field: 'until' }
    if (ends === 'count' && !(Number.isInteger(count) && count >= 1 && count <= MAX_COUNT))
      return { message: `Occurrences must be 1 to ${MAX_COUNT}.`, field: 'count' }
    return null
  })
  const error = $derived(problem?.field === failed ? problem.message : '')
  const invalid = $derived(error ? failed : null)

  let dialog: HTMLDialogElement | undefined = $state()
  let first: HTMLInputElement | undefined = $state()
  let untilInput: HTMLInputElement | undefined = $state()
  let countInput: HTMLInputElement | undefined = $state()
  const dayButtons: HTMLButtonElement[] = $state([])

  $effect(() => {
    dialog?.showModal()
    first?.focus()
  })

  // Like Google, the end fields not in use start again from the new frequency's defaults.
  function freqChanged(): void {
    const next = customDefaults(freq, date)
    if (ends !== 'until') until = next.until
    if (ends !== 'count') count = next.count
  }

  // The last day stays on, like Google.
  function toggle(day: number): void {
    if (days.length === 1 && days[0] === day) return
    days = days.includes(day) ? days.filter((d) => d !== day) : [...days, day]
  }

  // The bad field gets the focus and points to the message.
  function done(): void {
    if (problem) {
      failed = problem.field
      const fields = {
        interval: first,
        days: dayButtons[startDay],
        until: untilInput,
        count: countInput
      }
      fields[problem.field]?.focus()
      return
    }
    answer({
      freq,
      interval,
      days: freq === 'weekly' ? [...days].sort((a, b) => a - b) : [],
      monthly: freq === 'monthly' ? monthly : 'day',
      until: ends === 'until' ? until : null,
      count: ends === 'count' ? count : null
    })
  }

  // close() gives focus back to the repeat select.
  function answer(next: Repeat | null): void {
    dialog?.close()
    onanswer(next)
  }
</script>

<!-- Keys stay in this dialog: the edit dialog behind it must not act on Esc, Tab or Ctrl+S. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
  class="pz-panel"
  bind:this={dialog}
  aria-labelledby="repeat-dialog-title"
  onkeydown={(e) => e.stopPropagation()}
  oncancel={(e) => {
    // Esc is Cancel.
    e.preventDefault()
    answer(null)
  }}
>
  <h2 id="repeat-dialog-title">Custom recurrence</h2>
  <div class="row">
    <span>Repeat every</span>
    <input
      bind:this={first}
      class="number"
      type="number"
      min="1"
      max={MAX_INTERVAL}
      aria-label={`${UNITS[freq][1][0].toUpperCase()}${UNITS[freq][1].slice(1)} to repeat`}
      aria-invalid={invalid === 'interval' || undefined}
      aria-describedby={invalid === 'interval' ? 'repeat-error' : undefined}
      bind:value={interval}
    />
    <select aria-label="Frequency" bind:value={freq} onchange={freqChanged}>
      {#each Object.entries(UNITS) as [value, names] (value)}
        <option {value}>{names[interval === 1 ? 0 : 1]}</option>
      {/each}
    </select>
  </div>

  {#if freq === 'weekly'}
    <div class="field">
      <span id="repeat-on">Repeat on</span>
      <div class="days" role="group" aria-labelledby="repeat-on">
        {#each order as day (day)}
          <button
            bind:this={dayButtons[day]}
            type="button"
            class="day"
            aria-label={dayName(day)}
            aria-pressed={days.includes(day)}
            aria-describedby={invalid === 'days' && day === startDay ? 'repeat-error' : undefined}
            onclick={() => toggle(day)}
          >
            {dayLetter(day)}
          </button>
        {/each}
      </div>
    </div>
  {:else if freq === 'monthly'}
    <select aria-label="Monthly on" bind:value={monthly}>
      <option value="day">{monthlyText('day', date)}</option>
      {#if nth(date) <= 4}<option value="weekday">{monthlyText('weekday', date)}</option>{/if}
      {#if isLast(date)}<option value="last">{monthlyText('last', date)}</option>{/if}
    </select>
  {/if}

  <fieldset class="ends">
    <legend>Ends</legend>
    <label class="check"
      ><input type="radio" name="ends" value="never" bind:group={ends} /> Never</label
    >
    <div class="check">
      <label class="check"
        ><input type="radio" name="ends" value="until" bind:group={ends} /> On</label
      >
      <input
        bind:this={untilInput}
        type="date"
        aria-label="Date on which the recurrence ends"
        min={date}
        disabled={ends !== 'until'}
        aria-invalid={invalid === 'until' || undefined}
        aria-describedby={invalid === 'until' ? 'repeat-error' : undefined}
        bind:value={until}
      />
    </div>
    <div class="check">
      <label class="check"
        ><input type="radio" name="ends" value="count" bind:group={ends} /> After</label
      >
      <input
        bind:this={countInput}
        class="number"
        type="number"
        min="1"
        max={MAX_COUNT}
        aria-label="Occurrence count"
        disabled={ends !== 'count'}
        aria-invalid={invalid === 'count' || undefined}
        aria-describedby={invalid === 'count' ? 'repeat-error' : undefined}
        bind:value={count}
      />
      <span>{count === 1 ? 'occurrence' : 'occurrences'}</span>
    </div>
  </fieldset>

  {#if error}<p id="repeat-error" class="error" role="alert">{error}</p>{/if}
  <div class="buttons">
    <button type="button" class="pill-btn" onclick={() => answer(null)}>Cancel</button>
    <button type="button" class="filled-btn" onclick={done}>Done</button>
  </div>
</dialog>

<style>
  dialog {
    width: min(26rem, calc(100vw - 2rem));
    padding: 1.5rem;
    color: var(--on-surface);
    box-shadow: var(--shadow-float);
    accent-color: var(--primary);
  }

  dialog::backdrop {
    background: rgb(30 20 10 / 40%);
  }

  h2 {
    margin: 0 0 1rem;
    font-size: 1.375rem;
    font-weight: 400;
  }

  input,
  select {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--outline);
    border-radius: var(--radius);
    background: var(--surface);
    color: inherit;
    font: inherit;
  }

  input[type='radio'] {
    padding: 0;
  }

  .number {
    width: 4.5rem;
  }

  .row,
  .check {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .row,
  .field,
  .ends,
  select {
    margin-bottom: 1rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .days {
    display: flex;
    gap: 0.25rem;
  }

  /* Round toggles, like Google's. */
  .day {
    width: 2rem;
    height: 2rem;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--surface-high);
    color: var(--on-surface);
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
  }

  .day[aria-pressed='true'] {
    background: var(--primary);
    color: var(--on-primary);
  }

  .ends {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0;
    border: 0;
  }

  legend {
    margin-bottom: 0.5rem;
    padding: 0;
  }

  input:disabled {
    opacity: 0.5;
  }

  .error {
    margin: 0 0 1rem;
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

    /* Every day is a circle; a pressed one is filled, so it does not look like the focus ring. */
    .day {
      border: 1px solid ButtonText;
    }

    .day[aria-pressed='true'] {
      forced-color-adjust: none;
      background: Highlight;
      color: HighlightText;
    }
  }
</style>
