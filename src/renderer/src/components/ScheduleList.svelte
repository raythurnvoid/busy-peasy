<script lang="ts">
  import { tick, type Snippet } from 'svelte'
  import type { Calendar, CalendarEvent } from '../../../shared/api'
  import { eventName, needsRsvp } from '../../../shared/events'
  import { formats, spokenTime } from '../lib/settings.svelte'
  import { fromDateKey, isSameDay, startOfDay } from '../lib/time'

  let {
    days,
    calendars,
    years,
    onopen,
    onmenu,
    onday,
    top,
    children
  }: {
    // Days with their events, from scheduleDays.
    days: { day: Date; events: CalendarEvent[] }[]
    calendars: Calendar[]
    // Search shows the year on each day, Schedule does not, like Google.
    years: boolean
    onopen: (event: CalendarEvent, anchor: HTMLElement) => void
    // Right-click or Shift+F10: the color menu.
    onmenu: (event: CalendarEvent, anchor: HTMLElement, e: MouseEvent) => void
    // The date was clicked: Google opens that day in the Day view.
    onday: (day: Date) => void
    // Notes before and after the days.
    top?: Snippet
    children?: Snippet
  } = $props()

  let now = $state(new Date())
  let root: HTMLDivElement | undefined = $state()

  // Search: focus the first event from today on (else the last day's), in the middle of the list, like Google.
  export function focusToday(): void {
    const groups = [...root!.querySelectorAll<HTMLElement>('.day')]
    const group = groups.find((g) => Number(g.dataset.day) >= startOfDay(now).getTime()) ?? groups.at(-1)
    const row = group?.querySelector<HTMLElement>('.event')
    row?.focus()
    row?.scrollIntoView({ block: 'center' })
  }

  // Delete: the row goes away, so focus moves to the next row (else the one before, else the list), not to the page.
  // Call it before the row goes.
  export function focusNext(id: number): void {
    const rows = [...root!.querySelectorAll<HTMLElement>('.event')]
    const i = rows.findIndex((row) => row.dataset.id === String(id))
    if (i === -1) return
    const next = rows[i + 1] ?? rows[i - 1] ?? root
    void tick().then(() => next?.focus())
  }

  // Undo: the row is back.
  export function focusEvent(id: number): void {
    void tick().then(() => root?.querySelector<HTMLElement>(`.event[data-id="${id}"]`)?.focus())
  }

  function timeLabel(event: CalendarEvent): string {
    if (event.allDay) return 'All day'
    // A timed event over several days, e.g. "24 Oct, 13:30 – 25 Oct, 12:30".
    if (!isSameDay(new Date(event.start), new Date(event.end - 1))) {
      return `${formats.monthDay.format(event.start)}, ${formats.time.format(event.start)} – ${formats.monthDay.format(event.end)}, ${formats.time.format(event.end)}`
    }
    return formats.time.formatRange(event.start, event.end)
  }

  // Up and Down: the next event. Left and Right: the first event of the next day, like Google.
  function onKey(e: KeyboardEvent): void {
    const rows = [...root!.querySelectorAll<HTMLElement>('.event')]
    const i = rows.indexOf(e.target as HTMLElement)
    if (i === -1) return
    let next: HTMLElement | null | undefined
    if (e.key === 'ArrowDown') next = rows[i + 1]
    else if (e.key === 'ArrowUp') next = rows[i - 1]
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const groups = [...root!.querySelectorAll('.day')].filter((g) => g.querySelector('.event'))
      const day = groups.findIndex((g) => g.contains(rows[i]))
      next = groups[day + (e.key === 'ArrowRight' ? 1 : -1)]?.querySelector<HTMLElement>('.event')
    } else return
    e.preventDefault()
    next?.focus()
  }

  $effect(() => {
    const timer = setInterval(() => (now = new Date()), 30_000)
    return () => clearInterval(timer)
  })
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="schedule" tabindex="-1" bind:this={root} onkeydown={onKey}>
  {@render top?.()}
  {#each days as group (group.day.getTime())}
    {@const today = isSameDay(group.day, now)}
    <div class="day" data-day={group.day.getTime()}>
      <h3 class="date">
        <!-- "Thursday, 31 December"; the year only when it is not this year, like Google. -->
        <button
          class="day-btn"
          aria-label="{group.day.getFullYear() === now.getFullYear()
            ? `${formats.weekdayLong.format(group.day)}, ${formats.dayMonth.format(group.day)}`
            : formats.fullDate.format(group.day)}{today ? ', today' : ''}"
          onclick={() => onday(group.day)}
        >
          <span class="num" class:today>{group.day.getDate()}</span>
          <span class="label">
            {(years ? formats.monthYearShort : formats.monthShort).format(group.day)}, {formats.weekday.format(group.day)}
          </span>
        </button>
      </h3>
      <div class="events">
        <!-- Keyed by event, so focus stays on its row when the list loads again after a sync. -->
        {#each group.events as event (event.id)}
          {@const calendar = calendars.find((c) => c.id === event.calendarId)}
          {@const time = timeLabel(event)}
          {@const title = event.title || '(No title)'}
          <button
            class="event"
            data-id={event.id}
            class:needs-rsvp={needsRsvp(event)}
            class:declined={!event.cancelled && event.response === 'declined'}
            class:tentative={!event.cancelled && event.response === 'tentative'}
            class:cancelled={event.cancelled}
            class:past={(event.allDay ? fromDateKey(event.endDate!).getTime() : event.end) <= now.getTime()}
            style:--c={event.color ?? calendar?.color ?? '#039be5'}
            aria-label={eventName(event, calendar, spokenTime(event), formats.date.format(group.day))}
            onclick={(e) => onopen(event, e.currentTarget)}
            oncontextmenu={(e) => (e.preventDefault(), e.stopPropagation(), onmenu(event, e.currentTarget, e))}
          >
            <span class="dot"></span>
            <span class="time">{time}</span>
            <span class="title">{title}</span>
            <span class="location">{event.location}</span>
          </button>
        {/each}
      </div>
    </div>
  {/each}
  {@render children?.()}
</div>

<style>
  .schedule {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0.5rem 0 1rem;
  }

  .day {
    display: flex;
    align-items: flex-start;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--line);
  }

  /* Room for "NOV 2026, MON" (search shows the year) in Cinzel caps, which are wider than a sans. */
  .date {
    flex: none;
    width: 9.75rem;
    margin: 0;
    font: inherit;
    letter-spacing: normal;
  }

  .day-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.5rem 0 0;
    border: 0;
    border-radius: var(--radius);
    background: transparent;
    cursor: pointer;
  }

  .day-btn:hover {
    background: var(--hover);
  }

  .num {
    display: grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 50%;
    font-family: var(--font-family-display);
    font-size-adjust: none;
    font-size: 1.25rem;
  }

  .num.today {
    background: var(--primary);
    color: var(--on-primary);
  }

  .label {
    font-family: var(--font-family-display);
    font-size-adjust: none;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    white-space: nowrap;
    color: var(--on-surface-variant);
  }

  .events {
    flex: 1;
    min-width: 0;
  }

  .event {
    display: flex;
    align-items: center;
    gap: 1rem;
    width: 100%;
    height: 2.5rem;
    padding: 0 0.75rem;
    border: 0;
    border-radius: var(--radius);
    background: transparent;
    text-align: left;
    cursor: pointer;
  }

  .event:hover {
    background: var(--hover);
  }

  .dot {
    flex: none;
    width: 0.625rem;
    height: 0.625rem;
    border-radius: 50%;
    background: var(--c);
  }

  /* Needs an answer or declined: hollow dot. Tentative: hatched. Like Google and the Month view. */
  .needs-rsvp .dot,
  .declined .dot {
    background: transparent;
    box-shadow: inset 0 0 0 2px var(--c);
  }

  .tentative .dot {
    background: repeating-linear-gradient(-45deg, var(--c) 0 2px, transparent 2px 4px);
    box-shadow: inset 0 0 0 1px var(--c);
  }

  /* Long enough for "16:00 – 16:30"; an event over several days takes more. */
  .time {
    flex: none;
    min-width: 8rem;
  }

  .title,
  .location {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .title {
    flex: none;
    max-width: 50%;
  }

  .location {
    flex: 1;
    min-width: 0;
    color: var(--on-surface-variant);
  }

  .declined .time,
  .declined .title,
  .cancelled .title {
    text-decoration: line-through;
  }

  .cancelled {
    color: var(--on-surface-variant);
  }

  .cancelled .dot {
    background: var(--outline);
  }

  /* Past: grey text and a pale dot, like Google. 80% keeps 4.5:1, also on hover (light 4.67, dark 6.13). */
  .past {
    color: color-mix(in srgb, var(--on-surface-variant) 80%, var(--surface));
  }

  .past .dot {
    opacity: 0.4;
  }

  @media (forced-colors: active) {
    /* Dots are backgrounds, which forced colors remove: draw them in system colors so the answers still differ. */
    .dot {
      forced-color-adjust: none;
      background: CanvasText;
      box-shadow: none;
    }

    .needs-rsvp .dot,
    .declined .dot,
    .cancelled .dot {
      background: Canvas;
      border: 1.5px solid CanvasText;
    }

    .tentative .dot {
      background: repeating-linear-gradient(-45deg, CanvasText 0 2px, Canvas 2px 4px);
      border: 1px solid CanvasText;
    }

    .num.today {
      forced-color-adjust: none;
      background: Highlight;
      color: HighlightText;
    }
  }
</style>
