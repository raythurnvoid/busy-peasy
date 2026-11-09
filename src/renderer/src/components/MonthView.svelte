<script lang="ts">
  import { tick } from 'svelte'
  import type { Calendar, CalendarEvent, Times } from '../../../shared/api'
  import { eventName, needsRsvp } from '../../../shared/events'
  import { textOn } from '../lib/color'
  import { drag } from '../lib/drag'
  import { inAllDayRow, layoutAllDay, type AllDayBar } from '../lib/layout'
  import { formats, spokenTime } from '../lib/settings.svelte'
  import { addDays, allDayTimes, dateKey, daysBetween, fromDateKey, isSameDay, moveDates, moveTimes, shownDays } from '../lib/time'
  import EventChip from './EventChip.svelte'
  import Popover from './Popover.svelte'

  let {
    start,
    month,
    weekends,
    events,
    calendars,
    canDrag,
    newEvent,
    onopen,
    onmenu,
    oncreate,
    onmove,
    onday
  }: {
    // First day of the grid (week start before the 1st) and the month being shown.
    start: Date
    month: number
    // false: Saturday and Sunday columns are left out.
    weekends: boolean
    events: CalendarEvent[]
    calendars: Calendar[]
    // false: the event cannot be moved (an invite, a view-only calendar, ...).
    canDrag: (event: CalendarEvent) => boolean
    // The placeholder of a new event with these times, shown while a drag creates one.
    newEvent: (times: Times) => CalendarEvent
    onopen: (event: CalendarEvent, anchor: HTMLElement) => void
    // Right-click or Shift+F10: the color menu.
    onmenu: (event: CalendarEvent, anchor: HTMLElement, e: MouseEvent) => void
    // end: the day after the last one a drag covered.
    oncreate: (start: Date, allDay: boolean, point: { x: number; y: number }, end?: Date) => void
    // A drag moved the event to other days (maybe the same day). The time stays, like Google.
    onmove: (event: CalendarEvent, times: Times) => void
    onday: (day: Date) => void
  } = $props()

  const LINE_PX = 22
  // Day number row on top of each cell.
  const HEAD_PX = 28
  // The id of the moving copy, so it does not clash with the original in keyed lists.
  const COPY = -2

  // One cell line: an all-day bar piece, an empty lane (keeps bars aligned across days), or a timed event.
  type Line = { bar: AllDayBar } | { gap: true } | { event: CalendarEvent }

  let gridHeight = $state(0)
  let now = $state(new Date())
  let more: { day: Date; anchor: DOMRect } | null = $state(null)
  let root: HTMLDivElement | undefined = $state()
  // The one cell with tabindex 0 (roving tabindex), as a date key. null: today, or the first day of the month.
  let focus: string | null = $state(null)
  // The drag in progress. event: the one moved; null while creating. times: what it would get.
  let preview: { event: CalendarEvent | null; times: Times } | null = $state(null)
  let pointer = { x: 0, y: 0 }

  // The copy is laid out like any event, first, so a full cell does not hide it.
  const copy = $derived.by(() => preview && { ...(preview.event ?? newEvent(preview.times)), ...preview.times, id: COPY })
  const all = $derived(copy ? [copy, ...events] : events)

  // Without weekends, a row can hold only days of the month before or after: it is left out.
  const weeks = $derived(
    Array.from({ length: 6 }, (_, w) => {
      const first = addDays(start, w * 7)
      const visible = shownDays(first, 7, weekends)
      const { bars } = layoutAllDay(all, visible)
      const days = visible.map((day, d) => {
        const next = addDays(day, 1)
        const covering = bars.filter((b) => b.startDay <= d && b.endDay >= d)
        const lanes = covering.length ? Math.max(...covering.map((b) => b.row)) + 1 : 0
        const lines: Line[] = Array.from({ length: lanes }, (_, lane) => {
          const bar = covering.find((b) => b.row === lane)
          return bar ? { bar } : { gap: true }
        })
        // Timed events show on the day they start.
        for (const event of all) {
          if (!inAllDayRow(event) && event.start >= day.getTime() && event.start < next.getTime()) lines.push({ event })
        }
        return { day, index: d, lines }
      })
      return { first, days }
    }).filter((week) => weekends || week.days.some(({ day }) => day.getMonth() === month))
  )
  // Lines that fit in one cell; the last one turns into "N more" when there are too many.
  const fit = $derived(Math.max(1, Math.floor((gridHeight / weeks.length - HEAD_PX) / LINE_PX)))
  // Read from the live grid, so the "more" list follows sync and edits.
  const moreEvents = $derived.by(() => {
    if (!more) return []
    const day = more.day.getTime()
    const lines = weeks.flatMap((w) => w.days).find((d) => d.day.getTime() === day)?.lines ?? []
    return lines.flatMap((l) => ('bar' in l ? [l.bar.event] : 'event' in l ? [l.event] : []))
  })

  const cells = $derived(weeks.flatMap((w) => w.days.map((d) => d.day)))
  const focusKey = $derived.by(() => {
    if (focus && cells.some((d) => dateKey(d) === focus)) return focus
    return dateKey(cells.find((d) => isSameDay(d, now)) ?? cells.find((d) => d.getMonth() === month) ?? cells[0])
  })

  const byId = $derived(new Map(calendars.map((c) => [c.id, c])))
  const color = (event: CalendarEvent): string => byId.get(event.calendarId)?.color ?? '#039be5'
  const label = (event: CalendarEvent): string => event.title || '(No title)'
  const name = (event: CalendarEvent, day: Date): string => eventName(event, byId.get(event.calendarId), spokenTime(event), formats.date.format(day))

  $effect(() => {
    const timer = setInterval(() => (now = new Date()), 60_000)
    return () => clearInterval(timer)
  })

  // Month cells carry their date. null: the pointer is not over a cell.
  function dayAt(x: number, y: number): Date | null {
    const key = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-day]')?.dataset.day
    return key ? fromDateKey(key) : null
  }

  // A press on an event (move it by whole days) or on an empty cell (event null: create an all-day event).
  function startDrag(e: PointerEvent, event: CalendarEvent | null): void {
    const press = dayAt(e.clientX, e.clientY)
    if (!press) return
    let at = press
    drag(e, root!, 'move', {
      onmove: (x, y) => {
        pointer = { x, y }
        at = dayAt(x, y) ?? at
        if (event) {
          const shift = daysBetween(press, at)
          preview = { event, times: event.allDay ? moveDates(event, shift) : moveTimes(event, shift, 0) }
        } else {
          const [first, last] = at < press ? [at, press] : [press, at]
          preview = { event, times: allDayTimes(dateKey(first), dateKey(addDays(last, 1))) }
        }
      },
      onend: () => {
        const done = preview
        preview = null
        if (!done) return
        const { times } = done
        if (event) onmove(event, times)
        else oncreate(fromDateKey(times.startDate!), true, pointer, fromDateKey(times.endDate!))
      },
      oncancel: () => (preview = null)
    })
  }

  // Arrows move between days (up and down: a week), Home and End go to the ends of the week row, Enter or Space
  // opens quick create for that day, like Google.
  function cellKey(e: KeyboardEvent, day: Date): void {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      return oncreate(day, true, { x: r.left + r.width / 2, y: r.top + r.height / 2 })
    }
    const week = weeks[0].days.length
    const i = cells.findIndex((d) => d.getTime() === day.getTime())
    let next: number | null = null
    if (e.key === 'ArrowLeft') next = i - 1
    else if (e.key === 'ArrowRight') next = i + 1
    else if (e.key === 'ArrowUp') next = i - week
    else if (e.key === 'ArrowDown') next = i + week
    else if (e.key === 'Home') next = i - (i % week)
    else if (e.key === 'End') next = i - (i % week) + week - 1
    if (next === null) return
    e.preventDefault()
    focus = dateKey(cells[Math.min(cells.length - 1, Math.max(0, next))])
    void tick().then(() => root?.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]')?.focus())
  }

  // Nothing left on that day: set more to null (not just hide the list), so it does not open again when an event
  // comes back to that day.
  $effect(() => {
    if (more && !moreEvents.length) more = null
  })

  // A reminder opens an event from outside: the list must not stay open under its popover.
  export function closeMore(): void {
    more = null
  }
