<script lang="ts">
  import { tick } from 'svelte'
  import { formats } from '../lib/settings.svelte'
  import { addDays, addMonths, isSameDay, monthGridStart } from '../lib/time'

  let { selected, weekStart, onpick }: { selected: Date; weekStart: number; onpick: (day: Date) => void } = $props()

  // The shown month follows the selected date, but its arrows can move away from it.
  let shown = $derived(addMonths(selected, 0))

  const days = $derived(Array.from({ length: 42 }, (_, i) => addDays(monthGridStart(shown, weekStart), i)))
  // The day with the one tab stop (roving tabindex), like Google. It follows the selected day; the arrow keys move it.
  let focusDay = $derived(selected)
  // After the header arrows the focus day may not be shown: then the 1st of the shown month has the tab stop.
  const stop = $derived(days.find((d) => isSameDay(d, focusDay)) ?? shown)
  // The app runs for days in the tray, so today moves.
  let today = $state(new Date())

  $effect(() => {
    const timer = setInterval(() => (today = new Date()), 60_000)
    return () => clearInterval(timer)
  })

  let grid: HTMLTableElement | undefined = $state()

  // Like Google: arrows move a day (up and down: a week), Home and End go to the first and last day of the month, Page
  // Up and Page Down to the same day a month back or on. Past the grid the month changes. Enter and Space are the
  // button's own click.
  function onKey(e: KeyboardEvent): void {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key]
    const month = { PageUp: -1, PageDown: 1 }[e.key]
    const y = stop.getFullYear()
    const m = stop.getMonth()
    let next: Date | null = step ? addDays(stop, step) : null
    if (e.key === 'Home') next = new Date(y, m, 1)
    else if (e.key === 'End') next = new Date(y, m + 1, 0)
    // A shorter month takes its last day (31 January -> 28 February).
    else if (month) next = new Date(y, m + month, Math.min(stop.getDate(), new Date(y, m + month + 1, 0).getDate()))
    if (!next) return
    e.preventDefault()
    focusDay = next
    // Home, End and the page keys always show that day's month, also when the grid already has the day (1 November in
    // October's last row).
    if (!step || !days.some((d) => isSameDay(d, next))) shown = addMonths(next, 0)
    focusStop()
  }

  // A pick in another month shows that month, so its button is new: focus stays in the grid, like Google.
  function focusStop(): void {
    void tick().then(() => grid?.querySelector<HTMLElement>('button[tabindex="0"]')?.focus())
  }
</script>

<div class="mini">
  <div class="head">
    <span class="title">{formats.month.format(shown)}</span>
    <button class="icon-btn small" aria-label="Previous month" onclick={() => (shown = addMonths(shown, -1))}>
      <svg viewBox="0 0 24 24"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4-4.6-4.6z" /></svg>
    </button>
    <button class="icon-btn small" aria-label="Next month" onclick={() => (shown = addMonths(shown, 1))}>
      <svg viewBox="0 0 24 24"><path d="M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z" /></svg>
    </button>
  </div>
  <!-- A grid with one tab stop, like Google, so screen readers pass the arrow keys on. -->
  <table class="grid" role="grid" aria-label={formats.month.format(shown)} bind:this={grid} onkeydown={onKey}>
    <thead>
      <tr>
        {#each days.slice(0, 7) as day (day.getTime())}
          <th class="weekday" aria-label={formats.weekdayLong.format(day)}>{formats.weekdayNarrow.format(day)}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each [0, 7, 14, 21, 28, 35] as first (first)}
        <tr>
          {#each days.slice(first, first + 7) as day (day.getTime())}
            {@const other = day.getMonth() !== shown.getMonth()}
            {@const isToday = isSameDay(day, today)}
            <td>
              <!-- Google's names: "28, Wednesday, today", and "27 September, Sunday" for another month. -->
              <button
                class="day"
                class:other
                class:today={isToday}
                class:selected={isSameDay(day, selected)}
                tabindex={isSameDay(day, stop) ? 0 : -1}
                aria-label="{other ? formats.dayMonth.format(day) : day.getDate()}, {formats.weekdayLong.format(day)}{isToday ? ', today' : ''}"
                aria-pressed={isSameDay(day, selected)}
                aria-current={isToday ? 'date' : undefined}
                onclick={() => (onpick(day), focusStop())}>{day.getDate()}</button
              >
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .mini {
    margin-bottom: 1rem;
  }

  .head {
    display: flex;
    align-items: center;
    padding-left: 0.5rem;
  }

  .title {
    flex: 1;
    font-weight: 500;
  }

  .small {
    width: 1.75rem;
    height: 1.75rem;
  }

  .small svg {
    width: 1.25rem;
    height: 1.25rem;
  }

  .grid {
    margin: 0 auto;
    border-collapse: collapse;
    text-align: center;
  }

  th,
  td {
    width: 2rem;
    padding: 0;
  }

  .weekday {
    font-size: 0.625rem;
    font-weight: 500;
    line-height: 2rem;
    color: var(--on-surface-variant);
  }

  .day {
    width: 1.75rem;
    height: 1.75rem;
    margin: 0.125rem;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    font-size: 0.625rem;
    font-weight: 500;
    cursor: pointer;
  }

  .day:hover {
    background: var(--hover);
  }

  .other {
    color: var(--on-surface-variant);
  }

  .selected {
    background: var(--primary-container);
    color: var(--on-primary-container);
  }

  .today {
    background: var(--primary);
    color: var(--on-primary);
  }

  /* Backgrounds are gone in forced colors: today keeps a system color, the selected day a border. */
  @media (forced-colors: active) {
    .selected {
      border: 1px solid CanvasText;
    }

    .today {
      forced-color-adjust: none;
      background: Highlight;
      color: HighlightText;
    }
  }
</style>