</script>

{#snippet line(item: Line, dayIndex: number, day: Date)}
  {#if 'bar' in item}
    {@const e = item.bar.event}
    {@const first = dayIndex === item.bar.startDay}
    {@const fill = e.color ?? color(e)}
    {@const on = textOn(fill)}
    <!-- The title shows on the first piece of each week; later pieces just continue the color and are not read again. -->
    <!-- A timed event of 24 h or more shows its start time first, like Google ("10:00 Title"). -->
    <!-- An event color keeps a strip in the calendar's color at the start, like the chips. -->
    <button
      class="bar"
      class:cont-left={!first || item.bar.startsBefore}
      class:cont-right={dayIndex !== item.bar.endDay || item.bar.endsAfter}
      class:strip={e.color !== null && first && !item.bar.startsBefore}
      class:needs-rsvp={needsRsvp(e)}
      class:tentative={!e.cancelled && e.response === 'tentative'}
      class:declined={!e.cancelled && e.response === 'declined'}
      class:cancelled={e.cancelled}
      class:past={(e.allDay ? fromDateKey(e.endDate!).getTime() : e.end) <= now.getTime()}
      class:dragging={e.id === preview?.event?.id}
      class:copy={e.id === COPY}
      style:--c={fill}
      style:--on-c={on}
      style:--away={on === '#ffffff' ? '#000000' : '#ffffff'}
      style:--cal={color(e)}
      aria-label={name(e, day)}
      aria-hidden={first ? undefined : 'true'}
      data-id={e.id}
      tabindex={first ? 0 : -1}
      onpointerdown={(ev) => (canDrag(e) ? startDrag(ev, e) : drag(ev, root!))}
      onclick={(ev) => (ev.stopPropagation(), onopen(e, ev.currentTarget))}
      oncontextmenu={(ev) => (ev.preventDefault(), ev.stopPropagation(), onmenu(e, ev.currentTarget, ev))}
      >{#if first}{#if !e.allDay}{`${formats.time.format(e.start)} `}{/if}{label(e)}{/if}</button
    >
  {:else if 'gap' in item}
    <div class="gap"></div>
  {:else}
    {@const e = item.event}
    <button
      class="timed"
      class:needs-rsvp={needsRsvp(e)}
      class:tentative={!e.cancelled && e.response === 'tentative'}
      class:declined={!e.cancelled && e.response === 'declined'}
      class:cancelled={e.cancelled}
      class:past={e.end <= now.getTime()}
      class:dragging={e.id === preview?.event?.id}
      class:copy={e.id === COPY}
      style:--c={e.color ?? color(e)}
      aria-label={name(e, day)}
      data-id={e.id}
      onpointerdown={(ev) => (canDrag(e) ? startDrag(ev, e) : drag(ev, root!))}
      onclick={(ev) => (ev.stopPropagation(), onopen(e, ev.currentTarget))}
      oncontextmenu={(ev) => (ev.preventDefault(), ev.stopPropagation(), onmenu(e, ev.currentTarget, ev))}
    >
      <span class="dot"></span><span class="time">{formats.time.format(e.start)}</span>
      <span class="name">{label(e)}</span>
    </button>
  {/if}
{/snippet}

<div class="month" role="grid" aria-label="Month" style:--days={weeks[0].days.length} bind:this={root}>
  <div class="weekdays" role="row">
    {#each weeks[0].days as { day } (day.getTime())}
      <div role="columnheader">{formats.weekday.format(day)}</div>
    {/each}
  </div>
  <div class="weeks" style:--weeks={weeks.length} bind:clientHeight={gridHeight}>
    {#each weeks as week (week.first.getTime())}
      <div class="week" role="row">
        {#each week.days as { day, index, lines } (day.getTime())}
          {@const overflow = lines.length > fit}
          {@const shown = overflow ? lines.slice(0, fit - 1) : lines}
          {@const count = lines.filter((l) => !('gap' in l)).length}
          <div
            class="cell"
            class:other-month={day.getMonth() !== month}
            role="gridcell"
            tabindex={dateKey(day) === focusKey ? 0 : -1}
            aria-current={isSameDay(day, now) ? 'date' : undefined}
            aria-label="{count} {count === 1 ? 'event' : 'events'}, {formats.weekdayLong.format(day)}, {formats.dayMonth.format(day)}"
            data-day={dateKey(day)}
            onfocus={() => (focus = dateKey(day))}
            onkeydown={(e) => cellKey(e, day)}
            onpointerdown={(e) => e.target === e.currentTarget && startDrag(e, null)}
            onclick={(e) => oncreate(day, true, { x: e.clientX, y: e.clientY })}
          >
            <button
              class="day-num"
              class:today={isSameDay(day, now)}
              aria-label="Show {formats.monthDay.format(day)}"
              onclick={(e) => (e.stopPropagation(), onday(day))}
            >
              {day.getDate() === 1 ? formats.monthDay.format(day) : day.getDate()}
            </button>
            <!-- Keyed by event, so after a sync a focused chip still shows its own event. -->
            {#each shown as item, i ('bar' in item ? item.bar.event.id : 'event' in item ? item.event.id : `gap${i}`)}
              {@render line(item, index, day)}
            {/each}
            {#if overflow}
              <button
                class="more"
                aria-label="{lines.length - shown.length} more events"
                onclick={(e) => {
                  e.stopPropagation()
                  more = { day, anchor: e.currentTarget.getBoundingClientRect() }
                }}>{lines.length - shown.length} more</button
              >
            {/if}
          </div>
        {/each}
      </div>
    {/each}
  </div>
</div>

{#if more}
  {@const list = more}
  <Popover anchor={list.anchor} label="Events on {formats.monthDay.format(list.day)}" width="15rem" onclose={() => (more = null)}>
    <div class="more-head">
      <div class="more-weekday">{formats.weekday.format(list.day)}</div>
      <div class="more-date">{list.day.getDate()}</div>
    </div>
    <div class="more-list">
      {#each moreEvents as e (e.id)}
        <div class="more-item">
          <EventChip
            event={e}
            color={color(e)}
            now={now.getTime()}
            compact
            timeLabel={e.allDay ? 'All day' : formats.time.format(e.start)}
            name={name(e, list.day)}
            onopen={(anchor) => {
              more = null
              onopen(e, anchor)
            }}
            onmenu={(anchor, ev) => {
              more = null
              onmenu(e, anchor, ev)
            }}
          />
        </div>
      {/each}
    </div>
  </Popover>
{/if}

<style>
  .month {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    /* Like Google: no text selection when a drag starts. */
    user-select: none;
  }

  .weekdays,
  .week {
    display: grid;
    grid-template-columns: repeat(var(--days), minmax(0, 1fr));
  }

  .weekdays div {
    padding-top: 0.5rem;
    text-align: center;
    font-family: var(--font-family-display);
    font-size-adjust: none;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--on-surface-variant);
    border-left: 1px solid var(--grid-line);
  }

  .weeks {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-rows: repeat(var(--weeks), minmax(0, 1fr));
  }

  .week {
    min-height: 0;
    border-bottom: 1px solid var(--grid-line);
  }

  .cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    min-height: 0;
    padding-bottom: 2px;
    border-left: 1px solid var(--grid-line);
    overflow: hidden;
  }

  .day-num {
    align-self: center;
    flex: none;
    min-width: 1.5rem;
    height: 1.5rem;
    margin-top: 2px;
    padding: 0 0.375rem;
    border: 0;
    border-radius: 0.75rem;
    background: transparent;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
  }

  .day-num:hover {
    background: var(--hover);
  }

  .day-num.today {
    background: var(--primary);
    color: var(--on-primary);
  }

  .other-month .day-num:not(.today) {
    color: var(--on-surface-variant);
  }

  .bar,
  .timed,
  .more,
  .gap {
    flex: none;
    height: 1.25rem;
    margin: 0 0.5rem;
    padding: 0 0.375rem;
    border: 0;
    border-radius: var(--radius);
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 1.25rem;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }

  .bar {
    background: var(--c);
    color: var(--on-c);
  }

  .bar.strip {
    border-left: 4px solid var(--cal);
  }

  /* Answers and past, the same as the chips (EventChip.svelte). */
  .bar.needs-rsvp,
  .bar.declined {
    background: var(--surface);
    color: color-mix(in srgb, var(--c) 50%, var(--on-surface));
    box-shadow: inset 0 0 0 1px var(--c);
  }

  .bar.declined {
    text-decoration: line-through;
  }

  .bar.tentative {
    background: repeating-linear-gradient(-45deg, var(--c) 0 6px, color-mix(in srgb, var(--c) 75%, var(--away)) 6px 12px);
  }

  .bar.past {
    --tint: color-mix(in srgb, var(--c) 30%, var(--surface));
    background: var(--tint);
    color: var(--on-surface);
  }

  .bar.past.needs-rsvp,
  .bar.past.declined {
    background: var(--surface);
    color: color-mix(in srgb, var(--c) 30%, var(--on-surface-variant));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 50%, var(--surface));
  }

  .bar.past.tentative {
    background: repeating-linear-gradient(-45deg, var(--tint) 0 6px, color-mix(in srgb, var(--tint) 75%, var(--surface)) 6px 12px);
  }

  /* Canceled by the organizer: outlined, grey and struck, like the chips. After .past, so a past one stays grey. */
  .bar.cancelled {
    border: 1px solid var(--outline);
    background: var(--surface);
    color: var(--on-surface-variant);
    text-decoration: line-through;
  }

  /* Pieces of one bar touch across cells. */
  .cont-left {
    margin-left: -1px;
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }

  .cont-right {
    margin-right: 0;
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }

  .timed {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    background: transparent;
  }

  .timed:hover,
  .more:hover {
    background: var(--hover);
  }

  .dot {
    flex: none;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--c);
    /* A thin ring, so light colors still show on the surface. */
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--on-surface) 30%, transparent);
  }

  /* Needs an answer or declined: hollow dot, like Google. */
  .needs-rsvp .dot,
  .declined .dot {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px var(--c);
  }

  .tentative .dot {
    background: repeating-linear-gradient(-45deg, var(--c) 0 2px, transparent 2px 4px);
    box-shadow: inset 0 0 0 1px var(--c);
  }

  .cancelled .dot {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px var(--on-surface-variant);
  }

  .time {
    font-weight: 400;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .declined .name,
  .cancelled .name {
    text-decoration: line-through;
  }

  /* Past: grey text and a pale dot, like Google. 80% keeps 4.5:1, also on hover (light 4.67, dark 6.13). */
  .timed.past {
    color: color-mix(in srgb, var(--on-surface-variant) 80%, var(--surface));
  }

  .past .dot {
    opacity: 0.4;
  }

  .more {
    background: transparent;
  }

  /* While dragging, the original stays in place, faded, like Google. */
  .dragging {
    opacity: 0.5;
  }

  /* The copy in the target cell: a light background and a shadow, like Google. */
  .copy {
    pointer-events: none;
    box-shadow: var(--shadow-float);
  }

  .timed.copy {
    background: var(--surface);
  }

  .more-head {
    text-align: center;
  }

  .more-weekday {
    font-family: var(--font-family-display);
    font-size-adjust: none;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--on-surface-variant);
  }

  .more-date {
    font-family: var(--font-family-display);
    font-size-adjust: none;
    font-size: 1.5rem;
  }

  .more-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0.5rem;
  }

  .more-item {
    height: 1.375rem;
  }

  @media (forced-colors: active) {
    .bar {
      border: 1px solid CanvasText;
    }

    .bar.needs-rsvp {
      border-style: dashed;
    }

    .bar.tentative {
      border-style: dotted;
    }

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

    .day-num.today {
      forced-color-adjust: none;
      background: Highlight;
      color: HighlightText;
    }

    /* Shadows are gone in forced colors, so the copy gets an outline. */
    .copy {
      outline: 2px dashed CanvasText;
    }
  }
</style>
